import { type Extent, Keyturn, type Proposal, type Queryable } from "./keyturn.ts";
import { plain } from "./render.ts";

/** What happened to a proposal, as it is told to whoever watches. */
export interface Told {
  event: string;
  /** Who did it, as the audit log has it. */
  by: string;
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
  // Anyone who can connect can say anything on the channel, an agent too. So what is heard
  // is never believed, and not even read: it is only a reason to look. What is told is read
  // from the audit log, which nobody but Keyturn writes, and each entry of it is told once.
  //
  // Entries get their numbers before their transactions are kept, so a lower number can
  // appear after a higher one. Each look therefore goes back over the last numbers too, and
  // the ones already seen are remembered.
  const seen = new Set<bigint>();
  let highest = 0n;
  const look = async (silent: boolean) => {
    const from = highest > BEHIND ? highest - BEHIND : 0n;
    const { rows } = await db.query(
      "select seq::text as seq, proposal_id::text as proposal, event, actor::text as actor from keyturn.audit where seq > $1 order by seq",
      [from.toString()],
    );
    for (const entry of rows as { seq: string; proposal: string; event: string; actor: string }[]) {
      const seq = BigInt(entry.seq);
      if (seen.has(seq)) {
        continue;
      }
      seen.add(seq);
      if (seq > highest) {
        highest = seq;
      }
      if (silent || !(entry.event in words)) {
        continue;
      }
      const proposal = await keyturn.proposal(entry.proposal);
      // One this login may not see: an agent watching hears only of its own.
      if (proposal === null) {
        continue;
      }
      await tell({
        event: entry.event,
        by: entry.actor,
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
    }
    for (const seq of seen) {
      if (seq + BEHIND < highest) {
        seen.delete(seq);
      }
    }
  };
  // However much is said, one look is at work and at most one more is owed: a flood of
  // messages costs a flood of nothing.
  let looking = false;
  let again = false;
  const heard = () => {
    if (looking) {
      again = true;
      return;
    }
    looking = true;
    void (async () => {
      do {
        again = false;
        await look(false).catch(fault);
      } while (again);
      looking = false;
    })();
  };
  db.heard((channel) => {
    if (channel === "keyturn") {
      heard();
    }
  });
  // Listening first, then what is already there: a step kept between the two is still told.
  await db.query("listen keyturn");
  await look(true);
}

/** How far back each look goes for an entry whose transaction was kept late. */
const BEHIND = 2000n;

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
  const who = plain(told.by);
  const note =
    proposal.note === "" ? "" : `: ${plain(proposal.note).replace(/\s+/g, " ").slice(0, 200)}`;
  return `${plain(proposal.id).slice(0, 8)} ${words[told.event] ?? plain(told.event)} by ${who}, ${size}${told.event === "opened" ? note : ""}`;
}

/** The line as Slack takes it: its three marks of its own made plain, so a note cannot make a link or call a channel. */
export function forSlack(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
