import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { type Queryable, Refused, refusalOf } from "./keyturn.ts";

/**
 * An archive file is lines of JSON. The first says what the file holds. Each line after it
 * is one proposal: its row, the exact text its hash was made from, and its entries in the
 * audit log, and what each change wrote where that was kept. The last line carries the hash
 * of every line before it.
 */
export interface ArchiveHead {
  keyturn: "archive";
  /** Every finished proposal whose last entry was before this time is in the file. */
  before: string;
  proposals: number;
  entries: number;
  /** The hash of every entry's own hash, in the log's order. The database gives the same for what it would remove. */
  digest: string;
}

/** What a written or checked archive is: its first line, and the hash of the file's body. */
export interface Archive extends ArchiveHead {
  /** The hash of every line but the last. Kept with the mark the removal leaves in the database. */
  file: string;
}

interface Entry {
  seq: string;
  proposal_id: string;
  at_text: string;
  actor: string;
  event: string;
  detail_text: string;
  prev_hash: string;
  hash: string;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Writes every finished proposal from before a time to a file. Nothing is removed from the
 * database: that is `prune`, given what this returns.
 *
 * The file is read from one view of the data, so it is whole. It must not exist yet.
 */
export async function writeArchive(db: Queryable, before: Date, path: string): Promise<Archive> {
  // It is read inside one transaction, and a pool would give each statement another connection.
  if (typeof (db as { totalCount?: unknown }).totalCount === "number") {
    throw new Refused(
      "an archive is written over one connection, not a pool: give a client checked out of it",
      null,
    );
  }
  let file: Awaited<ReturnType<typeof open>>;
  try {
    // "wx": made new, or not at all. An archive is never written over another.
    file = await open(path, "wx", 0o600);
  } catch (error) {
    throw new Refused(
      (error as { code?: string }).code === "EEXIST"
        ? `${path} is already there, and an archive is not written over a file`
        : `${path} cannot be written: ${(error as Error).message}`,
      null,
    );
  }
  try {
    await db.query("begin isolation level repeatable read read only");
    const found = (
      await db.query(
        "select proposals::int as proposals, entries::int as entries, digest from keyturn.archive_digest($1)",
        [before],
      )
    ).rows[0] as { proposals: number; entries: number; digest: string };
    const head: ArchiveHead = { keyturn: "archive", before: before.toISOString(), ...found };
    const body = createHash("sha256");
    const first = `${JSON.stringify(head)}\n`;
    // The first line is under the file's hash too: what the file says it holds cannot be altered.
    body.update(first, "utf8");
    await file.write(first);

    const ids = (
      await db.query(
        `select p.id::text as id from keyturn.proposals p
          where p.id in (select keyturn.archivable($1))
          order by (select min(a.seq) from keyturn.audit a where a.proposal_id = p.id), p.id`,
        [before],
      )
    ).rows.map((row) => (row as { id: string }).id);
    for (let from = 0; from < ids.length; from += 100) {
      const { rows } = await db.query(
        `select jsonb_build_object(
                  'proposal', to_jsonb(p),
                  -- The text the proposal's hash is the hash of, exactly as PostgreSQL wrote it.
                  'content_text', keyturn.content_of(p.id),
                  -- What each change wrote, where that was kept: taking one back was held against it.
                  'written', coalesce((select jsonb_agg(jsonb_build_object('seq', c.seq, 'as_written', c.as_written) order by c.seq)
                                         from keyturn.changes c where c.proposal_id = p.id and c.as_written is not null), '[]'),
                  'audit', coalesce((select jsonb_agg(jsonb_build_object(
                                        'seq', a.seq::text, 'proposal_id', a.proposal_id,
                                        'at_text', to_char(a.at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
                                        'actor', a.actor::text, 'event', a.event,
                                        'detail_text', a.detail::text, 'prev_hash', a.prev_hash, 'hash', a.hash) order by a.seq)
                                       from keyturn.audit a where a.proposal_id = p.id), '[]'))::text as line
           from keyturn.proposals p
           join unnest($1::uuid[]) with ordinality as wanted (id, place) on wanted.id = p.id
          order by wanted.place`,
        [ids.slice(from, from + 100)],
      );
      for (const row of rows) {
        const line = `${(row as { line: string }).line}\n`;
        body.update(line, "utf8");
        await file.write(line);
      }
    }
    await db.query("commit");
    const sum = body.digest("hex");
    await file.write(`${JSON.stringify({ keyturn: "end", file: sum })}\n`);
    // On the disk, not only handed to it, before anything is removed on the strength of it.
    await file.sync();
    return { ...head, file: sum };
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw refusalOf(error) ?? error;
  } finally {
    await file.close();
  }
}

/**
 * Reads an archive file and holds it against itself. Returns what it is, or throws with
 * what does not fit.
 *
 * | Held against                         | Catches                                         |
 * | ------------------------------------ | ----------------------------------------------- |
 * | The hash in its last line            | Any line altered, added, removed or moved       |
 * | Each entry's own hash, and its chain | An entry altered, or one taken out of a chain   |
 * | The hash a proposal was approved by  | Rows other than the ones that were approved     |
 * | The digest and counts it starts with | A file that is not the whole of what it says    |
 *
 * The first is only as good as the place the file's hash is kept: the mark the removal left
 * in the database has it, and `keyturn archive` prints it.
 */
export async function verifyArchive(path: string): Promise<Archive> {
  const wrong = (what: string) => new Refused(`the archive does not hold together: ${what}`, null);
  let head: ArchiveHead | null = null;
  let end: string | null = null;
  let proposals = 0;
  const entries: Entry[] = [];
  const body = createHash("sha256");
  const stream = createReadStream(path, "utf8");
  // A file that is not there is said plainly, and is not an error nobody handled.
  const unread = new Promise<never>((_, reject) => {
    stream.once("error", (error) =>
      reject(new Refused(`${path} cannot be read: ${error.message}`, null)),
    );
  });
  unread.catch(() => {});
  const read = async () => {
    for await (const line of createInterface({
      input: stream,
      crlfDelay: Number.POSITIVE_INFINITY,
    })) {
      if (line === "") {
        continue;
      }
      if (end !== null) {
        throw wrong("there is something after its last line");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw wrong("a line of it is not JSON");
      }
      if (head === null) {
        head = parsed as ArchiveHead;
        if (head?.keyturn !== "archive" || typeof head.digest !== "string") {
          throw wrong("its first line does not say what it is");
        }
        body.update(`${line}\n`, "utf8");
        continue;
      }
      if ((parsed as { keyturn?: string } | null)?.keyturn === "end") {
        end = String((parsed as { file?: unknown }).file);
        continue;
      }
      body.update(`${line}\n`, "utf8");
      const one = (parsed ?? {}) as {
        proposal?: { id?: string };
        content_text?: string;
        audit?: Entry[];
      };
      if (typeof one.proposal?.id !== "string" || !Array.isArray(one.audit)) {
        throw wrong("a line of it is not a proposal with its entries");
      }
      // Every proposal's record begins with its being made. One without has lost its beginning.
      if (one.audit[0]?.event !== "opened") {
        throw wrong(`the record of proposal ${one.proposal.id} does not begin where it was made`);
      }
      proposals += 1;
      let previous = "";
      for (const entry of one.audit) {
        if (typeof entry?.seq !== "string" || !/^[0-9]{1,18}$/.test(entry.seq)) {
          throw wrong("an entry of it has no number");
        }
        if (entry.proposal_id !== one.proposal.id) {
          throw wrong(`entry ${entry.seq} is filed under another proposal`);
        }
        if (entry.prev_hash !== previous) {
          throw wrong(`entry ${entry.seq} does not follow the entry before it`);
        }
        const expected = sha256(
          `${entry.prev_hash}|${entry.proposal_id}|${entry.at_text}|${entry.actor}|${entry.event}|${entry.detail_text}`,
        );
        if (entry.hash !== expected) {
          throw wrong(`entry ${entry.seq} has been changed`);
        }
        // An approval names the hash of the content. The content in the file has to be that content.
        if (entry.event === "approved" || entry.event === "approved_by_rule") {
          const approved = (JSON.parse(entry.detail_text) as { content_hash?: string })
            .content_hash;
          if (typeof one.content_text !== "string" || sha256(one.content_text) !== approved) {
            throw wrong(
              `the rows of proposal ${one.proposal.id} are not the rows that were approved`,
            );
          }
        }
        previous = entry.hash;
        entries.push(entry);
      }
    }
  };
  await Promise.race([read(), unread]);

  const found = head as ArchiveHead | null;
  if (found === null) {
    throw wrong("it is empty");
  }
  if (end === null) {
    throw wrong("it has no last line: it was cut short");
  }
  const sum = body.digest("hex");
  if (sum !== end) {
    throw wrong("it has been altered since it was written");
  }
  if (proposals !== found.proposals || entries.length !== found.entries) {
    throw wrong(
      `it says ${found.proposals} proposals and ${found.entries} entries, and holds ${proposals} and ${entries.length}`,
    );
  }
  entries.sort((one, other) => (BigInt(one.seq) < BigInt(other.seq) ? -1 : 1));
  if (sha256(entries.map((entry) => entry.hash).join("")) !== found.digest) {
    throw wrong("its entries do not have the digest it gives");
  }
  return { ...found, file: sum };
}

/** Removes from the database what an archive file holds, given what writing it returned. For the owner. */
export async function prune(
  db: Queryable,
  before: Date,
  archive: { digest: string; file?: string },
): Promise<{
  proposals: number;
  entries: number;
  digest: string;
  head_before: string;
  head_after: string;
}> {
  try {
    const { rows } = await db.query("select keyturn.prune($1, $2, $3) as done", [
      before,
      archive.digest,
      archive.file ?? null,
    ]);
    return (
      rows[0] as {
        done: {
          proposals: number;
          entries: number;
          digest: string;
          head_before: string;
          head_after: string;
        };
      }
    ).done;
  } catch (error) {
    throw refusalOf(error) ?? error;
  }
}
