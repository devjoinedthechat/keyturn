import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Io, run } from "../src/cli.ts";
import { Keyturn } from "../src/index.ts";
import { Database, logins } from "./database.ts";

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
    const doctor = await keyturn(logins.owner, ["doctor"]);
    expect(doctor).toMatchObject({ code: 0, err: "" });

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
    expect(declined.asked[0]).toContain("all 2 of these changes");
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

    const asked = await keyturn(logins.alice, ["approve", made.id], ["no"]);
    expect(asked.asked[0]).toContain("all 150 of these changes");
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
    expect((await keyturn(logins.owner, ["doctor", "--json"])).code).toBe(0);
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
