import { readdir, readFile } from "node:fs/promises";
import { type Queryable, Refused, refusalOf } from "./keyturn.ts";

const roles = ["keyturn_agent", "keyturn_approver", "keyturn_rule"] as const;

/** The SQL an administrator runs once for a server, when the installing login may not create roles. */
export const rolesSql = roles.map((role) => `create role ${role} nologin;`).join("\n");

export async function version(): Promise<string> {
  const text = await readFile(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(text) as { version: string }).version;
}

/** The version installed in this database, or null when Keyturn is not there. */
export async function installed(db: Queryable): Promise<string | null> {
  const { rows } = await db.query(
    "select obj_description(oid, 'pg_namespace') as comment from pg_namespace where nspname = 'keyturn'",
  );
  const row = rows[0] as { comment: string | null } | undefined;
  if (row === undefined) {
    return null;
  }
  return row.comment?.replace(/^keyturn /, "") ?? "unknown";
}

/**
 * Installs Keyturn into the database, as the login on the connection, which becomes its
 * owner. All of it or none: the statements run in one transaction. The connection must be
 * one nobody else is using, since a transaction is opened on it.
 */
export async function install(db: Queryable): Promise<{ version: string }> {
  single(db);
  const present = await installed(db);
  if (present !== null) {
    const release = await version();
    throw new Refused(
      present === release
        ? `keyturn ${present} is already installed in this database`
        : `keyturn ${present} is already installed in this database. To move it to ${release}, keeping what it holds: keyturn upgrade`,
      "42P06",
    );
  }
  const { rows } = await db.query(
    `select (select rolcreaterole or rolsuper from pg_roles where rolname = current_user) as may_create,
            array(select wanted from unnest($1::text[]) as wanted
                   where not exists (select from pg_roles where rolname = wanted)) as missing`,
    [roles],
  );
  const state = rows[0] as { may_create: boolean; missing: string[] };
  if (state.missing.length > 0 && !state.may_create) {
    throw new Refused(
      `this login may not create roles, and ${state.missing.join(", ")} ${state.missing.length === 1 ? "does" : "do"} not exist. An administrator runs this once:\n${rolesSql}`,
      "42501",
      null,
    );
  }

  const folder = new URL("../sql/", import.meta.url);
  const files = (await readdir(folder)).filter((name) => name.endsWith(".sql")).sort();
  const release = await version();
  await db.query("begin");
  try {
    for (const role of state.missing) {
      await db.query(`create role ${role} nologin`);
    }
    for (const file of files) {
      await db.query(await readFile(new URL(file, folder), "utf8"));
    }
    await db.query(
      `comment on schema keyturn is 'keyturn ${release.replace(/[^0-9a-z.+-]/gi, "")}'`,
    );
    await db.query("commit");
  } catch (error) {
    // If the rollback fails too, the first failure is still the one to report.
    await db.query("rollback").catch(() => {});
    throw refusalOf(error) ?? error;
  }
  return { version: release };
}

/** What Keyturn keeps: carried over, row for row, when it moves to a later version. */
const kept = ["proposals", "changes", "audit", "rules", "forbidden", "archived"] as const;

/** Whether one version comes after another: 0.10.0 after 0.9.2. */
function later(one: string, other: string): boolean {
  const parts = (text: string) => text.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(one), parts(other)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) {
      return (a[index] ?? 0) > (b[index] ?? 0);
    }
  }
  return false;
}

/**
 * Moves the Keyturn in this database to the version of this package, keeping every proposal,
 * every rule and the whole audit log.
 *
 * All of it or none, in one transaction. What Keyturn holds is set aside, its functions and
 * tables are replaced with this version's, the tables that were under it are put under it
 * again, and what was set aside is put back row for row. The audit log must come out
 * exactly as it went in: the same entries, with the same value for the whole log. If it
 * does not, nothing is changed.
 *
 * While it runs, which is a moment, nothing can be proposed, decided or applied.
 */
export async function upgrade(db: Queryable): Promise<{ from: string; to: string }> {
  single(db);
  const from = await installed(db);
  const to = await version();
  if (from === null) {
    throw new Refused("keyturn is not installed in this database. Run: keyturn install", null);
  }
  if (from === to) {
    throw new Refused(`keyturn ${to} is what this database already has`, null);
  }
  if (!later(to, from)) {
    throw new Refused(
      `this database has keyturn ${from}, which is later than this program's ${to}. Use the later program`,
      null,
    );
  }
  const folder = new URL("../sql/", import.meta.url);
  const files = (await readdir(folder)).filter((name) => name.endsWith(".sql")).sort();
  const names = async (schema: string, table: string) =>
    (
      await db.query(
        `select a.attname::text as name from pg_attribute a
          where a.attrelid = to_regclass($1) and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
          order by a.attnum`,
        [`${schema}.${table}`],
      )
    ).rows.map((row) => (row as { name: string }).name);

  await db.query("begin");
  try {
    // Nothing moves while this runs.
    await db.query(
      "lock table keyturn.proposals, keyturn.changes, keyturn.audit, keyturn.protected in access exclusive mode",
    );
    const before = (await db.query("select entries::text, head from keyturn.audit_head()"))
      .rows[0] as { entries: string; head: string };
    const faults = (await db.query("select count(*)::int as n from keyturn.verify_audit()"))
      .rows[0] as { n: number };

    const columns = new Map<string, string[]>();
    for (const table of kept) {
      const present = await names("keyturn", table);
      if (present.length > 0) {
        columns.set(table, present);
        await db.query(
          `create temp table keyturn_kept_${table} on commit drop as select * from keyturn.${table}`,
        );
      }
    }
    const under = (
      await db.query(
        `select p.relation::oid::text as oid, p.exact,
                exists (select from pg_class c where c.oid = p.relation) as there
           from keyturn.protected p order by p.added_at, p.relation::oid`,
      )
    ).rows as { oid: string; exact: boolean; there: boolean }[];

    await db.query("drop schema if exists proposal cascade");
    await db.query("drop schema keyturn cascade");
    for (const file of files) {
      await db.query(await readFile(new URL(file, folder), "utf8"));
    }
    // A table that has been dropped since is left out. Its proposals are kept, and say so when applied.
    for (const table of under) {
      if (table.there) {
        await db.query("select keyturn.protect($1::oid::regclass, $2)", [table.oid, table.exact]);
      }
    }
    for (const table of kept) {
      const had = columns.get(table);
      if (had === undefined) {
        continue;
      }
      const now = await names("keyturn", table);
      const both = had
        .filter((name) => now.includes(name))
        .map((name) => `"${name.replaceAll('"', '""')}"`);
      await db.query(
        `insert into keyturn.${table} (${both.join(", ")}) overriding system value
           select ${both.join(", ")} from keyturn_kept_${table}`,
      );
    }
    await db.query(
      "select setval(pg_get_serial_sequence('keyturn.audit', 'seq'), greatest((select max(seq) from keyturn.audit), 1), (select count(*) > 0 from keyturn.audit))",
    );

    const after = (await db.query("select entries::text, head from keyturn.audit_head()"))
      .rows[0] as { entries: string; head: string };
    const faultsAfter = (await db.query("select count(*)::int as n from keyturn.verify_audit()"))
      .rows[0] as { n: number };
    if (
      after.entries !== before.entries ||
      after.head !== before.head ||
      faultsAfter.n > faults.n
    ) {
      throw new Refused(
        "the audit log did not come out as it went in, so nothing was changed. This is a fault in keyturn: please report it",
        null,
      );
    }
    await db.query(`comment on schema keyturn is 'keyturn ${to.replace(/[^0-9a-z.+-]/gi, "")}'`);
    await db.query("commit");
  } catch (error) {
    // If the rollback fails too, the first failure is still the one to report.
    await db.query("rollback").catch(() => {});
    throw refusalOf(error) ?? error;
  }
  return { from, to };
}

/**
 * Takes Keyturn out: its schema, the proposal views, every proposal and the audit log. The
 * tables it protected are left as they are, with no way for an agent to change them. The
 * three roles stay, since other databases on the server may use them.
 */
export async function uninstall(db: Queryable): Promise<void> {
  single(db);
  await db.query("begin");
  try {
    await db.query("drop schema if exists proposal cascade");
    await db.query("drop schema if exists keyturn cascade");
    await db.query("commit");
  } catch (error) {
    // If the rollback fails too, the first failure is still the one to report.
    await db.query("rollback").catch(() => {});
    throw refusalOf(error) ?? error;
  }
}

/**
 * Puts a table under Keyturn and makes its proposal view. `exact: false` lets the table's
 * own triggers alter a row as it is applied without failing the apply.
 */
export async function protect(
  db: Queryable,
  table: string,
  options: { exact?: boolean } = {},
): Promise<void> {
  try {
    await db.query("select keyturn.protect($1::regclass, $2)", [table, options.exact ?? true]);
  } catch (error) {
    throw refusalOf(error) ?? error;
  }
}

/** Takes a table out from under Keyturn. Its waiting proposals are closed as stale. */
export async function unprotect(db: Queryable, table: string): Promise<void> {
  try {
    await db.query("select keyturn.unprotect($1::regclass)", [table]);
  } catch (error) {
    throw refusalOf(error) ?? error;
  }
}

/** Installing opens a transaction, which a pool would spread over several connections. */
function single(db: Queryable): void {
  if ("totalCount" in db || "idleCount" in db) {
    throw new Refused(
      "this takes one connection, not a pool: take a client from the pool and pass that",
      null,
    );
  }
}
