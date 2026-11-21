// The refund desk: a support database for two companies that sell subscriptions, with the
// refunds table under Keyturn and the refund policy written as rules.
//
//   node examples/refund-desk/serve.ts
//
// Starts PostgreSQL in a container, sets everything up, and stays up until it is stopped.
// The other programs here find it through the file it leaves beside itself.

import { readFile, rm, writeFile } from "node:fs/promises";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { install, protect } from "../../src/index.ts";
import { condition, never } from "../../test/fixtures/refund-policy.ts";

type Row = Record<string, unknown>;
type Ticket = {
  id: string;
  tenantId: string;
  customerId: string;
  customer: { id: string; name: string; email: string };
  ticket: { id: string; category: string; customerId: string; subject: string; body: string };
  invoices: Row[];
  payments: Row[];
  refunds: Row[];
};

export const STATE = new URL("./.state.json", import.meta.url);
const fixture = JSON.parse(
  await readFile(new URL("../../test/fixtures/refund-cases.json", import.meta.url), "utf8"),
) as {
  now: string;
  tenants: Row[];
  base: { payments: Row[]; invoices: Row[] };
  scenarios: Ticket[];
};

const container = await new PostgreSqlContainer(
  process.env.POSTGRES_IMAGE ?? "postgres:18.3",
).start();
const url = (user: string, password: string) =>
  `postgres://${user}:${password}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
const owner = new pg.Client({
  connectionString: url(container.getUsername(), container.getPassword()),
});
await owner.connect();

await owner.query(`
  create role support_agent login password 'agent';
  create role dana login password 'dana';
  -- The desk's own clock, so that "fourteen days ago" means the same on any day this is run.
  create function sim_now() returns timestamptz language sql immutable as $$select '${fixture.now}'::timestamptz$$;
  create table tenants (
    id text primary key, name text not null, refund_window_days integer not null,
    refund_approval_limit_cents integer not null, agent_daily_refund_cap_cents integer not null
  );
  create table customers (id text primary key, tenant_id text not null references tenants (id), name text not null, email text);
  create table tickets (
    id text primary key, tenant_id text not null references tenants (id), customer_id text not null references customers (id),
    category text not null, subject text not null, body text not null
  );
  create table invoices (
    id text primary key, tenant_id text not null references tenants (id), customer_id text not null references customers (id),
    number text not null, status text not null, amount_cents integer not null, issued_at timestamptz not null,
    -- Free text entered by the customer at checkout.
    reference text
  );
  create table payments (
    id text primary key, tenant_id text not null references tenants (id), customer_id text not null references customers (id),
    invoice_id text not null references invoices (id), amount_cents integer not null, status text not null, created_at timestamptz not null
  );
  create table refunds (
    id uuid primary key default gen_random_uuid(),
    ticket_id text references tickets (id),
    payment_id text not null references payments (id),
    amount_cents integer not null,
    reason text not null,
    created_by text not null default 'agent',
    created_at timestamptz not null default sim_now()
  );
`);
await install(owner);
await protect(owner, "refunds");

const load = (table: string, columns: string, rows: Row[]) =>
  rows.length === 0
    ? null
    : owner.query(
        `insert into ${table} select ${columns} from jsonb_to_recordset($1::jsonb) as r(${columns
          .split(", ")
          .map(
            (name) =>
              `${name} ${/Cents"$/.test(name) || /Days"$/.test(name) ? "integer" : /At"$/.test(name) ? "timestamptz" : "text"}`,
          )
          .join(", ")}) on conflict do nothing`,
        [JSON.stringify(rows)],
      );
await load(
  "tenants",
  `id, name, "refundWindowDays", "refundApprovalLimitCents", "agentDailyRefundCapCents"`,
  fixture.tenants.map((tenant) => ({
    ...tenant,
    name: tenant.slug === "harbor" ? "Harbor Notes" : "Tallyfield",
  })),
);
// Only tickets about refunds: the rest of the set is about plans and a help centre, which are not here.
const tickets = fixture.scenarios.filter(
  (one) => one.ticket.category === "refund" && !one.id.startsWith("knowledge-"),
);
const invoices = [...fixture.base.invoices, ...tickets.flatMap((one) => one.invoices)];
const payments = [...fixture.base.payments, ...tickets.flatMap((one) => one.payments)];
const named = new Map(
  tickets.map((one) => [one.customer.id, { tenantId: one.tenantId, ...one.customer }]),
);
for (const row of [...invoices, ...payments]) {
  if (!named.has(row.customerId as string)) {
    named.set(row.customerId as string, {
      id: row.customerId as string,
      tenantId: row.tenantId as string,
      name: "Another customer",
      email: "",
    });
  }
}
await load("customers", `id, "tenantId", name, email`, [...named.values()]);
await load(
  "tickets",
  `id, "tenantId", "customerId", category, subject, body`,
  tickets.map((one) => ({ ...one.ticket, tenantId: one.tenantId })),
);
await load(
  "invoices",
  `id, "tenantId", "customerId", number, status, "amountCents", "issuedAt", reference`,
  invoices,
);
await load(
  "payments",
  `id, "tenantId", "customerId", "invoiceId", "amountCents", status, "createdAt"`,
  payments,
);
for (const one of tickets) {
  for (const refund of one.refunds) {
    await owner.query(
      "insert into refunds (payment_id, amount_cents, reason, created_by, created_at) values ($1, $2, $3, $4, $5)",
      [refund.paymentId, refund.amountCents, refund.reason, refund.createdBy, refund.createdAt],
    );
  }
}

await owner.query(`
  grant keyturn_agent to support_agent;
  grant keyturn_approver to dana;
  grant select on tenants, customers, tickets, invoices, payments, refunds to keyturn_agent, keyturn_approver;
`);
// The policy, as the two rules of test/fixtures/refund-policy.ts: what needs no person, and what no approval allows.
await owner.query(
  `select keyturn.allow('refund_policy', 'refunds', array['insert'],
     array['ticket_id', 'payment_id', 'amount_cents', 'reason', 'created_by'], max_rows => 1, condition => $1, per_hour => 100000)`,
  [condition],
);
await owner.query(
  `select keyturn.forbid('refund_never', 'refunds', array['insert'], $1,
     'The refund policy does not allow this refund, with or without approval.')`,
  [never],
);

await writeFile(
  STATE,
  JSON.stringify({
    owner: url(container.getUsername(), container.getPassword()),
    agent: url("support_agent", "agent"),
    approver: url("dana", "dana"),
    tickets: tickets.map((one) => one.id),
  }),
);
console.log(`The refund desk is up, with ${tickets.length} tickets. Ctrl-C stops it.`);
console.log(`  agent     KEYTURN_URL=${url("support_agent", "agent")}`);
console.log(`  approver  KEYTURN_URL=${url("dana", "dana")}   (keyturn review, keyturn list)`);

const stop = async () => {
  await rm(STATE, { force: true });
  await owner.end().catch(() => {});
  await container.stop();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
await new Promise(() => {});
