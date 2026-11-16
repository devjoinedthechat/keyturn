import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { apply, Database, logins, propose, refusal } from "./database.ts";

const schema = `
  create table orders (
    id          integer primary key,
    customer    text not null,
    status      text not null default 'paid',
    refunded    numeric(10, 2) not null default 0,
    updated_at  timestamptz not null default '2026-01-01T00:00:00Z'
  );
  insert into orders (id, customer) select n, 'customer ' || n from generate_series(1, 50) as n;
  select keyturn.protect('orders');
  -- The agent may read. That is all it is given on the table.
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

const order = async (id: number) =>
  (await owner.query("select * from orders where id = $1", [id])).rows[0];
const refund = (id: number, amount: number) => ({
  table: "orders",
  operation: "update",
  key: { id },
  set: { refunded: amount, status: "refunded" },
});

describe("a proposal", () => {
  test("changes nothing until a different login approves it, and then changes exactly what was approved", async () => {
    const proposed = await propose(agent, [refund(1, 400)], "Customer was charged twice.");

    expect(await order(1)).toMatchObject({ refunded: "0.00", status: "paid" });
    expect((await refusal(apply(agent, proposed.proposal_id)))?.message).toContain(
      "pending, not approved",
    );

    await alice.query("select keyturn.approve($1, $2)", [
      proposed.proposal_id,
      proposed.content_hash,
    ]);
    expect(await order(1)).toMatchObject({ refunded: "0.00", status: "paid" });

    expect(await apply(agent, proposed.proposal_id)).toEqual({ status: "applied", changes: 1 });
    expect(await order(1)).toMatchObject({
      refunded: "400.00",
      status: "refunded",
      customer: "customer 1",
    });
    // The rows the proposal did not name are as they were.
    expect(
      (await owner.query("select count(*)::int as n from orders where refunded <> 0")).rows[0].n,
    ).toBe(1);
  });

  test("records the rows as they were and as they would be", async () => {
    const proposed = await propose(agent, [refund(2, 150)]);

    const changes = (
      await alice.query("select * from keyturn.changes where proposal_id = $1", [
        proposed.proposal_id,
      ])
    ).rows;

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      operation: "update",
      key: { id: 2 },
      columns: ["refunded", "status"],
    });
    expect(changes[0].before).toMatchObject({
      id: 2,
      refunded: 0,
      status: "paid",
      updated_at: "2026-01-01T00:00:00+00:00",
    });
    expect(changes[0].after).toMatchObject({
      id: 2,
      refunded: 150,
      status: "refunded",
      updated_at: "2026-01-01T00:00:00+00:00",
    });
  });

  test("inserts and deletes, and applies several changes together or not at all", async () => {
    const proposed = await propose(agent, [
      { table: "orders", operation: "insert", values: { id: 900, customer: "new customer" } },
      { table: "orders", operation: "delete", key: { id: 50 } },
      refund(49, 10),
    ]);
    await alice.query("select keyturn.approve($1, $2)", [
      proposed.proposal_id,
      proposed.content_hash,
    ]);

    expect(await apply(alice, proposed.proposal_id)).toEqual({ status: "applied", changes: 3 });

    expect(await order(900)).toMatchObject({ customer: "new customer", status: "paid" });
    expect(await order(50)).toBeUndefined();
    expect(await order(49)).toMatchObject({ refunded: "10.00" });
  });

  test("is refused when it is not a change that can be carried out", async () => {
    const message = async (change: unknown) => (await refusal(propose(agent, [change])))?.message;

    expect(await message({ table: "pg_authid", operation: "delete", key: { oid: 10 } })).toContain(
      "not a table under keyturn",
    );
    expect(
      await message({ table: "no_such_table", operation: "delete", key: { id: 1 } }),
    ).toContain("not a table under keyturn");
    expect(
      await message({ table: "orders", operation: "update", key: { id: 3 }, set: { nonsense: 1 } }),
    ).toContain('no column "nonsense"');
    expect(
      await message({
        table: "orders",
        operation: "update",
        key: { id: 9999 },
        set: { status: "x" },
      }),
    ).toContain("no row with key");
    expect(
      await message({ table: "orders", operation: "update", key: { id: 3 }, set: { id: 4 } }),
    ).toContain("primary key is not changed");
    expect(
      await message({
        table: "orders",
        operation: "update",
        key: { customer: "customer 3" },
        set: { status: "x" },
      }),
    ).toContain("exactly the primary key");
    expect(
      await message({
        table: "orders",
        operation: "update",
        key: { id: 3 },
        set: { status: "paid" },
      }),
    ).toContain("already has these values");
    expect(await message({ table: "orders", operation: "truncate" })).toContain('give "operation"');
    expect((await refusal(propose(agent, [])))?.message).toContain("at least one change");
  });
});

describe("an approval", () => {
  test("is for the content the approver names, and for nothing else", async () => {
    const proposed = await propose(agent, [refund(3, 25)]);
    const other = await propose(agent, [refund(4, 9999)]);

    // The hash of another proposal, and a made-up one.
    expect(
      (
        await refusal(
          alice.query("select keyturn.approve($1, $2)", [proposed.proposal_id, other.content_hash]),
        )
      )?.message,
    ).toContain("not the content");
    expect(
      (
        await refusal(
          alice.query("select keyturn.approve($1, $2)", [proposed.proposal_id, "0".repeat(64)]),
        )
      )?.message,
    ).toContain("not the content");
    expect(
      (await refusal(alice.query("select keyturn.approve($1, null)", [proposed.proposal_id])))
        ?.message,
    ).toContain("not the content");

    await alice.query("select keyturn.approve($1, $2)", [
      proposed.proposal_id,
      proposed.content_hash,
    ]);
    // Approved once. It is not approved again, and the other one is still pending.
    expect(
      (
        await refusal(
          alice.query("select keyturn.approve($1, $2)", [
            proposed.proposal_id,
            proposed.content_hash,
          ]),
        )
      )?.message,
    ).toContain("approved, not pending");
    expect((await refusal(apply(agent, other.proposal_id)))?.message).toContain(
      "pending, not approved",
    );
  });

  test("cannot be given by an agent, by the proposer, or by a login with no part in keyturn", async () => {
    const proposed = await propose(agent, [refund(5, 60)]);
    const [otherAgent, stranger] = await Promise.all([
      database.as(logins.otherAgent),
      database.as(logins.stranger),
    ]);
    const approve = (client: pg.Client) =>
      refusal(
        client.query("select keyturn.approve($1, $2)", [
          proposed.proposal_id,
          proposed.content_hash,
        ]),
      );

    // 42501 is "insufficient privilege": the database's own refusal, not an error in the request.
    expect((await approve(agent))?.code).toBe("42501");
    expect((await approve(otherAgent))?.code).toBe("42501");
    expect((await approve(stranger))?.code).toBe("42501");
    expect(
      (await refusal(agent.query("select keyturn.reject($1)", [proposed.proposal_id])))?.code,
    ).toBe("42501");

    expect((await refusal(apply(agent, proposed.proposal_id)))?.message).toContain(
      "pending, not approved",
    );
    expect(await order(5)).toMatchObject({ refunded: "0.00" });
  });

  test("a rejected proposal is never applied", async () => {
    const proposed = await propose(agent, [refund(6, 70)]);

    await alice.query("select keyturn.reject($1, $2)", [
      proposed.proposal_id,
      "Not a duplicate charge.",
    ]);

    expect((await refusal(apply(agent, proposed.proposal_id)))?.message).toContain(
      "rejected, not approved",
    );
    expect(
      (
        await refusal(
          alice.query("select keyturn.approve($1, $2)", [
            proposed.proposal_id,
            proposed.content_hash,
          ]),
        )
      )?.message,
    ).toContain("rejected, not pending");
    expect(await order(6)).toMatchObject({ refunded: "0.00" });
  });
});

describe("applying", () => {
  test("is refused when a row has changed since the proposal was made, and nothing is written", async () => {
    const proposed = await propose(agent, [refund(7, 80), refund(8, 80)]);
    await alice.query("select keyturn.approve($1, $2)", [
      proposed.proposal_id,
      proposed.content_hash,
    ]);
    // Someone else refunds order 8 in the meantime.
    await owner.query("update orders set refunded = 80 where id = 8");

    const outcome = await apply(agent, proposed.proposal_id);

    expect(outcome).toMatchObject({ status: "stale", change: 2 });
    expect(outcome.reason).toContain("has changed since the proposal was made");
    // Neither row was written, the one that had not changed included.
    expect(await order(7)).toMatchObject({ refunded: "0.00", status: "paid" });
    expect(await order(8)).toMatchObject({ refunded: "80.00", status: "paid" });
  });

  test("is refused when the row is gone, or when a row to insert is already there", async () => {
    const gone = await propose(agent, [refund(9, 5)]);
    const taken = await propose(agent, [
      { table: "orders", operation: "insert", values: { id: 901, customer: "late" } },
    ]);
    for (const proposed of [gone, taken]) {
      await alice.query("select keyturn.approve($1, $2)", [
        proposed.proposal_id,
        proposed.content_hash,
      ]);
    }
    await owner.query("delete from orders where id = 9");
    await owner.query("insert into orders (id, customer) values (901, 'early')");

    expect((await apply(agent, gone.proposal_id)).reason).toContain("is gone");
    expect((await apply(agent, taken.proposal_id)).reason).toContain("already has a row");
    expect(await order(901)).toMatchObject({ customer: "early" });
  });

  test("happens once, however often and from however many connections it is asked for", async () => {
    await owner.query("update orders set refunded = 0, status = 'paid' where id = 10");
    const proposed = await propose(agent, [
      { table: "orders", operation: "update", key: { id: 10 }, set: { refunded: 33 } },
    ]);
    await alice.query("select keyturn.approve($1, $2)", [
      proposed.proposal_id,
      proposed.content_hash,
    ]);
    const connections = await Promise.all(
      Array.from({ length: 8 }, (_, index) => database.as(index % 2 ? logins.agent : logins.bob)),
    );

    const outcomes = await Promise.all(
      connections.map((connection) => apply(connection, proposed.proposal_id)),
    );

    // Every caller is told the same thing, and the row was written once.
    expect(new Set(outcomes.map((outcome) => JSON.stringify(outcome)))).toEqual(
      new Set([JSON.stringify({ status: "applied", changes: 1 })]),
    );
    expect(await order(10)).toMatchObject({ refunded: "33.00" });
    // Asked again later, it answers the same and writes nothing: the row has moved on and stays so.
    await owner.query("update orders set refunded = 34 where id = 10");
    expect(await apply(agent, proposed.proposal_id)).toEqual({ status: "applied", changes: 1 });
    expect(await order(10)).toMatchObject({ refunded: "34.00" });
  });

  test("is refused once the proposal has expired", async () => {
    const result = await agent.query(
      "select * from keyturn.propose($1::jsonb, '', interval '1 second')",
      [JSON.stringify([refund(11, 1)])],
    );
    const proposed = result.rows[0];
    await alice.query("select keyturn.approve($1, $2)", [
      proposed.proposal_id,
      proposed.content_hash,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect((await refusal(apply(agent, proposed.proposal_id)))?.message).toContain("expired");
    expect(await order(11)).toMatchObject({ refunded: "0.00" });
  });
});
