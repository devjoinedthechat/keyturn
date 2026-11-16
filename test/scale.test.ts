import type pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Database, logins } from "./database.ts";

// The largest proposal Keyturn takes, made both ways. Each row once cost a look at every row
// before it: ten thousand rows took most of a minute. The limits here are several times what
// it takes when the cost of a row does not grow, and far below what it took when it did.

const schema = `
  create table orders (id integer primary key, customer text not null, total numeric(10, 2) not null, status text not null default 'paid');
  insert into orders select n, 'customer ' || n, 20 + n % 500 from generate_series(1, 30000) as n;
  select keyturn.protect('orders');
  grant select on orders to keyturn_agent, keyturn_approver;
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

const left = async () =>
  (await owner.query("select count(*)::int as n from orders")).rows[0].n as number;
const within = async (limit: number, work: () => Promise<unknown>) => {
  const from = performance.now();
  await work();
  expect(performance.now() - from).toBeLessThan(limit);
};

test("ten thousand rows through a view are proposed, approved and applied in seconds", async () => {
  let made = { proposal_id: "", content_hash: "", changes: "" };
  await within(15_000, async () => {
    await agent.query("begin");
    await agent.query("delete from proposal.orders where id <= 10000");
    made = (await agent.query("select * from keyturn.proposed()")).rows[0];
    await agent.query("commit");
  });
  expect(made.changes).toBe("10000");
  expect(await left()).toBe(30000);

  await within(5_000, () =>
    alice.query("select keyturn.approve($1, $2)", [made.proposal_id, made.content_hash]),
  );
  await within(15_000, async () => {
    const outcome = (await agent.query("select keyturn.apply($1) as outcome", [made.proposal_id]))
      .rows[0].outcome;
    expect(outcome).toEqual({ status: "applied", changes: 10000 });
  });
  expect(await left()).toBe(20000);
});

test("ten thousand rows given to the function are proposed in seconds, and one more is refused", async () => {
  const changes = Array.from({ length: 10000 }, (_, index) => ({
    table: "orders",
    operation: "update",
    key: { id: 10001 + index },
    set: { status: "archived" },
  }));
  await within(20_000, () =>
    agent.query("select * from keyturn.propose($1::jsonb, 'Archive.')", [JSON.stringify(changes)]),
  );

  const tooMany = [...changes, { table: "orders", operation: "delete", key: { id: 20001 } }];
  await expect(
    agent.query("select * from keyturn.propose($1::jsonb, 'x')", [JSON.stringify(tooMany)]),
  ).rejects.toThrow("at most 10000 changes");
  await agent.query("begin");
  await expect(agent.query("delete from proposal.orders where id > 10000")).rejects.toThrow(
    "at most 10000 changes",
  );
  await agent.query("rollback");
  expect(await left()).toBe(20000);
});

test("a statement through a view that names one row reads one row, not the table", async () => {
  const plan = (
    await agent.query(
      "explain (format json) update proposal.orders set status = 'x' where id = 25000",
    )
  ).rows[0]["QUERY PLAN"];
  const text = JSON.stringify(plan);
  expect(text).toContain("Index Scan");
  expect(text).not.toContain("Seq Scan");
});
