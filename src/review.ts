import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Keyturn, type Queryable, Refused } from "./keyturn.ts";

/**
 * The review page: a list of waiting proposals, one proposal's rows before and after, and
 * approve or reject.
 *
 * It adds no power. It holds one database connection, as whoever started it, and calls the
 * functions the command line calls. A fault in the page cannot get a change past the
 * database. What it must not do is let someone else use that connection, so:
 *
 * - it listens on this machine only;
 * - every request for data carries a key made for this run, which is in the address
 *   printed to the terminal and nowhere else;
 * - a request that names another host, or comes from another site, is refused;
 * - the page may load nothing but its own three files, and puts what an agent wrote on
 *   the screen as text, never as markup.
 */
export interface Review {
  /** The address to open, with the key in it. */
  url: string;
  port: number;
  close(): Promise<void>;
}

const files: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/hidden.js": { file: "hidden.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

const headers = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
};

class Problem extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The waiting proposals, or the decided ones, for the list at the side: one query however
 * many there are, at most two hundred of them, and only the start of each note. The list is
 * written by the party being reviewed, and must not be able to slow the page a reviewer is using.
 */
const listed = (decided: boolean) => `
  select p.id, p.proposed_by::text as "proposedBy", left(p.note, 300) as note, p.status,
         p.proposed_at as "proposedAt", p.expires_at as "expiresAt",
         (p.status in ('pending', 'approved') and p.expires_at <= clock_timestamp()) as expired,
         p.decided_by::text as "decidedBy",
         (select count(*)::int from keyturn.changes c where c.proposal_id = p.id) as changes,
         coalesce((select jsonb_agg(jsonb_build_object('table', e.relation, 'operation', e.operation, 'rows', e.row_count))
                     from keyturn.extent(p.id) as e), '[]'::jsonb) as extent
    from keyturn.proposals p
   where ${decided ? "not" : ""} (p.status = 'pending' and p.expires_at > clock_timestamp())
   order by ${decided ? "coalesce(p.finished_at, p.decided_at, p.expires_at) desc" : "p.proposed_at"}, p.id
   limit 201`;

export async function serveReview(
  db: Queryable,
  options: { port?: number; fault?: (error: unknown) => void } = {},
): Promise<Review> {
  const keyturn = new Keyturn(db);
  const key = randomBytes(24).toString("base64url");
  const folder = new URL("../review/", import.meta.url);

  const server = createServer((request, response) => {
    answer(request, response).catch((error: unknown) => {
      const status = error instanceof Problem ? error.status : error instanceof Refused ? 409 : 500;
      // What the database said is for the reviewer. Anything else stays in the terminal.
      const known = error instanceof Problem || error instanceof Refused;
      if (!known) {
        options.fault?.(error);
      }
      const message = known
        ? (error as Error).message
        : "The review page could not reach the database.";
      send(response, status, { error: message, refused: error instanceof Refused });
    });
  });

  async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const port = (server.address() as AddressInfo).port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    // A page on another site can make this browser call 127.0.0.1 under a name of its own. The name gives it away.
    if (!hosts.includes(request.headers.host ?? "")) {
      throw new Problem(421, "This page answers only on this machine.");
    }
    const url = new URL(request.url ?? "/", `http://${hosts[0]}`);

    const file = files[url.pathname];
    if (file !== undefined) {
      if (request.method !== "GET") {
        throw new Problem(405, "Not allowed.");
      }
      response.writeHead(200, { ...headers, "content-type": file.type });
      response.end(await readFile(new URL(file.file, folder)));
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      throw new Problem(404, "There is nothing here.");
    }

    const origin = request.headers.origin;
    if (origin !== undefined && !hosts.map((host) => `http://${host}`).includes(origin)) {
      throw new Problem(403, "Not from this page.");
    }
    const given = Buffer.from((request.headers.authorization ?? "").replace(/^Bearer /, ""));
    const wanted = Buffer.from(key);
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      throw new Problem(
        401,
        "Open the address the terminal printed: it carries the key for this run.",
      );
    }

    const parts = url.pathname.split("/").slice(2);
    if (request.method === "GET" && parts.length === 1 && parts[0] === "me") {
      const { rows } = await db.query(
        `select session_user::text as login, current_database()::text as database,
                pg_has_role(session_user, 'keyturn_approver', 'MEMBER') as approver`,
      );
      send(response, 200, rows[0]);
      return;
    }
    if (request.method === "GET" && parts.length === 1 && parts[0] === "proposals") {
      const { rows } = await db.query(listed(url.searchParams.get("show") === "decided"));
      send(response, 200, { proposals: rows.slice(0, 200), more: rows.length > 200 });
      return;
    }

    const [collection, id, action] = parts;
    if (collection !== "proposals" || id === undefined || !uuid.test(id) || parts.length > 3) {
      throw new Problem(404, "There is nothing here.");
    }
    if (request.method === "GET" && action === undefined) {
      const proposal = await keyturn.proposal(id);
      if (proposal === null) {
        throw new Problem(404, "There is no such proposal that this login can see.");
      }
      send(response, 200, {
        proposal,
        extent: await keyturn.extent(id),
        history: await keyturn.history(id),
        // Why it has come to a person. Only an approver is told.
        waits: proposal.status === "pending" ? await keyturn.waitsBecause(id).catch(() => []) : [],
      });
      return;
    }
    if (request.method === "GET" && action === "rows") {
      const from = whole(url.searchParams.get("from") ?? "1");
      const count = url.searchParams.get("count") === "1000" ? 1000 : 100;
      // The hash is read before the rows. If the content could change between the two, the
      // rows would be the later ones, and an approval of this hash would be refused: never
      // the other way round, where rows are approved that were not the ones read.
      const proposal = await keyturn.proposal(id);
      if (proposal === null) {
        throw new Problem(404, "There is no such proposal that this login can see.");
      }
      send(response, 200, {
        contentHash: proposal.contentHash,
        rows: await keyturn.diff(id, { from, count }),
        // The rows these rows point to, as they are now. No part of what the hash names.
        references: await keyturn.refersTo(id, { from, count }),
      });
      return;
    }
    if (request.method !== "POST") {
      throw new Problem(405, "Not allowed.");
    }
    // A form on another site cannot send this type without asking first, and the answer to asking is no.
    if (!(request.headers["content-type"] ?? "").startsWith("application/json")) {
      throw new Problem(415, "Not allowed.");
    }
    const body = await read(request);
    if (action === "approve") {
      if (typeof body.hash !== "string" || !/^[0-9a-f]{64}$/.test(body.hash)) {
        throw new Problem(400, "An approval names the hash of what was read.");
      }
      await keyturn.approve(id, body.hash);
    } else if (action === "reject") {
      if (body.reason !== undefined && typeof body.reason !== "string") {
        throw new Problem(400, "A reason is text.");
      }
      await keyturn.reject(id, body.reason === "" ? undefined : body.reason);
    } else if (action === "apply") {
      await keyturn.apply(id);
    } else if (action === "revert") {
      if (body.reason !== undefined && typeof body.reason !== "string") {
        throw new Problem(400, "A reason is text.");
      }
      const outcome = await keyturn.revert(id, body.reason === "" ? undefined : body.reason);
      if (outcome.status !== "reverted") {
        throw new Problem(
          409,
          `Nothing was taken back: ${outcome.reason ?? "a row stood in the way"}.`,
        );
      }
    } else {
      throw new Problem(404, "There is nothing here.");
    }
    send(response, 200, {
      proposal: await keyturn.proposal(id),
      history: await keyturn.history(id),
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/#${key}`,
    port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function whole(text: string): number {
  if (!/^[0-9]{1,9}$/.test(text) || Number(text) < 1) {
    throw new Problem(400, "Rows are counted from 1.");
  }
  return Number(text);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function read(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 16_384) {
      throw new Problem(413, "Too much.");
    }
    chunks.push(chunk as Buffer);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // Falls through to the refusal below.
  }
  throw new Problem(400, "Not understood.");
}
