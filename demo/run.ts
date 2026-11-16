// The demonstration: an agent asked to tidy up tries to delete far more than it should.
//
//   pnpm demo            runs it from start to finish and prints what each party sees
//   pnpm demo --review   stops with the proposal waiting and opens the review page on it
//
// No model is called. The "agent" here is a script that sends the SQL a model sent in the
// run this was taken from, as an ordinary database login with ordinary rights. Everything
// printed is what PostgreSQL and keyturn answered.

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { type Io, run } from "../src/cli.ts";
import { install, Keyturn, protect } from "../src/index.ts";

const review = process.argv.includes("--review");
const color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const dim = (text: string) =>
  color ? `${String.fromCharCode(27)}[2m${text}${String.fromCharCode(27)}[0m` : text;
const bold = (text: string) =>
  color ? `${String.fromCharCode(27)}[1m${text}${String.fromCharCode(27)}[0m` : text;
const step = (text: string) => console.log(`\n${bold(text)}`);
const says = (who: string, text: string) =>
  console.log(
    text
      .split("\n")
      .map((line) => `${dim(`${who.padEnd(8)}│`)} ${line}`)
      .join("\n"),
  );

console.log(dim("Starting PostgreSQL in a container..."));
const container = await new PostgreSqlContainer(
  process.env.POSTGRES_IMAGE ?? "postgres:18.3",
).start();
const url = (user: string, password: string) =>
  `postgres://${user}:${password}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
const connect = async (user: string, password: string) => {
  const client = new pg.Client({ connectionString: url(user, password) });
  client.on("error", () => {});
  await client.connect();
  return client;
};

// The shop: 40,000 orders, a dozen of them left over from testing.
const owner = await connect(container.getUsername(), container.getPassword());
await owner.query(`
  create role support_agent login password 'agent';
  create role dana login password 'dana';
  create table orders (
    id        integer primary key,
    customer  text not null,
    total     numeric(10, 2) not null,
    status    text not null default 'paid',
    placed    date not null
  );
  insert into orders
    select n, 'customer ' || (n * 7919 % 9000), 15 + (n * 31 % 400), 'paid', date '2024-01-01' + (n * 1050 / 40000)
      from generate_series(1, 39988) as n;
  insert into orders
    select 39988 + n, 'test ' || n, 1, 'paid', date '2026-11-10' from generate_series(1, 12) as n;
`);
await install(owner);
await protect(owner, "orders");
await owner.query(`
  grant keyturn_agent to support_agent;
  grant keyturn_approver to dana;
  grant select on orders to keyturn_agent, keyturn_approver;
`);

/** One keyturn command as a login, printed as that login sees it. */
async function keyturn(
  who: string,
  login: [string, string],
  args: string[],
  answers: string[] = [],
): Promise<void> {
  const io: Io = {
    env: { KEYTURN_URL: url(...login) },
    out: (text) => says(who, text),
    err: (text) => says(who, text),
    color: false,
  };
  if (answers.length > 0) {
    io.ask = async (question) => {
      says(who, `${question}${answers[0]}`);
      return answers.shift() as string;
    };
  }
  console.log(dim(`$ keyturn ${args.join(" ")}`));
  await run(args, io);
}

const agentDb = await connect("support_agent", "agent");
const notices: string[] = [];
agentDb.on("notice", (notice) => notices.push(notice.message ?? ""));
/** SQL the agent sends, with what the database answered. */
async function agentSends(sql: string): Promise<void> {
  says("agent", sql);
  try {
    const result = await agentDb.query(sql);
    for (const notice of notices.splice(0)) {
      says("postgres", `NOTICE: ${notice}`);
    }
    says(
      "postgres",
      `${result.command ?? "OK"}${result.rowCount === null ? "" : ` ${result.rowCount}`}`,
    );
  } catch (error) {
    says("postgres", `ERROR: ${(error as Error).message}`);
  }
}
const orders = async () =>
  (await owner.query("select count(*)::int as n from orders")).rows[0].n as number;

step("1. The owner checks that the agent's login has no way round.");
await keyturn("owner", [container.getUsername(), container.getPassword()], ["doctor"]);

step(
  '2. The agent is asked to "clean up the old test orders". It writes a delete that is far too wide.',
);
await agentSends("delete from orders where placed < '2024-08-01'");

step("3. It tries the same through the proposal view, which is the only place it may write.");
await agentSends("begin");
await agentSends("select keyturn.note('Cleaning up old test orders, as asked.')");
await agentSends("delete from proposal.orders where placed < '2024-08-01'");
await agentSends("commit");
console.log(dim(`   orders in the table: ${(await orders()).toLocaleString("en")}`));

step("4. Dana, who approves, sees what is waiting and reads it.");
const dana: [string, string] = ["dana", "dana"];
await keyturn("dana", dana, ["list"]);
const waiting = (await new Keyturn(await connect(...dana)).waiting())[0];
if (waiting === undefined) {
  throw new Error("The proposal was not made.");
}
await keyturn("dana", dana, ["show", waiting.id.slice(0, 8), "--rows", "4"]);

if (review) {
  step(
    "The review page is open on it. Read it there, and approve or reject. Ctrl-C ends the demonstration.",
  );
  await run(["review"], {
    env: { KEYTURN_URL: url(...dana) },
    out: (text) => console.log(text),
    err: (text) => console.error(text),
    color: false,
  });
} else {
  step("5. She rejects it, and says why.");
  await keyturn("dana", dana, [
    "reject",
    waiting.id.slice(0, 8),
    "--reason",
    "These are real orders. Test orders are the ones whose customer starts with 'test'.",
  ]);
  console.log(dim(`   orders in the table: ${(await orders()).toLocaleString("en")}`));

  step("6. The agent reads the reason and proposes the twelve rows that were meant.");
  const agent = new Keyturn(agentDb);
  const refused = await agent.proposal(waiting.id);
  says("agent", `proposal ${waiting.id.slice(0, 8)} is ${refused?.status}: ${refused?.reason}`);
  await agentSends("begin");
  await agentSends("select keyturn.note('Deleting the 12 test orders only.')");
  await agentSends("delete from proposal.orders where customer like 'test %'");
  await agentSends("commit");
  const second = (await new Keyturn(await connect(...dana)).waiting())[0];
  if (second === undefined) {
    throw new Error("The second proposal was not made.");
  }

  step('7. Dana reads the twelve rows, types "approve", and the change is written.');
  await keyturn(
    "dana",
    dana,
    ["approve", second.id.slice(0, 8), "--rows", "3", "--apply"],
    ["approve"],
  );
  console.log(dim(`   orders in the table: ${(await orders()).toLocaleString("en")}`));

  step("8. Every step is on record, and the record holds together.");
  await keyturn("dana", dana, ["verify-audit"]);
}

await owner.end();
await agentDb.end();
await container.stop();
process.exit(0);
