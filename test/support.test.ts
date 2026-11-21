import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { apply, Database, logins, propose, refusal } from "./database.ts";

/**
 * What Keyturn does with each kind of table, column and statement: the tests behind
 * docs/support.md. Where the answer is "refused", the refusal is the thing tested.
 */

const schema = `
  create type mood as enum ('calm', 'cross');
  create domain percent as integer check (value between 0 and 100);
  create type place as (street text, number integer);
  create table kinds (
    id        uuid primary key,
    feeling   mood not null,
    share     percent not null,
    lives     place,
    raw       bytea,
    addr      inet,
    span      int4range,
    took      interval,
    at        timestamptz,
    big       numeric,
    doc       jsonb,
    words     text[],
    spots     place[],
    on_day    date,
    exactly   double precision
  );
  create table measures (id integer not null, taken date not null, reading numeric not null, primary key (id, taken))
    partition by range (taken);
  create table measures_2025 partition of measures for values from ('2025-01-01') to ('2026-01-01');
  create table measures_2026 partition of measures for values from ('2026-01-01') to ('2027-01-01');
  insert into measures values (1, '2025-06-01', 1.5), (2, '2026-06-01', 2.5);
  create schema shop;
  create table shop.orders (id integer primary key, total numeric(10, 2) not null);
  insert into shop.orders values (1, 10);
  create table loose_rows (a integer, b text);
  create table plain_orders (id serial primary key, total numeric(10, 2) not null);
  insert into plain_orders (total) values (5);
  create view order_totals as select id, total from plain_orders;
  create materialized view order_sums as select sum(total) as total from plain_orders;
  select keyturn.protect('kinds');
  select keyturn.protect('measures');
  select keyturn.protect('shop.orders');
  select keyturn.protect('plain_orders');
  grant usage on schema shop to keyturn_agent, keyturn_approver;
  grant select on kinds, measures, shop.orders, plain_orders to keyturn_agent, keyturn_approver;
`;

let database: Database;
let owner: pg.Client;
let agent: pg.Client;
let alice: pg.Client;

beforeAll(async () => {
  database = await Database.create(schema);
  [owner, agent, alice] = await Promise.all([
    database.as(logins.owner),
    database.as(logins.agent),
    database.as(logins.alice),
  ]);
});

afterAll(async () => {
  await database.close();
});

async function applied(changes: unknown[]): Promise<string> {
  const made = await propose(agent, changes);
  await alice.query("select keyturn.approve($1, $2)", [made.proposal_id, made.content_hash]);
  const outcome = await apply(agent, made.proposal_id);
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "applied" });
  return made.proposal_id;
}
const all = async (table: string, order = "1") =>
  (
    await owner.query(
      `select coalesce(jsonb_agg(to_jsonb(t) order by ${order}), '[]')::text as rows from ${table} t`,
    )
  ).rows[0].rows as string;
const revert = async (proposal: string) =>
  (await alice.query("select keyturn.revert($1) as outcome", [proposal])).rows[0].outcome as {
    status: string;
  };

describe("kinds of table", () => {
  test("a table with no primary key, a view and a materialized view are not put under keyturn", async () => {
    for (const name of ["loose_rows", "order_totals", "order_sums"]) {
      expect(
        await refusal(owner.query("select keyturn.protect($1::regclass)", [name])),
        name,
      ).not.toBeNull();
    }
    expect((await refusal(owner.query("select keyturn.protect('loose_rows')")))?.message).toContain(
      "primary key",
    );
  });

  test("a partitioned table is proposed to, applied and taken back through its parent", async () => {
    const before = await all("measures", "id, taken");
    const proposal = await applied([
      {
        table: "measures",
        operation: "insert",
        values: { id: 3, taken: "2026-02-01", reading: 9 },
      },
      {
        table: "measures",
        operation: "update",
        key: { id: 1, taken: "2025-06-01" },
        set: { reading: 7 },
      },
      { table: "measures", operation: "delete", key: { id: 2, taken: "2026-06-01" } },
    ]);
    expect(
      (await owner.query("select reading from measures_2025 where id = 1")).rows[0].reading,
    ).toBe("7");
    expect((await owner.query("select count(*)::int as n from measures_2026")).rows[0].n).toBe(1);
    expect(await revert(proposal)).toMatchObject({ status: "reverted" });
    expect(await all("measures", "id, taken")).toBe(before);
    // The parts themselves are tables the agent has no rights on.
    expect((await refusal(agent.query("update measures_2025 set reading = 0")))?.code).toBe(
      "42501",
    );
    expect((await refusal(agent.query("update measures set reading = 0")))?.code).toBe("42501");
  });

  test("a table in another schema works by its full name", async () => {
    const proposal = await applied([
      { table: "shop.orders", operation: "update", key: { id: 1 }, set: { total: 12 } },
    ]);
    expect((await owner.query("select total from shop.orders")).rows[0].total).toBe("12.00");
    expect(await revert(proposal)).toMatchObject({ status: "reverted" });
    expect((await refusal(agent.query("update shop.orders set total = 0")))?.code).toBe("42501");
  });
});

describe("kinds of value", () => {
  test("every one comes back exactly: written, changed, taken back", async () => {
    const id = "5b0b3f0e-1f4b-4e0a-9d43-0a2f3b6f7c11";
    const values = {
      id,
      feeling: "cross",
      share: 55,
      lives: { street: "Mill Lane", number: 4 },
      raw: "\\x00ff10",
      addr: "192.168.7.0/24",
      span: "[3,9)",
      took: "1 day 02:03:04.5",
      at: "2026-03-01T10:20:30.123456+02:00",
      big: "123456789012345678901234567890.000000000000000000001",
      doc: { a: [1, 2.5, "x", null], b: { c: true } },
      words: ["a,b", 'say "hi"', "", "null"],
      spots: [
        { street: "A", number: 1 },
        { street: "B, the second", number: 2 },
      ],
      on_day: "2024-02-29",
      exactly: 0.1,
    };
    const inserted = await applied([{ table: "kinds", operation: "insert", values }]);
    const first = await all("kinds");
    const row = (await owner.query("select * from kinds")).rows[0];
    expect(row.big).toBe("123456789012345678901234567890.000000000000000000001");
    expect(row.words).toEqual(["a,b", 'say "hi"', "", "null"]);
    expect(row.raw.toString("hex")).toBe("00ff10");
    expect(row.took.toPostgres?.() ?? JSON.stringify(row.took)).toBeTruthy();

    const changed = await applied([
      {
        table: "kinds",
        operation: "update",
        key: { id },
        set: {
          feeling: "calm",
          share: 100,
          lives: { street: "Hill Road", number: 9 },
          raw: "\\x",
          span: "empty",
          big: "0.1",
          doc: [],
          words: [],
          exactly: 1e300,
        },
      },
    ]);
    expect(
      (await owner.query("select feeling, share, big::text, exactly from kinds")).rows[0],
    ).toEqual({
      feeling: "calm",
      share: 100,
      big: "0.1",
      exactly: 1e300,
    });
    expect(await revert(changed)).toMatchObject({ status: "reverted" });
    expect(await all("kinds")).toBe(first);
    expect(await revert(inserted)).toMatchObject({ status: "reverted" });
    expect(await all("kinds")).toBe("[]");
  });

  test("a value the column would refuse is refused when it is proposed", async () => {
    const one = (values: Record<string, unknown>) =>
      refusal(
        propose(agent, [
          {
            table: "kinds",
            operation: "insert",
            values: {
              id: "5b0b3f0e-1f4b-4e0a-9d43-0a2f3b6f7c12",
              feeling: "calm",
              share: 1,
              ...values,
            },
          },
        ]),
      );
    expect(await one({ feeling: "furious" })).not.toBeNull();
    expect(await one({ addr: "not an address" })).not.toBeNull();
    // A range that runs backwards is not a range: the type itself refuses it.
    const over = await propose(agent, [
      {
        table: "kinds",
        operation: "insert",
        values: {
          id: "5b0b3f0e-1f4b-4e0a-9d43-0a2f3b6f7c13",
          feeling: "calm",
          share: 1,
          span: "[9,3)",
        },
      },
    ]).catch((error: Error) => error);
    expect(over).toBeInstanceOf(Error);
  });
});

describe("what an agent may try on the table itself", () => {
  test("changing, emptying or dropping it is refused, as is anything else an owner does", async () => {
    for (const statement of [
      "truncate plain_orders",
      "alter table plain_orders add column sneaky text",
      "alter table plain_orders disable trigger all",
      "drop table plain_orders",
      "create index on plain_orders (total)",
      "create trigger t before insert on plain_orders for each row execute function suppress_redundant_updates_trigger()",
      "alter table plain_orders owner to current_user",
      "comment on table plain_orders is 'mine'",
    ]) {
      const refused = await refusal(agent.query(statement));
      expect(refused, statement).not.toBeNull();
    }
    // Granting itself the right is not an error in PostgreSQL: it warns, and grants nothing.
    await agent.query("grant update on plain_orders to current_user");
    expect((await refusal(agent.query("update plain_orders set total = 0")))?.code).toBe("42501");
    expect((await owner.query("select count(*)::int as n from plain_orders")).rows[0].n).toBe(1);
  });

  test("its sequence is not the agent's to move, unless the owner gave it", async () => {
    expect((await refusal(agent.query("select setval('plain_orders_id_seq', 1000)")))?.code).toBe(
      "42501",
    );
    expect((await refusal(agent.query("select nextval('plain_orders_id_seq')")))?.code).toBe(
      "42501",
    );
  });

  test("a function that writes with its owner's rights is a way round, and the doctor says so", async () => {
    await owner.query(`
      create function give_discount(p_id integer) returns void language sql security definer
        as 'update public.plain_orders set total = 0 where id = p_id';
      grant execute on function give_discount(integer) to keyturn_agent;
    `);
    await agent.query("select give_discount(1)");
    expect((await owner.query("select total from plain_orders where id = 1")).rows[0].total).toBe(
      "0.00",
    );
    const found = await owner.query(
      "select level, finding from keyturn.doctor() where finding like '%give_discount%'",
    );
    // Once for each login that can reach it.
    expect(found.rows.length).toBeGreaterThan(0);
    expect(new Set(found.rows.map((row) => row.level))).toEqual(new Set(["fail"]));
    await owner.query("drop function give_discount(integer)");
  });
});

describe("what the owner changes while a proposal waits", () => {
  test("a column added, a table renamed or dropped: the proposal is stale, and nothing is written", async () => {
    await owner.query(`
      create table shifting (id integer primary key, v integer not null);
      create table renamed_soon (id integer primary key, v integer not null);
      create table dropped_soon (id integer primary key, v integer not null);
      insert into shifting values (1, 1); insert into renamed_soon values (1, 1); insert into dropped_soon values (1, 1);
      select keyturn.protect('shifting'); select keyturn.protect('renamed_soon'); select keyturn.protect('dropped_soon');
      grant select on shifting, renamed_soon, dropped_soon to keyturn_agent, keyturn_approver;
    `);
    const waiting: Record<string, string> = {};
    for (const table of ["shifting", "renamed_soon", "dropped_soon"]) {
      const made = await propose(agent, [
        { table, operation: "update", key: { id: 1 }, set: { v: 2 } },
      ]);
      await alice.query("select keyturn.approve($1, $2)", [made.proposal_id, made.content_hash]);
      waiting[table] = made.proposal_id;
    }
    await owner.query("alter table shifting add column extra text");
    await owner.query("alter table renamed_soon rename to renamed_now");
    await owner.query("drop table dropped_soon cascade");
    for (const table of ["shifting", "renamed_soon", "dropped_soon"]) {
      expect(await apply(agent, waiting[table] as string), table).toMatchObject({
        status: "stale",
      });
    }
    expect((await owner.query("select v from shifting")).rows[0].v).toBe(1);
    expect((await owner.query("select v from renamed_now")).rows[0].v).toBe(1);
  });
});
