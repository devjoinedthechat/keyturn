import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Io, run } from "../src/cli.ts";
import { Keyturn } from "../src/index.ts";
import { administrator, Database, logins } from "./database.ts";

let database: Database;
let owner: pg.Client;
let agent: Keyturn;

beforeAll(async () => {
  database = await Database.bare();
  owner = await database.as(logins.owner);
  await owner.query(`
    create table orders (id integer primary key, customer text not null, total numeric(10, 2) not null, status text not null default 'paid');
    insert into orders select n, 'customer ' || n, 20 + n, 'paid' from generate_series(1, 200) as n;
  `);
});

afterAll(async () => {
  await database.close();
});

/** Runs one command as a login, with a person at the terminal who types `answers`, or nobody. */
async function keyturn(login: string, args: string[], answers?: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const io: Io = {
    env: { KEYTURN_URL: database.url(login) },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    color: false,
  };
  if (answers !== undefined) {
    io.ask = async (question) => {
      asked.push(question);
      return answers.shift() ?? "";
    };
  }
  const code = await run(args, io);
  return { code, out: out.join("\n"), err: err.join("\n"), asked };
}

/**
 * What the doctor finds wrong here. Logins belong to the whole server, and another test file
 * makes faulty agents of its own while this one runs: those are another database's business.
 * The exit code has to agree with everything found, theirs included.
 */
async function doctorFailures() {
  const result = await keyturn(logins.owner, ["doctor", "--json"]);
  const failures = (JSON.parse(result.out) as { level: string; about: string }[]).filter(
    (finding) => finding.level === "fail",
  );
  expect(result.code).toBe(failures.length > 0 ? 1 : 0);
  return failures.filter((finding) => !/^(wrong|both)_/.test(finding.about));
}

const order = async (id: number) =>
  (await owner.query("select * from orders where id = $1", [id])).rows[0];

describe("from the terminal", () => {
  test("says what to do when keyturn is not installed", async () => {
    const result = await keyturn(logins.owner, ["doctor"]);
    expect(result).toMatchObject({ code: 1, out: "" });
    expect(result.err).toContain("keyturn install");
  });

  test("a table is protected and a change reviewed, approved and applied", async () => {
    expect((await keyturn(logins.owner, ["install"])).out).toContain("Installed keyturn");
    expect((await keyturn(logins.owner, ["install"])).err).toContain("already installed");
    const protect = await keyturn(logins.owner, ["protect", "orders"]);
    expect(protect.code).toBe(0);
    expect(protect.out).toContain("proposal.orders");
    await owner.query("grant select on orders to keyturn_agent, keyturn_approver");
    expect(await doctorFailures()).toEqual([]);

    agent = new Keyturn(await database.as(logins.agent));
    const made = await agent.propose(
      [
        {
          table: "orders",
          operation: "update",
          key: { id: 1 },
          set: { total: 0, status: "refunded" },
        },
        { table: "orders", operation: "delete", key: { id: 2 } },
      ],
      { note: "Customer 1 was charged twice; order 2 is a duplicate." },
    );

    const list = await keyturn(logins.alice, ["list"]);
    expect(list.out).toContain(made.id.slice(0, 8));
    expect(list.out).toContain("2 rows");
    expect(list.out).toContain("charged twice");

    const show = await keyturn(logins.alice, ["show", made.id.slice(0, 8)]);
    expect(show.code).toBe(0);
    expect(show.out).toContain(made.contentHash);
    expect(show.out).toContain("#1 update public.orders  id = 1");
    expect(show.out).toMatch(/total\s+21\.00 {2}-> {2}0\.00/);
    expect(show.out).toMatch(/status\s+"paid" {2}-> {2}"refunded"/);
    expect(show.out).toContain("(2 other columns unchanged)");
    expect(show.out).toContain("#2 delete public.orders  id = 2");
    expect(show.out).toMatch(/- customer\s+"customer 2"/);
    expect(show.out).toContain("1 delete");

    // Someone who reads it and does not type the word leaves it as it was.
    const declined = await keyturn(logins.alice, ["approve", made.id], ["y"]);
    expect(declined.code).toBe(1);
    expect(declined.asked[0]).toContain("Approve these 2 changes?");
    expect(declined.out).toContain(made.contentHash);
    expect((await agent.proposal(made.id))?.status).toBe("pending");

    const approved = await keyturn(logins.alice, ["approve", made.id], ["approve"]);
    expect(approved).toMatchObject({ code: 0, err: "" });
    expect(await order(1)).toMatchObject({ total: "21.00", status: "paid" });

    const applied = await keyturn(logins.agent, ["apply", made.id]);
    expect(applied.out).toBe("Applied: 2 rows written.");
    expect(await order(1)).toMatchObject({ total: "0.00", status: "refunded" });
    expect(await order(2)).toBeUndefined();

    const audit = await keyturn(logins.alice, ["verify-audit"]);
    expect(audit.code).toBe(0);
    expect(audit.out).toMatch(/3 entries\.\nhead [0-9a-f]{64}/);
  });

  test("approves without a person only the content whose hash it is given", async () => {
    const made = await agent.propose([
      { table: "orders", operation: "update", key: { id: 3 }, set: { status: "shipped" } },
    ]);
    const nobody = await keyturn(logins.alice, ["approve", made.id]);
    expect(nobody.code).toBe(2);
    expect(nobody.err).toContain("--hash");

    const wrong = await keyturn(logins.alice, ["approve", made.id, "--hash", "f".repeat(64)]);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("Refused:");
    expect((await agent.proposal(made.id))?.status).toBe("pending");

    const right = await keyturn(logins.alice, [
      "approve",
      made.id,
      "--hash",
      made.contentHash,
      "--apply",
      "--json",
    ]);
    expect(right.code).toBe(0);
    expect(JSON.parse(right.out)).toEqual({
      id: made.id,
      approved: true,
      outcome: { status: "applied", changes: 1 },
    });
    expect((await order(3)).status).toBe("shipped");
  });

  test("refuses each login what the database refuses it", async () => {
    const made = await agent.propose([
      { table: "orders", operation: "update", key: { id: 4 }, set: { status: "shipped" } },
    ]);
    const own = await keyturn(logins.agent, ["approve", made.id, "--hash", made.contentHash]);
    expect(own).toMatchObject({ code: 1, out: "" });
    expect(own.err).toContain("Refused:");

    expect((await keyturn(logins.agent, ["apply", made.id])).err).toContain(
      "pending, not approved",
    );
    expect((await keyturn(logins.agent, ["protect", "orders"])).code).toBe(1);
    expect((await keyturn(logins.agent, ["doctor"])).code).toBe(1);
    expect((await keyturn(logins.agent, ["uninstall", "--yes"])).code).toBe(1);
    expect((await keyturn(logins.otherAgent, ["show", made.id])).err).toContain("no proposal");
    expect((await keyturn(logins.stranger, ["list"])).code).toBe(1);

    const rejected = await keyturn(logins.alice, [
      "reject",
      made.id,
      "--reason",
      "Not yet shipped.",
    ]);
    expect(rejected.code).toBe(0);
    expect(await agent.proposal(made.id)).toMatchObject({
      status: "rejected",
      reason: "Not yet shipped.",
    });
    const late = await keyturn(logins.agent, ["apply", made.id]);
    expect(late.code).toBe(1);
    expect(late.err).toContain("rejected");
  });

  test("says how much of a large proposal is on the screen", async () => {
    const made = await agent.propose(
      Array.from({ length: 150 }, (_, index) => ({
        table: "orders",
        operation: "delete" as const,
        key: { id: 20 + index },
      })),
      { note: "Clean up old orders." },
    );
    const show = await keyturn(logins.alice, ["show", made.id, "--rows", "10"]);
    expect(show.out).toContain("150 deletes");
    expect(show.out).toContain("Rows 1 to 10 of 150 are shown. --from 11 shows the next");
    expect(show.out).not.toContain("#11 ");

    const next = await keyturn(logins.alice, ["show", made.id, "--rows", "10", "--from", "141"]);
    expect(next.out).toContain("#150 delete");
    expect(next.out).not.toContain("are shown");

    // Rows that were not on the screen are not approved by habit: the word is not enough, the number is asked for.
    const habit = await keyturn(logins.alice, ["approve", made.id], ["approve"]);
    expect(habit.asked[0]).toContain("50 of 150 changes were shown");
    expect(habit.asked[0]).toContain("type that number");
    expect(habit.code).toBe(1);
    expect((await agent.proposal(made.id))?.status).toBe("pending");
    const wrong = await keyturn(logins.alice, ["approve", made.id], ["149"]);
    expect(wrong.code).toBe(1);
    // With every row on the screen, the word is asked for as usual.
    const whole = await keyturn(logins.alice, ["approve", made.id, "--rows", "200"], ["no"]);
    expect(whole.asked[0]).toContain("Approve these 150 changes?");
    await keyturn(logins.alice, ["reject", made.id]);
  });

  test("stale and unknown things end with a plain sentence and a failing exit", async () => {
    const made = await agent.propose([
      { table: "orders", operation: "update", key: { id: 5 }, set: { status: "shipped" } },
    ]);
    await owner.query("update orders set total = 1 where id = 5");
    const stale = await keyturn(logins.alice, [
      "approve",
      made.id,
      "--hash",
      made.contentHash,
      "--apply",
    ]);
    expect(stale.code).toBe(1);
    expect(stale.out).toContain("Nothing was written. The proposal is stale");

    expect((await keyturn(logins.alice, ["show", "zzzz"])).code).toBe(2);
    expect((await keyturn(logins.alice, ["show", "00000000"])).err).toContain("no proposal");
    expect((await keyturn(logins.alice, ["show"])).code).toBe(2);
    expect((await keyturn(logins.alice, ["show", made.id, "--rows", "0"])).code).toBe(2);
    expect((await keyturn(logins.alice, ["frobnicate"])).code).toBe(2);
    expect((await keyturn(logins.alice, ["list", "--nonsense"])).code).toBe(2);
    expect((await keyturn(logins.alice, [])).code).toBe(2);
    expect((await keyturn(logins.alice, ["help"])).code).toBe(0);
    expect((await keyturn(logins.owner, ["uninstall"])).code).toBe(2);
  });

  test("the doctor fails the build when an agent has a way round", async () => {
    await owner.query("grant update on orders to keyturn_agent");
    const doctor = await keyturn(logins.owner, ["doctor"]);
    await owner.query("revoke update on orders from keyturn_agent");
    expect(doctor.code).toBe(1);
    expect(doctor.out).toContain("fail");
    expect(doctor.out).toContain("fix:");
    expect(await doctorFailures()).toEqual([]);
  });

  test("serves the review page until it is told to stop", async () => {
    const out: string[] = [];
    let page = { status: 0, listed: 0 };
    const code = await run(["review", "--port", "0"], {
      env: { KEYTURN_URL: database.url(logins.alice) },
      out: (text) => out.push(text),
      err: () => {},
      color: false,
      until: async () => {
        const [address, key] = (
          /http:\/\/127\.0\.0\.1:\d+\/#\S+/.exec(out.join("\n")) as RegExpExecArray
        )[0].split("#");
        const home = await fetch(address as string);
        const data = await fetch(`${address}api/proposals?show=decided`, {
          headers: { authorization: `Bearer ${key}` },
        });
        page = {
          status: home.status,
          listed: ((await data.json()) as { proposals: unknown[] }).proposals.length,
        };
      },
    });
    expect(code).toBe(0);
    expect(page.status).toBe(200);
    expect(page.listed).toBeGreaterThan(2);
    expect((await keyturn(logins.alice, ["review", "--port", "http"])).code).toBe(2);
  });

  test("approves rows it did not show when their number is typed", async () => {
    const made = await agent.propose(
      Array.from({ length: 12 }, (_, index) => ({
        table: "orders",
        operation: "update" as const,
        key: { id: 181 + index },
        set: { status: "held" },
      })),
    );
    const total = (await agent.proposal(made.id))?.changes as number;
    const typed = await keyturn(logins.alice, ["approve", made.id, "--rows", "5"], [String(total)]);
    expect(typed.asked[0]).toContain(`5 of ${total} changes were shown`);
    expect(typed.code).toBe(0);
    expect((await agent.proposal(made.id))?.status).toBe("approved");
  });

  test("says what is wrong with a command before it looks for a database", async () => {
    const nowhere = async (args: string[]) => {
      const err: string[] = [];
      const code = await run(args, {
        env: { KEYTURN_URL: "postgres://nobody@127.0.0.1:1/none" },
        out: () => {},
        err: (text) => err.push(text),
        color: false,
      });
      return { code, err: err.join("\n") };
    };
    expect(await nowhere(["frobnicate"])).toMatchObject({ code: 2 });
    expect((await nowhere(["approve"])).err).toContain("needs a proposal");
    expect((await nowhere(["protect"])).code).toBe(2);
    expect((await nowhere(["list"])).err).toContain("Could not connect");
    const malformed = await run(["list", "--url", "not a url at all"], {
      env: {},
      out: () => {},
      err: () => {},
      color: false,
    });
    expect(malformed).toBe(1);
  });

  test("prints what a table's own trigger said without letting it repaint the terminal", async () => {
    const esc = String.fromCharCode(27);
    await owner.query(`
      create table guarded (id integer primary key, v text);
      insert into guarded values (1, 'a');
      create function refuse_v() returns trigger language plpgsql as $$ begin raise exception 'value % is not allowed', new.v; end $$;
      create trigger refuse_v before update on guarded for each row execute function refuse_v();
      select keyturn.protect('guarded');
      grant select on guarded to keyturn_agent, keyturn_approver;
    `);
    const made = await agent.propose([
      {
        table: "guarded",
        operation: "update",
        key: { id: 1 },
        set: { v: `x${esc}[2J${esc}[31mapproved` },
      },
    ]);
    const applied = await keyturn(logins.alice, [
      "approve",
      made.id,
      "--hash",
      made.contentHash,
      "--apply",
    ]);
    expect(applied.code).toBe(1);
    expect(applied.out).toContain("The proposal is failed");
    expect(applied.out).toContain("\\u{1b}[2J");
    expect(applied.out + applied.err).not.toContain(esc);
    const again = await keyturn(logins.agent, ["apply", made.id]);
    expect(again.out + again.err).not.toContain(esc);
    const asJson = await keyturn(logins.alice, ["show", made.id, "--json"]);
    expect(asJson.out).not.toContain(esc);
    expect(
      JSON.parse(asJson.out).rows[0].columns.find((c: { column: string }) => c.column === "v")
        .after,
    ).toContain(esc);
  });

  test("ends, and says so, when the database goes away under the review page", async () => {
    const admin = await administrator(database);
    const err: string[] = [];
    const out: string[] = [];
    const code = await run(["review"], {
      env: { KEYTURN_URL: database.url(logins.bob) },
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      color: false,
      until: async () => {
        await admin.query(
          "select pg_terminate_backend(pid) from pg_stat_activity where usename = $1 and datname = current_database()",
          [logins.bob],
        );
        // The page would be told to stop only by a person; the lost connection has to do it.
        await new Promise(() => {});
      },
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("connection to the database was lost");
  });

  test("never prints the password it connected with", async () => {
    const io: Io = { env: {}, out: () => {}, err: () => {}, color: false };
    const said: string[] = [];
    io.err = (text) => said.push(text);
    const code = await run(
      ["list", "--url", "postgres://nobody:hunter2secret@127.0.0.1:1/none"],
      io,
    );
    expect(code).toBe(1);
    expect(said.join("\n")).toContain("Could not connect");
    expect(said.join("\n")).not.toContain("hunter2secret");
  });

  test("runs as a program of its own", async () => {
    const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
    const result = await promisify(execFile)(process.execPath, [bin, "list", "--all", "--json"], {
      env: { ...process.env, KEYTURN_URL: database.url(logins.alice), NO_COLOR: "1" },
    });
    const listed = JSON.parse(result.stdout) as { id: string; status: string }[];
    expect(listed.length).toBeGreaterThan(3);
    expect(new Set(listed.map((proposal) => proposal.status))).toContain("applied");

    const failing = await promisify(execFile)(process.execPath, [bin, "apply", "00000000"], {
      env: { ...process.env, KEYTURN_URL: database.url(logins.alice) },
    }).catch((error) => error);
    expect(failing.code).toBe(1);
    expect(failing.stderr).toContain("Refused:");
  });
});

describe("what a decision rests on, from the terminal", () => {
  test("an approver is shown why it waits and the rows it points to; an agent only the rows", async () => {
    await owner.query(`
      create table accounts (id integer primary key, holder text not null, credit_limit integer not null);
      create table charges (id integer primary key, account integer references accounts (id), amount integer not null);
      insert into accounts values (1, 'Ada Lund', 500);
      select keyturn.protect('charges');
      grant select on accounts, charges to keyturn_agent, keyturn_approver;
      select keyturn.allow('small_charges', 'charges', array['insert'], array['id', 'account', 'amount'],
                           condition => '(after ->> ''amount'')::integer <= 100');
    `);
    const proposer = new Keyturn(await database.as(logins.agent));
    const made = await proposer.propose([
      { table: "charges", operation: "insert", values: { id: 1, account: 1, amount: 450 } },
      { table: "charges", operation: "insert", values: { id: 2, account: 77, amount: 5 } },
    ]);

    const forApprover = await keyturn(logins.alice, ["show", made.id]);
    expect(forApprover.code).toBe(0);
    expect(forApprover.out).toContain(
      "the rule small_charges lets through one row in a proposal, and this one holds 2",
    );
    expect(forApprover.out).toContain("refers to public.accounts  account = 1  (as it is now)");
    expect(forApprover.out).toMatch(/holder\s+"Ada Lund"/);
    expect(forApprover.out).toMatch(/credit_limit\s+500/);
    expect(forApprover.out).toContain("refers to public.accounts  account = 77: no such row");

    const forAgent = await keyturn(logins.agent, ["show", made.id]);
    expect(forAgent.out).not.toContain("small_charges");
    expect(forAgent.out).toContain("refers to public.accounts  account = 1");

    const asJson = JSON.parse((await keyturn(logins.alice, ["show", made.id, "--json"])).out);
    expect(asJson.references).toHaveLength(2);
    expect(asJson.waits[0]).toMatchObject({ seq: null, rule: "small_charges" });
    await new Keyturn(await database.as(logins.alice)).reject(made.id);
  });

  test("a row whose key the table makes for itself is shown, with no key yet", async () => {
    await owner.query(`
      create table remarks (id serial primary key, account integer references accounts (id), body text not null);
      select keyturn.protect('remarks');
      grant select on remarks to keyturn_agent, keyturn_approver;
    `);
    const proposer = new Keyturn(await database.as(logins.agent));
    const made = await proposer.propose([
      { table: "remarks", operation: "insert", values: { account: 1, body: "Called back." } },
    ]);
    const shown = await keyturn(logins.alice, ["show", made.id]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("#1 insert public.remarks");
    expect(shown.out).toMatch(/body\s+"Called back."/);
    expect(shown.out).toContain("refers to public.accounts  account = 1");
    await new Keyturn(await database.as(logins.alice)).reject(made.id);
  });
});
