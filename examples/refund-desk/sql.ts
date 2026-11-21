// One SQL statement, sent as the agent's login. This is the whole of what the agent has.
//
//   node examples/refund-desk/sql.ts "select * from invoices where number = 'INV-000163'"
//
// Prints the rows as JSON, or what PostgreSQL refused it with. Each statement and its answer
// is added to .log.jsonl beside this file, so that a run can be read afterwards.

import { appendFile, readFile } from "node:fs/promises";
import pg from "pg";

const statement = process.argv.slice(2).join(" ").trim();
if (statement === "") {
  console.error('Give one SQL statement: node examples/refund-desk/sql.ts "select ..."');
  process.exit(2);
}
let state: { agent: string };
try {
  state = JSON.parse(await readFile(new URL("./.state.json", import.meta.url), "utf8"));
} catch {
  console.error("The refund desk is not up. Start it: node examples/refund-desk/serve.ts");
  process.exit(1);
}

const client = new pg.Client({ connectionString: state.agent });
const notices: string[] = [];
client.on("notice", (notice) => notices.push(notice.message ?? ""));
await client.connect();
let answer: { rows?: unknown[]; changed?: number | null; notices?: string[]; error?: string };
try {
  const result = await client.query(statement);
  const last = Array.isArray(result) ? result.at(-1) : result;
  answer = { rows: last.rows.slice(0, 200), changed: last.rowCount };
} catch (error) {
  answer = { error: (error as Error).message };
}
if (notices.length > 0) {
  answer.notices = notices;
}
await client.end();
await appendFile(
  new URL("./.log.jsonl", import.meta.url),
  `${JSON.stringify({ ticket: process.env.TICKET ?? null, statement, ...answer })}\n`,
);
console.log(JSON.stringify(answer, null, 2));
process.exit(answer.error === undefined ? 0 : 1);
