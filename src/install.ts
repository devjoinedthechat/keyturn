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
const kept = [
  "proposals",
  "changes",
  "audit",
  "rules",
  "forbidden",
  "archived",
  "settings",
] as const;
/** The tables among them that number their own rows, and must go on from where they were. */
const numbered = ["audit", "archived"] as const;
const own = "nspname in ('keyturn', 'proposal')";

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

  // Only the login that owns Keyturn moves it. Anyone else who could, a superuser say, would
  // become the owner of every function in it, and those functions run with their owner's rights.
  const owned = (
    await db.query(
      `select pg_get_userbyid(n.nspowner)::text as owner, pg_get_userbyid(n.nspowner) = current_user as mine
         from pg_namespace n where n.nspname = 'keyturn'`,
    )
  ).rows[0] as { owner: string; mine: boolean };
  if (!owned.mine) {
    throw new Refused(
      `keyturn in this database belongs to ${owned.owner}. Connect as that login to move it`,
      "42501",
    );
  }

  await db.query("begin");
  try {
    // Nothing moves while this runs.
    await db.query(
      "lock table keyturn.proposals, keyturn.changes, keyturn.audit, keyturn.protected in access exclusive mode",
    );
    // Replacing Keyturn's objects takes with it whatever of the owner's own hangs on them: a
    // view of the audit log, a foreign key to a proposal, a policy that asks keyturn.caller_is.
    // Losing a policy unnoticed would let an agent read what it could not. So none of it is
    // dropped: the move is refused, and they are named.
    const hanging = (
      await db.query(
        `with mine as (
           select 'pg_class'::regclass::oid as classid, c.oid as objid from pg_class c
            where c.relnamespace in (select oid from pg_namespace where ${own})
           union all
           select 'pg_proc'::regclass::oid, p.oid from pg_proc p
            where p.pronamespace in (select oid from pg_namespace where ${own})
           union all
           select 'pg_type'::regclass::oid, t.oid from pg_type t
            where t.typnamespace in (select oid from pg_namespace where ${own})
           union all
           select 'pg_namespace'::regclass::oid, n.oid from pg_namespace n where ${own}
         ),
         hung as (
           select distinct d.classid, d.objid, i.type, i.identity,
                  -- The schema of the thing itself or, for what sits on a table (a policy, a
                  -- trigger, a view's rule, a default), of that table. Read from the catalog:
                  -- a name can be made to say anything.
                  coalesce(i.schema, (
                    select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     where c.oid = case d.classid
                       when 'pg_policy'::regclass then (select polrelid from pg_policy where oid = d.objid)
                       when 'pg_trigger'::regclass then (select tgrelid from pg_trigger where oid = d.objid)
                       when 'pg_rewrite'::regclass then (select ev_class from pg_rewrite where oid = d.objid)
                       when 'pg_attrdef'::regclass then (select adrelid from pg_attrdef where oid = d.objid)
                       when 'pg_constraint'::regclass then (select conrelid from pg_constraint where oid = d.objid)
                     end)) as home
             from pg_depend d
             join mine on d.refclassid = mine.classid and d.refobjid = mine.objid
             cross join lateral pg_identify_object(d.classid, d.objid, d.objsubid) as i
            where d.deptype in ('n', 'a')
              and (d.classid, d.objid) not in (select classid, objid from mine)
         )
         select distinct type || ' ' || identity as what from hung
          where home is distinct from 'keyturn' and home is distinct from 'proposal'
            -- What a session made for itself goes with the session, and is not the owner's to drop.
            and coalesce(home, '') !~ '^pg_(toast_)?temp'
          order by 1`,
      )
    ).rows
      // A view hangs on what it reads by its rewrite rule. It is named as the view it is.
      // Names are other people's words: kept on one line.
      .map((row) =>
        (row as { what: string }).what
          .replace(/^rule "?_RETURN"? on /, "view ")
          .replace(/\s+/g, " "),
      );
    if (hanging.length > 0) {
      throw new Refused(
        `these depend on keyturn's own tables or functions and would be dropped with them: ${hanging.slice(0, 40).join("; ")}${hanging.length > 40 ? `; and ${hanging.length - 40} more` : ""}. Drop them, run keyturn upgrade, and make them again`,
        null,
      );
    }
    const granted = (
      await db.query(
        `select distinct case when given.grantee = 0 then 'everyone (public)' else pg_get_userbyid(given.grantee)::text end as role
           from (
           select 'n'::"char" as kind, (aclexplode(nspacl)).* from pg_namespace where ${own}
           union all
           select case when c.relkind = 'S' then 'S' else 'r' end::"char", (aclexplode(c.relacl)).* from pg_class c
            where c.relnamespace in (select oid from pg_namespace where ${own})
           union all
           -- A column's own rights never come from default privileges.
           select null::"char", (aclexplode(a.attacl)).* from pg_attribute a join pg_class c on c.oid = a.attrelid
            where c.relnamespace in (select oid from pg_namespace where ${own})
           union all
           select 'f'::"char", (aclexplode(p.proacl)).* from pg_proc p
            where p.pronamespace in (select oid from pg_namespace where ${own})
         ) as given
          where (given.grantee = 0 or pg_get_userbyid(given.grantee)::text <> all ($1::text[] || current_user::text))
            -- A right the owner's default privileges give on every new object of its kind is
            -- given again by the new version: that one is not lost. Only that exact right, on
            -- that kind of object.
            and not exists (
              select from pg_default_acl d, lateral aclexplode(d.defaclacl) as again
               where d.defaclrole = (select oid from pg_roles where rolname = current_user)
                 and d.defaclnamespace = 0
                 and d.defaclobjtype = given.kind
                 and again.grantee = given.grantee
                 and again.privilege_type = given.privilege_type)
          order by 1`,
        [roles],
      )
    ).rows.map((row) => (row as { role: string }).role.replace(/\s+/g, " "));
    if (granted.length > 0) {
      throw new Refused(
        `rights on keyturn's own tables or functions were given by hand to ${granted.join(", ")}, and would be lost. Revoke them, run keyturn upgrade, and give them again`,
        null,
      );
    }
    // Where each numbered table had got to. Entries that were put away still have their numbers.
    const reached = new Map<string, string>();
    for (const table of numbered) {
      const sequence = (
        await db.query(
          "select case when to_regclass($1) is not null then pg_get_serial_sequence($1, 'seq') end as name",
          [`keyturn.${table}`],
        )
      ).rows[0] as { name: string | null };
      if (sequence.name !== null) {
        const at = (
          await db.query(
            `select (case when is_called then last_value else last_value - 1 end)::text as last from ${sequence.name}`,
          )
        ).rows[0] as { last: string };
        reached.set(table, at.last);
      }
    }
    await db.query(
      "create temp table keyturn_kept_protected on commit drop as select * from keyturn.protected",
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
    // Put under Keyturn again, not looked at afresh: a table whose columns changed since it was
    // protected still says so, and a view its owner took away stays away.
    await db.query(
      `update keyturn.protected p set shape = k.shape, added_at = k.added_at
         from keyturn_kept_protected k where k.relation = p.relation`,
    );
    await db.query(
      `select keyturn.drop_view(k.relation) from keyturn_kept_protected k
        where k.view is null and exists (select from keyturn.protected p where p.relation = k.relation)`,
    );
    for (const table of kept) {
      const had = columns.get(table);
      if (had === undefined) {
        continue;
      }
      const now = await names("keyturn", table);
      if (table === "settings") {
        // The new version made its one row. The owner's own takes its place.
        await db.query("delete from keyturn.settings");
      }
      const both = had
        .filter((name) => now.includes(name))
        .map((name) => `"${name.replaceAll('"', '""')}"`);
      await db.query(
        `insert into keyturn.${table} (${both.join(", ")}) overriding system value
           select ${both.join(", ")} from keyturn_kept_${table}`,
      );
    }
    for (const table of numbered) {
      const last = reached.get(table);
      if (last !== undefined) {
        // On from the highest number ever given, kept or put away: a number is never used twice.
        await db.query(
          `select setval(pg_get_serial_sequence('keyturn.${table}', 'seq'),
                         greatest($1::bigint, (select coalesce(max(seq), 0) from keyturn.${table}), 1),
                         greatest($1::bigint, (select coalesce(max(seq), 0) from keyturn.${table})) > 0)`,
          [last],
        );
      }
    }

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
