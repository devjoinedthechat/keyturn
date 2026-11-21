// Builds the material for the catch-rate study: every refund from the policy test that
// reaches a person, printed the way `keyturn show` prints it, twice. Once as the rows alone,
// and once with what is shown beside them: why it waits and the rows it points to.
//
//   node study/catch-rate/build.ts
//
// Writes study/catch-rate/items.json (with the answer for each), and one sheet for each
// way of showing, in the same shuffled order, without the answers.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { Keyturn } from "../../src/index.ts";
import { renderProposal, type Style } from "../../src/render.ts";
import { condition, never } from "../../test/fixtures/refund-policy.ts";

type Payment = {
  id: string;
  tenantId: string;
  customerId: string;
  invoiceId: string;
  amountCents: number;
  status: string;
  createdAt: string;
};
type Case = {
  id: string;
  tenantId: string;
  customerId: string;
  ticket: { id: string; category: string; customerId: string; subject: string; body: string };
  intent: { reason?: string } | null;
  payments: Payment[];
  refunds: {
    paymentId: string;
    amountCents: number;
    reason: string;
    createdBy: string;
    createdAt: string;
  }[];
  expected: {
    outcome: string;
    refunds: { paymentId: string; amountCents: number }[];
    approval: { amountCents: number } | null;
  };
};
type Fixture = {
  now: string;
  tenants: Record<string, unknown>[];
  base: { payments: Payment[] };
  scenarios: Case[];
};

const here = new URL("./", import.meta.url);
const fixture = JSON.parse(
  await readFile(new URL("../../test/fixtures/refund-cases.json", import.meta.url), "utf8"),
) as Fixture;

const container = await new PostgreSqlContainer(
  process.env.POSTGRES_IMAGE ?? "postgres:18.3",
).start();
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
  create role support_agent login password 'study' in role keyturn_agent;
  create role dana login password 'study' in role keyturn_approver;`);
const folder = new URL("../../sql/", import.meta.url);
for (const file of (await readdir(folder)).filter((name) => name.endsWith(".sql")).sort()) {
  await owner.query(await readFile(new URL(file, folder), "utf8"));
}
await owner.query(`
  create function sim_now() returns timestamptz language sql immutable as $$select '${fixture.now}'::timestamptz$$;
  create table tenants (
    id text primary key, name text not null, refund_window_days integer not null,
    refund_approval_limit_cents integer not null, agent_daily_refund_cap_cents integer not null
  );
  create table tickets (
    id text primary key, tenant_id text not null references tenants (id), customer_id text not null,
    category text not null, subject text not null, body text not null
  );
  create table payments (
    id text primary key, tenant_id text not null references tenants (id), customer_id text not null, invoice_id text not null,
    amount_cents integer not null, status text not null, created_at timestamptz not null
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
  select keyturn.protect('refunds');
  grant select on tenants, tickets, payments, refunds to keyturn_agent, keyturn_approver;`);
await owner.query(
  `insert into tenants select id, name, "refundWindowDays", "refundApprovalLimitCents", "agentDailyRefundCapCents"
     from jsonb_to_recordset($1::jsonb) as r(id text, name text, "refundWindowDays" integer, "refundApprovalLimitCents" integer, "agentDailyRefundCapCents" integer)`,
  [
    JSON.stringify(
      fixture.tenants.map((tenant) => ({
        ...tenant,
        name: tenant.slug === "harbor" ? "Harbor Notes" : "Tallyfield",
      })),
    ),
  ],
);
await owner.query(
  `select keyturn.allow('refund_policy', 'refunds', array['insert'],
     array['ticket_id', 'payment_id', 'amount_cents', 'reason', 'created_by'], max_rows => 1, condition => $1, per_hour => 100000)`,
  [condition],
);
await owner.query(
  `select keyturn.forbid('refund_never', 'refunds', array['insert'], $1, 'The refund policy does not allow this refund, with or without approval.')`,
  [never],
);

const insertPayments = (rows: Payment[]) =>
  owner.query(
    `insert into payments select id, "tenantId", "customerId", "invoiceId", "amountCents", status, "createdAt"
       from jsonb_to_recordset($1::jsonb) as r(id text, "tenantId" text, "customerId" text, "invoiceId" text, "amountCents" integer, status text, "createdAt" timestamptz)`,
    [JSON.stringify(rows)],
  );
await insertPayments(fixture.base.payments);

const agentDb = await connect("support_agent", "study");
const agent = new Keyturn(agentDb);
const approverDb = await connect("dana", "study");
const approver = new Keyturn(approverDb);
const style: Style = { color: false, full: true, unchanged: false };
const baseIds = fixture.base.payments.map((payment) => payment.id);

type Item = {
  scenario: string;
  ask: { paymentId: string; amountCents: number; reason: string };
  /** Whether this is the request a careful agent would have sent for the ticket. */
  right: boolean;
  rows: string;
  context: string;
};
const items: Item[] = [];
const tally = { asked: 0, refused: 0, alone: 0, person: 0 };

for (const scenario of fixture.scenarios) {
  if (scenario.payments.length === 0) continue;
  await owner.query("delete from refunds");
  await owner.query("delete from payments where id <> all($1::text[])", [baseIds]);
  await owner.query("delete from tickets");
  await insertPayments(scenario.payments);
  await owner.query(
    `insert into refunds (payment_id, amount_cents, reason, created_by, created_at)
       select "paymentId", "amountCents", reason, "createdBy", "createdAt"
         from jsonb_to_recordset($1::jsonb) as r("paymentId" text, "amountCents" integer, reason text, "createdBy" text, "createdAt" timestamptz)`,
    [JSON.stringify(scenario.refunds)],
  );
  await owner.query("insert into tickets values ($1, $2, $3, $4, $5, $6)", [
    scenario.ticket.id,
    scenario.tenantId,
    scenario.ticket.customerId,
    scenario.ticket.category,
    scenario.ticket.subject,
    scenario.ticket.body,
  ]);
  const reasonWanted =
    scenario.intent?.reason === "duplicate_charge"
      ? "duplicate_charge"
      : scenario.intent?.reason === "service_issue"
        ? "service_credit"
        : "customer_request";

  for (const payment of scenario.payments) {
    for (const reason of ["duplicate_charge", "customer_request", "service_credit"]) {
      for (const amountCents of [payment.amountCents, Math.floor(payment.amountCents / 2)]) {
        tally.asked += 1;
        let id: string;
        try {
          ({ id } = await agent.propose(
            [
              {
                table: "refunds",
                operation: "insert",
                values: {
                  ticket_id: scenario.ticket.id,
                  payment_id: payment.id,
                  amount_cents: amountCents,
                  reason,
                  created_by: "agent",
                },
              },
            ],
            // What an agent would write whether it was right or had been talked into it.
            { note: "Refund for the customer's request on this ticket." },
          ));
        } catch {
          tally.refused += 1;
          continue;
        }
        const applied = await agent.apply(id).then(
          () => true,
          () => false,
        );
        if (applied) {
          tally.alone += 1;
          await owner.query("delete from refunds where payment_id = $1 and ticket_id = $2", [
            payment.id,
            scenario.ticket.id,
          ]);
          continue;
        }
        tally.person += 1;
        const proposal = await approver.proposal(id);
        if (proposal === null) throw new Error("the approver cannot see the proposal");
        const extent = await approver.extent(id);
        const rows = await approver.diff(id);
        const context = {
          references: await approver.refersTo(id),
          waits: await approver.waitsBecause(id),
        };
        // The id and the hash are different every run and tell a reader nothing.
        const steady = (text: string) =>
          text.replaceAll(id, "(proposal)").replaceAll(proposal.contentHash, "(hash)");
        items.push({
          scenario: scenario.id,
          ask: { paymentId: payment.id, amountCents, reason },
          // The one request a careful agent would send for this ticket: the reason the ticket
          // gives, the whole amount the policy sends to a person, and, where the ticket's own
          // answer names a payment, that payment.
          right:
            scenario.expected.approval !== null &&
            reason === reasonWanted &&
            amountCents === scenario.expected.approval.amountCents &&
            (scenario.expected.refunds.length === 0 ||
              scenario.expected.refunds.some((wanted) => wanted.paymentId === payment.id)),
          rows: steady(renderProposal(proposal, extent, rows, style)),
          context: steady(renderProposal(proposal, extent, rows, style, context)),
        });
        await approver.reject(id, "Study.");
      }
    }
  }
}

// One order for both sheets, the same every run.
let seed = 20261121;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const order = items.map((_, index) => index);
for (let index = order.length - 1; index > 0; index -= 1) {
  const other = Math.floor(random() * (index + 1));
  [order[index], order[other]] = [order[other] as number, order[index] as number];
}
const sheet = (which: "rows" | "context") =>
  order
    .map(
      (index, place) =>
        `## Item ${place + 1}\n\n\`\`\`text\n${(items[index] as Item)[which]}\n\`\`\`\n`,
    )
    .join("\n");

await writeFile(
  new URL("items.json", here),
  `${JSON.stringify(
    order.map((index, place) => ({ item: place + 1, ...(items[index] as Item) })),
    null,
    2,
  )}\n`,
);
await writeFile(new URL("sheet-rows.md", here), sheet("rows"));
await writeFile(new URL("sheet-context.md", here), sheet("context"));
console.log(
  JSON.stringify({
    ...tally,
    items: items.length,
    right: items.filter((item) => item.right).length,
  }),
);

await Promise.all([owner.end(), agentDb.end(), approverDb.end()]);
await container.stop();
process.exit(0);
