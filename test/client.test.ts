import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  install,
  installed,
  Keyturn,
  protect,
  Refused,
  Undecided,
  uninstall,
} from "../src/index.ts";
import { json, plain, renderProposal } from "../src/render.ts";
import { Database, logins } from "./database.ts";

const schema = `
  create table accounts (
    id       integer primary key,
    holder   text not null,
    balance  numeric(30, 4) not null default 0,
    flags    jsonb not null default '{}',
    closed   boolean not null default false,
    memo     text
  );
  insert into accounts (id, holder, balance) select n, 'holder ' || n, 100 from generate_series(1, 300) as n;
  select keyturn.protect('accounts');
  grant select on accounts to keyturn_agent, keyturn_approver;
`;

let database: Database;
let owner: pg.Client;
let agent: Keyturn;
let alice: Keyturn;

beforeAll(async () => {
  database = await Database.create(schema);
  owner = await database.as(logins.owner);
  agent = new Keyturn(await database.as(logins.agent));
  alice = new Keyturn(await database.as(logins.alice));
});

afterAll(async () => {
  await database.close();
});

const balance = async (id: number) =>
  (await owner.query("select balance from accounts where id = $1", [id])).rows[0]?.balance;

describe("the client", () => {
  test("proposes, shows what would change, and applies once someone else approved what was shown", async () => {
    const made = await agent.propose(
      [{ table: "accounts", operation: "update", key: { id: 1 }, set: { balance: 250 } }],
      { note: "Deposit cleared.", validFor: "2 hours" },
    );

    const waiting = await alice.waiting();
    expect(waiting.map((proposal) => proposal.id)).toContain(made.id);
    const proposal = await alice.proposal(made.id);
    expect(proposal).toMatchObject({
      id: made.id,
      proposedBy: logins.agent,
      note: "Deposit cleared.",
      status: "pending",
      contentHash: made.contentHash,
      expired: false,
      decidedBy: null,
      changes: 1,
    });
    expect(await alice.extent(made.id)).toEqual([
      { table: "public.accounts", operation: "update", rows: 1 },
    ]);
    const [row] = await alice.diff(made.id);
    expect(row).toMatchObject({
      seq: 1,
      table: "public.accounts",
      operation: "update",
      key: { id: "1" },
    });
    expect(row?.columns.map((column) => column.column)).toEqual([
      "id",
      "holder",
      "balance",
      "flags",
      "closed",
      "memo",
    ]);
    expect(row?.columns.filter((column) => column.changed)).toEqual([
      {
        column: "balance",
        before: "100.0000",
        after: "250.0000",
        beforeKind: "number",
        afterKind: "number",
        changed: true,
      },
    ]);

    await alice.approve(made.id, made.contentHash);
    expect(await agent.apply(made.id)).toEqual({ status: "applied", changes: 1 });
    expect(await agent.apply(made.id)).toEqual({ status: "applied", changes: 1 });
    expect(await balance(1)).toBe("250.0000");
  });

  test("shows a reviewer every digit of a number, and tells null from the word and from a value not given", async () => {
    const made = await agent.propose([
      {
        table: "accounts",
        operation: "update",
        key: { id: 2 },
        // More digits than a JavaScript number holds. Sent as text, kept by the database as a number.
        set: { balance: "12345678901234567890.1234", memo: "null" },
      },
      { table: "accounts", operation: "insert", values: { id: 900, holder: "new holder" } },
    ]);
    const [update, insert] = await alice.diff(made.id);
    const changed = Object.fromEntries(
      (update?.columns ?? [])
        .filter((column) => column.changed)
        .map((column) => [column.column, column]),
    );
    expect(changed.balance).toMatchObject({
      after: "12345678901234567890.1234",
      afterKind: "number",
    });
    expect(changed.memo).toMatchObject({
      before: null,
      beforeKind: "null",
      after: "null",
      afterKind: "string",
    });
    expect(insert?.columns).toEqual([
      {
        column: "id",
        before: null,
        after: "900",
        beforeKind: "absent",
        afterKind: "number",
        changed: true,
      },
      {
        column: "holder",
        before: null,
        after: "new holder",
        beforeKind: "absent",
        afterKind: "string",
        changed: true,
      },
    ]);
  });

  test("names a row by a key larger than a program's numbers, digit for digit", async () => {
    await owner.query(`
      create table ledger (id bigint primary key, amount numeric not null);
      insert into ledger values (9007199254740993, 1), (9007199254740992, 2);
      select keyturn.protect('ledger');
      grant select on ledger to keyturn_agent, keyturn_approver;
    `);
    const made = await agent.propose([
      { table: "ledger", operation: "update", key: { id: "9007199254740993" }, set: { amount: 5 } },
    ]);
    const [row] = await alice.diff(made.id);
    expect(row?.key).toEqual({ id: "9007199254740993" });
    const proposal = await alice.proposal(made.id);
    const text = renderProposal(
      proposal as NonNullable<typeof proposal>,
      await alice.extent(made.id),
      [row as NonNullable<typeof row>],
      {
        color: false,
        full: false,
        unchanged: false,
      },
    );
    expect(text).toContain("id = 9007199254740993");
  });

  test("is refused a pool for installing, which needs one connection", async () => {
    const { default: postgres } = await import("pg");
    const pool = new postgres.Pool({ connectionString: database.url(logins.owner), max: 2 });
    try {
      await expect(install(pool)).rejects.toThrow("one connection, not a pool");
      await expect(uninstall(pool)).rejects.toThrow("one connection, not a pool");
      // The client itself is at home on a pool.
      expect(await new Keyturn(pool).waiting()).toBeInstanceOf(Array);
    } finally {
      await pool.end();
    }
  });

  test("gives a large proposal a page at a time", async () => {
    const made = await agent.propose(
      Array.from({ length: 120 }, (_, index) => ({
        table: "accounts",
        operation: "delete" as const,
        key: { id: 100 + index },
      })),
    );
    expect(await alice.extent(made.id)).toEqual([
      { table: "public.accounts", operation: "delete", rows: 120 },
    ]);
    expect((await alice.diff(made.id)).map((row) => row.seq)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    expect((await alice.diff(made.id, { from: 101, count: 50 })).map((row) => row.seq)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 101),
    );
  });

  test("turns the database's no into a refusal that says why", async () => {
    const made = await agent.propose([
      { table: "accounts", operation: "update", key: { id: 3 }, set: { closed: true } },
    ]);
    const own = await agent.approve(made.id, made.contentHash).catch((error) => error);
    expect(own).toBeInstanceOf(Refused);
    expect(own.code).toBe("42501");

    const swapped = await alice.approve(made.id, "0".repeat(64)).catch((error) => error);
    expect(swapped).toBeInstanceOf(Refused);
    expect(swapped.message).not.toContain("keyturn:");

    const early = await agent.apply(made.id).catch((error) => error);
    expect(early).toBeInstanceOf(Refused);
    expect(early.message).toContain("pending, not approved");

    const noRow = await agent
      .propose([{ table: "accounts", operation: "delete", key: { id: 99999 } }])
      .catch((error) => error);
    expect(noRow).toBeInstanceOf(Refused);
  });

  test("shows an agent only its own proposals", async () => {
    const other = new Keyturn(await database.as(logins.otherAgent));
    const made = await agent.propose([
      { table: "accounts", operation: "update", key: { id: 4 }, set: { closed: true } },
    ]);
    expect(await other.proposal(made.id)).toBeNull();
    expect(await other.diff(made.id)).toEqual([]);
    expect((await other.waiting()).map((proposal) => proposal.id)).not.toContain(made.id);
  });

  test("waits for a decision, and says so when none comes", async () => {
    const approved = await agent.propose([
      { table: "accounts", operation: "update", key: { id: 5 }, set: { closed: true } },
    ]);
    const waitingFor = agent.decision(approved.id, { everyMs: 50, timeoutMs: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await alice.approve(approved.id, approved.contentHash);
    expect(await waitingFor).toMatchObject({ status: "approved", decidedBy: logins.alice });

    const rejected = await agent.propose([
      { table: "accounts", operation: "update", key: { id: 6 }, set: { closed: true } },
    ]);
    await alice.reject(rejected.id, "Account is in dispute.");
    expect(await agent.decision(rejected.id)).toMatchObject({
      status: "rejected",
      reason: "Account is in dispute.",
    });

    const ignored = await agent.propose([
      { table: "accounts", operation: "update", key: { id: 7 }, set: { closed: true } },
    ]);
    await expect(
      agent.decision(ignored.id, { everyMs: 50, timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(Undecided);
    const stopped = new AbortController();
    stopped.abort();
    await expect(agent.decision(ignored.id, { signal: stopped.signal })).rejects.toThrow();

    const brief = await agent.propose(
      [{ table: "accounts", operation: "update", key: { id: 8 }, set: { closed: true } }],
      { validFor: "0.3 seconds" },
    );
    await expect(agent.decision(brief.id, { everyMs: 100, timeoutMs: 20_000 })).rejects.toThrow(
      "expired",
    );
  });

  test("checks the database and the audit log", async () => {
    const keeper = new Keyturn(owner);
    // Faulty agents another test file makes on the same server are not this database's.
    expect(
      (await keeper.doctor()).filter(
        (finding) => finding.level === "fail" && !/^(wrong|both)_/.test(finding.about),
      ),
    ).toEqual([]);
    expect(await alice.verifyAudit()).toEqual([]);
    const head = await alice.auditHead();
    expect(head.entries).toBeGreaterThan(0);
    expect(head.head).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("one rule for what does not show", () => {
  test("is the same on the page and in the terminal, for every character there is", async () => {
    const page = (await import("../review/hidden.js")) as { hidden(character: string): boolean };
    const differing: string[] = [];
    let masked = 0;
    for (let code = 0; code <= 0x10ffff; code += 1) {
      // Half a pair is not a character anyone can write on its own.
      if (code >= 0xd800 && code <= 0xdfff) {
        continue;
      }
      const character = String.fromCodePoint(code);
      const inTerminal = plain(character) !== character;
      if (page.hidden(character) !== inTerminal) {
        differing.push(code.toString(16));
      }
      masked += inTerminal ? 1 : 0;
    }
    expect(differing).toEqual([]);
    expect(masked).toBeGreaterThan(1000);
  });

  test("covers the characters that hide, reverse, join or stand in for nothing", () => {
    for (const code of [
      0x00, 0x1b, 0x7f, 0x9b, 0xad, 0x34f, 0x61c, 0x115f, 0x180e, 0x200b, 0x200d, 0x202e, 0x2028,
      0x2066, 0x3164, 0xfe0f, 0xfeff, 0xffa0, 0xfff9, 0xe0041, 0xe0101,
    ]) {
      const character = String.fromCodePoint(code);
      expect(plain(`a${character}b`), code.toString(16)).toBe(`a\\u{${code.toString(16)}}b`);
    }
    expect(plain("Søren's café, 東京 – naïve façade ½ € 😀\tok\nnext")).toBe(
      "Søren's café, 東京 – naïve façade ½ € 😀\tok\nnext",
    );
  });

  test("is kept to in JSON as well, which stays JSON", () => {
    const value = {
      note: `a${String.fromCharCode(0x9b)}2J${String.fromCodePoint(0x202e)}b${String.fromCodePoint(0xe0041)}`,
      n: 1,
    };
    const text = json(value);
    expect(text).not.toMatch(/[\u0080-\u009f\u202e]/);
    expect(text).toContain("\\u009b");
    expect(text).toContain("\\udb40\\udc41");
    expect(JSON.parse(text)).toEqual(value);
  });
});

describe("what a reviewer is shown", () => {
  const esc = String.fromCharCode(27);
  const override = String.fromCodePoint(0x202e);

  test("cannot be repainted by what an agent wrote", async () => {
    const hostile = `ok${esc}[2J${esc}[1;1Happroved by alice${override}`;
    const made = await agent.propose(
      [{ table: "accounts", operation: "update", key: { id: 9 }, set: { memo: hostile } }],
      { note: hostile },
    );
    const proposal = await alice.proposal(made.id);
    const text = renderProposal(
      proposal as NonNullable<typeof proposal>,
      await alice.extent(made.id),
      await alice.diff(made.id),
      { color: false, full: false, unchanged: false },
    );
    expect(text).not.toContain(esc);
    expect(text).not.toContain(override);
    expect(text).toContain("\\u{1b}[2J");
    expect(text).toContain("\\u{202e}");
  });

  test("keeps ordinary text as it is", () => {
    expect(plain("Søren's café, 東京\tok\nnext")).toBe("Søren's café, 東京\tok\nnext");
    expect(plain(`a${String.fromCharCode(0)}b${String.fromCodePoint(0x200b)}c`)).toBe(
      "a\\u{0}b\\u{200b}c",
    );
  });
});

describe("installing", () => {
  test("puts keyturn in, all of it or none, and takes it out leaving the tables", async () => {
    const empty = await Database.bare();
    try {
      const keeper = await empty.as(logins.owner);
      expect(await installed(keeper)).toBeNull();

      const done = await install(keeper);
      expect(done.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(await installed(keeper)).toBe(done.version);
      await expect(install(keeper)).rejects.toThrow("already installed");

      await keeper.query("create table things (id integer primary key, body text)");
      await keeper.query("insert into things values (1, 'kept')");
      await protect(keeper, "things");
      await expect(protect(keeper, "nothing_here")).rejects.toThrow();

      await uninstall(keeper);
      expect(await installed(keeper)).toBeNull();
      expect((await keeper.query("select body from things")).rows).toEqual([{ body: "kept" }]);
      expect(
        (await keeper.query("select from pg_namespace where nspname in ('keyturn', 'proposal')"))
          .rowCount,
      ).toBe(0);

      // Installed again after being taken out, by the same script.
      await install(keeper);
      expect(await installed(keeper)).toBe(done.version);
    } finally {
      await empty.close();
    }
  });

  test("leaves nothing behind when it cannot finish", async () => {
    const empty = await Database.bare();
    try {
      const keeper = await empty.as(logins.owner);
      // Something already holds a name the install needs.
      await keeper.query("create schema proposal");
      await expect(install(keeper)).rejects.toThrow();
      expect(await installed(keeper)).toBeNull();
      expect(
        (await keeper.query("select from pg_namespace where nspname = 'keyturn'")).rowCount,
      ).toBe(0);
    } finally {
      await empty.close();
    }
  });

  test("is refused to a login that owns nothing here", async () => {
    const empty = await Database.bare();
    try {
      const stranger = await empty.as(logins.stranger);
      await expect(install(stranger)).rejects.toThrow();
      expect(await installed(stranger)).toBeNull();
    } finally {
      await empty.close();
    }
  });
});
