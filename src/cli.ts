import { parseArgs } from "node:util";
import pg from "pg";
import { install, installed, protect, uninstall, unprotect, version } from "./install.ts";
import { Keyturn, type Queryable, Refused } from "./keyturn.ts";
import { renderFindings, renderList, renderProposal, type Style } from "./render.ts";

const usage = `keyturn: PostgreSQL refuses an agent's write until a person approved that exact change.

For the tables' owner
  keyturn install                 Install into the database
  keyturn protect <table>         Put a table under keyturn. --loose lets the table's own triggers alter applied rows
  keyturn unprotect <table>       Take a table out again
  keyturn doctor                  Check that an agent has no way round. Exit 1 if it has
  keyturn uninstall --yes         Remove keyturn, its proposals and its audit log

For an approver
  keyturn list                    Proposals waiting for a decision. --all for the latest in any state
  keyturn show <proposal>         The rows a proposal would change, before and after
  keyturn approve <proposal>      Show it, ask, approve. --apply writes it too
  keyturn reject <proposal>       --reason "..." says why
  keyturn apply <proposal>        Write an approved proposal's changes
  keyturn verify-audit            Check the audit log holds together. Exit 1 if it does not

A proposal is named by its id or the start of it.

The database
  --url <url>                     Or KEYTURN_URL, or DATABASE_URL, or the PG* variables.
                                  The login decides what is allowed: connect as the owner to install,
                                  as an approver to approve.

Display
  --rows <n>  --from <n>          Which rows of a large proposal to show (50 from the first)
  --unchanged                     Show the columns an update leaves alone
  --full                          Show long values whole
  --json                          Print data, not text
  --hash <hash>                   With approve: approve this content without being asked.
                                  The hash of what was reviewed, from show`;

export interface Io {
  env: Record<string, string | undefined>;
  out(text: string): void;
  err(text: string): void;
  /** Asks the person at the terminal. Absent when there is none. */
  ask?: (question: string) => Promise<string>;
  color: boolean;
  /** For tests: a connection to use in place of one made from the url. */
  connect?: (url: string | undefined) => Promise<Queryable & { end(): Promise<void> }>;
}

class Usage extends Error {}

/** Runs one command and gives its exit code: 0 done, 1 refused or found wanting, 2 not understood. */
export async function run(argv: string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${usage}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, target] = positionals;
  if (values.help || command === undefined || command === "help") {
    io.out(usage);
    return command === undefined && !values.help ? 2 : 0;
  }
  if (values.version || command === "version") {
    io.out(await version());
    return 0;
  }

  const url = values.url ?? io.env.KEYTURN_URL ?? io.env.DATABASE_URL;
  let db: Queryable & { end(): Promise<void> };
  try {
    db = await (io.connect ?? connect)(url);
  } catch (error) {
    io.err(`Could not connect to the database: ${(error as Error).message}`);
    return 1;
  }

  const keyturn = new Keyturn(db);
  const style: Style = {
    color: io.color,
    full: values.full ?? false,
    unchanged: values.unchanged ?? false,
  };
  const print = (data: unknown, text: string) =>
    io.out(values.json ? JSON.stringify(data, null, 2) : text);
  const need = (what: string): string => {
    if (target === undefined) {
      throw new Usage(`keyturn ${command} needs ${what}.`);
    }
    return target;
  };
  const number = (name: "rows" | "from", fallback: number): number => {
    const given = values[name];
    if (given === undefined) {
      return fallback;
    }
    if (!/^[0-9]{1,9}$/.test(given) || Number(given) < 1) {
      throw new Usage(`--${name} takes a number from 1.`);
    }
    return Number(given);
  };
  const shown = async (id: string) => {
    // Read before anything is asked of the database, so a wrong number stops the command at once.
    const page = { from: number("from", 1), count: number("rows", 50) };
    const proposal = await keyturn.proposal(id);
    if (proposal === null) {
      throw new Refused(`there is no proposal ${id} that this login can see`, "02000", null);
    }
    const extent = await keyturn.extent(id);
    const rows = await keyturn.diff(id, page);
    return { proposal, extent, rows };
  };

  try {
    if (command !== "install" && (await installed(db)) === null) {
      throw new Refused(
        "keyturn is not installed in this database. Run: keyturn install",
        "3F000",
        null,
      );
    }
    switch (command) {
      case "install": {
        const done = await install(db);
        print(done, `Installed keyturn ${done.version}. Next: keyturn protect <table>`);
        return 0;
      }
      case "uninstall": {
        if (!values.yes) {
          throw new Usage(
            "This removes every proposal and the audit log. Run it with --yes if that is meant.",
          );
        }
        await uninstall(db);
        print({ removed: true }, "Removed. The tables it protected are as they were.");
        return 0;
      }
      case "protect": {
        const table = need("a table");
        await protect(db, table, { exact: !values.loose });
        print(
          { protected: table },
          `${table} is under keyturn. Agents write to proposal.${table.split(".").join("_")} or call keyturn.propose().\nGive them: grant select on ${table} to keyturn_agent;  Then: keyturn doctor`,
        );
        return 0;
      }
      case "unprotect": {
        const table = need("a table");
        await unprotect(db, table);
        print({ unprotected: table }, `${table} is no longer under keyturn.`);
        return 0;
      }
      case "doctor": {
        const findings = await keyturn.doctor();
        print(findings, renderFindings(findings, style));
        return findings.some((finding) => finding.level === "fail") ? 1 : 0;
      }
      case "list": {
        const proposals = values.all ? await keyturn.recent() : await keyturn.waiting();
        print(proposals, renderList(proposals, style));
        return 0;
      }
      case "show": {
        const all = await shown(await named(db, need("a proposal")));
        print(all, renderProposal(all.proposal, all.extent, all.rows, style));
        return 0;
      }
      case "approve": {
        const id = await named(db, need("a proposal"));
        let hash = values.hash;
        if (hash === undefined) {
          if (io.ask === undefined) {
            throw new Usage(
              "Nobody is at the terminal to ask. Read the proposal with keyturn show, then pass its hash: keyturn approve <proposal> --hash <hash>",
            );
          }
          const all = await shown(id);
          io.out(renderProposal(all.proposal, all.extent, all.rows, style));
          io.out("");
          const total = all.proposal.changes;
          const answer = await io.ask(
            `Approve ${total === 1 ? "this change" : `all ${total.toLocaleString("en")} of these changes`}? Type "approve", or anything else to leave it: `,
          );
          if (answer.trim().toLowerCase() !== "approve") {
            io.out("Left as it was.");
            return 1;
          }
          // The hash of what was on the screen, not one read again: content that changed in between is refused.
          hash = all.proposal.contentHash;
        }
        await keyturn.approve(id, hash);
        if (!values.apply) {
          print({ id, approved: true }, `Approved ${id}. The agent, or keyturn apply, writes it.`);
          return 0;
        }
        const outcome = await keyturn.apply(id);
        print({ id, approved: true, outcome }, `Approved ${id}. ${told(outcome)}`);
        return outcome.status === "applied" ? 0 : 1;
      }
      case "reject": {
        const id = await named(db, need("a proposal"));
        await keyturn.reject(id, values.reason);
        print({ id, rejected: true }, `Rejected ${id}.`);
        return 0;
      }
      case "apply": {
        const id = await named(db, need("a proposal"));
        const outcome = await keyturn.apply(id);
        print({ id, outcome }, told(outcome));
        return outcome.status === "applied" ? 0 : 1;
      }
      case "verify-audit": {
        const [problems, head] = [await keyturn.verifyAudit(), await keyturn.auditHead()];
        print(
          { problems, ...head },
          problems.length === 0
            ? `The audit log holds together: ${head.entries.toLocaleString("en")} entries.\nhead ${head.head}\nKeep the head somewhere this database's owner cannot reach.`
            : `${problems.map((problem) => `${problem.proposalId}  ${problem.problem}`).join("\n")}\n\nThe audit log does not hold together.`,
        );
        return problems.length === 0 ? 0 : 1;
      }
      default:
        throw new Usage(`There is no command "${command}".`);
    }
  } catch (error) {
    if (error instanceof Usage) {
      io.err(`${error.message}\n\nkeyturn help lists the commands.`);
      return 2;
    }
    if (error instanceof Refused) {
      io.err(`Refused: ${error.message}`);
      return 1;
    }
    io.err(`Failed: ${(error as Error).message}`);
    return 1;
  } finally {
    await db.end().catch(() => {});
  }
}

function told(outcome: { status: string; reason?: string; changes?: number }): string {
  if (outcome.status === "applied") {
    return `Applied: ${outcome.changes ?? 0} row${outcome.changes === 1 ? "" : "s"} written.`;
  }
  return `Nothing was written. The proposal is ${outcome.status}${outcome.reason === undefined ? "" : `: ${outcome.reason}`}`;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      hash: { type: "string" },
      reason: { type: "string" },
      rows: { type: "string" },
      from: { type: "string" },
      all: { type: "boolean" },
      apply: { type: "boolean" },
      loose: { type: "boolean" },
      unchanged: { type: "boolean" },
      full: { type: "boolean" },
      json: { type: "boolean" },
      yes: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
  });
}

/** The proposal an id, or the start of one, names. */
async function named(db: Queryable, given: string): Promise<string> {
  const start = given.toLowerCase();
  if (!/^[0-9a-f-]{4,36}$/.test(start)) {
    throw new Usage(
      `"${given.slice(0, 40)}" is not a proposal's id, or at least four characters from the start of one.`,
    );
  }
  const { rows } = await db.query(
    "select id from keyturn.proposals where id::text like $1 || '%' order by proposed_at desc limit 2",
    [start],
  );
  if (rows.length === 0) {
    throw new Refused(`there is no proposal ${given} that this login can see`, "02000", null);
  }
  if (rows.length > 1) {
    throw new Usage(`More than one proposal starts with ${given}. Give more of the id.`);
  }
  return (rows[0] as { id: string }).id;
}

async function connect(url: string | undefined) {
  const client = new pg.Client(url === undefined ? {} : { connectionString: url });
  // A connection the server closes while idle must not take the process down with an unhandled error.
  client.on("error", () => {});
  await client.connect();
  return client;
}
