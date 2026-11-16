import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { version } from "./install.ts";
import {
  type Change,
  Keyturn,
  type Proposal,
  type Queryable,
  Refused,
  Undecided,
} from "./keyturn.ts";

/**
 * Keyturn as tools an agent calls directly, over the Model Context Protocol on standard
 * input and output.
 *
 * It is a convenience and holds no part of the guarantee. It connects as the agent's own
 * login, so the most a model can do through it, whatever it is told or tricked into, is
 * what that login can do: propose, look, and apply what someone else approved.
 *
 * Written against the protocol itself and not on its SDK, which would bring in a web
 * framework and some twenty packages for five tools. The tests drive it with the official
 * client, so that it speaks the protocol as others do.
 */

const protocols = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  call(input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

/** The input was not what the tool takes. Said to the model, so that it can put it right. */
class Mistake extends Error {}

const text = (input: Record<string, unknown>, name: string, most: number): string => {
  const given = input[name];
  if (typeof given !== "string" || given.trim() === "" || given.length > most) {
    throw new Mistake(`"${name}" must be text of 1 to ${most} characters.`);
  }
  return given;
};

const briefly = (proposal: Proposal) => ({
  proposal_id: proposal.id,
  status: proposal.expired ? "expired" : proposal.status,
  rows: proposal.changes,
  note: proposal.note,
  decided_by: proposal.decidedBy,
  reason: proposal.reason,
  expires_at: proposal.expiresAt,
  outcome: proposal.outcome,
});

function toolsOver(db: Queryable): Tool[] {
  const keyturn = new Keyturn(db);
  const reads = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  return [
    {
      name: "list_protected_tables",
      title: "List protected tables",
      description:
        "Lists the tables you cannot write directly, with their columns and primary keys. To change a row in one of them, call propose_change. Read rows with ordinary SELECT statements through your usual database access.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: reads,
      call: async () => {
        const { rows } = await db.query(`
          select format('%I.%I', n.nspname, c.relname) as "table", p.key_columns as primary_key,
                 (select jsonb_agg(jsonb_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
                                                      'settable', a.attgenerated = '') order by a.attnum)
                    from pg_attribute a where a.attrelid = p.relation and a.attnum > 0 and not a.attisdropped) as columns
            from keyturn.protected p
            join pg_class c on c.oid = p.relation
            join pg_namespace n on n.oid = c.relnamespace
           where has_table_privilege(session_user, p.relation, 'SELECT')
           order by 1`);
        return { tables: rows };
      },
    },
    {
      name: "propose_change",
      title: "Propose a change",
      description:
        "Proposes inserts, updates and deletes to protected tables. Nothing is written: the proposal waits for a person to read the exact rows and approve them. Put every row that belongs together in one proposal, and say in the note why the change is needed, since the note is what the approver reads first. Returns a proposal_id. Then call check_proposal to wait for the decision, and apply_proposal once it is approved.",
      inputSchema: {
        type: "object",
        required: ["changes", "note"],
        additionalProperties: false,
        properties: {
          note: {
            type: "string",
            minLength: 1,
            maxLength: 2000,
            description: "Why this change is needed, for the person who approves it.",
          },
          changes: {
            type: "array",
            minItems: 1,
            maxItems: 10000,
            description: "The row changes. Each names one row by its primary key.",
            items: {
              type: "object",
              required: ["table", "operation"],
              additionalProperties: false,
              properties: {
                table: {
                  type: "string",
                  description: "A table from list_protected_tables, such as public.orders.",
                },
                operation: { type: "string", enum: ["insert", "update", "delete"] },
                key: {
                  type: "object",
                  description:
                    "For update and delete: the primary key of the row, every key column and nothing else.",
                },
                set: {
                  type: "object",
                  description: "For update: the columns to change and their new values.",
                },
                values: {
                  type: "object",
                  description: "For insert: the new row's columns and values.",
                },
              },
            },
          },
          valid_for: {
            type: "string",
            description:
              'How long the proposal may wait, as a PostgreSQL interval such as "2 hours". One day if left out; 30 days at most.',
          },
        },
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      call: async (input) => {
        const note = text(input, "note", 2000);
        if (!Array.isArray(input.changes) || input.changes.length === 0) {
          throw new Mistake('"changes" must be a list of at least one change.');
        }
        const validFor = input.valid_for === undefined ? undefined : text(input, "valid_for", 40);
        const made = await keyturn.propose(input.changes as Change[], {
          note,
          ...(validFor === undefined ? {} : { validFor }),
        });
        return {
          proposal_id: made.id,
          status: "pending",
          rows: input.changes.length,
          written: false,
          next: "Nothing was written. A person has to approve these exact rows. Call check_proposal with wait_seconds to wait for the decision, then apply_proposal.",
        };
      },
    },
    {
      name: "check_proposal",
      title: "Check a proposal",
      description:
        "Says where a proposal of yours stands: pending, approved, rejected (with the approver's reason), applied, stale, failed or expired. With wait_seconds it waits up to that long for a decision before answering. A rejection is a decision by a person: read the reason, and do not propose the same change again unless the reason is answered.",
      inputSchema: {
        type: "object",
        required: ["proposal_id"],
        additionalProperties: false,
        properties: {
          proposal_id: { type: "string" },
          wait_seconds: {
            type: "integer",
            minimum: 0,
            maximum: 300,
            description: "How long to wait for a decision. 0 if left out.",
          },
        },
      },
      annotations: reads,
      call: async (input, signal) => {
        const id = text(input, "proposal_id", 36);
        const wait = input.wait_seconds ?? 0;
        if (typeof wait !== "number" || !Number.isInteger(wait) || wait < 0 || wait > 300) {
          throw new Mistake('"wait_seconds" must be a whole number from 0 to 300.');
        }
        let proposal = await keyturn.proposal(id);
        if (proposal === null) {
          throw new Mistake(`There is no proposal ${id} of yours.`);
        }
        if (wait > 0 && proposal.status === "pending" && !proposal.expired) {
          try {
            proposal = await keyturn.decision(id, {
              timeoutMs: wait * 1000,
              everyMs: 1000,
              signal,
            });
          } catch (error) {
            if (!(error instanceof Undecided)) {
              throw error;
            }
            proposal = (await keyturn.proposal(id)) ?? proposal;
          }
        }
        return briefly(proposal);
      },
    },
    {
      name: "apply_proposal",
      title: "Apply an approved proposal",
      description:
        'Writes the rows of a proposal that has been approved, all of them or none. Refused while the proposal is pending, unless the tables\' owner has a rule that lets this kind of change through without a person. "stale" means a row changed after you proposed: nothing was written, so read the rows again and make a new proposal if the change is still right. Calling it again for an applied proposal is safe and writes nothing more.',
      inputSchema: {
        type: "object",
        required: ["proposal_id"],
        additionalProperties: false,
        properties: { proposal_id: { type: "string" } },
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      call: async (input) => {
        const id = text(input, "proposal_id", 36);
        const outcome = await keyturn.apply(id);
        return { proposal_id: id, ...outcome, written: outcome.status === "applied" };
      },
    },
    {
      name: "list_proposals",
      title: "List your proposals",
      description: "Lists your latest proposals, newest first, with where each stands.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: reads,
      call: async () => ({ proposals: (await keyturn.recent(30)).map(briefly) }),
    },
  ];
}

/** Why this login must not serve an agent, or null when it may. */
export async function unfitForAgent(db: Queryable): Promise<string | null> {
  const { rows } = await db.query(`
    select session_user::text as login,
           keyturn.caller_is('keyturn_agent') as agent,
           keyturn.caller_is('keyturn_approver') as approver,
           (select rolsuper or rolbypassrls from pg_roles where rolname = session_user) as above`);
  const who = rows[0] as { login: string; agent: boolean; approver: boolean; above: boolean };
  if (who.above) {
    return `${who.login} is a superuser or bypasses row-level security. An agent's tools must run as a login that can only propose.`;
  }
  if (who.approver) {
    return `${who.login} can approve. An agent that can approve its own proposals is not held by anything.`;
  }
  if (!who.agent) {
    return `${who.login} is not in keyturn_agent. Run: grant keyturn_agent to ${who.login}`;
  }
  return null;
}

/**
 * Serves the tools until the input ends. `input` and `output` carry one JSON-RPC message a
 * line; nothing else is ever written to `output`.
 */
export async function serveTools(db: Queryable, input: Readable, output: Writable): Promise<void> {
  const tools = toolsOver(db);
  const release = await version();
  const running = new Map<string | number, AbortController>();
  const pending = new Set<Promise<void>>();

  const write = (message: Record<string, unknown>) => {
    output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  async function handle(message: Record<string, unknown>): Promise<void> {
    const { id, method } = message;
    const params = (
      typeof message.params === "object" && message.params !== null ? message.params : {}
    ) as Record<string, unknown>;
    const asked = typeof id === "string" || typeof id === "number";

    if (method === "notifications/cancelled") {
      const which = params.requestId;
      if (typeof which === "string" || typeof which === "number") {
        running.get(which)?.abort();
      }
      return;
    }
    if (!asked) {
      // Any other notification, such as the one that says the client is ready, needs no answer.
      return;
    }
    if (typeof method !== "string") {
      write({ id, error: { code: -32600, message: "Not a request." } });
      return;
    }

    switch (method) {
      case "initialize": {
        const wanted = params.protocolVersion;
        write({
          id,
          result: {
            protocolVersion:
              typeof wanted === "string" && protocols.includes(wanted) ? wanted : protocols[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "keyturn", title: "Keyturn", version: release },
            instructions:
              "The tables listed by list_protected_tables cannot be written directly: a write is refused by the database. To change them, call propose_change, wait for a person's decision with check_proposal, then call apply_proposal. A proposal changes nothing until it is applied.",
          },
        });
        return;
      }
      case "ping":
        write({ id, result: {} });
        return;
      case "tools/list":
        write({
          id,
          result: {
            tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
              name,
              title,
              description,
              inputSchema,
              annotations,
            })),
          },
        });
        return;
      case "tools/call": {
        const tool = tools.find((candidate) => candidate.name === params.name);
        if (tool === undefined) {
          write({
            id,
            error: {
              code: -32602,
              message: `There is no tool ${String(params.name).slice(0, 80)}.`,
            },
          });
          return;
        }
        const given = params.arguments ?? {};
        const stop = new AbortController();
        running.set(id, stop);
        try {
          if (typeof given !== "object" || given === null || Array.isArray(given)) {
            throw new Mistake("The arguments must be an object.");
          }
          const result = await tool.call(given as Record<string, unknown>, stop.signal);
          write({
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              structuredContent: result,
              isError: false,
            },
          });
        } catch (error) {
          if (stop.signal.aborted) {
            // The client gave up on this call and wants no answer to it.
            return;
          }
          // What the database refused, and what the model got wrong, go back to the model as
          // the tool's answer: it can read them and act. Anything else is a fault here, and
          // its detail stays out of the model's reach.
          const said =
            error instanceof Refused
              ? `Refused by the database: ${error.message}`
              : error instanceof Mistake
                ? error.message
                : "The tool failed. Nothing was written.";
          write({ id, result: { content: [{ type: "text", text: said }], isError: true } });
        } finally {
          running.delete(id);
        }
        return;
      }
      default:
        write({ id, error: { code: -32601, message: `Method not found: ${method.slice(0, 80)}` } });
    }
  }

  for await (const line of createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })) {
    if (line.trim() === "") {
      continue;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write({ id: null, error: { code: -32700, message: "Not JSON." } });
      continue;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      write({ id: null, error: { code: -32600, message: "Not a request." } });
      continue;
    }
    // Each call runs on its own, so that one that is waiting for a person does not hold up the rest.
    const work = handle(message as Record<string, unknown>).catch(() => {});
    pending.add(work);
    work.finally(() => pending.delete(work));
  }
  for (const stop of running.values()) {
    stop.abort();
  }
  await Promise.all(pending);
}
