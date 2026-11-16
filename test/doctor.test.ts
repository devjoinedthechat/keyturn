import type pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { administrator, Database, logins, propose, refusal } from "./database.ts";

const schema = `
  create table ledger (id integer primary key, amount numeric(12, 2) not null, memo text);
  insert into ledger values (1, 10, null);
  select keyturn.protect('ledger');
  grant select on ledger to keyturn_agent, keyturn_approver;
`;

let database: Database;
let owner: pg.Client;
let admin: pg.Client;

beforeAll(async () => {
  database = await Database.create(schema);
  owner = await database.as(logins.owner);
  admin = await administrator(database);
});

afterAll(async () => {
  await database.close();
});

type Finding = { level: string; about: string; finding: string; fix: string | null };
// Logins belong to the whole server, and other test files make wrong ones of their own while
// this one runs. Only the standing logins and this file's own are looked at.
const mine = (found: Finding) =>
  !/^(wrong|both)_/.test(found.about) || found.about.includes(database.name);
const findings = async (): Promise<Finding[]> =>
  (await admin.query("select * from keyturn.doctor()")).rows.filter(mine);
const sound = async () => (await findings()).every((found) => found.level !== "fail");
const failures = async (about: string) =>
  (await findings())
    .filter((found) => found.level === "fail" && found.about === about)
    .map((found) => found.finding);

/** Makes a wrong agent for one test, and removes it and everything it was given afterwards. */
async function withAgent(
  fault: (role: string) => string,
  check: (role: string) => Promise<void>,
): Promise<void> {
  const role = `wrong_${database.name}_${Math.random().toString(36).slice(2, 8)}`;
  await admin.query(`create role ${role} login password 'test-only' in role keyturn_agent`);
  try {
    await admin.query(fault(role));
    await check(role);
  } finally {
    await admin.query(`reset role; drop owned by ${role}; drop role ${role}`);
  }
}

test("a database set up as intended has nothing wrong with it", async () => {
  expect((await findings()).filter((found) => found.level === "fail")).toEqual([]);
  expect(await sound()).toBe(true);
});

test.each([
  [
    "was granted an update on the table",
    (role: string) => `grant update on ledger to ${role}`,
    "may update public.ledger",
  ],
  [
    "was granted a delete",
    (role: string) => `grant delete on ledger to ${role}`,
    "may delete public.ledger",
  ],
  [
    "may truncate",
    (role: string) => `grant truncate on ledger to ${role}`,
    "may truncate public.ledger",
  ],
  [
    "may write one column",
    (role: string) => `grant update (memo) on ledger to ${role}`,
    "may write some columns of public.ledger",
  ],
  ["is a superuser", (role: string) => `alter role ${role} superuser`, "is a superuser"],
  [
    "bypasses row-level security",
    (role: string) => `alter role ${role} bypassrls`,
    "bypasses row-level security",
  ],
  [
    "can create roles",
    (role: string) => `alter role ${role} createrole`,
    "can create and alter roles",
  ],
  [
    "is also an approver",
    (role: string) => `grant keyturn_approver to ${role}`,
    "is both an agent and an approver",
  ],
  [
    "is a member of the table's owner",
    (role: string) => `grant ${logins.owner} to ${role}`,
    "owns public.ledger, or is a member of the role that does",
  ],
  [
    "may write anything, through a role built into the server",
    (role: string) => `grant pg_write_all_data to ${role}`,
    "may update public.ledger",
  ],
])("an agent that %s is reported", async (_name, fault, expected) => {
  await withAgent(fault, async (role) => {
    expect((await failures(role)).join("; ")).toContain(expected);
    expect(await sound()).toBe(false);
    expect((await admin.query("select keyturn.doctor_ok() as ok")).rows[0].ok).toBe(false);
  });
  // With the wrong agent gone, the database is sound again.
  expect(await sound()).toBe(true);
});

test("a write granted to everyone is reported for every agent", async () => {
  await owner.query("grant insert on ledger to public");
  try {
    expect((await failures(logins.agent)).join("; ")).toContain("may insert public.ledger");
    expect((await failures("keyturn_agent")).join("; ")).toContain("may insert public.ledger");
  } finally {
    await owner.query("revoke insert on ledger from public");
  }
});

test("a role the agent could switch to, which can write, is reported even though the agent inherits nothing from it", async () => {
  await withAgent(
    (role) =>
      `create role writer_${role} nologin; grant update on ledger to writer_${role}; grant writer_${role} to ${role} with inherit false`,
    async (role) => {
      // has_table_privilege says no: nothing is inherited. SET ROLE would get there all the same.
      expect(
        (await admin.query("select has_table_privilege($1, 'ledger', 'UPDATE') as may", [role]))
          .rows[0].may,
      ).toBe(false);
      try {
        expect((await failures(role)).join("; ")).toContain(
          `is a member of writer_${role}, which may write public.ledger`,
        );
      } finally {
        await admin.query(`drop owned by writer_${role}; drop role writer_${role}`);
      }
    },
  );
});

test("a function that writes with its owner's rights, and that the agent may run, is reported", async () => {
  await owner.query(`
    create function set_amount(p_id integer, p_amount numeric) returns void language sql security definer
      as $$ update ledger set amount = p_amount where id = p_id $$;
  `);
  try {
    // New functions can be run by everyone unless that is taken away. This is the commonest way round.
    const found = await failures(logins.agent);
    expect(found.join("; ")).toContain(
      "may run public.set_amount(integer,numeric), which runs with the rights of a role that can write a protected table",
    );
    // And it is a real way in, not a theoretical one.
    const agent = await database.as(logins.agent);
    await agent.query("select set_amount(1, 999999)");
    expect((await owner.query("select amount::text from ledger where id = 1")).rows[0].amount).toBe(
      "999999.00",
    );

    await owner.query("revoke execute on function set_amount(integer, numeric) from public");
    expect(await failures(logins.agent)).toEqual([]);
    expect((await refusal(agent.query("select set_amount(1, 1)")))?.code).toBe("42501");
  } finally {
    await owner.query(
      "drop function set_amount(integer, numeric); update ledger set amount = 10 where id = 1",
    );
  }
});

test("a table that has changed shape, has triggers, or is the target of a cascade is pointed out", async () => {
  await owner.query(`
    create table entries (id integer primary key, ledger_id integer not null references ledger (id) on delete cascade);
    create function noop() returns trigger language plpgsql as $$ begin return new; end $$;
    create trigger noop before update on ledger for each row execute function noop();
    alter table ledger add column added text;
  `);
  try {
    const about = (await findings()).filter(
      (found) => found.about === "public.ledger" || found.about === "ledger",
    );

    expect(about.find((found) => found.level === "fail")?.finding).toContain(
      "has changed shape since it was protected",
    );
    expect(
      about
        .filter((found) => found.level === "note")
        .map((found) => found.finding)
        .join("; "),
    ).toContain("has triggers of its own");
    expect(
      about
        .filter((found) => found.level === "note")
        .map((found) => found.finding)
        .join("; "),
    ).toContain("referenced by a foreign key that cascades");
    // The fix it gives is the fix.
    await owner.query(about.find((found) => found.level === "fail")?.fix as string);
    expect(await sound()).toBe(true);
  } finally {
    await owner.query(
      "drop table entries; drop trigger noop on ledger; drop function noop(); alter table ledger drop column added; select keyturn.protect('ledger')",
    );
  }
});

test("the agent cannot run the doctor, which would tell it where to push", async () => {
  const agent = await database.as(logins.agent);

  expect((await refusal(agent.query("select * from keyturn.doctor()")))?.code).toBe("42501");
  // It still works as an agent.
  expect(
    (
      await propose(agent, [
        { table: "ledger", operation: "update", key: { id: 1 }, set: { memo: "x" } },
      ])
    ).content_hash,
  ).toMatch(/^[0-9a-f]{64}$/);
});
