import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { administrator, apply, Database, logins, propose, refusal } from "./database.ts";

const schema = `
  create table tickets (
    id        integer primary key,
    subject   text not null,
    status    text not null default 'open',
    note      text not null default '',
    owed      numeric(10, 2) not null default 0
  );
  insert into tickets (id, subject) select n, 'ticket ' || n from generate_series(1, 200) as n;
  select keyturn.protect('tickets');
  grant select on tickets to keyturn_agent, keyturn_approver;
`;

let database: Database;
let owner: pg.Client;
let agent: pg.Client;
let otherAgent: pg.Client;
let alice: pg.Client;
let next = 0;

beforeAll(async () => {
  database = await Database.create(schema);
  [owner, agent, otherAgent, alice] = await Promise.all([
    database.as(logins.owner),
    database.as(logins.agent),
    database.as(logins.otherAgent),
    database.as(logins.alice),
  ]);
});

afterAll(async () => {
  await database.close();
});

// Each test starts with no rules and takes tickets no other test has touched.
beforeEach(async () => {
  await owner.query("delete from keyturn.rules");
});

const fresh = () => {
  next += 1;
  return next;
};
const ticket = async (id: number) =>
  (await owner.query("select * from tickets where id = $1", [id])).rows[0];
const update = (id: number, set: Record<string, unknown>) => ({
  table: "tickets",
  operation: "update",
  key: { id },
  set,
});
const allow = (definition: string) => owner.query(`select keyturn.allow(${definition})`);
const waits = async (changes: unknown[], client: pg.Client = agent) => {
  const proposed = await propose(client, changes);
  const refused = await refusal(apply(client, proposed.proposal_id));
  expect(refused?.code).toBe("42501");
  expect(refused?.message).toContain("pending, not approved");
  return proposed;
};

describe("with no rule", () => {
  test("every change waits for a person", async () => {
    const id = fresh();
    await waits([update(id, { status: "closed" })]);
    expect((await ticket(id)).status).toBe("open");
  });
});

describe("a rule the owner wrote", () => {
  test("lets through the change it describes, and the record says a rule did it and which", async () => {
    await allow(`'close_tickets', 'tickets', array['update'], array['status', 'note']`);
    const id = fresh();
    const proposed = await propose(agent, [update(id, { status: "closed", note: "Solved." })]);

    expect(await apply(agent, proposed.proposal_id)).toMatchObject({ status: "applied" });
    expect(await ticket(id)).toMatchObject({ status: "closed", note: "Solved." });

    const record = (
      await owner.query("select decided_by, content_hash from keyturn.proposals where id = $1", [
        proposed.proposal_id,
      ])
    ).rows[0];
    expect(record).toEqual({ decided_by: "keyturn_rule", content_hash: proposed.content_hash });
    const log = (
      await owner.query(
        "select event, detail from keyturn.audit where proposal_id = $1 order by seq",
        [proposed.proposal_id],
      )
    ).rows;
    expect(log.map((entry) => entry.event)).toEqual(["opened", "approved_by_rule", "applied"]);
    expect(log[1].detail).toEqual({
      rules: { close_tickets: 1 },
      content_hash: proposed.content_hash,
    });
    expect((await owner.query("select * from keyturn.verify_audit()")).rows).toEqual([]);
  });

  test("lets through nothing it does not describe", async () => {
    await allow(`'close_tickets', 'tickets', array['update'], array['status', 'note'], 2`);
    const [a, b, c] = [fresh(), fresh(), fresh()];

    // A column the rule does not list, alone or beside one it does.
    await waits([update(a, { owed: 900 })]);
    await waits([update(a, { status: "closed", owed: 900 })]);
    // Another operation.
    await waits([{ table: "tickets", operation: "delete", key: { id: a } }]);
    await waits([
      { table: "tickets", operation: "insert", values: { id: 9000, subject: "made up" } },
    ]);
    // More rows than the rule allows in one proposal.
    await waits([
      update(a, { status: "closed" }),
      update(b, { status: "closed" }),
      update(c, { status: "closed" }),
    ]);
    // One change the rule covers beside one it does not: the whole proposal waits.
    await waits([update(a, { status: "closed" }), update(b, { owed: 1 })]);

    for (const id of [a, b, c]) {
      expect(await ticket(id)).toMatchObject({ status: "open", owed: "0.00" });
    }
    expect((await owner.query("select from tickets where id = 9000")).rowCount).toBe(0);
  });

  test("still leaves the change to a person who wants to decide it", async () => {
    await allow(`'close_tickets', 'tickets', array['update'], array['status']`);
    const id = fresh();
    const proposed = await propose(agent, [update(id, { status: "closed" })]);
    await alice.query("select keyturn.reject($1, 'Leave it open.')", [proposed.proposal_id]);
    expect((await refusal(apply(agent, proposed.proposal_id)))?.message).toContain("rejected");
    expect((await ticket(id)).status).toBe("open");
  });

  test("holds a condition over the row as it is and as it would be", async () => {
    await allow(
      `'small_credit', 'tickets', array['update'], array['owed'], 1,
       $$(after ->> 'owed')::numeric <= 50 and before ->> 'status' = 'open'$$`,
    );
    const [small, large, closed] = [fresh(), fresh(), fresh()];
    await owner.query("update tickets set status = 'closed' where id = $1", [closed]);

    const proposed = await propose(agent, [update(small, { owed: 50 })]);
    expect((await apply(agent, proposed.proposal_id)).status).toBe("applied");
    await waits([update(large, { owed: 50.01 })]);
    await waits([update(closed, { owed: 5 })]);

    expect((await ticket(small)).owed).toBe("50.00");
    expect((await ticket(large)).owed).toBe("0.00");
    expect((await ticket(closed)).owed).toBe("0.00");
  });

  test("does not cover a row its condition cannot be worked out for", async () => {
    await allow(
      `'numbered_notes', 'tickets', array['update'], array['note'], 1, $$(after ->> 'note')::integer > 0$$`,
    );
    const id = fresh();
    await waits([update(id, { note: "not a number" })]);
    const proposed = await propose(agent, [update(id, { note: "7" })]);
    expect((await apply(agent, proposed.proposal_id)).status).toBe("applied");
  });

  test("covers inserts and deletes only when it says so", async () => {
    await allow(`'add_tickets', 'tickets', array['insert'], array['id', 'subject']`);
    await allow(
      `'drop_spam', 'tickets', array['delete'], null, 1, $$before ->> 'subject' like 'spam%'$$`,
    );
    const [spam, real] = [fresh(), fresh()];
    await owner.query("update tickets set subject = 'spam offer' where id = $1", [spam]);

    const added = await propose(agent, [
      { table: "tickets", operation: "insert", values: { id: 9100, subject: "printer" } },
    ]);
    expect((await apply(agent, added.proposal_id)).status).toBe("applied");
    // An insert that sets a column the rule does not list.
    await waits([
      {
        table: "tickets",
        operation: "insert",
        values: { id: 9101, subject: "printer", owed: 500 },
      },
    ]);

    const dropped = await propose(agent, [
      { table: "tickets", operation: "delete", key: { id: spam } },
    ]);
    expect((await apply(agent, dropped.proposal_id)).status).toBe("applied");
    await waits([{ table: "tickets", operation: "delete", key: { id: real } }]);

    expect((await owner.query("select from tickets where id = 9100")).rowCount).toBe(1);
    expect((await owner.query("select from tickets where id = 9101")).rowCount).toBe(0);
    expect(await ticket(spam)).toBeUndefined();
    expect(await ticket(real)).toBeDefined();
  });

  test("does not let a change through against a row that moved", async () => {
    await allow(`'close_tickets', 'tickets', array['update'], array['status']`);
    const id = fresh();
    const proposed = await propose(agent, [update(id, { status: "closed" })]);
    await owner.query("update tickets set note = 'customer replied' where id = $1", [id]);
    expect((await apply(agent, proposed.proposal_id)).status).toBe("stale");
    expect((await ticket(id)).status).toBe("open");
  });

  test("covers a change written as ordinary SQL through a view", async () => {
    await allow(`'close_tickets', 'tickets', array['update'], array['status']`);
    const id = fresh();
    await agent.query("begin");
    await agent.query("update proposal.tickets set status = 'closed' where id = $1", [id]);
    const proposal = (await agent.query("select proposal_id from keyturn.proposed()")).rows[0]
      .proposal_id;
    expect((await apply(agent, proposal)).status).toBe("applied");
    await agent.query("commit");
    expect((await ticket(id)).status).toBe("closed");
  });

  // The count is kept by the rule's name, so writing the rule again does not start it over.
  test("stops after as many proposals in an hour as it says, however many agents ask", async () => {
    await allow(`'close_slowly', 'tickets', array['update'], array['status'], 1, null, 3`);
    const ids = [fresh(), fresh(), fresh(), fresh(), fresh(), fresh()];
    const proposals = await Promise.all(
      ids.map((id, index) =>
        propose(index % 2 ? agent : otherAgent, [update(id, { status: "closed" })]),
      ),
    );
    // Each agent on connections of its own, all at once.
    const clients = await Promise.all(
      ids.map((_, index) => database.as(index % 2 ? logins.agent : logins.otherAgent)),
    );
    const outcomes = await Promise.all(
      proposals.map((proposed, index) =>
        refusal(apply(clients[index] as pg.Client, proposed.proposal_id)),
      ),
    );

    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(3);
    for (const outcome of outcomes.filter((outcome) => outcome !== null)) {
      expect(outcome?.message).toContain("this one waits for a person");
    }
    const closed = await owner.query(
      "select from tickets where id = any($1) and status = 'closed'",
      [ids],
    );
    expect(closed.rowCount).toBe(3);
  });

  test("is replaced by a later one of the same name, which is the next version, and covers nothing once switched off", async () => {
    await allow(`'close_tickets', 'tickets', array['update'], array['status', 'owed']`);
    await allow(`'close_tickets', 'tickets', array['update'], array['status']`);
    const id = fresh();
    await waits([update(id, { owed: 10 })]);

    const proposed = await propose(agent, [update(id, { status: "closed" })]);
    await apply(agent, proposed.proposal_id);
    const detail = (
      await owner.query(
        "select detail from keyturn.audit where proposal_id = $1 and event = 'approved_by_rule'",
        [proposed.proposal_id],
      )
    ).rows[0].detail;
    expect(detail.rules).toEqual({ close_tickets: 2 });

    await owner.query("update keyturn.rules set active = false where name = 'close_tickets'");
    await waits([update(fresh(), { status: "closed" })]);
  });
});

describe("the rules themselves", () => {
  test("cannot be written, changed or read by an agent, nor written by an approver", async () => {
    await allow(`'close_tickets', 'tickets', array['update'], array['status']`);
    const attempts = [
      "select keyturn.allow('anything', 'tickets', array['update', 'delete'], array['owed'], 10000)",
      "insert into keyturn.rules (name, relation, operations) values ('anything', 'tickets', array['delete'])",
      "update keyturn.rules set columns = array['owed'], max_rows = 10000",
      "delete from keyturn.rules",
    ];
    for (const statement of [...attempts, "select * from keyturn.rules"]) {
      expect((await refusal(agent.query(statement)))?.code, statement).toBe("42501");
    }
    for (const statement of attempts) {
      expect((await refusal(alice.query(statement)))?.code, statement).toBe("42501");
    }
    expect((await alice.query("select name from keyturn.rules")).rows).toEqual([
      { name: "close_tickets" },
    ]);
  });

  test("are refused when they could not mean what they say", async () => {
    const refused = async (definition: string) => (await refusal(allow(definition)))?.message;
    expect(await refused(`'x', 'pg_class', array['update'], array['relname']`)).toContain(
      "not a table under keyturn",
    );
    expect(await refused(`'x', 'tickets', array['update'], array['nothing']`)).toContain(
      'no column "nothing"',
    );
    expect(await refused(`'x', 'tickets', array['update']`)).toContain("lists the columns");
    expect(await refused(`'x', 'tickets', array['insert'], array[]::text[]`)).toContain(
      "lists the columns",
    );
    expect(
      await refused(`'x', 'tickets', array['update'], array['status'], 1, 'this is not sql'`),
    ).not.toBeUndefined();
    expect(await refused(`'x', 'tickets', array['drop'], array['status']`)).toContain("check");
    expect(await refused(`'x', 'tickets', array['update'], array['status'], 0`)).toContain("check");
    expect(await refused(`'Bad Name', 'tickets', array['update'], array['status']`)).toContain(
      "check",
    );
    expect((await owner.query("select from keyturn.rules")).rowCount).toBe(0);
  });

  test("are listed by the doctor, so what needs no person is never a surprise", async () => {
    await allow(
      `'close_tickets', 'tickets', array['update'], array['status'], 5, $$after ->> 'status' = 'closed'$$`,
    );
    const notes = (
      await owner.query("select finding, fix from keyturn.doctor() where finding like 'the rule %'")
    ).rows;
    expect(notes).toEqual([
      {
        finding:
          "the rule close_tickets lets an agent update (status) with no person, up to 5 rows a proposal and 60 proposals an hour, under a condition",
        fix: "update keyturn.rules set active = false where name = 'close_tickets'",
      },
    ]);
  });
});

describe("the name a rule's approval is recorded under", () => {
  test("cannot be taken by a person: a login made to carry it is reported", async () => {
    const admin = await administrator(database);
    await admin.query("begin");
    await admin.query("alter role keyturn_rule login");
    const findings = (
      await admin.query("select level from keyturn.doctor() where about = 'keyturn_rule'")
    ).rows;
    await admin.query("rollback");
    expect(findings).toEqual([{ level: "fail" }]);
  });

  test("cannot be given to a proposal by an approver's own approval", async () => {
    const id = fresh();
    const proposed = await propose(agent, [update(id, { status: "closed" })]);
    await alice.query("select keyturn.approve($1, $2)", [
      proposed.proposal_id,
      proposed.content_hash,
    ]);
    const record = await owner.query("select decided_by from keyturn.proposals where id = $1", [
      proposed.proposal_id,
    ]);
    expect(record.rows[0].decided_by).toBe(logins.alice);
  });
});
