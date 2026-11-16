import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { administrator, apply, Database, logins, propose, refusal } from "./database.ts";

// Faults a review found after the first release was written. Each is here as the case that
// showed it, so that it stays fixed.

const schema = `
  create domain label as text not null check (value <> '');
  create extension citext;
  create schema "Odd Schema";

  -- A column that may never be absent, by its type.
  create table tagged (id integer primary key, label label, qty integer not null default 0);
  insert into tagged values (1, 'one', 1), (2, 'two', 2), (3, 'three', 3);

  -- A key whose type, and whose idea of equal, come from an extension.
  create table people (handle citext primary key, name text not null);
  insert into people select 'user' || n, 'Person ' || n from generate_series(1, 3000) as n;

  -- Names that need quoting, a key of two columns, outside the public schema.
  create table "Odd Schema"."My Table" ("a b" text, day date, "Value" numeric, primary key ("a b", day));
  insert into "Odd Schema"."My Table" values ('x y', '2026-01-01', 1), ('x y', '2026-01-02', 2);

  -- A key too large for a program's own numbers.
  create table big (id bigint primary key, body text not null);
  insert into big values (9007199254740993, 'the odd one'), (9007199254740992, 'the even one');

  -- A table that numbers its own rows.
  create table numbered (id integer generated always as identity primary key, body text not null);
  insert into numbered (body) values ('first');

  create table customers (id integer primary key, name text not null);
  create table orders (id integer primary key, customer integer not null references customers, total numeric(10, 2) not null);
  insert into customers values (1, 'one'), (2, 'two');
  insert into orders select n, 1, 10 from generate_series(1, 400) as n;

  create table renamed (id integer primary key, body text not null);
  insert into renamed values (1, 'x'), (2, 'y');
  create table dropped (id integer primary key, body text not null);
  insert into dropped values (1, 'x');

  create table parted (id integer, body text, primary key (id)) partition by range (id);
  create table parted_low partition of parted for values from (0) to (100);
  insert into parted values (1, 'x');

  create table hidden (id integer primary key, secret text);

  select keyturn.protect(t) from unnest(array['tagged', 'people', '"Odd Schema"."My Table"', 'big', 'numbered', 'orders', 'renamed', 'dropped', 'parted', 'hidden']::regclass[]) t;
  grant select on tagged, people, big, numbered, orders, customers, renamed, dropped, parted to keyturn_agent, keyturn_approver;
  grant usage on schema "Odd Schema" to keyturn_agent, keyturn_approver;
  grant select on "Odd Schema"."My Table" to keyturn_agent, keyturn_approver;
`;

let database: Database;
let owner: pg.Client;
let agent: pg.Client;
let alice: pg.Client;
let admin: pg.Client;

beforeAll(async () => {
  database = await Database.create(schema);
  [owner, agent, alice] = await Promise.all([
    database.as(logins.owner),
    database.as(logins.agent),
    database.as(logins.alice),
  ]);
  admin = await administrator(database);
});

afterAll(async () => {
  await database.close();
});

const approve = (proposed: { proposal_id: string; content_hash: string }) =>
  alice.query("select keyturn.approve($1, $2)", [proposed.proposal_id, proposed.content_hash]);
const through = async (proposed: { proposal_id: string; content_hash: string }) => {
  await approve(proposed);
  return apply(agent, proposed.proposal_id);
};
const viewed = async (statement: string) => {
  await agent.query("begin");
  await agent.query(statement);
  const made = (await agent.query("select * from keyturn.proposed()")).rows[0];
  await agent.query("commit");
  return made as { proposal_id: string; content_hash: string };
};
const one = async (query: string, values: unknown[] = []) =>
  (await owner.query(query, values)).rows[0];
const status = async (id: string) =>
  (await one("select status from keyturn.proposals where id = $1", [id])).status as string;

describe("rows of awkward tables", () => {
  test("a column whose type forbids null does not stop a row being named by its key", async () => {
    expect(
      await through(
        await propose(agent, [
          { table: "tagged", operation: "update", key: { id: 1 }, set: { qty: 10 } },
        ]),
      ),
    ).toMatchObject({ status: "applied" });
    expect(
      await through(
        await propose(agent, [{ table: "tagged", operation: "delete", key: { id: 2 } }]),
      ),
    ).toMatchObject({ status: "applied" });
    expect(
      await through(await viewed("update proposal.tagged set qty = 30 where id = 3")),
    ).toMatchObject({
      status: "applied",
    });
    expect(
      await through(
        await propose(agent, [
          { table: "tagged", operation: "insert", values: { id: 4, label: "four" } },
        ]),
      ),
    ).toMatchObject({ status: "applied" });
    expect((await owner.query("select id, label, qty from tagged order by id")).rows).toEqual([
      { id: 1, label: "one", qty: 10 },
      { id: 3, label: "three", qty: 30 },
      { id: 4, label: "four", qty: 0 },
    ]);
    // What the type forbids is still forbidden: said when the row is proposed, or at the latest when it is written.
    const empty = await refusal(
      propose(agent, [
        { table: "tagged", operation: "update", key: { id: 1 }, set: { label: null } },
      ]),
    );
    expect(empty?.message).toContain("does not allow null");
  });

  test("a key of an extension's type is matched the way the table matches it, by its index", async () => {
    const proposed = await propose(agent, [
      { table: "people", operation: "update", key: { handle: "USER7" }, set: { name: "Renamed" } },
    ]);
    expect(await through(proposed)).toMatchObject({ status: "applied" });
    expect((await one("select name from people where handle = 'user7'")).name).toBe("Renamed");

    const condition = (await one("select keyturn.key_condition('people', array['handle']) as text"))
      .text as string;
    expect(condition).toContain("operator(public.=)");
    const plan = JSON.stringify(
      (
        await owner.query(`explain (format json) select * from people t where ${condition}`, [
          '{"handle": "user9"}',
        ])
      ).rows[0]["QUERY PLAN"],
    );
    expect(plan).toContain("Index Scan");
  });

  test("names that need quoting, a key of two columns, and a schema of its own", async () => {
    const proposed = await propose(agent, [
      {
        table: '"Odd Schema"."My Table"',
        operation: "update",
        key: { "a b": "x y", day: "2026-01-02" },
        set: { Value: 22.5 },
      },
      {
        table: '"Odd Schema"."My Table"',
        operation: "delete",
        key: { day: "2026-01-01", "a b": "x y" },
      },
      {
        table: '"Odd Schema"."My Table"',
        operation: "insert",
        values: { "a b": "new", day: "2026-02-01" },
      },
    ]);
    expect(await through(proposed)).toEqual({ status: "applied", changes: 3 });
    expect(
      (await owner.query('select * from "Odd Schema"."My Table" order by day')).rows,
    ).toMatchObject([
      { "a b": "x y", Value: "22.5" },
      { "a b": "new", Value: null },
    ]);
    const viewedOne = await viewed(
      `update proposal."Odd Schema_My Table" set "Value" = 1 where "a b" = 'new'`,
    );
    expect(await through(viewedOne)).toMatchObject({ status: "applied" });
    expect(
      (await alice.query("select distinct relation from keyturn.diff($1)", [viewedOne.proposal_id]))
        .rows,
    ).toEqual([{ relation: '"Odd Schema"."My Table"' }]);
  });

  test("a key larger than a program's numbers names the right row", async () => {
    const proposed = await propose(agent, [
      // Sent as text, as a careful caller would send it.
      {
        table: "big",
        operation: "update",
        key: { id: "9007199254740993" },
        set: { body: "changed" },
      },
    ]);
    expect(await through(proposed)).toMatchObject({ status: "applied" });
    expect((await owner.query("select id::text, body from big order by id")).rows).toEqual([
      { id: "9007199254740992", body: "the even one" },
      { id: "9007199254740993", body: "changed" },
    ]);
  });

  test("a column the table numbers itself takes no value, and is refused when proposed, not when applied", async () => {
    const byFunction = await refusal(
      propose(agent, [{ table: "numbered", operation: "insert", values: { id: 50, body: "x" } }]),
    );
    expect(byFunction?.message).toContain('no column "id" that can be set');
    const byView = await refusal(
      agent.query("insert into proposal.numbered (id, body) values (50, 'x')"),
    );
    expect(byView?.message).toContain("numbers its rows itself");

    expect(
      await through(
        await propose(agent, [
          { table: "numbered", operation: "insert", values: { body: "second" } },
        ]),
      ),
    ).toMatchObject({ status: "applied" });
    expect(
      await through(await viewed("insert into proposal.numbered (body) values ('third')")),
    ).toMatchObject({
      status: "applied",
    });
    expect(
      (await owner.query("select body from numbered order by id")).rows.map((row) => row.body),
    ).toEqual(["first", "second", "third"]);
  });
});

describe("a proposal whose table moved on", () => {
  test("goes stale when the table is renamed, and says so, instead of being stuck", async () => {
    const proposed = await propose(agent, [
      { table: "renamed", operation: "update", key: { id: 1 }, set: { body: "z" } },
    ]);
    await approve(proposed);
    await owner.query("alter table renamed rename to renamed_since");
    try {
      const outcome = await apply(agent, proposed.proposal_id);
      expect(outcome).toMatchObject({ status: "stale" });
      expect(outcome.reason).toBe(
        "public.renamed has been renamed to public.renamed_since since the proposal was made",
      );
      // The record still says what the reviewer read.
      expect(
        (await alice.query("select relation from keyturn.extent($1)", [proposed.proposal_id])).rows,
      ).toEqual([{ relation: "public.renamed" }]);
      expect((await owner.query("select * from keyturn.verify_audit()")).rows).toEqual([]);
    } finally {
      await owner.query("alter table renamed_since rename to renamed");
    }
  });

  test("goes stale when the table is dropped, and the doctor points at what is left behind", async () => {
    const proposed = await propose(agent, [
      { table: "dropped", operation: "delete", key: { id: 1 } },
    ]);
    await approve(proposed);
    await owner.query("drop table dropped cascade");
    expect(await apply(agent, proposed.proposal_id)).toEqual({
      status: "stale",
      change: 1,
      reason: "public.dropped no longer exists",
    });
    expect(
      (
        await alice.query("select relation, operation from keyturn.diff($1)", [
          proposed.proposal_id,
        ])
      ).rows[0],
    ).toEqual({
      relation: "public.dropped",
      operation: "delete",
    });
    const found = (
      await owner.query(
        "select level, finding, fix from keyturn.doctor() where finding like '%no longer exists'",
      )
    ).rows;
    expect(found).toHaveLength(1);
    expect(found[0].level).toBe("fail");
    await owner.query(found[0].fix);
    expect(
      (await owner.query("select from keyturn.doctor() where finding like '%no longer exists'"))
        .rowCount,
    ).toBe(0);
  });
});

describe("applying", () => {
  test("a lock not got in time leaves the approval standing, and the next try writes", async () => {
    const proposed = await propose(agent, [
      { table: "orders", operation: "insert", values: { id: 9001, customer: 2, total: 5 } },
    ]);
    await approve(proposed);

    const holder = await database.as(logins.owner);
    await holder.query("begin");
    await holder.query("select from customers where id = 2 for update");
    await agent.query("set lock_timeout = '300ms'");
    const first = await refusal(apply(agent, proposed.proposal_id));
    await agent.query("reset lock_timeout");
    await holder.query("rollback");

    expect(first?.code).toBe("55P03");
    expect(await status(proposed.proposal_id)).toBe("approved");
    expect(await apply(agent, proposed.proposal_id)).toEqual({ status: "applied", changes: 1 });
  });

  test("a write the table itself turns down ends the proposal as failed", async () => {
    const proposed = await propose(agent, [
      { table: "orders", operation: "insert", values: { id: 9002, customer: 777, total: 5 } },
    ]);
    expect(await through(proposed)).toMatchObject({ status: "failed" });
    expect(await status(proposed.proposal_id)).toBe("failed");
  });

  test("two proposals over the same rows, listed in opposite orders, never wait on each other for good", async () => {
    for (let round = 0; round < 12; round += 1) {
      const ids = [10 + round * 4, 11 + round * 4, 12 + round * 4, 13 + round * 4];
      const change = (id: number, total: number) => ({
        table: "orders",
        operation: "update",
        key: { id },
        set: { total },
      });
      const forward = await propose(
        agent,
        ids.map((id) => change(id, 20 + round)),
      );
      const backward = await propose(
        agent,
        [...ids].reverse().map((id) => change(id, 30 + round)),
      );
      await approve(forward);
      await approve(backward);
      const second = await database.as(logins.agent);
      const outcomes = await Promise.all([
        apply(agent, forward.proposal_id),
        apply(second, backward.proposal_id),
      ]);
      await second.end();
      // One is written; the other finds the rows changed. Neither is refused for a deadlock.
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["applied", "stale"]);
    }
  });
});

describe("a rule's hourly limit", () => {
  test("is not got round by a transaction that keeps one view of the data", async () => {
    await owner.query(
      "select keyturn.allow('small_orders', 'orders', array['update'], array['total'], per_hour => 2)",
    );
    const change = (id: number) => [
      { table: "orders", operation: "update", key: { id }, set: { total: 1 } },
    ];
    const clients = await Promise.all([1, 2, 3, 4, 5].map(() => database.as(logins.agent)));
    // Each opens its transaction, and so fixes what it will see, before any of them has applied.
    for (const client of clients) {
      await client.query("begin isolation level repeatable read");
      await client.query("select 1");
    }
    const outcomes: string[] = [];
    for (const [index, client] of clients.entries()) {
      const attempt = await refusal(
        (async () => {
          const made = await propose(client, change(300 + index));
          await apply(client, made.proposal_id);
        })(),
      );
      outcomes.push(attempt === null ? "applied" : attempt.message);
      await client.query(attempt === null ? "commit" : "rollback");
    }
    expect(outcomes.filter((outcome) => outcome === "applied")).toEqual([]);
    expect(outcomes[0]).toContain("only in a read committed transaction");
    expect(
      (
        await one(
          "select count(*)::int as n from orders where id between 300 and 304 and total = 1",
        )
      ).n,
    ).toBe(0);

    // In the ordinary kind of transaction the rule works, twice.
    const results: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const made = await propose(agent, change(310 + index));
      const attempt = await refusal(apply(agent, made.proposal_id));
      results.push(attempt === null ? "applied" : "waits");
    }
    expect(results).toEqual(["applied", "applied", "waits", "waits"]);
    await owner.query("delete from keyturn.rules");
  });

  test("a rule switched off is off for a proposal already made", async () => {
    await owner.query(
      "select keyturn.allow('small_orders_two', 'orders', array['update'], array['total'])",
    );
    const made = await propose(agent, [
      { table: "orders", operation: "update", key: { id: 330 }, set: { total: 2 } },
    ]);
    await owner.query("update keyturn.rules set active = false");
    expect((await refusal(apply(agent, made.proposal_id)))?.message).toContain(
      "pending, not approved",
    );
    await owner.query("delete from keyturn.rules");
  });
});

describe("what an agent can pile up or look at", () => {
  test("a login has room for two hundred waiting proposals and no more", async () => {
    const other = await database.as(logins.otherAgent);
    const change = (id: number) => [
      { table: "orders", operation: "update", key: { id }, set: { total: 3 } },
    ];
    await other.query(
      `select keyturn.propose(jsonb_build_array(jsonb_build_object('table', 'orders', 'operation', 'update', 'key', jsonb_build_object('id', n), 'set', jsonb_build_object('total', 3))), 'flood')
         from generate_series(1, 200) as n`,
    );
    expect((await refusal(propose(other, change(201))))?.message).toContain(
      "already has 200 proposals waiting",
    );
    expect(
      (await refusal(other.query("update proposal.orders set total = 4 where id = 202")))?.message,
    ).toContain("already has 200 proposals waiting");
    // Another login is not affected, and a decision makes room.
    await propose(agent, change(203));
    const oldest = (
      await one(
        "select id from keyturn.proposals where proposed_by = $1 and status = 'pending' limit 1",
        [logins.otherAgent],
      )
    ).id;
    await alice.query("select keyturn.reject($1)", [oldest]);
    await propose(other, change(204));
  });

  test("the list of protected tables shows an agent only the ones it may read", async () => {
    const seen = (await agent.query("select relation::text from keyturn.protected")).rows.map(
      (row) => row.relation,
    );
    expect(seen).toContain("orders");
    expect(seen).not.toContain("hidden");
    expect((await alice.query("select from keyturn.protected")).rowCount).toBeGreaterThan(
      seen.length,
    );
  });
});

describe("the doctor", () => {
  const failures = async (about: string) =>
    (
      await admin.query(
        "select finding from keyturn.doctor() where level = 'fail' and about = $1",
        [about],
      )
    ).rows.map((row) => row.finding as string);
  const withAgent = async (
    fault: (role: string) => string,
    check: (role: string) => Promise<void>,
  ) => {
    const role = `wrong_${database.name}_${Math.random().toString(36).slice(2, 8)}`;
    await admin.query(`create role ${role} login password 'test-only' in role keyturn_agent`);
    try {
      await admin.query(fault(role));
      await check(role);
    } finally {
      await admin.query(`reset role; drop owned by ${role} cascade; drop role ${role}`);
    }
  };

  test("reports a grant on a partition of a protected table", async () => {
    await withAgent(
      (role) => `grant insert on parted_low to ${role}`,
      async (role) => {
        expect((await failures(role)).join("; ")).toContain(
          "may insert public.parted_low (which holds rows of public.parted)",
        );
      },
    );
  });

  test("reports a role built into the server that the agent could switch to", async () => {
    await withAgent(
      (role) => `alter role ${role} noinherit; grant pg_write_all_data to ${role}`,
      async (role) => {
        expect((await failures(role)).join("; ")).toContain(
          "is a member of pg_write_all_data, which may write",
        );
      },
    );
  });

  test("reports the right to put a trigger on a protected table, and a trigger function the agent owns", async () => {
    await withAgent(
      (role) => `grant trigger on orders to ${role}`,
      async (role) => {
        expect((await failures(role)).join("; ")).toContain("may put a trigger on public.orders");
      },
    );
    await withAgent(
      (role) => `
        grant create on schema public to ${role};
        set role ${role};
        create function public.mine_${role}() returns trigger language plpgsql as $$ begin return new; end $$;
        reset role;
        create trigger mine before update on orders for each row execute function public.mine_${role}();`,
      async (role) => {
        try {
          expect((await failures(role)).join("; ")).toContain(
            "owns a function that a trigger on public.orders runs",
          );
        } finally {
          await admin.query(
            "drop trigger mine on orders; revoke create on schema public from public",
          );
          await admin.query(`revoke create on schema public from ${role}`);
        }
      },
    );
  });
});
