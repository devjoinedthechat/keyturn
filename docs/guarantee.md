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

An agent cannot write, change or read the rules. `keyturn.doctor()` lists every active one.

## The record

Every step of a proposal is an entry in `keyturn.audit`: opened, approved, approved by a rule, rejected, applied, stale or failed. The entry is written in the same transaction as the step, with the login that took it.

- Entries are never updated, deleted or truncated. Triggers refuse it, the owner included.
- Each entry carries the hash of the one before it for the same proposal. `keyturn.verify_audit()` reports an entry that was altered, one that is missing, and a proposal whose state has no entry behind it.
- `keyturn.audit_head()` gives one value for the whole log. Someone who can switch the triggers off can rewrite the log so that it verifies; a head value kept outside the database shows that too.

## Who it holds against

| Actor                                      | Cannot                                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| The agent's role                           | Write a protected table; approve or reject; apply a proposal that is not approved; change a proposal after it is made |
| The agent's role, with the record          | Add, alter or remove an audit entry; read another agent's entries; write or read a rule                               |
| The agent's own code, wrong or manipulated | Do anything the agent's role cannot. The guarantee does not depend on that code                                       |
| An approver                                | Approve their own proposal; approve content other than what they name                                                 |
| Two connections at once                    | Apply a proposal twice; apply it against rows that have changed                                                       |

## Outside the claim

- **The database owner and superusers.** They can do anything. Nothing should connect as them at run time.
- **An agent given the owner's credentials.** Then it is not connected through Keyturn.
- **An approver who approves without reading.** Keyturn puts the rows in front of a person. It cannot make them look.
- **Effects outside the database.** Emails, payments, calls to other services.
- **What a table's cascades do to other tables.** The approved rows are checked after the write. Rows a cascade changes elsewhere are that table's own design.

## How it differs from what exists

Keyturn approves the rows that will change, inside the database you already run.

| Approach                           | Where approval is enforced     | What the approver sees    |
| ---------------------------------- | ------------------------------ | ------------------------- |
| Approval hooks in agent frameworks | In the agent's own process     | The tool call's arguments |
| Access proxies and gateways        | In front of the database       | The SQL text              |
| Branch-and-merge databases         | In a different database engine | A row diff                |
| Keyturn                            | In PostgreSQL, by privileges   | The rows before and after |

A direct connection with the agent's credentials gets past the first two. The third means moving to another database.
