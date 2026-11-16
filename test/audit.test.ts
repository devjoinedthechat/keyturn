import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { administrator, apply, Database, logins, propose, refusal } from "./database.ts";

const schema = `
  create table orders (
    id        integer primary key,
    customer  text not null,
    status    text not null default 'paid',
    refunded  numeric(10, 2) not null default 0
  );
  insert into orders (id, customer) select n, 'customer ' || n from generate_series(1, 60) as n;
  select keyturn.protect('orders');
  grant select on orders to keyturn_agent, keyturn_approver;

  create table scratch (id integer primary key, body text not null);
  insert into scratch values (1, 'one'), (2, 'two');
  select keyturn.protect('scratch');
  grant select on scratch to keyturn_agent, keyturn_approver;
`;

let database: Database;
let owner: pg.Client;
let agent: pg.Client;
let otherAgent: pg.Client;
let alice: pg.Client;
let admin: pg.Client;

beforeAll(async () => {
  database = await Database.create(schema);
  [owner, agent, otherAgent, alice] = await Promise.all([
    database.as(logins.owner),
    database.as(logins.agent),
    database.as(logins.otherAgent),
    database.as(logins.alice),
  ]);
  admin = await administrator(database);
});

afterAll(async () => {
  await database.close();
});

const refund = (id: number, amount: number) => ({
  table: "orders",
  operation: "update",
  key: { id },
  set: { refunded: amount },
});
const entries = async (proposal: string) =>
  (
    await owner.query(
      "select event, actor, detail, prev_hash, hash from keyturn.audit where proposal_id = $1 order by seq",
      [proposal],
    )
  ).rows;
const problems = async (client: pg.Client = owner) =>
  (await client.query("select * from keyturn.verify_audit()")).rows;
const approve = (proposed: { proposal_id: string; content_hash: string }) =>
  alice.query("select keyturn.approve($1, $2)", [proposed.proposal_id, proposed.content_hash]);

describe("the audit log", () => {
  test("has an entry for each thing that happens to a proposal, by the login that did it, each following the one before", async () => {
    const proposed = await propose(agent, [refund(1, 25)]);
    await approve(proposed);
    await apply(agent, proposed.proposal_id);

    const log = await entries(proposed.proposal_id);
    expect(log.map((entry) => [entry.event, entry.actor])).toEqual([
      ["opened", logins.agent],
      ["approved", logins.alice],
      ["applied", logins.agent],
    ]);
    expect(log[0].prev_hash).toBe("");
    expect(log[1].prev_hash).toBe(log[0].hash);
    expect(log[2].prev_hash).toBe(log[1].hash);
    expect(log[1].detail).toEqual({ content_hash: proposed.content_hash });
    expect(log[2].detail).toMatchObject({ status: "applied", changes: 1 });
    expect(await problems()).toEqual([]);
  });

  test("records a rejection, a proposal gone stale, and one made through a view", async () => {
    const rejected = await propose(agent, [refund(2, 5)]);
    await alice.query("select keyturn.reject($1, $2)", [rejected.proposal_id, "Not owed."]);

    const stale = await propose(agent, [refund(3, 5)]);
    await approve(stale);
    await owner.query("update orders set status = 'shipped' where id = 3");
    expect((await apply(agent, stale.proposal_id)).status).toBe("stale");

    await agent.query("begin");
    await agent.query("update proposal.orders set refunded = 7 where id = 4");
    const viewed = (await agent.query("select proposal_id from keyturn.proposed()")).rows[0]
      .proposal_id;
    await agent.query("commit");

    expect((await entries(rejected.proposal_id)).map((entry) => entry.event)).toEqual([
      "opened",
      "rejected",
    ]);
    expect((await entries(rejected.proposal_id))[1].detail).toEqual({ reason: "Not owed." });
    expect((await entries(stale.proposal_id)).map((entry) => entry.event)).toEqual([
      "opened",
      "approved",
      "stale",
    ]);
    expect((await entries(viewed)).map((entry) => entry.event)).toEqual(["opened"]);
    expect(await problems()).toEqual([]);
  });

  test("keeps no entry for a proposal that was rolled back", async () => {
    const before = (await owner.query("select count(*) from keyturn.audit")).rows[0].count;
    await agent.query("begin");
    await propose(agent, [refund(5, 5)]);
    await agent.query("rollback");
    expect((await owner.query("select count(*) from keyturn.audit")).rows[0].count).toBe(before);
  });

  test("shows an agent its own entries, an approver all of them, and another agent none", async () => {
    const proposed = await propose(agent, [refund(6, 5)]);
    const seen = (client: pg.Client) =>
      client
        .query("select count(*)::int as n from keyturn.audit where proposal_id = $1", [
          proposed.proposal_id,
        ])
        .then((result) => result.rows[0].n);
    expect(await seen(agent)).toBe(1);
    expect(await seen(alice)).toBe(1);
    expect(await seen(otherAgent)).toBe(0);
  });

  test("cannot be written, changed or emptied by an agent or an approver", async () => {
    for (const client of [agent, alice]) {
      for (const statement of [
        "insert into keyturn.audit (proposal_id, event, prev_hash, hash) values (gen_random_uuid(), 'approved', '', '')",
        "update keyturn.audit set event = 'approved'",
        "delete from keyturn.audit",
        "truncate keyturn.audit",
        "select keyturn.audit_append(gen_random_uuid(), 'approved', '{}')",
        "alter table keyturn.audit disable trigger all",
      ]) {
        expect((await refusal(client.query(statement)))?.code, statement).toBe("42501");
      }
    }
  });

  test("refuses a change or a removal even from the tables' owner", async () => {
    for (const statement of [
      "update keyturn.audit set event = 'approved'",
      "delete from keyturn.audit",
      "truncate keyturn.audit",
    ]) {
      expect((await refusal(owner.query(statement)))?.message, statement).toContain(
        "never changed or emptied",
      );
    }
  });

  test("may be checked by an approver, and not by an agent", async () => {
    expect(await problems(alice)).toEqual([]);
    expect((await refusal(problems(agent)))?.code).toBe("42501");
    expect((await alice.query("select * from keyturn.audit_head()")).rows[0].head).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

// What someone who can switch the guards off leaves behind. Each is done and then undone.
describe("an audit log that was tampered with", () => {
  let proposal: string;
  let head: string;

  beforeAll(async () => {
    const proposed = await propose(agent, [refund(10, 5)]);
    await approve(proposed);
    await apply(agent, proposed.proposal_id);
    proposal = proposed.proposal_id;
    head = (await owner.query("select head from keyturn.audit_head()")).rows[0].head;
  });

  const tampered = async (statement: string) => {
    await admin.query("begin");
    try {
      await admin.query("set local session_replication_role = replica");
      await admin.query(statement, [proposal]);
      await admin.query("set local session_replication_role = origin");
      return {
        problems: (
          await admin.query("select problem from keyturn.verify_audit() where proposal_id = $1", [
            proposal,
          ])
        ).rows.map((row) => row.problem as string),
        head: (await admin.query("select head from keyturn.audit_head()")).rows[0].head as string,
        doctor: (
          await admin.query(
            "select finding from keyturn.doctor() where about = 'keyturn.audit' and level = 'fail'",
          )
        ).rows.map((row) => row.finding as string),
      };
    } finally {
      await admin.query("rollback");
    }
  };

  test("shows an entry whose content was changed", async () => {
    const after = await tampered(
      `update keyturn.audit set actor = 'alice_was_never_here' where proposal_id = $1 and event = 'approved'`,
    );
    expect(after.problems).toEqual([expect.stringContaining("has been changed")]);
    expect(after.doctor).toEqual([expect.stringContaining("does not hold together")]);
  });

  test("shows an entry that was removed from the middle", async () => {
    const after = await tampered(
      `delete from keyturn.audit where proposal_id = $1 and event = 'approved'`,
    );
    expect(after.problems).toEqual([expect.stringContaining("does not follow")]);
    expect(after.head).not.toBe(head);
  });

  test("shows a last entry that was removed, because the proposal no longer matches", async () => {
    const after = await tampered(
      `delete from keyturn.audit where proposal_id = $1 and event = 'applied'`,
    );
    expect(after.problems).toEqual(["the proposal is applied and its last entry says approved"]);
  });

  test("shows a proposal that was moved on with no entry", async () => {
    const waiting = await propose(agent, [refund(11, 5)]);
    proposal = waiting.proposal_id;
    const after = await tampered(
      `update keyturn.proposals set status = 'approved', decided_by = 'alice', decided_at = now(), content_hash = 'x' where id = $1`,
    );
    expect(after.problems).toEqual(["the proposal is approved and its last entry says opened"]);
  });

  test("shows a whole proposal's entries removed, by the value kept for the whole log", async () => {
    const current = (await owner.query("select head from keyturn.audit_head()")).rows[0].head;
    const after = await tampered(`delete from keyturn.audit where proposal_id = $1`);
    expect(after.head).not.toBe(current);
    expect(after.problems).toEqual([expect.stringContaining("its last entry says nothing")]);
  });

  test("is reported by the doctor when its guards are switched off", async () => {
    await admin.query("begin");
    await admin.query("alter table keyturn.audit disable trigger audit_is_append_only");
    const findings = (
      await admin.query("select finding from keyturn.doctor() where about = 'keyturn.audit'")
    ).rows;
    await admin.query("rollback");
    expect(findings).toEqual([{ finding: expect.stringContaining("can be changed or emptied") }]);
    expect(await problems()).toEqual([]);
  });
});

describe("a table taken out from under keyturn", () => {
  test("closes its waiting proposals with an entry, and takes its rules with it", async () => {
    await owner.query(
      "select keyturn.allow('scratch_body', 'scratch', array['update'], array['body'])",
    );
    const proposed = await propose(agent, [
      { table: "scratch", operation: "delete", key: { id: 2 } },
    ]);
    await owner.query("select keyturn.unprotect('scratch')");
    expect((await entries(proposed.proposal_id)).map((entry) => entry.event)).toEqual([
      "opened",
      "stale",
    ]);
    expect((await owner.query("select from keyturn.rules")).rowCount).toBe(0);
    expect(await problems()).toEqual([]);
  });
});
