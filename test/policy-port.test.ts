import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { apply, Database, logins, propose } from "./database.ts";
import { condition, never } from "./fixtures/refund-policy.ts";

/**
 * A real refund policy, written once as a Keyturn rule and once as plain code, and held
 * against each other on every refund an agent could ask for across a set of support tickets.
 *
 * The question is whether rules can carry a policy that looks at other records and at
 * running totals, so that a person is needed only where the policy itself asks for one.
 *
 * The tickets, payments and limits in fixtures/refund-cases.json are made up. They are the
 * test scenarios of a support agent for subscription billing: two companies with different
 * refund windows and approval limits, and 76 tickets, a third of them attempts at abuse.
 */

type Payment = {
  id: string;
  tenantId: string;
  customerId: string;
  invoiceId: string;
  amountCents: number;
  status: string;
  createdAt: string;
};
type Refund = {
  id: string;
  paymentId: string;
  amountCents: number;
  reason: string;
  createdBy: string;
  createdAt: string;
};
type Tenant = {
  id: string;
  refundWindowDays: number;
  refundApprovalLimitCents: number;
  agentDailyRefundCapCents: number;
};
type Case = {
  id: string;
  tenantId: string;
  customerId: string;
  ticket: { id: string; category: string; customerId: string };
  intent: { reason?: string } | null;
  payments: Payment[];
  refunds: Refund[];
  expected: {
    outcome: string;
    reasonCode: string;
    refunds: { paymentId: string; amountCents: number }[];
    approval: { amountCents: number } | null;
  };
};
type Fixture = {
  now: string;
  tenants: Tenant[];
  base: { payments: Payment[]; refunds: Refund[] };
  scenarios: Case[];
};

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/refund-cases.json", import.meta.url), "utf8"),
) as Fixture;
const now = new Date(fixture.now);
const DAY = 86_400_000;
const REASONS = ["duplicate_charge", "customer_request", "service_credit"] as const;

const schema = `
  create function sim_now() returns timestamptz language sql immutable as $$select '${fixture.now}'::timestamptz$$;
  create table tenants (
    id text primary key,
    refund_window_days integer not null,
    refund_approval_limit_cents integer not null,
    agent_daily_refund_cap_cents integer not null
  );
  create table tickets (id text primary key, tenant_id text not null, customer_id text not null, category text not null);
  create table payments (
    id text primary key, tenant_id text not null, customer_id text not null, invoice_id text not null,
    amount_cents integer not null, status text not null, created_at timestamptz not null
  );
  create table refunds (
    id uuid primary key default gen_random_uuid(),
    ticket_id text,
    payment_id text not null,
    amount_cents integer not null,
    reason text not null,
    created_by text not null default 'agent',
    created_at timestamptz not null default sim_now()
  );
  select keyturn.protect('refunds');
  grant select on tenants, tickets, payments, refunds to keyturn_agent, keyturn_approver;
`;

type Ask = { ticketId: string; paymentId: string; amountCents: number; reason: string };
type World = { payments: Payment[]; refunds: (Refund & { ticketId?: string })[] };

/** The same policy as code: "alone" when no person is needed, "person" when one is, "never" when no approval may allow it. */
function policy(ask: Ask, world: World, scenario: Case): "alone" | "person" | "never" {
  const tenant = fixture.tenants.find((candidate) => candidate.id === scenario.tenantId);
  const payment = world.payments.find((candidate) => candidate.id === ask.paymentId);
  if (!tenant || !payment || payment.customerId !== scenario.ticket.customerId) return "never";
  if (scenario.ticket.category !== "refund" || ask.amountCents <= 0) return "never";
  const refunded = (rows: World["refunds"]) => rows.reduce((sum, row) => sum + row.amountCents, 0);
  const days = (from: string) => Math.floor((now.getTime() - Date.parse(from)) / DAY);
  const sameInvoice = world.payments.filter((other) => other.invoiceId === payment.invoiceId);
  const ofCustomer = new Set(
    world.payments.filter((other) => other.customerId === payment.customerId).map((p) => p.id),
  );
  const ofTenant = new Set(
    world.payments.filter((other) => other.tenantId === payment.tenantId).map((p) => p.id),
  );

  if (
    ask.amountCents + refunded(world.refunds.filter((r) => r.paymentId === payment.id)) >
    payment.amountCents
  ) {
    return "never";
  }
  if (ask.reason !== "duplicate_charge" && days(payment.createdAt) > tenant.refundWindowDays) {
    return "never";
  }
  if (ask.reason === "duplicate_charge") {
    const earlier = sameInvoice.some(
      (other) =>
        other.status === "succeeded" &&
        (other.createdAt < payment.createdAt ||
          (other.createdAt === payment.createdAt && other.id < payment.id)),
    );
    if (payment.status !== "succeeded" || !earlier) return "never";
  }
  if (sameInvoice.some((other) => other.status === "disputed")) return "never";
  if (
    ask.reason === "customer_request" &&
    world.refunds.some(
      (r) =>
        ofCustomer.has(r.paymentId) && r.reason === "customer_request" && days(r.createdAt) <= 365,
    )
  ) {
    return "never";
  }
  const today = refunded(
    world.refunds.filter(
      (r) =>
        ofTenant.has(r.paymentId) &&
        r.createdBy === "agent" &&
        Date.parse(r.createdAt) > now.getTime() - DAY,
    ),
  );
  const onTicket = refunded(world.refunds.filter((r) => r.ticketId === ask.ticketId));
  if (
    payment.amountCents > tenant.refundApprovalLimitCents ||
    onTicket + ask.amountCents > tenant.refundApprovalLimitCents ||
    today + ask.amountCents > tenant.agentDailyRefundCapCents
  ) {
    return "person";
  }
  return "alone";
}

let database: Database;
let owner: pg.Client;
let agent: pg.Client;
let alice: pg.Client;

const insertPayments = (rows: Payment[]) =>
  owner.query(
    `insert into payments select id, "tenantId", "customerId", "invoiceId", "amountCents", status, "createdAt"
       from jsonb_to_recordset($1::jsonb) as r(id text, "tenantId" text, "customerId" text, "invoiceId" text, "amountCents" integer, status text, "createdAt" timestamptz)`,
    [JSON.stringify(rows)],
  );
const insertRefunds = (rows: Refund[]) =>
  owner.query(
    `insert into refunds (payment_id, amount_cents, reason, created_by, created_at)
       select "paymentId", "amountCents", reason, "createdBy", "createdAt"
         from jsonb_to_recordset($1::jsonb) as r("paymentId" text, "amountCents" integer, reason text, "createdBy" text, "createdAt" timestamptz)`,
    [JSON.stringify(rows)],
  );

const asChange = (ask: Ask) => ({
  table: "refunds",
  operation: "insert",
  values: {
    ticket_id: ask.ticketId,
    payment_id: ask.paymentId,
    amount_cents: ask.amountCents,
    reason: ask.reason,
    created_by: "agent",
  },
});

/** Proposes and applies as the agent: "never" if it is refused outright, "alone" if a rule lets it through, "person" if it waits. */
async function ask(request: Ask, client: pg.Client = agent): Promise<"alone" | "person" | "never"> {
  let proposed: Awaited<ReturnType<typeof propose>>;
  try {
    proposed = await propose(client, [asChange(request)]);
  } catch (error) {
    expect((error as Error).message).toContain("forbidden by the rule refund_never: ");
    return "never";
  }
  return decide(client, proposed.proposal_id);
}

async function decide(client: pg.Client, proposal: string): Promise<"alone" | "person"> {
  let outcome: Awaited<ReturnType<typeof apply>>;
  try {
    outcome = await apply(client, proposal);
  } catch (error) {
    expect((error as Error).message).toContain("pending, not approved");
    // It waits for a person. It is turned down here so that the queue does not fill.
    await alice.query("select keyturn.reject($1, $2)", [proposal, "Not decided in this test."]);
    return "person";
  }
  expect(outcome.status, JSON.stringify(outcome)).toBe("applied");
  return "alone";
}

async function load(scenario: Case) {
  await owner.query("delete from refunds");
  await owner.query("delete from payments where id <> all($1::text[])", [
    fixture.base.payments.map((payment) => payment.id),
  ]);
  await owner.query("delete from tickets");
  await insertRefunds(fixture.base.refunds);
  await insertPayments(scenario.payments);
  await insertRefunds(scenario.refunds);
  await owner.query("insert into tickets values ($1, $2, $3, $4)", [
    scenario.ticket.id,
    scenario.tenantId,
    scenario.ticket.customerId,
    scenario.ticket.category,
  ]);
}

const worldOf = (scenario: Case): World => ({
  payments: [...fixture.base.payments, ...scenario.payments],
  refunds: [...fixture.base.refunds, ...scenario.refunds],
});

beforeAll(async () => {
  database = await Database.create(schema);
  [owner, agent, alice] = await Promise.all([
    database.as(logins.owner),
    database.as(logins.agent),
    database.as(logins.alice),
  ]);
  await owner.query(
    `insert into tenants select id, "refundWindowDays", "refundApprovalLimitCents", "agentDailyRefundCapCents"
       from jsonb_to_recordset($1::jsonb) as r(id text, "refundWindowDays" integer, "refundApprovalLimitCents" integer, "agentDailyRefundCapCents" integer)`,
    [JSON.stringify(fixture.tenants)],
  );
  await insertPayments(fixture.base.payments);
  await owner.query(
    `select keyturn.allow('refund_policy', 'refunds', array['insert'],
       array['ticket_id', 'payment_id', 'amount_cents', 'reason', 'created_by'],
       max_rows => 1, condition => $1, per_hour => 100000)`,
    [condition],
  );
  await owner.query(
    `select keyturn.forbid('refund_never', 'refunds', array['insert'], $1,
       'The refund policy does not allow this refund, with or without approval.')`,
    [never],
  );
}, 120_000);

afterAll(async () => {
  await database.close();
});

describe("a refund policy written as one rule", () => {
  test("lets through exactly the correct refunds that the policy lets through", async () => {
    const tally = { tickets: 0, withWrite: 0, alone: 0, person: 0, policyPerson: 0 };
    for (const scenario of fixture.scenarios) {
      tally.tickets += 1;
      if (scenario.expected.refunds.length === 0) continue;
      tally.withWrite += 1;
      await load(scenario);
      const reason =
        scenario.intent?.reason === "duplicate_charge"
          ? "duplicate_charge"
          : scenario.intent?.reason === "service_issue"
            ? "service_credit"
            : "customer_request";
      let waited = false;
      for (const refund of scenario.expected.refunds) {
        const outcome = await ask({ ticketId: scenario.ticket.id, ...refund, reason });
        waited ||= outcome === "person";
      }
      // The scenario's own, hand-written answer to "does this need a person?".
      expect(waited, scenario.id).toBe(scenario.expected.approval !== null);
      if (waited) tally.person += 1;
      else tally.alone += 1;
      if (scenario.expected.approval) tally.policyPerson += 1;
    }
    // Of 76 tickets, 27 end in a refund. The rule decides 24 of them alone and leaves 3 to a person,
    // the same 3 the policy leaves to one.
    expect(tally).toEqual({ tickets: 76, withWrite: 27, alone: 24, person: 3, policyPerson: 3 });
  }, 300_000);

  test("agrees with the policy on every refund an agent could ask for", async () => {
    const tally = { asked: 0, alone: 0, person: 0, never: 0, disagreements: [] as string[] };
    for (const scenario of fixture.scenarios) {
      if (scenario.payments.length === 0) continue;
      const world = worldOf(scenario);
      // Every payment of the customer, one of another customer, for every reason, whole and in half.
      const stranger = fixture.base.payments.find(
        (payment) =>
          payment.tenantId === scenario.tenantId && payment.customerId !== scenario.customerId,
      );
      const targets = [...scenario.payments, ...(stranger ? [stranger] : [])];
      for (const payment of targets) {
        for (const reason of REASONS) {
          for (const amountCents of [payment.amountCents, Math.floor(payment.amountCents / 2)]) {
            const request = {
              ticketId: scenario.ticket.id,
              paymentId: payment.id,
              amountCents,
              reason,
            };
            const wanted = policy(request, world, scenario);
            // Each request is judged on the records as they were: what an earlier one wrote is taken out.
            await load(scenario);
            const got = await ask(request);
            tally.asked += 1;
            tally[wanted] += 1;
            if (wanted !== got) {
              tally.disagreements.push(
                `${scenario.id} ${payment.id} ${reason} ${amountCents}: policy ${wanted}, rule ${got}`,
              );
            }
          }
        }
      }
    }
    expect(tally.disagreements).toEqual([]);
    expect({
      asked: tally.asked,
      alone: tally.alone,
      person: tally.person,
      never: tally.never,
    }).toEqual({
      asked: 1302,
      alone: 160,
      person: 36,
      never: 1106,
    });
  }, 900_000);

  test("does not let a refund above the limit through in parts, one after another or at once", async () => {
    const scenario = fixture.scenarios.find(
      (candidate) => candidate.id === "attack-split-to-avoid-approval",
    );
    if (!scenario) throw new Error("the split scenario is missing");
    const tenant = fixture.tenants.find((candidate) => candidate.id === scenario.tenantId);
    if (!tenant) throw new Error("no tenant");
    // Two payments, each small enough to be refunded alone, which together pass the ticket's limit.
    const part = Math.floor(tenant.refundApprovalLimitCents * 0.6);
    await load(scenario);
    const made = ["pay_split_one", "pay_split_two"].map((id, index) => ({
      id,
      tenantId: scenario.tenantId,
      customerId: scenario.ticket.customerId,
      invoiceId: `inv_split_${index}`,
      amountCents: part,
      status: "succeeded",
      createdAt: new Date(now.getTime() - DAY).toISOString(),
    }));
    await insertPayments(made);
    const requests = made.map((payment) => ({
      ticketId: scenario.ticket.id,
      paymentId: payment.id,
      amountCents: part,
      reason: "service_credit",
    }));

    // One after another: the second sees what the first wrote.
    expect(await ask(requests[0] as Ask)).toBe("alone");
    expect(await ask(requests[1] as Ask)).toBe("person");

    // At once, from two connections, both proposed before either is applied.
    await owner.query("delete from refunds");
    const second = await database.as(logins.otherAgent);
    const [one, two] = await Promise.all([
      propose(agent, [asChange(requests[0] as Ask)]),
      propose(second, [asChange(requests[1] as Ask)]),
    ]);
    const outcomes = await Promise.all([
      decide(agent, one.proposal_id),
      decide(second, two.proposal_id),
    ]);
    expect(outcomes.sort()).toEqual(["alone", "person"]);
    const total = await owner.query(
      "select coalesce(sum(amount_cents), 0)::integer as cents from refunds",
    );
    expect(total.rows[0].cents).toBe(part);
  }, 120_000);
});
