# Operating Keyturn

## Installing

`keyturn install` runs as the login that will own Keyturn, normally the tables' owner. It installs everything in one transaction, or nothing.

| Requirement | Detail                                                                |
| ----------- | --------------------------------------------------------------------- |
| PostgreSQL  | 15 or later. Older versions are refused with a message                |
| Rights      | An ordinary owner. No superuser is needed                             |
| Extensions  | None                                                                  |
| Roles       | `keyturn_agent`, `keyturn_approver` and `keyturn_rule`, all `NOLOGIN` |

The roles belong to the server, not to one database. If the installing login may not create roles, an administrator runs this once:

```sql
create role keyturn_agent nologin;
create role keyturn_approver nologin;
create role keyturn_rule nologin;
```

`keyturn_rule` is never granted to anyone. It is the name on record when a rule, and no person, let a change through.

## Logins

| Login         | Grant                                                | Never                                                        |
| ------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| Each agent    | `keyturn_agent`, and `SELECT` on what it should read | Any write privilege on a protected table; `keyturn_approver` |
| Each approver | `keyturn_approver`, and `SELECT` on protected tables | `keyturn_agent`                                              |
| The owner     | Owns the tables and Keyturn                          | A connection at run time                                     |

Identity is the login on the connection. Give each approver a login of their own, so the audit log names a person.

Run `keyturn doctor` after every change to roles or grants, and in your build. It exits with 1 when an agent has a way round.

## Protecting a table

```bash
keyturn protect orders
keyturn protect billing.invoices --loose
```

- The table needs a primary key.
- A view is made in the schema `proposal`: `proposal.orders`, or `proposal.billing_invoices` for a table outside `public`.
- `--loose` lets the table's own triggers alter a row as it is applied. Without it, a row that comes out different from what was approved fails the apply and nothing is written.
- Generated columns are left out of proposals. They follow the columns they are worked out from.

## Changing a table's shape

A table that changed shape takes no proposals until it is protected again, and proposals made before the change go stale.

Adding a column:

```sql
alter table orders add column channel text;
select keyturn.protect('orders');
```

Dropping or retyping a column, which the view would block:

```sql
select keyturn.drop_view('orders');
alter table orders drop column channel;
select keyturn.protect('orders');
```

## Proposals

| Fact                | Detail                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------- |
| Size                | At most 10,000 rows                                                                    |
| Waiting             | At most 200 for one login. More are refused until some are decided or expire           |
| Lifetime            | One day by default, 30 days at most. An expired proposal cannot be approved or applied |
| One row, one change | A proposal changes a given row once                                                    |
| Primary keys        | Not changed by an update. Delete the row and insert another                            |
| States              | `pending`, `approved`, `rejected`, `applied`, `stale`, `failed`                        |

`stale` means a row no longer matched what was recorded, or its table was renamed, dropped or reshaped, so nothing was written. `failed` means the table itself refused the write, by a constraint or by a row coming out different; nothing was written then either.

A lock that could not be had in time, a deadlock or a lost connection is neither. `apply` raises the error, the proposal stays approved, and the same call can be made again.

## Rules

```sql
select keyturn.allow(
  'close_tickets',              -- name
  'tickets',                    -- table
  array['update'],              -- operations
  array['status', 'note'],      -- the only columns that may be set
  max_rows => 1,
  condition => $$after ->> 'status' = 'closed'$$,
  per_hour => 60
);
```

- Writing a rule of the same name replaces it and raises its version.
- The condition is SQL over two `jsonb` values, `before` and `after`. A row it cannot be worked out for is not covered.
- A condition may read other tables, for a limit kept elsewhere or a running total. Name them with their schema, as in `public.payments`: a condition is worked out with an empty search path, and a table named without one is refused when the rule is written.
- A rule decides when the proposal is applied, in the same transaction as the write, and proposals under one rule are taken one after the other. A running total in a condition therefore counts what was applied a moment before, and a limit cannot be passed in parts.
- `test/policy-port.test.ts` in the repository holds a refund policy of nine conditions, written as one rule that lets through and one that forbids, against the same policy as code, on 1,302 refunds an agent could ask for.
- The hourly count is kept by the rule's name and read from the audit log.
- A rule decides only in a read committed transaction, the default. In any other, the proposal waits for a person.
- On a table with row-level security, give the rule a condition that keeps rows to what the agent may see. `keyturn doctor` points such tables out.
- Switch one off with `update keyturn.rules set active = false where name = 'close_tickets'`.

Only the owner writes rules. An approver can read them; an agent cannot.

### Rules that forbid

```sql
select keyturn.forbid(
  'refund_within_payment',      -- name
  'refunds',                    -- table
  array['insert'],              -- operations
  $$(after ->> 'amount')::numeric > (select p.amount from public.payments p where p.id = (after ->> 'payment')::integer)$$,
  'A refund is never more than the payment.'   -- said to the agent, shown to an approver
);
```

- A change the condition holds for is refused when it is proposed, with the reason. Nothing is recorded, so the queue holds only what a person should look at.
- It is held against the rules again when a person approves and when it is applied. An approval does not lift a rule.
- A condition that cannot be worked out for a row, or that gives neither true nor false, forbids the row. Write the condition so that it is false for the rows you mean to allow.
- A table with such a rule is written only in a read committed transaction, and proposals for it are applied one after the other.
- A rule that forbids is read before a rule that lets through.
- Switch one off with `update keyturn.forbidden set active = false where name = 'refund_within_payment'`. `keyturn doctor` lists every active one.

## The audit log

- `keyturn verify-audit` exits with 1 if the log does not hold together.
- Record the head value it prints somewhere the database's owner cannot reach, on a schedule. A later head for the same entry count that differs means the log was rewritten.
- Entries are never deleted, so the log grows with use. Keyturn has no pruning.

## The review page

`keyturn review` serves a page on 127.0.0.1 and prints its address, which carries a key made for that run. It uses the connection it was started with, so start it as the approver. To use it from another machine, forward the port over SSH; it does not listen on other addresses.

If the database connection is lost, the command says so and exits with 1, and the page tells the reviewer it has lost contact. Start it again. `keyturn tools` does the same, so that whatever runs it can restart it.

## Moving to a later version

Version 0.1 installs into a database that does not have Keyturn, and refuses one that does. To move to a later version, uninstall and install. Proposals and the audit log are removed with it, so record the audit head and export `keyturn.audit` first if the record matters.

## Removing

```bash
keyturn unprotect orders     # one table: its view and rules go, waiting proposals close as stale
keyturn uninstall --yes      # everything: proposals and the audit log included
```

The tables are left as they were. The three roles stay, since other databases on the server may use them.
