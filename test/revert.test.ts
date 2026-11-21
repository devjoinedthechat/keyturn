import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { apply, Database, logins, propose, refusal } from "./database.ts";

const schema = `
  create table orders (id integer primary key, customer text not null, total numeric(10, 2) not null, status text not null default 'paid');
  create table remarks (id serial primary key, order_id integer not null references orders (id), body text not null, made timestamptz not null default now());
  create table tags (id integer generated always as identity primary key, label text not null);
  insert into orders select n, 'customer ' || n, 20 + n from generate_series(1, 400) as n;
  insert into tags (label) select 'tag ' || n from generate_series(1, 50) as n;
  select keyturn.protect('orders');
  select keyturn.protect('remarks');
  select keyturn.protect('tags');
  grant select on orders, remarks, tags to keyturn_agent, keyturn_approver;
`;

let database: Database;
let owner: pg.Client;
let agent: pg.Client;
let alice: pg.Client;
let bob: pg.Client;
let next = 0;

beforeAll(async () => {
  database = await Database.create(schema);
  [owner, agent, alice, bob] = await Promise.all([
    database.as(logins.owner),
    database.as(logins.agent),
    database.as(logins.alice),
    database.as(logins.bob),
  ]);
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await owner.query("delete from keyturn.forbidden");
});

const fresh = () => {
  next += 1;
  return next;
};
const order = async (id: number) =>
  (await owner.query("select * from orders where id = $1", [id])).rows[0];
/** Proposes as the agent, approves as alice, applies. */
async function applied(changes: unknown[]): Promise<string> {
  const made = await propose(agent, changes);
  await alice.query("select keyturn.approve($1, $2)", [made.proposal_id, made.content_hash]);
  expect((await apply(agent, made.proposal_id)).status).toBe("applied");
  return made.proposal_id;
}
const revert = async (client: pg.Client, proposal: string, reason?: string) =>
  (await client.query("select keyturn.revert($1, $2) as outcome", [proposal, reason ?? null]))
    .rows[0].outcome as { status: string; changes?: number; change?: number; reason?: string };
const status = async (proposal: string) =>
  (await owner.query("select status from keyturn.proposals where id = $1", [proposal])).rows[0]
    .status as string;

describe("taking an applied change back", () => {
  test("gives an updated row its old values, and says so in the record", async () => {
    const id = fresh();
    const before = await order(id);
    const proposal = await applied([
      { table: "orders", operation: "update", key: { id }, set: { total: 0, status: "refunded" } },
    ]);
    expect((await order(id)).status).toBe("refunded");

    expect(await revert(alice, proposal, "Refunded the wrong order.")).toEqual({
      status: "reverted",
      changes: 1,
      reason: "Refunded the wrong order.",
    });
    expect(await order(id)).toEqual(before);
    expect(await status(proposal)).toBe("reverted");
    const steps = await owner.query(
      "select event, actor::text from keyturn.audit where proposal_id = $1 order by seq",
      [proposal],
    );
    expect(steps.rows.at(-1)).toEqual({ event: "reverted", actor: logins.alice });
    expect((await alice.query("select * from keyturn.verify_audit()")).rows).toEqual([]);
  });

  test("removes an inserted row whose key the table made, and puts a deleted row back as it was", async () => {
    const id = fresh();
    const inserted = await applied([
      { table: "remarks", operation: "insert", values: { order_id: id, body: "Called back." } },
    ]);
    expect(
      (await owner.query("select count(*)::int as n from remarks where order_id = $1", [id]))
        .rows[0].n,
    ).toBe(1);
    expect((await revert(alice, inserted)).status).toBe("reverted");
    expect(
      (await owner.query("select count(*)::int as n from remarks where order_id = $1", [id]))
        .rows[0].n,
    ).toBe(0);

    // A key the table always makes itself comes back the same.
    const tag = (await owner.query("select * from tags where id = 7")).rows[0];
    const deleted = await applied([{ table: "tags", operation: "delete", key: { id: 7 } }]);
    expect((await owner.query("select count(*)::int as n from tags where id = 7")).rows[0].n).toBe(
      0,
    );
    expect((await revert(alice, deleted)).status).toBe("reverted");
    expect((await owner.query("select * from tags where id = 7")).rows[0]).toEqual(tag);
  });

  test("takes back every change of a proposal, or none", async () => {
    const [first, second, third] = [fresh(), fresh(), fresh()];
    const before = [await order(first), await order(second), await order(third)];
    const proposal = await applied([
      { table: "orders", operation: "update", key: { id: first }, set: { status: "held" } },
      { table: "orders", operation: "delete", key: { id: second } },
      { table: "orders", operation: "update", key: { id: third }, set: { total: 1 } },
    ]);
    // Somebody writes to the third row afterwards.
    await owner.query("update orders set customer = 'renamed' where id = $1", [third]);

    const outcome = await revert(alice, proposal);
    expect(outcome).toMatchObject({ status: "conflict", change: 3 });
    expect(outcome.reason).toContain("has changed since the change was applied");
    expect((await order(first)).status).toBe("held");
    expect(await order(second)).toBeUndefined();
    expect(await status(proposal)).toBe("applied");

    // With the row as the proposal left it, all three go back.
    await owner.query("update orders set customer = $2 where id = $1", [third, before[2].customer]);
    expect(await revert(alice, proposal)).toEqual({ status: "reverted", changes: 3 });
    expect([await order(first), await order(second), await order(third)]).toEqual(before);
  });

  test("does not put a deleted row back over one that has taken its key", async () => {
    const id = fresh();
    const proposal = await applied([{ table: "orders", operation: "delete", key: { id } }]);
    await owner.query("insert into orders values ($1, 'someone else', 5, 'paid')", [id]);
    const outcome = await revert(alice, proposal);
    expect(outcome.status).toBe("conflict");
    expect(outcome.reason).toContain("has a row with key");
    expect((await order(id)).customer).toBe("someone else");
  });

  test("is for an approver, and only for a proposal that was applied", async () => {
    const id = fresh();
    const proposal = await applied([
      { table: "orders", operation: "update", key: { id }, set: { status: "held" } },
    ]);
    expect((await refusal(agent.query("select keyturn.revert($1)", [proposal])))?.code).toBe(
      "42501",
    );
    expect((await order(id)).status).toBe("held");

    const waiting = await propose(agent, [
      { table: "orders", operation: "update", key: { id: fresh() }, set: { status: "held" } },
    ]);
    expect(
      (await refusal(alice.query("select keyturn.revert($1)", [waiting.proposal_id])))?.message,
    ).toContain("is pending, not applied: there is nothing to take back");
  });

  test("happens once: asked again it gives the same answer, and the change is not applied again", async () => {
    const id = fresh();
    const proposal = await applied([
      { table: "orders", operation: "update", key: { id }, set: { status: "held" } },
    ]);
    const [one, two] = await Promise.all([revert(alice, proposal), revert(bob, proposal)]);
    expect(one).toEqual({ status: "reverted", changes: 1 });
    expect(two).toEqual(one);
    expect(
      (
        await owner.query(
          "select count(*)::int as n from keyturn.audit where proposal_id = $1 and event = 'reverted'",
          [proposal],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(await apply(agent, proposal)).toEqual({ status: "reverted", changes: 1 });
    expect((await order(id)).status).toBe("paid");
  });

  test("is held to the rules that forbid, as any write is", async () => {
    const id = fresh();
    const proposal = await applied([
      { table: "orders", operation: "update", key: { id }, set: { status: "shipped" } },
    ]);
    await owner.query(
      `select keyturn.forbid('shipped_stays', 'orders', array['update'],
         'before ->> ''status'' = ''shipped'' and after ->> ''status'' <> ''shipped''', 'A shipped order is not un-shipped.')`,
    );
    const refused = await refusal(alice.query("select keyturn.revert($1)", [proposal]));
    expect(refused?.code).toBe("42501");
    expect(refused?.message).toContain(
      "nothing is taken back: undoing change 1 is forbidden by the rule shipped_stays: A shipped order is not un-shipped.",
    );
    expect((await order(id)).status).toBe("shipped");
    expect(await status(proposal)).toBe("applied");
  });

  test("stops, with nothing taken back, when the table writes something else than the row as it was", async () => {
    const [first, second] = [fresh(), fresh()];
    const proposal = await applied([
      { table: "orders", operation: "update", key: { id: first }, set: { status: "held" } },
      { table: "orders", operation: "update", key: { id: second }, set: { status: "held" } },
    ]);
    await owner.query(`
      create function shout() returns trigger language plpgsql as 'begin new.customer := upper(new.customer); return new; end';
      create trigger shouting before update on orders for each row when (new.id = ${first}) execute function shout();
    `);
    const refused = await refusal(alice.query("select keyturn.revert($1)", [proposal]));
    await owner.query("drop trigger shouting on orders");
    expect(refused?.message).toContain("the row did not come out as it was before");
    expect((await order(first)).status).toBe("held");
    expect((await order(second)).status).toBe("held");
    expect(await status(proposal)).toBe("applied");
  });
});

describe("what an independent review found about taking back", () => {
  test("a row somebody has added to since is not deleted", async () => {
    await owner.query(`
      create table papers (id integer primary key, tags text[] not null, meta jsonb not null);
      select keyturn.protect('papers');
      grant select on papers to keyturn_agent, keyturn_approver;
    `);
    const proposal = await applied([
      { table: "papers", operation: "insert", values: { id: 1, tags: ["a"], meta: { a: 1 } } },
    ]);
    await owner.query(
      `update papers set tags = '{later,a,work}', meta = '{"a": 1, "added_later": "important"}' where id = 1`,
    );
    const outcome = await revert(alice, proposal);
    expect(outcome.status).toBe("conflict");
    expect((await owner.query("select count(*)::int as n from papers")).rows[0].n).toBe(1);
  });

  test("an applied insert is what was approved, not something that contains it", async () => {
    await owner.query(`
      create table lists (id integer primary key, tags text[] not null);
      create function more_tags() returns trigger language plpgsql as 'begin new.tags := new.tags || array[''added'']; return new; end';
      create trigger adding before insert on lists for each row execute function more_tags();
      select keyturn.protect('lists');
      grant select on lists to keyturn_agent, keyturn_approver;
    `);
    const made = await propose(agent, [
      { table: "lists", operation: "insert", values: { id: 1, tags: ["a"] } },
    ]);
    await alice.query("select keyturn.approve($1, $2)", [made.proposal_id, made.content_hash]);
    const outcome = await apply(agent, made.proposal_id);
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("the inserted row is not what was approved");
    expect((await owner.query("select count(*)::int as n from lists")).rows[0].n).toBe(0);
  });

  test("a row whose key the table makes half of can be proposed twice and taken back", async () => {
    await owner.query(`
      create table parts (a integer, b integer generated by default as identity, label text, primary key (a, b));
      select keyturn.protect('parts');
      grant select on parts to keyturn_agent, keyturn_approver;
    `);
    const proposal = await applied([
      { table: "parts", operation: "insert", values: { a: 1, label: "x" } },
      { table: "parts", operation: "insert", values: { a: 1, label: "y" } },
    ]);
    expect((await owner.query("select count(*)::int as n from parts")).rows[0].n).toBe(2);
    // Through the view too, in one statement.
    await agent.query("insert into proposal.parts (a, label) values (2, 'p'), (2, 'q')");
    expect(await revert(alice, proposal)).toEqual({ status: "reverted", changes: 2 });
    expect((await owner.query("select count(*)::int as n from parts")).rows[0].n).toBe(0);
  });

  test("two rows that may each be removed alone are not removed together against a rule", async () => {
    const id = fresh();
    const proposal = await applied([
      { table: "remarks", operation: "insert", values: { order_id: id, body: "one" } },
      { table: "remarks", operation: "insert", values: { order_id: id, body: "two" } },
    ]);
    await owner.query(
      `select keyturn.forbid('keep_one', 'remarks', array['delete'],
         '(select count(*) from public.remarks r where r.order_id = (before ->> ''order_id'')::integer) <= 1',
         'An order keeps at least one remark.')`,
    );
    const refused = await refusal(alice.query("select keyturn.revert($1)", [proposal]));
    expect(refused?.message).toContain("is forbidden by the rule keep_one");
    expect(
      (await owner.query("select count(*)::int as n from remarks where order_id = $1", [id]))
        .rows[0].n,
    ).toBe(2);
    expect(await status(proposal)).toBe("applied");
  });

  test("is not done in a transaction that fixed its view of the data before a rule was written", async () => {
    const id = fresh();
    const proposal = await applied([
      { table: "orders", operation: "update", key: { id }, set: { status: "held" } },
    ]);
    await alice.query("begin isolation level repeatable read");
    const refused = await refusal(alice.query("select keyturn.revert($1)", [proposal]));
    await alice.query("rollback");
    expect(refused?.message).toContain("only in a read committed transaction");
    expect((await order(id)).status).toBe("held");
  });
});
