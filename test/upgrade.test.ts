import { readdir, readFile } from "node:fs/promises";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { installed, Keyturn, upgrade, version } from "../src/index.ts";
import { Database, logins, refusal } from "./database.ts";

/**
 * A database is given Keyturn as it was at version 0.1.0, from the SQL of that version kept
 * in fixtures, and is used: proposals in every state, a rule, a table dropped. Then it is
 * moved to this version, and everything has to be there, and work.
 */

const old = new URL("./fixtures/sql-0.1.0/", import.meta.url);

async function asItWas(): Promise<{ database: Database; owner: pg.Client }> {
  const database = await Database.bare();
  const owner = await database.as(logins.owner);
  for (const file of (await readdir(old)).filter((name) => name.endsWith(".sql")).sort()) {
    await owner.query(await readFile(new URL(file, old), "utf8"));
  }
  await owner.query("comment on schema keyturn is 'keyturn 0.1.0'");
  await owner.query(`
    create table orders (id integer primary key, customer text not null, total numeric(10, 2) not null, status text not null default 'paid');
    create table remarks (id serial primary key, order_id integer not null, body text not null);
    create table scrap (id integer primary key, body text);
    insert into orders select n, 'customer ' || n, 20 + n from generate_series(1, 100) as n;
    insert into scrap values (1, 'x');
    select keyturn.protect('orders');
    select keyturn.protect('remarks', false);
    select keyturn.protect('scrap');
    grant select on orders, remarks, scrap to keyturn_agent, keyturn_approver;
    select keyturn.allow('hold_orders', 'orders', array['update'], array['status'], condition => 'after ->> ''status'' = ''held''');
  `);
  return { database, owner };
}

const propose = async (client: pg.Client, changes: unknown[], note = "") =>
  (
    await client.query("select * from keyturn.propose($1::jsonb, $2)", [
      JSON.stringify(changes),
      note,
    ])
  ).rows[0] as { proposal_id: string; content_hash: string };
const update = (id: number, set: Record<string, unknown>) => ({
  table: "orders",
  operation: "update",
  key: { id },
  set,
});

describe("moving from 0.1.0 to this version", () => {
  let database: Database;
  let owner: pg.Client;
  let agent: pg.Client;
  let alice: pg.Client;
  const made: Record<string, string> = {};
  let before: {
    head: { entries: string; head: string };
    proposals: unknown[];
    changes: unknown[];
    audit: unknown[];
  };

  const snapshot = async () => ({
    head: (await owner.query("select entries::text, head from keyturn.audit_head()")).rows[0],
    proposals: (
      await owner.query(
        "select id, proposed_by::text, note, content_hash, status, proposed_at, expires_at, decided_by::text, decided_at, reason, finished_at, outcome from keyturn.proposals order by id",
      )
    ).rows,
    changes: (
      await owner.query(
        "select proposal_id, seq, relation::oid::text, relation_name, shape, operation, key, before, after, columns from keyturn.changes order by proposal_id, seq",
      )
    ).rows,
    audit: (
      await owner.query(
        "select seq::text, proposal_id, at, actor::text, event, detail, prev_hash, hash from keyturn.audit order by seq",
      )
    ).rows,
  });

  beforeAll(async () => {
    ({ database, owner } = await asItWas());
    [agent, alice] = await Promise.all([database.as(logins.agent), database.as(logins.alice)]);
    const approve = (proposal: { proposal_id: string; content_hash: string }) =>
      alice.query("select keyturn.approve($1, $2)", [proposal.proposal_id, proposal.content_hash]);

    const applied = await propose(
      agent,
      [update(1, { total: 0, status: "refunded" })],
      "Refund order 1.",
    );
    await approve(applied);
    await agent.query("select keyturn.apply($1)", [applied.proposal_id]);
    made.applied = applied.proposal_id;

    const rejected = await propose(agent, [
      { table: "orders", operation: "delete", key: { id: 2 } },
    ]);
    await alice.query("select keyturn.reject($1, $2)", [rejected.proposal_id, "Not a duplicate."]);
    made.rejected = rejected.proposal_id;

    const approved = await propose(agent, [update(3, { total: 5 })], "Discount order 3.");
    await approve(approved);
    made.approved = approved.proposal_id;

    made.waiting = (
      await propose(agent, [update(4, { total: 7 })], "Discount order 4.")
    ).proposal_id;

    await agent.query("begin");
    await agent.query("select keyturn.note('Two remarks through the view.')");
    await agent.query(
      "insert into proposal.remarks (order_id, body) values (5, 'called'), (5, 'called again')",
    );
    made.viaView = (await agent.query("select * from keyturn.proposed()")).rows[0].proposal_id;
    await agent.query("commit");

    const stale = await propose(agent, [update(6, { total: 9 })]);
    await approve(stale);
    await owner.query("update orders set customer = 'renamed' where id = 6");
    await agent.query("select keyturn.apply($1)", [stale.proposal_id]);
    made.stale = stale.proposal_id;

    const byRule = await propose(agent, [update(7, { status: "held" })]);
    await agent.query("select keyturn.apply($1)", [byRule.proposal_id]);
    made.byRule = byRule.proposal_id;

    made.forDropped = (
      await propose(agent, [{ table: "scrap", operation: "delete", key: { id: 1 } }])
    ).proposal_id;
    await owner.query("drop table scrap cascade");

    before = await snapshot();
  });

  afterAll(async () => {
    await database.close();
  });

  test("keeps every proposal, every change and the audit log exactly, and says where it moved from", async () => {
    expect(await installed(owner)).toBe("0.1.0");
    expect(before.proposals).toHaveLength(8);

    const moved = await upgrade(owner);
    expect(moved).toEqual({ from: "0.1.0", to: await version() });
    expect(await installed(owner)).toBe(await version());

    const after = await snapshot();
    expect(after.head).toEqual(before.head);
    expect(after.proposals).toEqual(before.proposals);
    expect(after.changes).toEqual(before.changes);
    expect(after.audit).toEqual(before.audit);
    expect((await alice.query("select * from keyturn.verify_audit()")).rows).toEqual([]);
    expect((await owner.query("select name, version from keyturn.rules")).rows).toEqual([
      { name: "hold_orders", version: 1 },
    ]);
  });

  test("leaves the tables under it, the agent with no way round, and the views in place", async () => {
    expect((await refusal(agent.query("update orders set total = 0 where id = 50")))?.code).toBe(
      "42501",
    );
    expect(
      (
        await owner.query(
          "select relation::regclass::text as name, exact from keyturn.protected order by 1",
        )
      ).rows,
    ).toEqual([
      { name: "orders", exact: true },
      { name: "remarks", exact: false },
    ]);
    await agent.query("update proposal.orders set status = 'held' where id = 51");
    const failures = (
      await owner.query("select about, finding from keyturn.doctor() where level = 'fail'")
    ).rows.filter((row) => !/^(wrong|both)_/.test(row.about));
    expect(failures).toEqual([]);
  });

  test("lets what was waiting be decided and applied, and what was applied be taken back", async () => {
    const keyturn = new Keyturn(alice);
    const waiting = await keyturn.proposal(made.waiting as string);
    await keyturn.approve(made.waiting as string, waiting?.contentHash ?? "");
    expect((await new Keyturn(agent).apply(made.waiting as string)).status).toBe("applied");
    expect((await new Keyturn(agent).apply(made.approved as string)).status).toBe("applied");
    expect(
      (await owner.query("select total from orders where id in (3, 4) order by id")).rows,
    ).toEqual([{ total: "5.00" }, { total: "7.00" }]);

    const viaView = await keyturn.proposal(made.viaView as string);
    await keyturn.approve(made.viaView as string, viaView?.contentHash ?? "");
    expect((await new Keyturn(agent).apply(made.viaView as string)).changes).toBe(2);

    // Something this version has and that one did not, on a change that one applied.
    expect(await keyturn.revert(made.applied as string, "Wrong order.")).toMatchObject({
      status: "reverted",
    });
    expect((await owner.query("select total, status from orders where id = 1")).rows[0]).toEqual({
      total: "21.00",
      status: "paid",
    });
    // The proposal for the table that is gone is still on record, and says so.
    await keyturn.approve(
      made.forDropped as string,
      (await keyturn.proposal(made.forDropped as string))?.contentHash ?? "",
    );
    expect(await new Keyturn(agent).apply(made.forDropped as string)).toMatchObject({
      status: "stale",
    });
    expect((await alice.query("select * from keyturn.verify_audit()")).rows).toEqual([]);
  });

  test("is refused when there is nothing to move to", async () => {
    expect((await refusal(upgrade(owner)))?.message).toContain("is what this database already has");
    await owner.query("comment on schema keyturn is 'keyturn 99.0.0'");
    expect((await refusal(upgrade(owner)))?.message).toContain("is later than this program's");
    await owner.query(`comment on schema keyturn is 'keyturn ${await version()}'`);
  });
});

describe("a move that cannot be finished", () => {
  test("changes nothing", async () => {
    const { database, owner } = await asItWas();
    const agent = await database.as(logins.agent);
    await propose(agent, [update(1, { total: 0 })], "Still here afterwards.");
    // A table that can no longer be put under keyturn: its key is gone.
    await owner.query("alter table orders drop constraint orders_pkey");
    const head = (await owner.query("select entries::text, head from keyturn.audit_head()"))
      .rows[0];

    expect(await refusal(upgrade(owner))).not.toBeNull();
    expect(await installed(owner)).toBe("0.1.0");
    expect(
      (await owner.query("select entries::text, head from keyturn.audit_head()")).rows[0],
    ).toEqual(head);
    expect((await owner.query("select note from keyturn.proposals")).rows).toEqual([
      { note: "Still here afterwards." },
    ]);
    expect((await owner.query("select count(*)::int as n from keyturn.protected")).rows[0].n).toBe(
      3,
    );
    await database.close();
  });
});
