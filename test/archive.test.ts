import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Io, run } from "../src/cli.ts";
import { prune, verifyArchive, writeArchive } from "../src/index.ts";
import { apply, Database, logins, propose, refusal } from "./database.ts";

const schema = `
  create table orders (id integer primary key, customer text not null, total numeric(10, 2) not null, status text not null default 'paid');
  insert into orders select n, 'customer ' || n, 20 + n from generate_series(1, 100) as n;
  select keyturn.protect('orders');
  grant select on orders to keyturn_agent, keyturn_approver;
`;

let database: Database;
let owner: pg.Client;
let agent: pg.Client;
let alice: pg.Client;
let folder: string;
const made: Record<string, string> = {};

const update = (id: number, set: Record<string, unknown> = { status: "held" }) => ({
  table: "orders",
  operation: "update",
  key: { id },
  set,
});
const head = async () =>
  (await owner.query("select entries::int as entries, head from keyturn.audit_head()")).rows[0] as {
    entries: number;
    head: string;
  };
const count = async (table: string) =>
  (await owner.query(`select count(*)::int as n from keyturn.${table}`)).rows[0].n as number;

async function keyturn(login: string, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    env: { KEYTURN_URL: database.url(login) },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    color: false,
  };
  const code = await run(args, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

beforeAll(async () => {
  database = await Database.create(schema);
  [owner, agent, alice] = await Promise.all([
    database.as(logins.owner),
    database.as(logins.agent),
    database.as(logins.alice),
  ]);
  folder = await mkdtemp(join(tmpdir(), "keyturn-archive-"));

  const approve = (proposal: { proposal_id: string; content_hash: string }) =>
    alice.query("select keyturn.approve($1, $2)", [proposal.proposal_id, proposal.content_hash]);
  const applied = await propose(agent, [update(1), update(2, { total: 0 })], "Two changes.");
  await approve(applied);
  await apply(agent, applied.proposal_id);
  made.applied = applied.proposal_id;
  const rejected = await propose(agent, [update(3)]);
  await alice.query("select keyturn.reject($1, $2)", [rejected.proposal_id, "No."]);
  made.rejected = rejected.proposal_id;
  const reverted = await propose(agent, [update(4)]);
  await approve(reverted);
  await apply(agent, reverted.proposal_id);
  await alice.query("select keyturn.revert($1)", [reverted.proposal_id]);
  made.reverted = reverted.proposal_id;
  // Not finished: these stay, whatever the date.
  made.waiting = (await propose(agent, [update(5)], "Still waiting.")).proposal_id;
  const approved = await propose(agent, [update(6)]);
  await approve(approved);
  made.approved = approved.proposal_id;
});

afterAll(async () => {
  await database.close();
});

describe("putting old records away", () => {
  test("writes the finished proposals to a file that holds together, and removes nothing by itself", async () => {
    const path = join(folder, "kept.jsonl");
    const before = await head();
    const written = await writeArchive(owner, new Date(), path);
    expect(written).toMatchObject({ keyturn: "archive", proposals: 3, entries: 9 });
    expect(await verifyArchive(path)).toEqual(written);
    expect(await head()).toEqual(before);

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(5);
    const first = JSON.parse(lines[1] as string);
    expect(first.proposal.id).toBe(made.applied);
    const content = JSON.parse(first.content_text);
    expect(content.changes).toHaveLength(2);
    expect(content.changes[0].before.status).toBe("paid");
    expect(first.audit.map((entry: { event: string }) => entry.event)).toEqual([
      "opened",
      "approved",
      "applied",
    ]);

    // A file is never written over.
    expect((await refusal(writeArchive(owner, new Date(), path)))?.message).toContain(
      "is already there",
    );
  });

  test("a file that was altered, cut short, rearranged or added to does not hold together", async () => {
    const good = await readFile(join(folder, "kept.jsonl"), "utf8");
    const lines = good.trim().split("\n");
    const check = async (name: string, text: string) => {
      const path = join(folder, name);
      await writeFile(path, text);
      return (await refusal(verifyArchive(path)))?.message ?? "held together";
    };
    // A row of an approved proposal: it is no longer what the approval named.
    expect(await check("rows.jsonl", good.replace(/\\"total\\": 0/, '\\"total\\": 999'))).toContain(
      "are not the rows that were approved",
    );
    // An entry: its own hash no longer fits.
    expect(
      await check("entry.jsonl", good.replace(/"actor": ?"[^"]+"/, '"actor": "somebody_else"')),
    ).toContain("has been changed");
    // A proposal that was never approved has no hash of its own in the log. The file's last line still covers it.
    expect(
      await check("rejected.jsonl", good.replace('"reason": "No."', '"reason": "Yes."')),
    ).toContain("altered since it was written");
    expect(
      await check("moved.jsonl", [lines[0], lines[2], lines[1], lines[3], lines[4]].join("\n")),
    ).toContain("altered since it was written");
    expect(await check("short.jsonl", lines.slice(0, 3).join("\n"))).toContain("it was cut short");
    expect(await check("more.jsonl", `${good}${lines[1]}\n`)).toContain(
      "something after its last line",
    );
    // Its first line, which says what it holds, is under the file's hash as well.
    const first = JSON.parse(lines[0] as string) as { before: string };
    first.before = "2001-01-01T00:00:00.000Z";
    expect(
      await check("head.jsonl", [JSON.stringify(first), ...lines.slice(1)].join("\n")),
    ).toContain("altered since it was written");
    expect(await check("number.jsonl", good.replace(/"seq": ?"[0-9]+"/, '"seq": "1n"'))).toContain(
      "has no number",
    );
    expect(await check("null.jsonl", `${lines[0]}\nnull\n`)).toContain("is not a proposal");
    expect(await check("empty.jsonl", "")).toContain("it is empty");
    // A record with its first entry gone, the rest still a chain of its own.
    const cut = JSON.parse(lines[1] as string) as { audit: unknown[] };
    cut.audit = [];
    expect(
      await check("beginning.jsonl", [lines[0], JSON.stringify(cut), ...lines.slice(2)].join("\n")),
    ).toContain("does not begin where it was made");
    expect((await refusal(verifyArchive(join(folder, "not-there.jsonl"))))?.message).toContain(
      "cannot be read",
    );
  });

  test("removes exactly what the file holds, and leaves a mark, a whole log and what is unfinished", async () => {
    const path = join(folder, "removed.jsonl");
    const moment = new Date();
    const written = await writeArchive(owner, moment, path);
    const before = await head();

    // Only the owner removes, and only against the digest of what was written.
    for (const client of [agent, alice]) {
      expect(
        (await refusal(client.query("select keyturn.prune($1, $2)", [moment, written.digest])))
          ?.code,
      ).toBe("42501");
    }
    expect((await refusal(prune(owner, moment, { digest: "0".repeat(64) })))?.message).toContain(
      "that is not the digest of what would be removed",
    );
    expect(await head()).toEqual(before);

    // Somebody has one of the proposals open. The removal does not wait for them: it stops.
    const other = await database.as(logins.owner);
    await other.query("begin");
    await other.query("select from keyturn.proposals where id = $1 for update", [made.rejected]);
    const held = await refusal(prune(owner, moment, written));
    expect(held?.message).toContain("in use by another connection. Nothing is removed");
    await other.query("rollback");
    expect(await head()).toEqual(before);

    const done = await prune(owner, moment, written);
    expect(done).toMatchObject({
      proposals: 3,
      entries: 9,
      digest: written.digest,
      head_before: before.head,
    });
    expect(await count("proposals")).toBe(2);
    expect(await count("changes")).toBe(2);
    expect((await head()).entries).toBe(before.entries - 9);
    expect((await head()).head).toBe(done.head_after);
    expect((await alice.query("select * from keyturn.verify_audit()")).rows).toEqual([]);
    expect(
      (
        await alice.query(
          "select by::text, proposals::int, entries::int, digest, file, head_before, head_after from keyturn.archived",
        )
      ).rows,
    ).toEqual([
      {
        by: logins.owner,
        proposals: 3,
        entries: 9,
        digest: written.digest,
        file: written.file,
        head_before: before.head,
        head_after: done.head_after,
      },
    ]);
    // The tables themselves are as the proposals left them.
    expect((await owner.query("select status from orders where id = 1")).rows[0].status).toBe(
      "held",
    );

    // What was waiting is still decided and applied as before.
    await alice.query("select keyturn.reject($1)", [made.waiting]);
    expect((await apply(agent, made.approved as string)).status).toBe("applied");
    expect((await alice.query("select * from keyturn.verify_audit()")).rows).toEqual([]);
  });

  test("the log is still closed to everything else", async () => {
    expect(
      (await refusal(owner.query("update keyturn.audit set actor = 'nobody'")))?.message,
    ).toContain("never changed or emptied");
    // No word said in a session opens it. Only a removal that has left its mark gets through.
    await owner.query("set keyturn.pruning = 'on'");
    expect((await refusal(owner.query("delete from keyturn.audit")))?.message).toContain(
      "never changed or emptied",
    );
    await owner.query("reset keyturn.pruning");
    // A removal opens the log for as long as it takes, and not for the rest of its transaction.
    await owner.query("begin");
    await owner.query("select keyturn.prune('2000-01-01', encode(sha256(''::bytea), 'hex'))");
    const after = await refusal(owner.query("delete from keyturn.audit"));
    await owner.query("rollback");
    expect(after?.message).toContain("never changed or emptied");
    expect((await refusal(owner.query("delete from keyturn.audit")))?.message).toContain(
      "never changed or emptied",
    );
    expect((await refusal(owner.query("truncate keyturn.audit")))?.message).toContain(
      "never changed or emptied",
    );
    // A login that sets the same word has no right to remove anything.
    await agent.query("set keyturn.pruning = 'on'");
    expect((await refusal(agent.query("delete from keyturn.audit")))?.code).toBe("42501");
    await agent.query("reset keyturn.pruning");
  });

  test("from the terminal: one command writes, checks and removes; another checks a file with no database", async () => {
    const proposed = await propose(agent, [update(7)]);
    await alice.query("select keyturn.reject($1, $2)", [proposed.proposal_id, "Not now."]);
    const kept = join(folder, "cli-kept.jsonl");
    const keep = await keyturn(logins.owner, [
      "archive",
      "--before",
      new Date().toISOString(),
      "--out",
      kept,
      "--keep",
    ]);
    expect(keep.code).toBe(0);
    expect(keep.out).toContain("Nothing was removed.");

    const path = join(folder, "cli.jsonl");
    const done = await keyturn(logins.owner, [
      "archive",
      "--before",
      new Date().toISOString(),
      "--out",
      path,
    ]);
    expect(done.code).toBe(0);
    expect(done.out).toMatch(
      /Wrote 3 finished proposals, 7 entries to .*cli\.jsonl, and took them out of the database\./,
    );
    expect(await count("proposals")).toBe(0);

    const io: Io = { env: {}, out: () => {}, err: () => {}, color: false };
    const said: string[] = [];
    io.out = (text) => said.push(text);
    expect(await run(["verify-archive", path], io)).toBe(0);
    expect(said.join("\n")).toContain("The archive holds together: 3 proposals, 7 entries");
    expect(await run(["verify-archive", join(folder, "rows.jsonl")], io)).toBe(1);
    // Held against the hash the removal left in the database, it is that file and no other.
    const mark = (await owner.query("select file from keyturn.archived order by seq desc limit 1"))
      .rows[0].file as string;
    expect(await run(["verify-archive", path, "--hash", mark], io)).toBe(0);
    expect(await run(["verify-archive", path, "--hash", "0".repeat(64)], io)).toBe(1);

    expect(
      (
        await keyturn(logins.alice, [
          "archive",
          "--before",
          new Date().toISOString(),
          "--out",
          join(folder, "no.jsonl"),
        ])
      ).code,
    ).toBe(1);
    expect(
      (await keyturn(logins.owner, ["archive", "--before", "tomorrow-ish", "--out", "x"])).err,
    ).toContain("takes a date");
  });
});

describe("putting away and the rest of Keyturn", () => {
  test("what a rule let through in the last hour stays, so the rule's hourly limit still counts it", async () => {
    await owner.query(
      "select keyturn.allow('hold', 'orders', array['update'], array['status'], per_hour => 1)",
    );
    const first = await propose(agent, [update(40)]);
    expect((await apply(agent, first.proposal_id)).status).toBe("applied");
    const later = new Date(Date.now() + 1000);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(
      (await owner.query("select count(*)::int as n from keyturn.archivable($1)", [later])).rows[0]
        .n,
    ).toBe(0);
    // And so the second in the hour still waits for a person.
    const second = await propose(agent, [update(41)]);
    expect((await refusal(apply(agent, second.proposal_id)))?.message).toContain(
      "this one waits for a person",
    );
  });

  test("an archive is not written over a pool, and what a change wrote is in the file", async () => {
    const pool = { query: owner.query.bind(owner), totalCount: 1 } as unknown as pg.Client;
    expect(
      (await refusal(writeArchive(pool, new Date(), join(folder, "pool.jsonl"))))?.message,
    ).toContain("one connection, not a pool");
    const kept = (await readFile(join(folder, "kept.jsonl"), "utf8")).trim().split("\n");
    expect(Array.isArray((JSON.parse(kept[1] as string) as { written: unknown }).written)).toBe(
      true,
    );
  });
});
