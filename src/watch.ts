import { type Extent, Keyturn, type Proposal, type Queryable } from "./keyturn.ts";
import { plain } from "./render.ts";

/** What happened to a proposal, as it is told to whoever watches. */
export interface Told {
  event: string;
  proposal: {
    id: string;
    status: Proposal["status"];
    proposedBy: string;
    decidedBy: string | null;
    /** Written by the agent. */
    note: string;
    changes: number;
    extent: Extent[];
  };
}

/** A connection that can be listened on. */
export interface Hearing extends Queryable {
  heard(listener: (channel: string, payload: string) => void): void;
}

/**
 * Listens for what happens to proposals and tells each thing to `tell`, with how large the
 * proposal is and who made it. Nothing of the rows themselves is read or told.
 *
 * Connect as an approver, who may read every proposal. What happened while nobody was
 * listening is not told afterwards: `keyturn list` shows what is waiting.
 */
export async function watch(
  db: Hearing,
  tell: (told: Told) => void | Promise<void>,
  fault: (error: unknown) => void = () => {},
): Promise<void> {
  const keyturn = new Keyturn(db);
  db.heard((channel, payload) => {
    if (channel !== "keyturn") {
      return;
    }
    void (async () => {
      const said = JSON.parse(payload) as { event?: unknown; proposal?: unknown };
      if (typeof said.event !== "string" || typeof said.proposal !== "string") {
        return;
      }
      const proposal = await keyturn.proposal(said.proposal);
      // One this login may not see: an agent watching hears only of its own.
      if (proposal === null) {
        return;
      }
      await tell({
        event: said.event,
        proposal: {
          id: proposal.id,
          status: proposal.status,
          proposedBy: proposal.proposedBy,
          decidedBy: proposal.decidedBy,
          note: proposal.note,
          changes: proposal.changes,
          extent: await keyturn.extent(proposal.id),
        },
      });
    })().catch(fault);
  });
  await db.query("listen keyturn");
}

const words: Record<string, string> = {
  opened: "proposed",
  approved: "approved",
  approved_by_rule: "let through by a rule",
  rejected: "rejected",
  applied: "applied",
  stale: "not applied, a row had changed",
  failed: "not applied, the table refused it",
  reverted: "taken back",
};

/** One line for a terminal or a chat: what happened, how large it is, and the agent's note. */
export function line(told: Told): string {
  const { proposal } = told;
  const size = proposal.extent
    .map(
      (part) =>
        `${part.rows.toLocaleString("en")} ${part.operation}${part.rows === 1 ? "" : "s"} in ${plain(part.table)}`,
    )
    .join(", ");
  const who =
    told.event === "opened" || proposal.decidedBy === null || told.event === "applied"
      ? plain(proposal.proposedBy)
      : plain(proposal.decidedBy);
  const note =
    proposal.note === "" ? "" : `: ${plain(proposal.note).replace(/\s+/g, " ").slice(0, 200)}`;
  return `${proposal.id.slice(0, 8)} ${words[told.event] ?? told.event} by ${who}, ${size}${told.event === "opened" ? note : ""}`;
}

/** Sends one thing to an address that takes JSON by POST. A refusal or no answer in ten seconds is an error. */
export async function post(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`${new URL(url).host} answered ${response.status}`);
  }
}
