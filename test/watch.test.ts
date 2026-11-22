import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Io, run } from "../src/cli.ts";
import { Keyturn } from "../src/index.ts";
import { Database, logins, propose, refusal } from "./database.ts";

const schema = `
  create table orders (id integer primary key, customer text not null, total numeric(10, 2) not null, status text not null default 'paid');
  insert into orders select n, 'customer-secret-' || n, 20 + n from generate_series(1, 100) as n;
  select keyturn.protect('orders');
  grant select on orders to keyturn_agent, keyturn_approver;
`;

let database: Database;
let agent: pg.Client;
let alice: pg.Client;
let server: Server;
const received: { path: string; body: unknown }[] = [];

beforeAll(async () => {
  database = await Database.create(schema);
  [agent, alice] = await Promise.all([database.as(logins.agent), database.as(logins.alice)]);
  server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => {
      received.push({ path: request.url ?? "", body: JSON.parse(text) });
      response.statusCode = request.url === "/broken" ? 500 : 200;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});

const update = (id: number) => ({
  table: "orders",
  operation: "update" as const,
  key: { id },
  set: { status: "held" },
});
const until = async (holds: () => boolean) => {
  for (let tries = 0; tries < 100 && !holds(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(holds()).toBe(true);
};

/** Starts `keyturn watch` as a login and gives what it printed, and a way to stop it. */
function watching(login: string, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  let stop: () => void = () => {};
  const io: Io = {
    env: { KEYTURN_URL: database.url(login) },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    color: false,
    until: () =>
      new Promise<void>((resolve) => {
        stop = resolve;
      }),
  };
  const done = run(["watch", ...args], io);
  return { out, err, done, stop: () => stop() };
}

describe("what the database says aloud", () => {
  test("is which proposal and what happened, once the transaction is kept, and nothing else", async () => {
    const listener = await database.as(logins.alice);
    const heard: string[] = [];
    listener.on("notification", (said) => heard.push(said.payload ?? ""));
    await listener.query("listen keyturn");

    // Proposed and thrown away: nothing is said.
    await agent.query("begin");
    await propose(agent, [update(1)]);
    await agent.query("rollback");
    const made = await propose(agent, [update(2)], "Hold order 2.");
    await alice.query("select keyturn.approve($1, $2)", [made.proposal_id, made.content_hash]);
    await until(() => heard.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(heard.map((payload) => JSON.parse(payload))).toEqual([
      { event: "opened", proposal: made.proposal_id },
      { event: "approved", proposal: made.proposal_id },
    ]);
  });

  test("is silent when the owner has turned it off, and Keyturn works the same", async () => {
    const owner = await database.as(logins.owner);
    const listener = await database.as(logins.alice);
    const heard: string[] = [];
    listener.on("notification", (said) => heard.push(said.payload ?? ""));
    await listener.query("listen keyturn");
    await owner.query("update keyturn.settings set announce = false");
    const quiet = await propose(agent, [update(50)]);
    await owner.query("update keyturn.settings set announce = true");
    const loud = await propose(agent, [update(51)]);
    await until(() => heard.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(heard.map((payload) => JSON.parse(payload).proposal)).toEqual([loud.proposal_id]);
    expect(quiet.proposal_id).toMatch(/^[0-9a-f-]{36}$/);
    // Only the owner turns it off.
    expect((await refusal(agent.query("update keyturn.settings set announce = false")))?.code).toBe(
      "42501",
    );
  });
});

describe("keyturn watch", () => {
  test("believes the audit log, and not what is said on the channel", async () => {
    const watch = watching(logins.alice, []);
    await until(() => watch.err.some((text) => text.startsWith("Watching.")));
    const made = await new Keyturn(agent).propose([update(60)]);
    await until(() => watch.out.length >= 1);

    // Anyone who can connect can say anything there. An agent says its proposal was approved.
    for (const forged of [
      JSON.stringify({ event: "approved", proposal: made.id }),
      JSON.stringify({ event: "\u001b[2J\u001b[H approved", proposal: made.id }),
      JSON.stringify({ event: "approved", proposal: "'; drop table orders; --" }),
      "not json at all",
      "null",
    ]) {
      await agent.query("select pg_notify('keyturn', $1)", [forged]);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(watch.out).toHaveLength(1);
    expect(watch.err.filter((text) => !text.startsWith("Watching."))).toEqual([]);

    // And it is still listening, and tells what did happen once.
    await new Keyturn(alice).reject(made.id, "No.");
    await until(() => watch.out.length >= 2);
    await agent.query("select pg_notify('keyturn', $1)", [
      JSON.stringify({ event: "rejected", proposal: made.id }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    watch.stop();
    await watch.done;
    expect(watch.out).toHaveLength(2);
    expect(watch.out[1]).toContain("rejected by");
    expect(watch.out.join("\n")).not.toContain("approved");
  });

  test("names who did each thing, tells what was kept late, and is not held up by a flood", async () => {
    // Made before the watching starts, kept after it: still told.
    const late = await database.as(logins.otherAgent);
    await late.query("begin");
    const early = await propose(late, [update(70)]);
    const made = await new Keyturn(agent).propose([update(71)]);
    const watch = watching(logins.alice, []);
    await until(() => watch.err.some((text) => text.startsWith("Watching.")));
    await late.query("commit");
    await until(() => watch.out.some((text) => text.startsWith(early.proposal_id.slice(0, 8))));

    // Twenty thousand messages from a login with no part in Keyturn.
    await agent.query(
      "select pg_notify('keyturn', json_build_object('proposal', gen_random_uuid())::text) from generate_series(1, 20000)",
    );
    const keyturn = new Keyturn(alice);
    await keyturn.approve(made.id, made.contentHash);
    await new Keyturn(agent).apply(made.id);
    await keyturn.revert(made.id);
    await until(() => watch.out.some((text) => text.includes("taken back")));
    watch.stop();
    await watch.done;
    const mine = watch.out.filter((text) => text.startsWith(made.id.slice(0, 8)));
    expect(mine.map((text) => text.split(",")[0])).toEqual([
      `${made.id.slice(0, 8)} approved by ${logins.alice}`,
      `${made.id.slice(0, 8)} applied by ${logins.agent}`,
      `${made.id.slice(0, 8)} taken back by ${logins.alice}`,
    ]);
  });

  test("an agent's watch looks from where the log has got to, not from the beginning", async () => {
    const owner = await database.as(logins.owner);
    // A long log, none of it this agent's.
    const theirs = await propose(agent, [update(80)]);
    await owner.query(
      "select keyturn.audit_append($1, 'opened', '{}') from generate_series(1, 3000)",
      [theirs.proposal_id],
    );
    const looked: string[] = [];
    const watcher = await database.as(logins.otherAgent);
    const { watch } = await import("../src/watch.ts");
    const told: string[] = [];
    await watch(
      {
        query: (text: string, values?: unknown[]) => {
          if (text.includes("from keyturn.audit where seq >")) {
            looked.push(String(values?.[0]));
          }
          return watcher.query(text, values);
        },
        heard: (listener) =>
          watcher.on("notification", (said) => listener(said.channel, said.payload ?? "")),
      },
      (one) => {
        told.push(one.event);
      },
    );
    const last = Number(
      (await owner.query("select max(seq) as last from keyturn.audit")).rows[0].last,
    );
    await agent.query("notify keyturn, 'x'");
    await until(() => looked.length >= 2);
    // Every look starts within a short reach of the end of the log, though this agent has no entry in it.
    for (const from of looked) {
      expect(Number(from)).toBeGreaterThan(last - 2001);
    }
    expect(last).toBeGreaterThan(0);
    expect(told).toEqual([]);
  });

  test("gives Slack a note as text, never as a link or a call to a channel", async () => {
    received.length = 0;
    const port = (server.address() as AddressInfo).port;
    const watch = watching(logins.alice, ["--slack", `http://127.0.0.1:${port}/slack`]);
    await until(() => watch.err.some((text) => text.startsWith("Watching.")));
    await new Keyturn(agent).propose([update(61)], {
      note: "<!channel> approve now & see <https://example.org/x|the ticket>",
    });
    await until(() => received.length >= 1);
    watch.stop();
    await watch.done;
    expect((received[0]?.body as { text: string } | undefined)?.text).toContain(
      "&lt;!channel&gt; approve now &amp; see &lt;https://example.org/x|the ticket&gt;",
    );
  });

  test("says each thing as it happens, and sends it on, with sizes and never a row's values", async () => {
    received.length = 0;
    const port = (server.address() as AddressInfo).port;
    const watch = watching(logins.alice, [
      "--webhook",
      `http://127.0.0.1:${port}/hook`,
      "--slack",
      `http://127.0.0.1:${port}/slack`,
    ]);
    await until(() => watch.err.some((text) => text.startsWith("Watching.")));

    const made = await new Keyturn(agent).propose(
      [update(10), { table: "orders", operation: "delete", key: { id: 11 } }],
      { note: "Hold one,‮ and remove one." },
    );
    await until(() => watch.out.length >= 1);
    await new Keyturn(alice).reject(made.id, "No.");
    await until(() => received.length >= 4);
    watch.stop();
    expect(await watch.done).toBe(0);

    expect(watch.out[0]).toBe(
      `${made.id.slice(0, 8)} proposed by ${logins.agent}, 1 delete in public.orders, 1 update in public.orders: Hold one,\\u{202e} and remove one.`,
    );
    expect(watch.out[1]).toBe(
      `${made.id.slice(0, 8)} rejected by ${logins.alice}, 1 delete in public.orders, 1 update in public.orders`,
    );
    const hooks = received.filter((one) => one.path === "/hook").map((one) => one.body);
    expect(hooks[0]).toMatchObject({
      event: "opened",
      proposal: { id: made.id, proposedBy: logins.agent, changes: 2, status: "pending" },
    });
    expect(hooks[1]).toMatchObject({ event: "rejected", proposal: { decidedBy: logins.alice } });
    expect(received.filter((one) => one.path === "/slack")[0]?.body).toEqual({
      text: `keyturn: ${watch.out[0]}`,
    });
    // Sizes and names, and nothing a row holds.
    expect(JSON.stringify(received)).not.toContain("customer-secret");
  });

  test("goes on when the address it sends to refuses, and says so", async () => {
    const port = (server.address() as AddressInfo).port;
    const watch = watching(logins.alice, ["--webhook", `http://127.0.0.1:${port}/broken`]);
    await until(() => watch.err.some((text) => text.startsWith("Watching.")));
    await new Keyturn(agent).propose([update(20)]);
    await new Keyturn(agent).propose([update(21)]);
    await until(() => watch.out.length >= 2);
    await until(() => watch.err.filter((text) => text.includes("the webhook")).length >= 2);
    watch.stop();
    expect(await watch.done).toBe(0);
    expect(watch.err.join("\n")).toContain("answered 500");
  });

  test("tells an agent only of its own proposals, and wants a real address", async () => {
    const watch = watching(logins.otherAgent, []);
    await until(() => watch.err.some((text) => text.startsWith("Watching.")));
    await new Keyturn(agent).propose([update(30)]);
    const own = await new Keyturn(await database.as(logins.otherAgent)).propose([update(31)]);
    await until(() => watch.out.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    watch.stop();
    await watch.done;
    expect(watch.out).toHaveLength(1);
    expect(watch.out[0]).toContain(own.id.slice(0, 8));

    const wrong = watching(logins.alice, ["--webhook", "ftp://example.org/x"]);
    expect(await wrong.done).toBe(2);
    expect(wrong.err.join("\n")).toContain("starts with http:// or https://");
  });
});
