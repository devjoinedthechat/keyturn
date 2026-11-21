import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { Database, logins, propose, refusal } from "./database.ts";

const schema = `
  create table customers (id integer primary key, name text not null, region text not null default 'north');
  create table payments (
    id       bigint primary key,
    customer integer not null references customers (id),
    amount   numeric(10, 2) not null,
    paid_on  date not null
  );
  create table seats (hall text, seat integer, label text not null, primary key (hall, seat));
  create table secrets (id integer primary key, word text not null);
  create table refunds (
    id       integer primary key,
    payment  bigint references payments (id),
    amount   numeric(10, 2) not null,
    hall     text,
    seat     integer,
    secret   integer references secrets (id),
    customer integer references customers (id),
    foreign key (hall, seat) references seats (hall, seat)
  );
  insert into customers values (1, 'Ada Lund', 'north'), (2, 'Bo Kim', 'south');
  insert into payments values (9007199254740993, 1, 120.50, '2026-03-01'), (2, 2, 80.00, '2026-02-01');
  insert into seats values ('A', 1, 'front left');
  insert into secrets values (1, 'hidden');
  insert into refunds (id, payment, amount) values (50, 2, 10.00);
  select keyturn.protect('refunds');
  grant select on customers, payments, seats, refunds to keyturn_agent, keyturn_approver;
  alter table customers enable row level security;
  create policy north_only on customers for select to keyturn_approver using (region = 'north');
  create policy all_for_agents on customers for select to keyturn_agent using (true);
`;

let database: Database;
let owner: pg.Client;
let agent: pg.Client;
let alice: pg.Client;
let next = 100;

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

beforeEach(async () => {
  await owner.query("delete from keyturn.rules");
  await owner.query("delete from keyturn.forbidden");
});

const refund = (values: Record<string, unknown>) => {
  next += 1;
  return { table: "refunds", operation: "insert", values: { id: next, amount: "5.00", ...values } };
};
type Reference = {
  seq: number;
  via: string;
  relation: string;
  key: Record<string, unknown>;
  state: string;
  column_name: string | null;
  value: string | null;
  kind: string | null;
};
const refersTo = async (client: pg.Client, proposal: string) =>
  (await client.query<Reference>("select * from keyturn.refers_to($1)", [proposal])).rows;
const waitsBecause = async (proposal: string) =>
  (
    await alice.query<{ seq: number | null; rule: string | null; because: string }>(
      "select * from keyturn.waits_because($1)",
      [proposal],
    )
  ).rows;

describe("the rows a proposal's rows point to", () => {
  test("are shown column by column, in the table's order, with every digit", async () => {
    const made = await propose(agent, [refund({ payment: "9007199254740993" })]);
    const rows = await refersTo(alice, made.proposal_id);
    expect(rows.map((row) => [row.column_name, row.value, row.kind])).toEqual([
      ["id", "9007199254740993", "number"],
      ["customer", "1", "number"],
      ["amount", "120.50", "number"],
      ["paid_on", "2026-03-01", "string"],
    ]);
    expect(rows[0]).toMatchObject({
      seq: 1,
      via: "refunds_payment_fkey",
      relation: "public.payments",
      state: "shown",
    });
  });

  test("say so when the row pointed to does not exist", async () => {
    const made = await propose(agent, [refund({ payment: 777 })]);
    const rows = await refersTo(alice, made.proposal_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      relation: "public.payments",
      state: "missing",
      column_name: null,
    });
  });

  test("follow a key of two columns, and leave out a column that points nowhere", async () => {
    const made = await propose(agent, [refund({ hall: "A", seat: 1 })]);
    const rows = await refersTo(alice, made.proposal_id);
    expect(new Set(rows.map((row) => row.via))).toEqual(new Set(["refunds_hall_seat_fkey"]));
    expect(rows.find((row) => row.column_name === "label")?.value).toBe("front left");
    expect(rows[0]?.key).toEqual({ hall: "A", seat: 1 });
  });

  test("show only what the caller may read", async () => {
    const made = await propose(agent, [refund({ payment: 2, secret: 1 })]);
    const rows = await refersTo(alice, made.proposal_id);
    // The approver has no right to the table of secrets.
    expect(rows.find((row) => row.relation === "public.secrets")).toMatchObject({
      state: "unreadable",
      value: null,
    });
    expect(JSON.stringify(rows)).not.toContain("hidden");
    // The payment is shown; it is read with the approver's rights like any other query of theirs.
    expect(rows.filter((row) => row.relation === "public.payments")).toHaveLength(4);
  });

  test("leave out a row the caller's own policies keep from them", async () => {
    // The approver's policy on customers shows the north only; the agent's shows all.
    const made = await propose(agent, [refund({ customer: 2 }), refund({ customer: 1 })]);
    const forApprover = await refersTo(alice, made.proposal_id);
    expect(forApprover.find((row) => row.seq === 1)).toMatchObject({ state: "missing" });
    expect(forApprover.find((row) => row.seq === 2 && row.column_name === "name")?.value).toBe(
      "Ada Lund",
    );
    expect(JSON.stringify(forApprover)).not.toContain("Bo Kim");
    expect(JSON.stringify(await refersTo(agent, made.proposal_id))).toContain("Bo Kim");
  });

  test("are those of the row as it is, for a delete", async () => {
    const made = await propose(agent, [{ table: "refunds", operation: "delete", key: { id: 50 } }]);
    const rows = await refersTo(alice, made.proposal_id);
    expect(rows.find((row) => row.column_name === "amount")?.value).toBe("80.00");
  });

  test("are not shown to an agent for another agent's proposal", async () => {
    const made = await propose(agent, [refund({ payment: 2 })]);
    const other = await database.as(logins.otherAgent);
    expect(await refersTo(other, made.proposal_id)).toEqual([]);
    expect((await refersTo(agent, made.proposal_id)).length).toBe(4);
  });

  test("come a page at a time, by the change they belong to", async () => {
    const made = await propose(agent, [
      refund({ payment: 2 }),
      refund({}),
      refund({ payment: "9007199254740993" }),
    ]);
    const second = (
      await alice.query<Reference>("select * from keyturn.refers_to($1, 2, 2)", [made.proposal_id])
    ).rows;
    expect(new Set(second.map((row) => row.seq))).toEqual(new Set([3]));
  });
});

describe("why a proposal waits", () => {
  test("is that no rule lets the table's changes through, said once", async () => {
    const made = await propose(agent, [refund({ payment: 2 }), refund({ payment: 2 })]);
    expect(await waitsBecause(made.proposal_id)).toEqual([
      {
        seq: null,
        rule: null,
        because: "no rule lets a change to public.refunds through without a person",
      },
    ]);
  });

  test("names what each rule lacks for each change", async () => {
    await owner.query(`
      select keyturn.allow('small_refunds', 'refunds', array['insert'], array['id', 'payment', 'amount'],
                           max_rows => 1, condition => $$(after ->> 'amount')::numeric <= 20$$);
      select keyturn.allow('tidy_up', 'refunds', array['delete'], max_rows => 5);
    `);
    const large = await propose(agent, [refund({ payment: 2, amount: "45.00" })]);
    expect(await waitsBecause(large.proposal_id)).toEqual([
      { seq: 1, rule: "small_refunds", because: "has a condition that does not hold for this row" },
      { seq: 1, rule: "tidy_up", because: "does not cover an insert" },
    ]);

    const seated = await propose(agent, [refund({ payment: 2, hall: "A", seat: 1 })]);
    expect((await waitsBecause(seated.proposal_id))[0]).toEqual({
      seq: 1,
      rule: "small_refunds",
      because: "does not let hall, seat be set",
    });

    const two = await propose(agent, [refund({ payment: 2 }), refund({ payment: 2 })]);
    expect(await waitsBecause(two.proposal_id)).toEqual([
      {
        seq: null,
        rule: "small_refunds",
        because: "lets through one row in a proposal, and this one holds 2",
      },
      { seq: 1, rule: "tidy_up", because: "does not cover an insert" },
      { seq: 2, rule: "tidy_up", because: "does not cover an insert" },
    ]);
  });

  test("says when every change is covered and it only has to be applied", async () => {
    await owner.query(
      "select keyturn.allow('small_refunds', 'refunds', array['insert'], array['id', 'payment', 'amount'])",
    );
    const made = await propose(agent, [refund({ payment: 2 })]);
    const rows = await waitsBecause(made.proposal_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.because).toContain("every change is covered by a rule");
  });

  test("says when a rule has come to forbid it", async () => {
    const made = await propose(agent, [refund({ payment: 2, amount: "45.00" })]);
    await owner.query(
      `select keyturn.forbid('small_only', 'refunds', array['insert'], $$(after ->> 'amount')::numeric > 20$$, 'Refunds above 20 are made by staff.')`,
    );
    expect(await waitsBecause(made.proposal_id)).toEqual([
      {
        seq: null,
        rule: null,
        because:
          "no one may approve this as things stand: change 1 is forbidden by the rule small_only: Refunds above 20 are made by staff.",
      },
    ]);
  });

  test("is not told to an agent, and is nothing once the proposal is decided", async () => {
    const made = await propose(agent, [refund({ payment: 2 })]);
    expect(
      (await refusal(agent.query("select * from keyturn.waits_because($1)", [made.proposal_id])))
        ?.code,
    ).toBe("42501");
    await alice.query("select keyturn.reject($1)", [made.proposal_id]);
    expect(await waitsBecause(made.proposal_id)).toEqual([]);
  });
});
