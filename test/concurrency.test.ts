import type pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { administrator, apply, Database, logins, propose, refusal } from "./database.ts";

// Several real connections at once. Each test holds one of them part-way through a
// transaction, so the order of events is fixed and not left to chance.

const schema = `
  create table stock (id integer primary key, quantity integer not null check (quantity >= 0));
  insert into stock select n, 100 from generate_series(1, 20) as n;
  select keyturn.protect('stock');
  grant select on stock to keyturn_agent, keyturn_approver;
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
  // Only an administrator sees what another login's connection is waiting for, or may cut it off.
  admin = await administrator(database);
});

afterAll(async () => {
  await database.close();
});

const take = (id: number, quantity: number) => ({
  table: "stock",
  operation: "update",
  key: { id },
  set: { quantity },
});
const approved = async (changes: unknown[]) => {
  const proposed = await propose(agent, changes);
  await alice.query("select keyturn.approve($1, $2)", [
    proposed.proposal_id,
    proposed.content_hash,
  ]);
  return proposed;
};
const quantity = async (id: number) =>
  (await owner.query("select quantity from stock where id = $1", [id])).rows[0].quantity;
/** True once the connection is waiting for a lock another transaction holds. */
async function waiting(client: pg.Client): Promise<void> {
  const pid = (client as unknown as { processID: number }).processID;
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = (
      await admin.query("select wait_event_type from pg_stat_activity where pid = $1", [pid])
    ).rows[0];
    if (state?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The connection never waited for a lock.");
}

test("a row being changed by someone else is waited for, and then the proposal is stale", async () => {
  const proposed = await approved([take(1, 90)]);
  const other = await database.as(logins.owner);
  const applier = await database.as(logins.agent);
  await other.query("begin; update stock set quantity = 50 where id = 1");

  // The apply cannot know yet whether that change will stand, so it waits.
  const applying = apply(applier, proposed.proposal_id);
  await waiting(applier);
  await other.query("commit");

  expect(await applying).toMatchObject({ status: "stale" });
  expect(await quantity(1)).toBe(50);
});

test("if that other change is undone, the proposal applies", async () => {
  const proposed = await approved([take(2, 90)]);
  const other = await database.as(logins.owner);
  const applier = await database.as(logins.agent);
  await other.query("begin; update stock set quantity = 50 where id = 2");

  const applying = apply(applier, proposed.proposal_id);
  await waiting(applier);
  await other.query("rollback");

  expect(await applying).toEqual({ status: "applied", changes: 1 });
  expect(await quantity(2)).toBe(90);
});

test("an apply that is cut off before it commits leaves nothing behind and can be done again", async () => {
  const proposed = await approved([take(3, 80), take(4, 80)]);
  const dying = await database.as(logins.agent);

  // Everything is written and the function has returned, and then the connection is lost.
  await dying.query("begin");
  expect(
    (await dying.query("select keyturn.apply($1) as outcome", [proposed.proposal_id])).rows[0]
      .outcome,
  ).toEqual({ status: "applied", changes: 2 });
  // Listening before the cut: the lost connection reports its end, sometimes more than once, and each report is expected.
  const lost = new Promise((resolve) => dying.on("error", resolve));
  await admin.query("select pg_terminate_backend($1)", [
    (dying as unknown as { processID: number }).processID,
  ]);
  await lost;

  expect([await quantity(3), await quantity(4)]).toEqual([100, 100]);
  expect(
    (
      await owner.query("select status from keyturn.proposals where id = $1", [
        proposed.proposal_id,
      ])
    ).rows[0].status,
  ).toBe("approved");
  // Nothing was half done, so doing it again is doing it for the first time.
  expect(await apply(agent, proposed.proposal_id)).toEqual({ status: "applied", changes: 2 });
  expect([await quantity(3), await quantity(4)]).toEqual([80, 80]);
});

test("two proposals for the same row: the first to be applied wins and the second is stale", async () => {
  const first = await approved([take(5, 70)]);
  const second = await approved([take(5, 60)]);
  const connections = await Promise.all([database.as(logins.agent), database.as(logins.bob)]);

  const outcomes = await Promise.all([
    apply(connections[0] as pg.Client, first.proposal_id),
    apply(connections[1] as pg.Client, second.proposal_id),
  ]);

  expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["applied", "stale"]);
  expect([70, 60]).toContain(await quantity(5));
  // Whichever lost was approved against a row that no longer exists, and stays unapplied.
  expect(await quantity(5)).toBe(outcomes[0]?.status === "applied" ? 70 : 60);
});

test("approving and rejecting at the same moment: one decision is made, not two", async () => {
  const proposed = await propose(agent, [take(6, 10)]);
  const bob = await database.as(logins.bob);

  const decisions = await Promise.all([
    refusal(
      alice.query("select keyturn.approve($1, $2)", [proposed.proposal_id, proposed.content_hash]),
    ),
    refusal(bob.query("select keyturn.reject($1, 'no')", [proposed.proposal_id])),
  ]);

  expect(decisions.filter((decision) => decision === null)).toHaveLength(1);
  const row = (
    await owner.query("select status, decided_by from keyturn.proposals where id = $1", [
      proposed.proposal_id,
    ])
  ).rows[0];
  expect(["approved", "rejected"]).toContain(row.status);
  expect(row.decided_by).toBe(row.status === "approved" ? logins.alice : logins.bob);
});

test("many proposals applied at once touch only their own rows", async () => {
  const proposals = await Promise.all(
    Array.from({ length: 10 }, (_, index) => approved([take(index + 10, index)])),
  );
  const connections = await Promise.all(proposals.map(() => database.as(logins.agent)));

  const outcomes = await Promise.all(
    proposals.map((proposed, index) =>
      apply(connections[index] as pg.Client, proposed.proposal_id),
    ),
  );

  expect(outcomes.every((outcome) => outcome.status === "applied")).toBe(true);
  const rows = (
    await owner.query("select id, quantity from stock where id between 10 and 19 order by id")
  ).rows;
  expect(rows).toEqual(
    Array.from({ length: 10 }, (_, index) => ({ id: index + 10, quantity: index })),
  );
});
