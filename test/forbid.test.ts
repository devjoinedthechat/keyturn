import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { apply, Database, logins, propose, refusal } from "./database.ts";

const schema = `
  create table accounts (id integer primary key, credit_limit integer not null, closed boolean not null default false);
  create table charges (
    id      integer primary key,
    account integer not null references accounts (id),
    amount  integer not null,
    note    text not null default ''
  );
  insert into accounts select n, 1000 from generate_series(1, 400) as n;
  select keyturn.protect('charges');
  select keyturn.protect('accounts');
  grant select on accounts, charges to keyturn_agent, keyturn_approver;
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

// Each test starts with the one rule below and takes an account no other test has touched.
beforeEach(async () => {
  await owner.query("delete from keyturn.rules");
  await owner.query("delete from keyturn.forbidden");
  await forbid(
    `'within_credit', 'charges', array['insert'],
     $$(after ->> 'amount')::integer + coalesce((select sum(c.amount) from public.charges c where c.account = (after ->> 'account')::integer), 0)
        > (select a.credit_limit from public.accounts a where a.id = (after ->> 'account')::integer)$$,
     'An account is not charged past its credit limit.'`,
  );
});

const fresh = () => {
  next += 1;
  return next;
};
const forbid = (definition: string) => owner.query(`select keyturn.forbid(${definition})`);
const charge = (account: number, amount: number, id = fresh() + 10_000) => ({
  table: "charges",
  operation: "insert",
  values: { id, account, amount },
});
const approve = (proposed: { proposal_id: string; content_hash: string }) =>
  alice.query("select keyturn.approve($1, $2)", [proposed.proposal_id, proposed.content_hash]);
const charged = async (account: number) =>
  (
    await owner.query(
      "select coalesce(sum(amount), 0)::integer as total from charges where account = $1",
      [account],
    )
  ).rows[0].total as number;
const waiting = async () =>
  (
    await owner.query(
      "select count(*)::integer as n from keyturn.proposals where status = 'pending'",
    )
  ).rows[0].n as number;

describe("a change a rule forbids", () => {
  test("is refused when it is proposed, with the rule's name and reason, and nothing is recorded", async () => {
    const account = fresh();
    const before = await waiting();
    const refused = await refusal(propose(agent, [charge(account, 1001)]));
    expect(refused?.code).toBe("42501");
    expect(refused?.message).toContain(
      "forbidden by the rule within_credit: An account is not charged past its credit limit.",
    );
    expect(refused?.message).toContain("Nothing is recorded");
    expect(await waiting()).toBe(before);
  });

  test("is refused through a proposal view too, and takes the rest of the statement with it", async () => {
    const [low, high] = [fresh(), fresh()];
    const before = await waiting();
    const refused = await refusal(
      agent.query(
        `insert into proposal.charges (id, account, amount) values (${fresh() + 20_000}, ${low}, 10), (${fresh() + 20_000}, ${high}, 5000)`,
      ),
    );
    expect(refused?.message).toContain("forbidden by the rule within_credit");
    expect(await waiting()).toBe(before);
  });

  test("leaves a change the rule does not forbid to wait for a person as before", async () => {
    const account = fresh();
    const proposed = await propose(agent, [charge(account, 1000)]);
    await approve(proposed);
    expect((await apply(agent, proposed.proposal_id)).status).toBe("applied");
    expect(await charged(account)).toBe(1000);
  });

  test("is not approved by anyone once a record has changed under it", async () => {
    const account = fresh();
    const proposed = await propose(agent, [charge(account, 800)]);
    await owner.query("update accounts set credit_limit = 500 where id = $1", [account]);
    const refused = await refusal(approve(proposed));
    expect(refused?.code).toBe("42501");
    expect(refused?.message).toContain(
      "no one may approve this: change 1 is forbidden by the rule within_credit",
    );
    // It is still there to be turned down.
    await alice.query("select keyturn.reject($1, $2)", [
      proposed.proposal_id,
      "Over the limit now.",
    ]);
    expect(await charged(account)).toBe(0);
  });

  test("is not written after approval either, and is written once the record allows it again", async () => {
    const account = fresh();
    const proposed = await propose(agent, [charge(account, 800)]);
    await approve(proposed);
    await owner.query("update accounts set credit_limit = 500 where id = $1", [account]);
    const refused = await refusal(apply(agent, proposed.proposal_id));
    expect(refused?.code).toBe("42501");
    expect(refused?.message).toContain(
      "nothing is written: change 1 is forbidden by the rule within_credit",
    );
    expect(await charged(account)).toBe(0);

    await owner.query("update accounts set credit_limit = 1000 where id = $1", [account]);
    expect((await apply(agent, proposed.proposal_id)).status).toBe("applied");
    expect(await charged(account)).toBe(800);
  });

  test("is not let through by a rule that would take the person out", async () => {
    await owner.query(
      "select keyturn.allow('small_charges', 'charges', array['insert'], array['id', 'account', 'amount'], max_rows => 1, per_hour => 1000)",
    );
    const account = fresh();
    // Refused outright when it is proposed.
    expect((await refusal(propose(agent, [charge(account, 1001)])))?.message).toContain(
      "forbidden by the rule within_credit",
    );
    // And when the record changes after: the rule that lets through does not get to decide.
    const proposed = await propose(agent, [charge(account, 800)]);
    await owner.query("update accounts set credit_limit = 500 where id = $1", [account]);
    const refused = await refusal(apply(agent, proposed.proposal_id));
    expect(refused?.message).toContain("nothing is written: change 1 is forbidden");
    const state = await owner.query(
      "select status, decided_by from keyturn.proposals where id = $1",
      [proposed.proposal_id],
    );
    expect(state.rows[0]).toEqual({ status: "pending", decided_by: null });
    expect(await charged(account)).toBe(0);
  });

  test("is refused when the condition cannot be worked out, or gives neither true nor false", async () => {
    await forbid(
      `'needs_a_note', 'charges', array['insert'], $$(after ->> 'note')::integer > 0$$, 'Charges carry a numbered note.'`,
    );
    const account = fresh();
    // No note: the condition is null.
    const missing = await refusal(propose(agent, [charge(account, 10)]));
    expect(missing?.message).toContain("forbidden by the rule needs_a_note: Charges carry");
    // A note that is not a number: the condition fails.
    const broken = await refusal(
      propose(agent, [
        {
          table: "charges",
          operation: "insert",
          values: { id: fresh() + 30_000, account, amount: 10, note: "x" },
        },
      ]),
    );
    expect(broken?.message).toContain(
      "forbidden by the rule needs_a_note (whose condition could not be worked out for this row)",
    );
  });

  test("holds a running total against two approved proposals applied at once", async () => {
    const account = fresh();
    const second = otherAgent;
    const [one, two] = [
      await propose(agent, [charge(account, 600)]),
      await propose(second, [charge(account, 600)]),
    ];
    await approve(one);
    await approve(two);
    const outcomes = await Promise.all([
      refusal(apply(agent, one.proposal_id)),
      refusal(apply(second, two.proposal_id)),
    ]);
    expect(outcomes.filter((outcome) => outcome === null).length).toBe(1);
    expect(outcomes.find((outcome) => outcome !== null)?.message).toContain(
      "forbidden by the rule within_credit",
    );
    expect(await charged(account)).toBe(600);
  });

  test("is written only in a read committed transaction", async () => {
    const account = fresh();
    const proposed = await propose(agent, [charge(account, 100)]);
    await approve(proposed);
    await agent.query("begin isolation level repeatable read");
    const refused = await refusal(apply(agent, proposed.proposal_id));
    await agent.query("rollback");
    expect(refused?.message).toContain("only in a read committed transaction");
    expect((await apply(agent, proposed.proposal_id)).status).toBe("applied");
  });
});

describe("the rules that forbid", () => {
  test("are written by the owner only, and read by an approver but not an agent", async () => {
    const definition = `'x', 'charges', array['insert'], 'false', 'Nothing.'`;
    for (const client of [agent, alice]) {
      expect((await refusal(client.query(`select keyturn.forbid(${definition})`)))?.code).toBe(
        "42501",
      );
      expect((await refusal(client.query("delete from keyturn.forbidden")))?.code).toBe("42501");
      expect(
        (await refusal(client.query("update keyturn.forbidden set active = false")))?.code,
      ).toBe("42501");
      expect((await refusal(client.query("truncate keyturn.forbidden")))?.code).toBe("42501");
      expect(
        (
          await refusal(
            client.query(
              "select keyturn.forbidden_by('charges'::regclass, 'insert', null, '{}'::jsonb)",
            ),
          )
        )?.code,
      ).toBe("42501");
    }
    expect((await refusal(agent.query("select * from keyturn.forbidden")))?.code).toBe("42501");
    expect((await alice.query("select name from keyturn.forbidden")).rows).toEqual([
      { name: "within_credit" },
    ]);
  });

  test("are refused for a table not under keyturn, and for a condition that is not SQL", async () => {
    await owner.query("create table if not exists loose (id integer primary key)");
    expect(
      (await refusal(forbid(`'x', 'loose', array['insert'], 'false', 'Nothing.'`)))?.message,
    ).toContain("is not a table under keyturn");
    expect(
      await refusal(forbid(`'x', 'charges', array['insert'], 'this is not sql', 'Nothing.'`)),
    ).not.toBeNull();
    expect(
      await refusal(forbid(`'x', 'charges', array['insert'], 'missing_table.x > 1', 'Nothing.'`)),
    ).not.toBeNull();
  });

  test("replace one of the same name with the next version, and go with the table", async () => {
    await forbid(`'within_credit', 'charges', array['insert'], 'false', 'Changed.'`);
    const rule = await owner.query(
      "select version, reason from keyturn.forbidden where name = 'within_credit'",
    );
    expect(rule.rows[0]).toEqual({ version: 2, reason: "Changed." });

    await forbid(
      `'no_closing', 'accounts', array['update'], $$(after ->> 'closed')::boolean$$, 'Accounts are closed by staff.'`,
    );
    await owner.query("select keyturn.unprotect('accounts')");
    expect((await owner.query("select name from keyturn.forbidden order by 1")).rows).toEqual([
      { name: "within_credit" },
    ]);
    await owner.query("select keyturn.protect('accounts')");
  });

  test("are listed by the doctor, with how to switch each off", async () => {
    const found = await owner.query(
      "select * from keyturn.doctor() where finding like '%forbids%'",
    );
    expect(found.rows).toHaveLength(1);
    expect(JSON.stringify(found.rows[0])).toContain("within_credit");
    expect(JSON.stringify(found.rows[0])).toContain("update keyturn.forbidden set active = false");
  });
});

describe("what an independent review found", () => {
  test("two changes of one proposal that each pass a running total do not pass it together", async () => {
    const account = fresh();
    const proposed = await propose(agent, [charge(account, 600), charge(account, 600)]);
    // Each is within the limit as things stand, so it is recorded and can be approved.
    await approve(proposed);
    const refused = await refusal(apply(agent, proposed.proposal_id));
    expect(refused?.code).toBe("42501");
    expect(refused?.message).toContain(
      "nothing is written: change 2 is forbidden by the rule within_credit",
    );
    expect(await charged(account)).toBe(0);
    const state = await owner.query("select status from keyturn.proposals where id = $1", [
      proposed.proposal_id,
    ]);
    expect(state.rows[0].status).toBe("approved");

    // The same through a rule that takes the person out: it does not get to decide.
    await owner.query(
      "select keyturn.allow('charges_alone', 'charges', array['insert'], array['id', 'account', 'amount'], max_rows => 2, per_hour => 1000)",
    );
    const alone = await propose(agent, [charge(account, 600), charge(account, 600)]);
    expect((await refusal(apply(agent, alone.proposal_id)))?.message).toContain(
      "change 2 is forbidden by the rule within_credit",
    );
    expect(await charged(account)).toBe(0);
    expect(
      (await owner.query("select status from keyturn.proposals where id = $1", [alone.proposal_id]))
        .rows[0].status,
    ).toBe("pending");
  });

  test("a session setting does not change what a condition says", async () => {
    await forbid(
      String.raw`'no_refund_word', 'charges', array['insert'], $$after ->> 'note' ~ '\mrefund\M'$$, 'Refunds are not made as charges.'`,
    );
    await owner.query(
      String.raw`select keyturn.allow('numbered', 'charges', array['insert'], array['id', 'account', 'amount', 'note'], condition => $$after ->> 'note' ~ '^\d+$'$$, per_hour => 1000)`,
    );
    const noted = (note: string) => ({
      table: "charges",
      operation: "insert",
      values: { id: fresh() + 40_000, account: fresh(), amount: 5, note },
    });
    const sly = await database.as(logins.agent);
    // With this off, a backslash in a string is an escape, and "\d" would read as "d".
    await sly.query("set standard_conforming_strings = off");
    await sly.query("set transform_null_equals = on");
    expect((await refusal(propose(sly, [noted("refund now")])))?.message).toContain(
      "forbidden by the rule no_refund_word",
    );
    // "ddd" is not a number, whatever the session says a backslash is.
    const letters = await propose(sly, [noted("ddd")]);
    expect((await refusal(apply(sly, letters.proposal_id)))?.message).toContain(
      "pending, not approved",
    );
    // And a number still goes through on the rule.
    const digits = await propose(sly, [noted("123")]);
    expect((await apply(sly, digits.proposal_id)).status).toBe("applied");

    // An approver with the setting off cannot approve past the rule either.
    await owner.query("update keyturn.forbidden set active = false where name = 'no_refund_word'");
    const waiting = await propose(agent, [noted("refund later")]);
    await owner.query("update keyturn.forbidden set active = true where name = 'no_refund_word'");
    const careless = await database.as(logins.bob);
    await careless.query("set standard_conforming_strings = off");
    expect(
      (
        await refusal(
          careless.query("select keyturn.approve($1, $2)", [
            waiting.proposal_id,
            waiting.content_hash,
          ]),
        )
      )?.message,
    ).toContain("no one may approve this");
  });

  test("an apply left open does not stop the owner writing or switching off a rule", async () => {
    const account = fresh();
    const proposed = await propose(agent, [charge(account, 10)]);
    await approve(proposed);
    await agent.query("begin");
    expect((await apply(agent, proposed.proposal_id)).status).toBe("applied");
    await owner.query("set lock_timeout = '1500ms'");
    const blocked = await refusal(
      owner.query("update keyturn.forbidden set active = false where name = 'within_credit'"),
    );
    await owner.query("update keyturn.forbidden set active = true where name = 'within_credit'");
    await owner.query("reset lock_timeout");
    await agent.query("commit");
    expect(blocked).toBeNull();
  });

  test("a rule written after a transaction fixed its view of the data is not missed", async () => {
    await owner.query("delete from keyturn.forbidden");
    const account = fresh();
    const proposed = await propose(agent, [charge(account, 10)]);
    await approve(proposed);
    await agent.query("begin isolation level repeatable read");
    await agent.query("select count(*) from keyturn.proposals");
    await forbid(`'frozen', 'charges', array['insert'], 'true', 'Charging is frozen.'`);
    const refused = await refusal(apply(agent, proposed.proposal_id));
    await agent.query("rollback");
    expect(refused?.message).toContain("only in a read committed transaction");
    expect(await charged(account)).toBe(0);
    // In the default kind of transaction the rule is seen.
    expect((await refusal(apply(agent, proposed.proposal_id)))?.message).toContain(
      "forbidden by the rule frozen",
    );
  });

  test("the text search an agent's session prefers does not change a condition either", async () => {
    await forbid(
      `'no_refund_stem', 'charges', array['insert'], 'to_tsvector(''english'', after ->> ''note'') @@ ''refund''::tsquery', 'Refunds are not made as charges.'`,
    );
    const sly = await database.as(logins.agent);
    await sly.query("set default_text_search_config = 'pg_catalog.simple'");
    const refused = await refusal(
      propose(sly, [
        {
          table: "charges",
          operation: "insert",
          values: { id: fresh() + 50_000, account: fresh(), amount: 5, note: "refunds" },
        },
      ]),
    );
    expect(refused?.message).toContain("forbidden by the rule no_refund_stem");
    // A condition that leaves the choice to the session gets one fixed answer, not the caller's.
    await owner.query("update keyturn.forbidden set active = false where name = 'no_refund_stem'");
    await forbid(
      `'no_refund_word_plain', 'charges', array['insert'], 'to_tsvector(after ->> ''note'') @@ ''refunding''::tsquery', 'Refunds are not made as charges.'`,
    );
    for (const setting of ["pg_catalog.simple", "pg_catalog.english"]) {
      await sly.query(`set default_text_search_config = '${setting}'`);
      const made = await refusal(
        propose(sly, [
          {
            table: "charges",
            operation: "insert",
            values: { id: fresh() + 50_000, account: fresh(), amount: 5, note: "refunding" },
          },
        ]),
      );
      expect(made?.message, setting).toContain("forbidden by the rule no_refund_word_plain");
    }
  });

  test("an agent cannot hold up the applying of other proposals for a table", async () => {
    const account = fresh();
    const proposed = await propose(agent, [charge(account, 10)]);
    await approve(proposed);
    const sly = await database.as(logins.agent);
    // The lock an earlier version waited on, which anyone could take.
    await sly.query(
      "select pg_advisory_lock(hashtext('keyturn.forbidden'), hashtext('charges'::regclass::oid::text))",
    );
    // And the one it waits on now, which an agent may not.
    expect((await refusal(sly.query("select from keyturn.protected for update")))?.code).toBe(
      "42501",
    );
    await agent.query("set lock_timeout = '2s'");
    const outcome = await apply(agent, proposed.proposal_id);
    await agent.query("reset lock_timeout");
    await sly.query("select pg_advisory_unlock_all()");
    expect(outcome.status).toBe("applied");
  });
});
