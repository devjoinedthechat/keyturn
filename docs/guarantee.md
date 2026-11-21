# What Keyturn guarantees

## The claim

An agent connected through Keyturn cannot change a protected table. It can only propose. The database applies a proposal if, and only if, a different login approved that exact proposal and the rows still look the way they did when it was made.

The one exception is written by the tables' owner, never by default: a rule that lets a described kind of small change through with no person. See [Rules that need no person](#rules-that-need-no-person).

## What each word means

| Word                        | Meaning                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Connected through Keyturn   | The agent's login is a member of `keyturn_agent` and of nothing that can write the table                                                |
| Cannot change               | The role holds no write privilege on the table. Nothing has to intercept the write: there is no write to intercept                      |
| Propose                     | Record the rows to change, as they are now and as they would be. Recording changes nothing else                                         |
| A different login           | Another database login, a member of `keyturn_approver`. Identity is the connection's, never a value the caller passes                   |
| That exact proposal         | The approver names a hash of the proposal's content. The proposal is applied only if its content still has that hash                    |
| Still look the way they did | Every row the proposal touches is locked and compared with the row recorded when it was proposed. One difference and nothing is written |

## Rules that need no person

A tables' owner may write a rule for changes too small to wait for someone. None exists until the owner writes one.

| A rule states          | Effect                                                              |
| ---------------------- | ------------------------------------------------------------------- |
| Table and operations   | Any other table or operation waits for a person                     |
| Columns                | A change that sets any other column waits                           |
| Rows in one proposal   | A larger proposal waits, whole                                      |
| Proposals in an hour   | Past the limit, the next one waits                                  |
| A condition, if wanted | SQL over the row before and after; a row it does not hold for waits |

A proposal goes through on rules only when every change in it is covered. The record then names the rules and their versions, and says no person decided. The stale-row check applies as it does to any proposal.

An agent cannot write or change a rule, or read what one says. It does learn the name of a rule that let its own proposal through. `keyturn.doctor()` lists every active one.

A proposal is applied only in a read committed transaction, PostgreSQL's default. One that keeps a single view of the data could not count what a rule has already let through, or see a rule written after it began, so it is refused.

A condition means the same whoever proposes or approves. It is worked out under fixed settings, whatever the session's are: a backslash in a string is a backslash, `= null` is not read as `is null`, and dates and times are written one way, in UTC.

## Rules that forbid

The owner may also write a rule for changes that no one may approve.

| When                        | What happens to a change the rule forbids                                 |
| --------------------------- | ------------------------------------------------------------------------- |
| It is proposed              | Refused, with the rule's reason. Nothing is recorded                      |
| A person approves           | Refused. The records a condition reads may have changed while it waited   |
| It is applied               | Nothing is written, whoever approved it, until the rule no longer forbids |
| A rule would let it through | The rule that forbids is read first, and the other does not get to decide |

A condition that cannot be worked out for a row, or that gives neither true nor false, forbids the row.

A running total in a condition holds. Proposals for a table with such a rule are applied one after the other, so it holds against two applied at once. And each change is held against the rules again just before it is written, with the changes before it in the same proposal already in place, so it holds against two changes in one proposal. Such a proposal can be recorded and approved, since each change passes as things stand; it is when it is applied that nothing is written.

A refusal tells the agent something. A condition that reads a table the agent may not read still answers yes or no to whatever the agent proposes, and a proposal made and rolled back leaves no entry. Whoever may propose can learn, one answer at a time, what a condition compares against. Keep out of conditions what must stay secret from the agent.

## The record

Every step of a proposal is an entry in `keyturn.audit`: opened, approved, approved by a rule, rejected, applied, stale, failed or reverted. The entry is written in the same transaction as the step, with the login that took it.

- Entries are never updated or truncated, and never deleted one by one. Triggers refuse it, the owner included.
- The owner may put whole finished proposals away: written to a file, checked, then removed with all their entries, so every chain left in the log is whole. Only what the file holds is removed, and a mark stays saying when, by whom, how much, and the value of the log before and after.
- Each entry carries the hash of the one before it for the same proposal. `keyturn.verify_audit()` reports an entry that was altered, one that is missing, and a proposal whose state has no entry behind it.
- `keyturn.audit_head()` gives one value for the whole log. Someone who can switch the triggers off can rewrite the log so that it verifies; a head value kept outside the database shows that too.

## Taking a change back

An approver may take an applied proposal back. Every row it wrote is put as the proposal recorded it before the change.

| Holds                                 | How                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| Only a person's login does it         | It is for `keyturn_approver`. An agent is refused                               |
| All of it or none                     | One row that cannot be put back leaves every row as it is                       |
| Nobody's later work is written over   | Each row is locked and must still be exactly as the proposal left it            |
| The rules that forbid hold for it too | Putting a row back is a write, and is held against them as one                  |
| It is on record, once                 | The proposal becomes `reverted`, with the login and the reason in the audit log |

A proposal that was taken back is not applied again.

This is about the proposal's own rows. Rows that others have since attached to one of them, and that the table deletes with it by a cascade, go with it. On a table protected with the loose option, the columns the proposal set are put back, and a column a trigger changes is as the trigger leaves it.

## Who it holds against

| Actor                                      | Cannot                                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| The agent's role                           | Write a protected table; approve or reject; apply a proposal that is not approved; change a proposal after it is made; take a change back |
| The agent's role, with the record          | Add, alter or remove an audit entry; read another agent's entries; write or read a rule                                                   |
| The agent's own code, wrong or manipulated | Do anything the agent's role cannot. The guarantee does not depend on that code                                                           |
| An approver                                | Approve their own proposal; approve content other than what they name; approve a change a rule forbids                                    |
| Two connections at once                    | Apply a proposal twice; apply it against rows that have changed                                                                           |

## Outside the claim

- **The database owner and superusers.** They can do anything. Nothing should connect as them at run time.
- **An agent given the owner's credentials.** Then it is not connected through Keyturn.
- **An approver who approves without reading.** Keyturn puts the rows in front of a person. It cannot make them look.
- **The rows shown beside a proposal.** The rows a proposal points to, and why it waits, are read when asked for. They are not in the hash an approval names, and may have changed by the time the change is written. A rule is read then; they are not.
- **Effects outside the database.** Emails, payments, calls to other services.
- **That something happened.** Each step of a proposal is said on the channel `keyturn` with the proposal's id. Any login of the database may listen. What the proposal holds is not said.
- **Row-level security as a limit on what may be proposed.** Policies decide which rows an agent can see and name. They do not check the row an agent proposes to insert, or what it proposes a row should become: the approver does. A rule on such a table needs a condition that does the same.
- **What a table's cascades do to other tables.** The approved rows are checked after the write. Rows a cascade changes elsewhere are that table's own design. Taking the change back puts the proposal's own rows back and not those.

## How it differs from what exists

Keyturn approves the rows that will change, inside the database you already run.

| Approach                           | Where approval is enforced     | What the approver sees    |
| ---------------------------------- | ------------------------------ | ------------------------- |
| Approval hooks in agent frameworks | In the agent's own process     | The tool call's arguments |
| Access proxies and gateways        | In front of the database       | The SQL text              |
| Branch-and-merge databases         | In a different database engine | A row diff                |
| Keyturn                            | In PostgreSQL, by privileges   | The rows before and after |

A direct connection with the agent's credentials gets past the first two. The third means moving to another database.
