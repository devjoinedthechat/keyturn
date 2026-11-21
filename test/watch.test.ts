import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Io, run } from "../src/cli.ts";
import { Keyturn } from "../src/index.ts";
import { Database, logins, propose } from "./database.ts";

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
});

describe("keyturn watch", () => {
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
