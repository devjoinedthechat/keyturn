/** Anything that runs a query: a `pg` Client, a Pool, or a client taken from a pool. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export type Change =
  | { table: string; operation: "insert"; values: Record<string, unknown> }
  | {
      table: string;
      operation: "update";
      key: Record<string, unknown>;
      set: Record<string, unknown>;
    }
  | { table: string; operation: "delete"; key: Record<string, unknown> };

export type Status = "pending" | "approved" | "rejected" | "applied" | "stale" | "failed";

export interface Proposal {
  id: string;
  proposedBy: string;
  note: string;
  status: Status;
  /** The hash of the content as it stands. An approval names it. */
  contentHash: string;
  proposedAt: Date;
  expiresAt: Date;
  expired: boolean;
  decidedBy: string | null;
  decidedAt: Date | null;
  reason: string | null;
  changes: number;
  outcome: Outcome | null;
}

export interface Outcome {
  status: "applied" | "stale" | "failed";
  reason?: string;
  changes?: number;
}

/** What a value is. `absent` when the row does not exist on that side, or the column was not given. */
export type Kind = "string" | "number" | "boolean" | "null" | "array" | "object" | "absent";

export interface ColumnDiff {
  column: string;
  /** The value as PostgreSQL writes it. Never passed through a JavaScript number. */
  before: string | null;
  after: string | null;
  beforeKind: Kind;
  afterKind: Kind;
  changed: boolean;
}

export interface RowDiff {
  seq: number;
  table: string;
  operation: "insert" | "update" | "delete";
  /** The row's primary key, each part as PostgreSQL writes it: text, so a large number keeps every digit. */
  key: Record<string, string | null>;
  columns: ColumnDiff[];
}

export interface Extent {
  table: string;
  operation: "insert" | "update" | "delete";
  rows: number;
}

/**
 * A row that a proposal's row points to through a foreign key, as it is at the moment of
 * asking. It is not part of what an approval names.
 */
export interface Reference {
  /** The change it belongs to. */
  seq: number;
  /** The foreign key's name. */
  via: string;
  table: string;
  /** The pointing columns and their values, as PostgreSQL writes them. */
  key: Record<string, string | null>;
  /** `missing`: no such row that this login's policies let through. `unreadable`: this login may not read the table. */
  state: "shown" | "missing" | "unreadable";
  columns: { column: string; value: string | null; kind: Kind }[];
}

/** One reason a waiting proposal has come to a person. */
export interface Waiting {
  /** The change it is about, or null when it is about the whole proposal. */
  seq: number | null;
  /** The rule that did not cover the change, or null when no rule is in question. */
  rule: string | null;
  because: string;
}

export interface Step {
  event: "opened" | "approved" | "approved_by_rule" | "rejected" | "applied" | "stale" | "failed";
  /** The login that did it. */
  actor: string;
  at: Date;
  detail: Record<string, unknown>;
}

export interface Finding {
  level: "fail" | "note";
  about: string;
  finding: string;
  fix: string | null;
}

/** The database said no. `message` is what it said, without the `keyturn:` it starts with. */
export class Refused extends Error {
  override readonly name = "Refused";
  /** The PostgreSQL error code: `42501` when the caller may not do this. Null when it was found without asking the database. */
  readonly code: string | null;

  constructor(message: string, code: string | null, cause?: unknown) {
    super(message, { cause });
    this.code = code;
  }
}

/** The proposal ran out of time undecided, or the wait did. */
export class Undecided extends Error {
  override readonly name = "Undecided";
}

const proposalColumns = `
  p.id, p.proposed_by::text as "proposedBy", p.note, p.status, keyturn.hash_of(p.id) as "contentHash",
  p.proposed_at as "proposedAt", p.expires_at as "expiresAt",
  (p.status in ('pending', 'approved') and p.expires_at <= clock_timestamp()) as expired,
  p.decided_by::text as "decidedBy", p.decided_at as "decidedAt", p.reason,
  (select count(*)::int from keyturn.changes c where c.proposal_id = p.id) as changes, p.outcome`;

/**
 * Keyturn, over one database connection.
 *
 * It adds no rights. Every method is a call to a function in the database, which decides by
 * the login on the connection: an agent's login can propose and apply, an approver's can
 * approve and reject. Anything else is refused there, and comes back as `Refused`.
 */
export class Keyturn {
  private readonly db: Queryable;

  constructor(db: Queryable) {
    this.db = db;
  }

  /** Records changes for someone else to approve. Nothing is written to the tables. */
  async propose(
    changes: Change[],
    options: { note?: string; validFor?: string } = {},
  ): Promise<{ id: string; contentHash: string }> {
    const rows = await this.run<{ proposal_id: string; content_hash: string }>(
      "select * from keyturn.propose($1::jsonb, $2, $3::interval)",
      [JSON.stringify(changes), options.note ?? "", options.validFor ?? "1 day"],
    );
    const row = rows[0] as { proposal_id: string; content_hash: string };
    return { id: row.proposal_id, contentHash: row.content_hash };
  }

  /** One proposal, or null when there is none the caller may see. */
  async proposal(id: string): Promise<Proposal | null> {
    const rows = await this.run<Proposal>(
      `select ${proposalColumns} from keyturn.proposals p where p.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** The proposals nobody has decided, oldest first. */
  async waiting(): Promise<Proposal[]> {
    return this.run<Proposal>(
      `select ${proposalColumns} from keyturn.proposals p
        where p.status = 'pending' and p.expires_at > clock_timestamp() order by p.proposed_at, p.id`,
    );
  }

  /** The latest proposals in any state, newest first. */
  async recent(count = 50): Promise<Proposal[]> {
    return this.run<Proposal>(
      `select ${proposalColumns} from keyturn.proposals p order by p.proposed_at desc, p.id limit $1`,
      [count],
    );
  }

  /** How many rows a proposal would change, by table and operation. */
  async extent(id: string): Promise<Extent[]> {
    return this.run<Extent>(
      `select relation as "table", operation, row_count::int as rows from keyturn.extent($1)`,
      [id],
    );
  }

  /** The rows a proposal would change, before and after, `count` rows starting at row `from`. */
  async diff(id: string, options: { from?: number; count?: number } = {}): Promise<RowDiff[]> {
    const rows = await this.run<{
      seq: number;
      table: string;
      operation: RowDiff["operation"];
      key: Record<string, string | null>;
      column: string;
      before: string | null;
      after: string | null;
      beforeKind: Kind;
      afterKind: Kind;
      changed: boolean;
    }>(
      `select seq, relation as "table", operation,
              (select jsonb_object_agg(part.key, part.value #>> '{}') from jsonb_each(d.key) as part) as key,
              column_name as "column", before, after,
              before_kind as "beforeKind", after_kind as "afterKind", changed
         from keyturn.diff($1, $2, $3) as d`,
      [id, options.from ?? 1, options.count ?? 100],
    );
    const result: RowDiff[] = [];
    for (const { seq, table, operation, key, ...column } of rows) {
      let row = result.at(-1);
      if (row?.seq !== seq) {
        row = { seq, table, operation, key, columns: [] };
        result.push(row);
      }
      row.columns.push(column);
    }
    return result;
  }

  /**
   * The rows a proposal's rows point to through foreign keys, for `count` changes starting
   * at change `from`. Read with this login's rights, as they are now.
   */
  async refersTo(
    id: string,
    options: { from?: number; count?: number } = {},
  ): Promise<Reference[]> {
    const rows = await this.run<{
      seq: number;
      via: string;
      table: string;
      key: Record<string, string | null>;
      state: Reference["state"];
      column: string | null;
      value: string | null;
      kind: Kind | null;
    }>(
      `select seq, via, relation as "table",
              (select jsonb_object_agg(part.key, part.value #>> '{}') from jsonb_each(r.key) as part) as key,
              state, column_name as "column", value, kind
         from keyturn.refers_to($1, $2, $3) as r`,
      [id, options.from ?? 1, options.count ?? 100],
    );
    const result: Reference[] = [];
    for (const { seq, via, table, key, state, column, value, kind } of rows) {
      let reference = result.at(-1);
      if (reference?.seq !== seq || reference.via !== via) {
        reference = { seq, via, table, key, state, columns: [] };
        result.push(reference);
      }
      if (column !== null && kind !== null) {
        reference.columns.push({ column, value, kind });
      }
    }
    return result;
  }

  /** Why a waiting proposal has come to a person. For an approver; nothing for a proposal that is decided. */
  async waitsBecause(id: string): Promise<Waiting[]> {
    return this.run<Waiting>("select seq, rule, because from keyturn.waits_because($1)", [id]);
  }

  /** What has happened to a proposal, in order, from the audit log. */
  async history(id: string): Promise<Step[]> {
    return this.run<Step>(
      "select event, actor::text as actor, at, detail from keyturn.audit where proposal_id = $1 order by seq",
      [id],
    );
  }

  /**
   * Approves the content with this hash. Refused if the proposal's content has any other
   * hash, so pass the hash of what the approver was shown, not one read again at the last moment.
   */
  async approve(id: string, contentHash: string): Promise<void> {
    await this.run("select keyturn.approve($1, $2)", [id, contentHash]);
  }

  async reject(id: string, reason?: string): Promise<void> {
    await this.run("select keyturn.reject($1, $2)", [id, reason ?? null]);
  }

  /**
   * Writes an approved proposal's changes. Safe to call again: a proposal already applied
   * gives back what the first call gave. `stale` means a row had changed and nothing was written.
   */
  async apply(id: string): Promise<Outcome> {
    const rows = await this.run<{ outcome: Outcome }>("select keyturn.apply($1) as outcome", [id]);
    return (rows[0] as { outcome: Outcome }).outcome;
  }

  /**
   * Waits until someone has decided, and gives the proposal as it then stands. Throws
   * `Undecided` if it expires first, or if `timeoutMs` passes.
   */
  async decision(
    id: string,
    options: { timeoutMs?: number; everyMs?: number; signal?: AbortSignal } = {},
  ): Promise<Proposal> {
    const until = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
    const every = Math.max(options.everyMs ?? 1000, 50);
    for (;;) {
      options.signal?.throwIfAborted();
      const proposal = await this.proposal(id);
      if (proposal === null) {
        throw new Refused(`there is no proposal ${id} that this login can see`, null);
      }
      if (proposal.status !== "pending") {
        return proposal;
      }
      if (proposal.expired) {
        throw new Undecided(`proposal ${id} expired with nobody having decided`);
      }
      if (until !== undefined && Date.now() + every > until) {
        throw new Undecided(`nobody has decided proposal ${id} yet`);
      }
      await pause(every, options.signal);
    }
  }

  /** Whether the guarantee holds in this database. For the tables' owner or an administrator. */
  async doctor(): Promise<Finding[]> {
    return this.run<Finding>("select level, about, finding, fix from keyturn.doctor()");
  }

  /** What does not fit in the audit log. Empty when it holds together. */
  async verifyAudit(): Promise<{ proposalId: string; problem: string }[]> {
    return this.run(`select proposal_id as "proposalId", problem from keyturn.verify_audit()`);
  }

  /** One value for the whole audit log, to keep somewhere the database's owner cannot reach. */
  async auditHead(): Promise<{ entries: number; head: string }> {
    const rows = await this.run<{ entries: number; head: string }>(
      "select entries::int as entries, head from keyturn.audit_head()",
    );
    return rows[0] as { entries: number; head: string };
  }

  private async run<Row>(text: string, values: unknown[] = []): Promise<Row[]> {
    try {
      return (await this.db.query(text, values)).rows as Row[];
    } catch (error) {
      throw refusalOf(error) ?? error;
    }
  }
}

/** The refusal in an error from the database, if it is one of Keyturn's or a missing right. */
export function refusalOf(error: unknown): Refused | null {
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return null;
  }
  const { message, code } = error as { message: unknown; code?: unknown };
  if (typeof message !== "string" || typeof code !== "string") {
    return null;
  }
  if (message.startsWith("keyturn: ")) {
    return new Refused(message.slice("keyturn: ".length), code, error);
  }
  return code === "42501" ? new Refused(message, code, error) : null;
}

/** Waits, and stops waiting at once when told to. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}
