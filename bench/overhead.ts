// What Keyturn costs, measured against writing directly.
//
//   pnpm bench                       PostgreSQL 18.3 in a container
//   POSTGRES_IMAGE=postgres:16 pnpm bench
//
// One connection for each party, on the machine the database runs on, so the figures are
// the database's work and not the network's. Every figure is the median of the runs.

import { readdir, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";

const image = process.env.POSTGRES_IMAGE ?? "postgres:18.3";
const runs = Number(process.env.RUNS ?? 200);

const container = await new PostgreSqlContainer(image).start();
const connect = async (user: string, password: string) => {
  const client = new pg.Client({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user,
    password,
  });
  await client.connect();
  return client;
};

const owner = await connect(container.getUsername(), container.getPassword());
await owner.query(`
  create role keyturn_agent nologin; create role keyturn_approver nologin; create role keyturn_rule nologin;
  create role bench_agent login password 'bench' in role keyturn_agent;
  create role bench_approver login password 'bench' in role keyturn_approver;`);
const folder = new URL("../sql/", import.meta.url);
for (const file of (await readdir(folder)).filter((name) => name.endsWith(".sql")).sort()) {
  await owner.query(await readFile(new URL(file, folder), "utf8"));
}
await owner.query(`
  create table orders (id integer primary key, customer text not null, total numeric(10, 2) not null,
                       status text not null default 'paid', placed timestamptz not null default now(), memo text);
  insert into orders (id, customer, total) select n, 'customer ' || n, 20 + n % 500 from generate_series(1, 200000) as n;
  create table plain (like orders including all);
  insert into plain select * from orders;
  select keyturn.protect('orders');
  grant select on orders to keyturn_agent, keyturn_approver;
  analyze;`);
const agent = await connect("bench_agent", "bench");
const approver = await connect("bench_approver", "bench");

const median = (times: number[]) =>
  [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)] as number;
async function timed(count: number, work: (index: number) => Promise<unknown>): Promise<number> {
  const times: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const from = performance.now();
    await work(index);
    times.push(performance.now() - from);
  }
  return median(times);
}

let next = 0;
const fresh = (count: number) => {
  const ids = Array.from({ length: count }, (_, index) => next + index + 1);
  next += count;
  return ids;
};

const results: [string, number][] = [];
const report = (name: string, ms: number) => {
  results.push([name, ms]);
  console.log(`${name.padEnd(58)} ${ms.toFixed(2).padStart(9)} ms`);
};

console.log(`${image}, median of ${runs} runs\n`);

// One row.
report(
  "direct update, one row",
  await timed(runs, () =>
    owner.query("update plain set status = 'shipped' where id = $1", fresh(1)),
  ),
);
const one = { propose: [] as number[], approve: [] as number[], apply: [] as number[] };
for (let index = 0; index < runs; index += 1) {
  const [id] = fresh(1);
  let from = performance.now();
  const made = (
    await agent.query("select * from keyturn.propose($1::jsonb, 'bench')", [
      JSON.stringify([
        { table: "orders", operation: "update", key: { id }, set: { status: "shipped" } },
      ]),
    ])
  ).rows[0];
  one.propose.push(performance.now() - from);
  from = performance.now();
  await approver.query("select keyturn.approve($1, $2)", [made.proposal_id, made.content_hash]);
  one.approve.push(performance.now() - from);
  from = performance.now();
  await agent.query("select keyturn.apply($1)", [made.proposal_id]);
  one.apply.push(performance.now() - from);
}
report("propose, one row", median(one.propose));
report("approve, one row", median(one.approve));
report("apply, one row", median(one.apply));
report(
  "propose through the view, one row",
  await timed(runs, () =>
    agent.query("update proposal.orders set status = 'held' where id = $1", fresh(1)),
  ),
);

// A login may have 200 proposals waiting. The ones a measurement leaves behind are turned
// down before the next, outside what is timed.
const clear = () =>
  approver.query(
    "select keyturn.reject(id, 'bench') from keyturn.proposals where status = 'pending'",
  );
await clear();

// Many rows in one statement.
for (const size of [100, 1000, 10000]) {
  const few = Math.max(3, Math.round(runs / (size / 10) / 4));
  report(
    `direct delete, ${size} rows`,
    await timed(few, async () => {
      const ids = fresh(size);
      await owner.query("delete from plain where id between $1 and $2", [ids[0], ids.at(-1)]);
    }),
  );
  const many = { propose: [] as number[], approve: [] as number[], apply: [] as number[] };
  for (let index = 0; index < few; index += 1) {
    const ids = fresh(size);
    let from = performance.now();
    await agent.query("begin");
    await agent.query("delete from proposal.orders where id between $1 and $2", [
      ids[0],
      ids.at(-1),
    ]);
    const made = (await agent.query("select * from keyturn.proposed()")).rows[0];
    await agent.query("commit");
    many.propose.push(performance.now() - from);
    from = performance.now();
    await approver.query("select keyturn.approve($1, $2)", [made.proposal_id, made.content_hash]);
    many.approve.push(performance.now() - from);
    from = performance.now();
    await agent.query("select keyturn.apply($1)", [made.proposal_id]);
    many.apply.push(performance.now() - from);
  }
  report(
    `propose by function, ${size} rows`,
    await timed(few, async () => {
      const ids = fresh(size);
      await agent.query("select * from keyturn.propose($1::jsonb, 'bench')", [
        JSON.stringify(ids.map((id) => ({ table: "orders", operation: "delete", key: { id } }))),
      ]);
    }),
  );
  await clear();
  report(`propose through the view, ${size} rows`, median(many.propose));
  report(`approve, ${size} rows`, median(many.approve));
  report(`apply, ${size} rows`, median(many.apply));
}

await Promise.all([owner.end(), agent.end(), approver.end()]);
await container.stop();
