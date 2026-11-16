import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { administrator, apply, Database, logins, propose, refusal } from "./database.ts";

// Every test here is a way in. Each is tried as the agent, and each must fail.

const schema = `
  create table accounts (
    id      integer primary key,
    tenant  text not null,
    balance numeric(12, 2) not null default 0
  );
  insert into accounts (id, tenant, balance) select n, case when n <= 10 then 'north' else 'south' end, 100 from generate_series(1, 20) as n;
  select keyturn.protect('accounts');
  grant select on accounts to keyturn_agent, keyturn_approver;

  -- A table the agent may not even read.
  create table salaries (id integer primary key, person text not null, amount numeric(12, 2) not null);
  insert into salaries values (1, 'the director', 250000);
  select keyturn.protect('salaries');

  -- A table where the agent sees one tenant's rows only.
  create table notes (id integer primary key, tenant text not null, body text not null);
  insert into notes values (1, 'north', 'visible to the agent'), (2, 'south', 'not visible to the agent');
  select keyturn.protect('notes');
  alter table notes enable row level security;
  create policy north_only on notes for select to keyturn_agent using (tenant = 'north');
  create policy approvers on notes for select to keyturn_approver using (true);
  grant select on notes to keyturn_agent, keyturn_approver;
`;

const PERMISSION_DENIED = "42501";

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

const balances = async () =>
  (await owner.query("select sum(balance)::text as total, count(*)::int as rows from accounts"))
    .rows[0];
const raise = (id: number, amount: number) => ({
  table: "accounts",
  operation: "update",
  key: { id },
  set: { balance: amount },
});
const code = async (client: pg.Client, sql: string) => (await refusal(client.query(sql)))?.code;

describe("writing the table directly", () => {
  test.each([
    ["update", "update accounts set balance = 1000000 where id = 1"],
    ["insert", "insert into accounts (id, tenant, balance) values (999, 'north', 1000000)"],
    ["delete", "delete from accounts"],
    ["truncate", "truncate accounts"],
    ["copy", "copy accounts (id, tenant, balance) from stdin"],
    [
      "an upsert",
      "insert into accounts (id, tenant) values (1, 'north') on conflict (id) do update set balance = 1000000",
    ],
    [
      "a merge",
      "merge into accounts a using (select 1 as id) s on a.id = s.id when matched then update set balance = 1000000",
    ],
    [
      "a data-changing query inside a read",
      "with gone as (delete from accounts returning *) select count(*) from gone",
    ],
    ["select for update, to hold rows hostage", "select * from accounts for update"],
  ])("%s is refused by the database", async (_name, sql) => {
    expect(await code(agent, sql)).toBe(PERMISSION_DENIED);
    expect(await balances()).toEqual({ total: "2000.00", rows: 20 });
  });

  test.each([
    ["dropping the table", "drop table accounts"],
    ["altering the table", "alter table accounts add column backdoor text"],
    [
      "adding a trigger to it",
      "create trigger t before insert on accounts for each row execute function suppress_redundant_updates_trigger()",
    ],
    ["adding a rule to it", "create rule r as on insert to accounts do also select 1"],
    ["taking the table over", "alter table accounts owner to current_user"],
    ["turning row-level security off elsewhere", "alter table notes disable row level security"],
  ])("%s is refused", async (_name, sql) => {
    expect(await code(agent, sql)).toBe(PERMISSION_DENIED);
  });
});

test("granting itself the privilege grants nothing", async () => {
  // PostgreSQL does not refuse this outright. It warns that nothing was granted, which is the same thing.
  await agent.query("grant update, insert, delete on accounts to current_user");

  expect(await code(agent, "update accounts set balance = 1000000 where id = 1")).toBe(
    PERMISSION_DENIED,
  );
  expect(
    (
      await owner.query("select has_table_privilege($1, 'accounts', 'UPDATE') as may", [
        logins.agent,
      ])
    ).rows[0].may,
  ).toBe(false);
});

describe("becoming someone else", () => {
  test.each([
    ["the approver group", "set role keyturn_approver"],
    ["an approver", `set role ${logins.alice}`],
    ["the owner", `set role ${logins.owner}`],
    ["another login, for the whole session", `set session authorization ${logins.alice}`],
  ])("the agent cannot become %s", async (_name, sql) => {
    expect(await code(agent, sql)).toBe(PERMISSION_DENIED);
    expect((await agent.query("select session_user, current_user")).rows[0]).toEqual({
      session_user: logins.agent,
      current_user: logins.agent,
    });
  });

  test("an identity handed in by the application counts for nothing", async () => {
    const proposed = await propose(agent, [raise(2, 5000)]);
    // What a web framework sets for the signed-in user. Any session can set it, so Keyturn does not read it.
    await agent.query(`set request.jwt.claims = '{"role": "keyturn_approver", "sub": "alice"}'`);
    await agent.query("set application_name = 'alice'");

    expect(
      (
        await refusal(
          agent.query("select keyturn.approve($1, $2)", [
            proposed.proposal_id,
            proposed.content_hash,
          ]),
        )
      )?.code,
    ).toBe(PERMISSION_DENIED);
    await agent.query("reset request.jwt.claims");
  });
});

describe("tampering with Keyturn's own records", () => {
  test("the agent cannot write a proposal, a change or an approval by hand", async () => {
    const proposed = await propose(agent, [raise(3, 5000)]);

    for (const sql of [
      `update keyturn.proposals set status = 'approved', decided_by = 'alice', decided_at = now() where id = '${proposed.proposal_id}'`,
      `update keyturn.changes set after = jsonb_set(after, '{balance}', '9999999') where proposal_id = '${proposed.proposal_id}'`,
      `insert into keyturn.changes (proposal_id, seq, relation, shape, operation, key, before, after, columns) select proposal_id, 2, relation, shape, operation, key, before, after, columns from keyturn.changes where proposal_id = '${proposed.proposal_id}'`,
      `delete from keyturn.proposals`,
      `truncate keyturn.proposals cascade`,
      `update keyturn.protected set exact = false`,
      `delete from keyturn.protected`,
      `select keyturn.protect('accounts', false)`,
    ]) {
      expect(await code(agent, sql), sql).toBe(PERMISSION_DENIED);
    }
    expect((await refusal(apply(agent, proposed.proposal_id)))?.message).toContain(
      "pending, not approved",
    );
  });

  test("the agent cannot replace or shadow a function Keyturn uses", async () => {
    // A function of the agent's own with the name of one Keyturn calls, placed first on the agent's search path.
    await agent.query(
      `create function pg_temp.sha256(bytea) returns bytea language sql as $$ select '\\x00'::bytea $$`,
    );
    await agent.query(
      `create function pg_temp.to_jsonb(anyelement) returns jsonb language sql as $$ select '{"id": 4, "tenant": "north", "balance": 0}'::jsonb $$`,
    );
    await agent.query("set search_path = pg_temp, public");

    const proposed = await propose(agent, [raise(4, 150)]);
    await agent.query("reset search_path");

    // The hash is a real one, and the row recorded is the real row.
    expect(proposed.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(proposed.content_hash).not.toBe("00");
    const change = (
      await alice.query("select before, after from keyturn.changes where proposal_id = $1", [
        proposed.proposal_id,
      ])
    ).rows[0];
    expect(change.before).toEqual({ id: 4, tenant: "north", balance: 100 });
    expect(change.after).toEqual({ id: 4, tenant: "north", balance: 150 });
    for (const sql of [
      "create or replace function keyturn.hash_of(uuid) returns text language sql as $$ select 'x' $$",
      "drop function keyturn.apply(uuid)",
      "alter function keyturn.approve(uuid, text) owner to current_user",
    ]) {
      expect(await code(agent, sql), sql).toBe(PERMISSION_DENIED);
    }
  });

  test("a proposal altered after it was approved is not applied, even when the owner did the altering", async () => {
    const proposed = await propose(agent, [raise(5, 150)]);
    await alice.query("select keyturn.approve($1, $2)", [
      proposed.proposal_id,
      proposed.content_hash,
    ]);
    // The one actor outside the claim, used here to play a break-in: the approved 150 becomes a million.
    await owner.query(
      `update keyturn.changes set after = jsonb_set(after, '{balance}', '1000000') where proposal_id = $1`,
      [proposed.proposal_id],
    );

    expect((await refusal(apply(agent, proposed.proposal_id)))?.message).toContain(
      "not what was approved",
    );
    expect(
      (await owner.query("select balance::text from accounts where id = 5")).rows[0].balance,
    ).toBe("100.00");
  });
});

describe("names and values that are really SQL", () => {
  test.each([
    [
      "a table name",
      { table: "accounts; drop table accounts; --", operation: "delete", key: { id: 1 } },
    ],
    [
      "a table name in quotes",
      { table: 'accounts" where true; --', operation: "delete", key: { id: 1 } },
    ],
    [
      "a column name",
      {
        table: "accounts",
        operation: "update",
        key: { id: 1 },
        set: { "balance = 1000000 where true; --": 1 },
      },
    ],
    [
      "a column name that closes the quote",
      {
        table: "accounts",
        operation: "update",
        key: { id: 1 },
        set: { 'balance" = 1000000, "tenant': "x" },
      },
    ],
    ["a key column", { table: "accounts", operation: "delete", key: { "id = id or true; --": 1 } }],
    [
      "an operation",
      { table: "accounts", operation: "delete; drop table accounts", key: { id: 1 } },
    ],
  ])("%s is taken as a name, found not to exist, and refused", async (_name, change) => {
    expect(await refusal(propose(agent, [change]))).not.toBeNull();
    expect(await balances()).toEqual({ total: "2000.00", rows: 20 });
  });

  test("a value is only ever a value", async () => {
    const hostile = "x'); update accounts set balance = 1000000; --";
    const proposed = await propose(agent, [
      { table: "accounts", operation: "update", key: { id: 6 }, set: { tenant: hostile } },
    ]);
    await alice.query("select keyturn.approve($1, $2)", [
      proposed.proposal_id,
      proposed.content_hash,
    ]);

    expect(await apply(agent, proposed.proposal_id)).toEqual({ status: "applied", changes: 1 });

    expect(
      (await owner.query("select tenant, balance::text from accounts where id = 6")).rows[0],
    ).toEqual({ tenant: hostile, balance: "100.00" });
    expect(
      (await owner.query("select count(*)::int as n from accounts where balance <> 100")).rows[0].n,
    ).toBe(0);
    await owner.query("update accounts set tenant = 'north' where id = 6");
  });
});

describe("reading what it should not see", () => {
  test("a proposal cannot be used to read a table the agent may not read", async () => {
    const attempt = await refusal(
      propose(agent, [
        { table: "salaries", operation: "update", key: { id: 1 }, set: { amount: 1 } },
      ]),
    );

    expect(attempt?.code).toBe(PERMISSION_DENIED);
    expect(attempt?.message).not.toContain("250000");
    expect(
      (
        await owner.query(
          "select count(*)::int as n from keyturn.changes where relation = 'salaries'::regclass",
        )
      ).rows[0].n,
    ).toBe(0);
    // Nor to insert into it, which would say whether a key is taken.
    expect(
      (
        await refusal(
          propose(agent, [
            { table: "salaries", operation: "insert", values: { id: 1, person: "x", amount: 1 } },
          ]),
        )
      )?.code,
    ).toBe(PERMISSION_DENIED);
  });

  test("a proposal cannot be used to read a row that row-level security hides", async () => {
    // The agent can change the row it sees.
    const visible = await propose(agent, [
      { table: "notes", operation: "update", key: { id: 1 }, set: { body: "changed" } },
    ]);
    expect(visible.content_hash).toMatch(/^[0-9a-f]{64}$/);

    // The hidden row is, to the agent, a row that is not there. The answer is the same as for a key that does not exist.
    const hidden = await refusal(
      propose(agent, [
        { table: "notes", operation: "update", key: { id: 2 }, set: { body: "changed" } },
      ]),
    );
    const absent = await refusal(
      propose(agent, [
        { table: "notes", operation: "update", key: { id: 777 }, set: { body: "changed" } },
      ]),
    );
    expect(hidden?.message).toContain("has no row with key");
    expect(hidden?.message.replace("2", "N")).toBe(absent?.message.replace("777", "N"));
    expect(hidden?.message).not.toContain("not visible to the agent");
    expect(
      (
        await owner.query(
          "select count(*)::int as n from keyturn.changes where before ->> 'body' = 'not visible to the agent'",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  test("claiming to have seen a row does not make it so", async () => {
    // The step that records a proposal can be called on its own. It takes a row only if the caller hands over the row that is really there.
    const forged = [
      {
        table: "public.notes",
        operation: "update",
        key: { id: 2 },
        set: { body: "x" },
        seen: { id: 2, tenant: "south", body: "a guess" },
      },
    ];

    const attempt = await refusal(
      agent.query("select * from keyturn.record_proposal($1::jsonb, '', interval '1 day')", [
        JSON.stringify(forged),
      ]),
    );

    expect(attempt?.message).toContain("has no row with key");
    expect(attempt?.message).not.toContain("not visible to the agent");
    // And what propose() is handed as "seen" is thrown away and read again.
    const lied = await refusal(
      propose(agent, [
        {
          table: "notes",
          operation: "update",
          key: { id: 2 },
          set: { body: "x" },
          seen: { id: 2, tenant: "south", body: "not visible to the agent" },
        },
      ]),
    );
    expect(lied?.message).toContain("has no row with key");
  });

  test("one agent cannot read another agent's proposals, and an approver reads them all", async () => {
    const other = await database.as(logins.otherAgent);
    const proposed = await propose(agent, [raise(7, 175)]);
    const count = async (client: pg.Client, table: string, column: string) =>
      (
        await client.query(`select count(*)::int as n from keyturn.${table} where ${column} = $1`, [
          proposed.proposal_id,
        ])
      ).rows[0].n;

    expect([
      await count(agent, "proposals", "id"),
      await count(agent, "changes", "proposal_id"),
    ]).toEqual([1, 1]);
    expect([
      await count(other, "proposals", "id"),
      await count(other, "changes", "proposal_id"),
    ]).toEqual([0, 0]);
    expect([
      await count(alice, "proposals", "id"),
      await count(alice, "changes", "proposal_id"),
    ]).toEqual([1, 1]);
    // A login with no part in Keyturn cannot look at all.
    expect(await code(await database.as(logins.stranger), "select * from keyturn.proposals")).toBe(
      PERMISSION_DENIED,
    );
  });
});

describe("the roles themselves", () => {
  test("an approver cannot propose, so nobody approves what they wrote", async () => {
    expect((await refusal(propose(alice, [raise(8, 1)])))?.code).toBe(PERMISSION_DENIED);
  });

  test("a login that is both agent and approver still cannot approve its own proposal", async () => {
    const admin = await administrator(database);
    const both = `both_${database.name}`;
    await admin.query(
      `create role ${both} login password 'test-only' in role keyturn_agent, keyturn_approver`,
    );
    const client = await database.as(both);
    try {
      const proposed = await propose(client, [raise(9, 5000)]);

      expect(
        (
          await refusal(
            client.query("select keyturn.approve($1, $2)", [
              proposed.proposal_id,
              proposed.content_hash,
            ]),
          )
        )?.code,
      ).toBe(PERMISSION_DENIED);
      expect(
        (await refusal(client.query("select keyturn.reject($1)", [proposed.proposal_id])))?.code,
      ).toBe(PERMISSION_DENIED);
    } finally {
      await client.end();
      await admin.query(`drop role ${both}`);
    }
  });

  test("a login with no part in keyturn can do nothing with it", async () => {
    const stranger = await database.as(logins.stranger);
    const proposed = await propose(agent, [raise(10, 110)]);
    await alice.query("select keyturn.approve($1, $2)", [
      proposed.proposal_id,
      proposed.content_hash,
    ]);

    expect((await refusal(propose(stranger, [raise(10, 1)])))?.code).toBe(PERMISSION_DENIED);
    expect((await refusal(apply(stranger, proposed.proposal_id)))?.code).toBe(PERMISSION_DENIED);
    expect(
      (await owner.query("select balance::text from accounts where id = 10")).rows[0].balance,
    ).toBe("100.00");
  });
});
