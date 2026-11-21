/**
 * A refund policy for subscription billing, as the two conditions Keyturn rules take: one
 * for refunds that need no person, one for refunds no approval allows. They read the tables
 * public.tenants, public.tickets, public.payments and public.refunds, and public.sim_now()
 * for the time, so that a test does not depend on the day it runs.
 */

/** The policy as one rule. Each line answers one of the policy's own conditions. */
export const condition = `
  exists (
    select 1
      from public.payments p
      join public.tenants n on n.id = p.tenant_id
      join public.tickets t on t.id = after ->> 'ticket_id'
     where p.id = after ->> 'payment_id'
       and t.category = 'refund' and t.customer_id = p.customer_id
       and (after ->> 'amount_cents')::integer > 0
       and after ->> 'reason' in ('duplicate_charge', 'customer_request', 'service_credit')
       and coalesce(after ->> 'created_by', 'agent') = 'agent'
       -- no more than is left of the payment
       and (after ->> 'amount_cents')::integer + coalesce((select sum(r.amount_cents) from public.refunds r where r.payment_id = p.id), 0) <= p.amount_cents
       -- a payment above the limit needs a person, however small the refund
       and p.amount_cents <= n.refund_approval_limit_cents
       -- a ticket's refunds together stay within the limit
       and (after ->> 'amount_cents')::integer + coalesce((select sum(r.amount_cents) from public.refunds r where r.ticket_id = t.id), 0) <= n.refund_approval_limit_cents
       -- the agent's refunds for the tenant in a day stay within the cap
       and (after ->> 'amount_cents')::integer + coalesce((
             select sum(r.amount_cents) from public.refunds r join public.payments q on q.id = r.payment_id
              where q.tenant_id = p.tenant_id and r.created_by = 'agent' and r.created_at > public.sim_now() - interval '24 hours'), 0)
           <= n.agent_daily_refund_cap_cents
       -- only a duplicate is refunded outside the window
       and (after ->> 'reason' = 'duplicate_charge'
            or floor(extract(epoch from public.sim_now() - p.created_at) / 86400) <= n.refund_window_days)
       -- a duplicate is a later successful payment of the same invoice
       and (after ->> 'reason' <> 'duplicate_charge'
            or (p.status = 'succeeded' and exists (
                  select 1 from public.payments q where q.invoice_id = p.invoice_id and q.status = 'succeeded'
                     and (q.created_at, q.id) < (p.created_at, p.id))))
       -- nothing on a disputed invoice
       and not exists (select 1 from public.payments q where q.invoice_id = p.invoice_id and q.status = 'disputed')
       -- one goodwill refund a year
       and (after ->> 'reason' <> 'customer_request'
            or not exists (
                  select 1 from public.refunds r join public.payments q on q.id = r.payment_id
                   where q.customer_id = p.customer_id and r.reason = 'customer_request'
                     and floor(extract(epoch from public.sim_now() - r.created_at) / 86400) <= 365))
  )`;

/** The part of the policy no approval lifts, as a rule that forbids: a refund is refused unless all of this holds. */
export const never = `
  not exists (
    select 1
      from public.payments p
      join public.tenants n on n.id = p.tenant_id
      join public.tickets t on t.id = after ->> 'ticket_id'
     where p.id = after ->> 'payment_id'
       and t.category = 'refund' and t.customer_id = p.customer_id
       and (after ->> 'amount_cents')::integer > 0
       and after ->> 'reason' in ('duplicate_charge', 'customer_request', 'service_credit')
       and coalesce(after ->> 'created_by', 'agent') = 'agent'
       and (after ->> 'amount_cents')::integer + coalesce((select sum(r.amount_cents) from public.refunds r where r.payment_id = p.id), 0) <= p.amount_cents
       and (after ->> 'reason' = 'duplicate_charge'
            or floor(extract(epoch from public.sim_now() - p.created_at) / 86400) <= n.refund_window_days)
       and (after ->> 'reason' <> 'duplicate_charge'
            or (p.status = 'succeeded' and exists (
                  select 1 from public.payments q where q.invoice_id = p.invoice_id and q.status = 'succeeded'
                     and (q.created_at, q.id) < (p.created_at, p.id))))
       and not exists (select 1 from public.payments q where q.invoice_id = p.invoice_id and q.status = 'disputed')
       and (after ->> 'reason' <> 'customer_request'
            or not exists (
                  select 1 from public.refunds r join public.payments q on q.id = r.payment_id
                   where q.customer_id = p.customer_id and r.reason = 'customer_request'
                     and floor(extract(epoch from public.sim_now() - r.created_at) / 86400) <= 365))
  )`;

export type Ask = { ticketId: string; paymentId: string; amountCents: number; reason: string };
export type World = {
  payments: {
    id: string;
    tenantId: string;
    customerId: string;
    invoiceId: string;
    amountCents: number;
    status: string;
    createdAt: string;
  }[];
  refunds: {
    paymentId: string;
    amountCents: number;
    reason: string;
    createdBy: string;
    createdAt: string;
    ticketId?: string | null;
  }[];
};
export type Limits = {
  refundWindowDays: number;
  refundApprovalLimitCents: number;
  agentDailyRefundCapCents: number;
};

/** The same policy as code: "alone" when no person is needed, "person" when one is, "never" when no approval may allow it. */
export function policy(
  ask: Ask,
  world: World,
  ticket: { customerId: string; category: string },
  tenant: Limits | undefined,
  now: Date,
): "alone" | "person" | "never" {
  const DAY = 86_400_000;
  const payment = world.payments.find((candidate) => candidate.id === ask.paymentId);
  if (!tenant || !payment || payment.customerId !== ticket.customerId) return "never";
  if (ticket.category !== "refund" || ask.amountCents <= 0) return "never";
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
