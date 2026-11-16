import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { run } from "../src/cli.ts";
import { Keyturn, serveTools } from "../src/index.ts";
import { administrator, Database, logins } from "./database.ts";

const schema = `
  create table orders (id integer primary key, customer text not null, total numeric(10, 2) not null, status text not null default 'paid',
                       label text generated always as (upper(customer)) stored);
  insert into orders (id, customer, total) select n, 'customer ' || n, 20 + n from generate_series(1, 50) as n;
  select keyturn.protect('orders');
  grant select on orders to keyturn_agent, keyturn_approver;

  create table secrets (id integer primary key, body text);
  select keyturn.protect('secrets');

  create table plain (id integer primary key);
  grant select on plain to keyturn_agent;
`;

let database: Database;
let owner: pg.Client;
let alice: Keyturn;
let client: Client;

beforeAll(async () => {
  database = await Database.create(schema);
  owner = await database.as(logins.owner);
  alice = new Keyturn(await database.as(logins.alice));
  // The official client starts the server as an agent's host would: a program of its own, spoken to over its input and output.
  client = new Client({ name: "keyturn-tests", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/bin.ts", import.meta.url)), "tools"],
      env: { PATH: process.env.PATH ?? "", KEYTURN_URL: database.url(logins.agent) },
    }),
  );
});

afterAll(async () => {
  await client?.close();
  await database.close();
});

type Answer = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: { type: string; text: string }[];
};
const call = async (name: string, input: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: input })) as Answer;
const order = async (id: number) =>
  (await owner.query("select * from orders where id = $1", [id])).rows[0];
const refund = (id: number) => ({
  table: "public.orders",
  operation: "update",
  key: { id },
  set: { total: 0, status: "refunded" },
});

describe("the agent's tools, spoken to by the official client", () => {
  test("introduce themselves and say how the tables are changed", async () => {
    expect(client.getServerVersion()).toMatchObject({ name: "keyturn" });
    expect(client.getInstructions()).toContain("propose_change");
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_protected_tables",
      "propose_change",
      "check_proposal",
      "apply_proposal",
      "list_proposals",
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description?.length).toBeGreaterThan(40);
    }
    expect(tools.find((tool) => tool.name === "apply_proposal")?.annotations?.destructiveHint).toBe(
      true,
    );
    expect(tools.find((tool) => tool.name === "check_proposal")?.annotations?.readOnlyHint).toBe(
      true,
    );
  });

  test("list the protected tables the agent can read, and no others", async () => {
    const answer = await call("list_protected_tables");
    expect(answer.structuredContent).toEqual({
      tables: [
        {
          table: "public.orders",
          primary_key: ["id"],
          columns: [
            { name: "id", type: "integer", settable: true },
            { name: "customer", type: "text", settable: true },
            { name: "total", type: "numeric(10,2)", settable: true },
            { name: "status", type: "text", settable: true },
            { name: "label", type: "text", settable: false },
          ],
        },
      ],
    });
    expect(JSON.parse(answer.content[0]?.text ?? "")).toEqual(answer.structuredContent);
  });

  test("propose, wait for a person, and apply what was approved", async () => {
    const proposed = await call("propose_change", {
      note: "Customer 1 was charged twice.",
      changes: [refund(1), { table: "public.orders", operation: "delete", key: { id: 2 } }],
    });
    expect(proposed.isError).toBeFalsy();
    expect(proposed.structuredContent).toMatchObject({
      status: "pending",
      rows: 2,
      written: false,
    });
    const id = proposed.structuredContent?.proposal_id as string;
    expect(await order(1)).toMatchObject({ total: "21.00", status: "paid" });

    expect((await call("check_proposal", { proposal_id: id })).structuredContent).toMatchObject({
      status: "pending",
      decided_by: null,
    });
    const early = await call("apply_proposal", { proposal_id: id });
    expect(early.isError).toBe(true);
    expect(early.content[0]?.text).toContain("Refused by the database");
    expect(early.content[0]?.text).toContain("pending, not approved");

    const waiting = call("check_proposal", { proposal_id: id, wait_seconds: 30 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await alice.approve(id, (await alice.proposal(id))?.contentHash as string);
    expect((await waiting).structuredContent).toMatchObject({
      status: "approved",
      decided_by: logins.alice,
    });
    expect(await order(1)).toMatchObject({ total: "21.00" });

    const applied = await call("apply_proposal", { proposal_id: id });
    expect(applied.structuredContent).toEqual({
      proposal_id: id,
      status: "applied",
      changes: 2,
      written: true,
    });
    expect(await order(1)).toMatchObject({ total: "0.00", status: "refunded" });
    expect(await order(2)).toBeUndefined();
    expect((await call("apply_proposal", { proposal_id: id })).structuredContent).toMatchObject({
      status: "applied",
    });

    const listed = (await call("list_proposals")).structuredContent?.proposals as {
      proposal_id: string;
      status: string;
    }[];
    expect(listed[0]).toMatchObject({ proposal_id: id, status: "applied" });
  });

  test("bring a rejection back with the person's reason, and a stale row as nothing written", async () => {
    const rejected = (
      await call("propose_change", { note: "Refund order 3.", changes: [refund(3)] })
    ).structuredContent?.proposal_id as string;
    await alice.reject(rejected, "Order 3 was never paid.");
    expect(
      (await call("check_proposal", { proposal_id: rejected, wait_seconds: 5 })).structuredContent,
    ).toMatchObject({
      status: "rejected",
      decided_by: logins.alice,
      reason: "Order 3 was never paid.",
    });
    expect((await call("apply_proposal", { proposal_id: rejected })).isError).toBe(true);

    const stale = (await call("propose_change", { note: "Refund order 4.", changes: [refund(4)] }))
      .structuredContent?.proposal_id as string;
    await alice.approve(stale, (await alice.proposal(stale))?.contentHash as string);
    await owner.query("update orders set customer = 'renamed' where id = 4");
    expect((await call("apply_proposal", { proposal_id: stale })).structuredContent).toMatchObject({
      status: "stale",
      written: false,
    });
    expect((await order(4)).status).toBe("paid");
  });

  test("tell the model what it got wrong, in words it can act on", async () => {
    const answers = {
      noNote: await call("propose_change", { changes: [refund(5)] }),
      emptyNote: await call("propose_change", { note: "  ", changes: [refund(5)] }),
      noChanges: await call("propose_change", { note: "Why.", changes: [] }),
      notProtected: await call("propose_change", {
        note: "Why.",
        changes: [{ table: "public.plain", operation: "insert", values: { id: 1 } }],
      }),
      cannotRead: await call("propose_change", {
        note: "Why.",
        changes: [{ table: "public.secrets", operation: "insert", values: { id: 1, body: "x" } }],
      }),
      noSuchRow: await call("propose_change", {
        note: "Why.",
        changes: [{ table: "public.orders", operation: "delete", key: { id: 99999 } }],
      }),
      generated: await call("propose_change", {
        note: "Why.",
        changes: [
          { table: "public.orders", operation: "update", key: { id: 5 }, set: { label: "X" } },
        ],
      }),
      unknownProposal: await call("check_proposal", {
        proposal_id: "00000000-0000-4000-8000-000000000000",
      }),
      badWait: await call("check_proposal", {
        proposal_id: "00000000-0000-4000-8000-000000000000",
        wait_seconds: 900,
      }),
    };
    for (const [name, answer] of Object.entries(answers)) {
      expect(answer.isError, name).toBe(true);
      expect(answer.content[0]?.text.length, name).toBeGreaterThan(10);
    }
    expect(answers.noNote.content[0]?.text).toBe('"note" must be text of 1 to 2000 characters.');
    expect(answers.notProtected.content[0]?.text).toContain("not a table under keyturn");
    expect(answers.cannotRead.content[0]?.text).toContain("may not read");
    expect(answers.generated.content[0]?.text).toContain("that can be set");
    expect(answers.unknownProposal.content[0]?.text).toContain("no proposal");
    await expect(client.callTool({ name: "drop_everything", arguments: {} })).rejects.toThrow(
      "no tool",
    );
    expect((await owner.query("select count(*)::int as n from orders")).rows[0].n).toBe(49);
  });

  test("stop waiting when the client gives up, and go on answering", async () => {
    const id = (await call("propose_change", { note: "Refund order 6.", changes: [refund(6)] }))
      .structuredContent?.proposal_id as string;
    const stop = new AbortController();
    const waiting = client.callTool(
      { name: "check_proposal", arguments: { proposal_id: id, wait_seconds: 300 } },
      undefined,
      {
        signal: stop.signal,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop.abort();
    await expect(waiting).rejects.toThrow();
    await client.ping();
    expect((await call("check_proposal", { proposal_id: id })).structuredContent).toMatchObject({
      status: "pending",
    });
  });
});

describe("the agent's tools", () => {
  const start = async (login: string) => {
    const err: string[] = [];
    const input = new PassThrough();
    input.end();
    const code = await run(["tools"], {
      env: { KEYTURN_URL: database.url(login) },
      out: () => {},
      err: (text) => err.push(text),
      color: false,
      input,
      output: new PassThrough(),
    });
    return { code, err: err.join("\n") };
  };

  test("will not be served by a login that could approve or write", async () => {
    expect(await start(logins.agent)).toEqual({ code: 0, err: "" });
    expect((await start(logins.alice)).err).toContain("can approve");
    expect((await start(logins.owner)).err).toContain("not in keyturn_agent");
    expect((await start(logins.stranger)).code).toBe(1);
  });

  /** Sends lines to a server over a database stand-in and gives back what it wrote. */
  const speak = async (
    lines: string[],
    db = { query: async () => ({ rows: [] as unknown[] }) },
  ) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
    const served = serveTools(db, input, output);
    for (const line of lines) {
      input.write(`${line}\n`);
    }
    // The input ending tells the server its client has gone, and it drops what is still running. So it is given a moment first.
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.end();
    await served;
    return written
      .join("")
      .split("\n")
      .filter((line) => line !== "")
      .map(
        (line) =>
          JSON.parse(line) as {
            id: unknown;
            result?: Record<string, unknown>;
            error?: { code: number; message: string };
          },
      );
  };

  test("answer every request with one line of JSON and never anything else", async () => {
    const answers = await speak([
      "this is not json",
      "[1, 2]",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "1999-01-01", capabilities: {} },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "",
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/list" }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "check_proposal", arguments: [1] },
      }),
      JSON.stringify({ jsonrpc: "2.0", id: 5 }),
    ]);
    expect(answers.map((answer) => [answer.id, answer.error?.code ?? "ok"])).toEqual([
      [null, -32700],
      [null, -32600],
      [1, "ok"],
      [2, "ok"],
      [3, -32601],
      [4, "ok"],
      [5, -32600],
    ]);
    // A version it does not know is answered with the latest it does.
    expect(answers[2]?.result?.protocolVersion).toBe("2025-11-25");
    expect(answers[5]?.result?.isError).toBe(true);
  });

  test("say what an id looks like when given something else", async () => {
    const answers = await speak([
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "check_proposal", arguments: { proposal_id: "abcd1234" } },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "apply_proposal", arguments: { proposal_id: "not-a-uuid" } },
      }),
    ]);
    for (const answer of answers) {
      expect(answer.result?.isError).toBe(true);
      expect(JSON.stringify(answer.result)).toContain(
        "must be the id that propose_change returned",
      );
    }
  });

  test("do not claim nothing was written when an apply's answer was lost, and report the fault to the operator", async () => {
    const faults: unknown[] = [];
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
    const served = serveTools(
      {
        query: async () => {
          throw new Error("Connection terminated unexpectedly");
        },
      },
      input,
      output,
      { fault: (error) => faults.push(error) },
    );
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "apply_proposal", arguments: { proposal_id: "00000000-0000-4000-8000-000000000000" } } })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.end();
    await served;
    const answer = JSON.parse(written.join("").trim()) as {
      result: { content: { text: string }[]; isError: boolean };
    };
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0]?.text).toContain(
      "whether the proposal was applied is not known",
    );
    expect(answer.result.content[0]?.text).not.toContain("Connection terminated");
    expect(faults).toHaveLength(1);
  });

  test("refuse a second request under an id that is still running", async () => {
    let finish: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const call = (id: number) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "list_proposals", arguments: {} },
      });
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
    const served = serveTools(
      {
        query: async () => {
          await slow;
          return { rows: [] };
        },
      },
      input,
      output,
    );
    input.write(`${call(7)}\n${call(7)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    finish();
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.end();
    await served;
    const answers = written
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { error?: { code: number }; result?: unknown });
    expect(answers.filter((answer) => answer.error?.code === -32600)).toHaveLength(1);
    expect(answers.filter((answer) => answer.result !== undefined)).toHaveLength(1);
  });

  test("end with a failing exit when the database goes away, so that whatever started them starts them again", async () => {
    const admin = await administrator(database);
    const input = new PassThrough();
    const err: string[] = [];
    const running = run(["tools"], {
      env: { KEYTURN_URL: database.url(logins.otherAgent) },
      out: () => {},
      err: (text) => err.push(text),
      color: false,
      input,
      output: new PassThrough(),
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where usename = $1 and datname = current_database()",
      [logins.otherAgent],
    );
    expect(await running).toBe(1);
    expect(err.join("\n")).toContain("connection to the database was lost");
  });

  test("keep a fault's detail from the model", async () => {
    const answers = await speak(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_proposals", arguments: {} },
        }),
      ],
      {
        query: async () => {
          throw new Error("connect ECONNREFUSED postgres://agent_bot:hunter2secret@10.0.0.5/shop");
        },
      },
    );
    expect(answers).toHaveLength(1);
    expect(answers[0]?.result).toEqual({
      content: [{ type: "text", text: "The tool failed. Nothing was written." }],
      isError: true,
    });
  });
});
