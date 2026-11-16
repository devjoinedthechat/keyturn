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
  const present = await installed(db);
  if (present !== null) {
    throw new Refused(`keyturn ${present} is already installed in this database`, "42P06", null);
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
    await db.query("rollback");
    throw refusalOf(error) ?? error;
  }
  return { version: release };
}

/**
 * Takes Keyturn out: its schema, the proposal views, every proposal and the audit log. The
 * tables it protected are left as they are, with no way for an agent to change them. The
 * three roles stay, since other databases on the server may use them.
 */
export async function uninstall(db: Queryable): Promise<void> {
  await db.query("begin");
  try {
    await db.query("drop schema if exists proposal cascade");
    await db.query("drop schema if exists keyturn cascade");
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
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
