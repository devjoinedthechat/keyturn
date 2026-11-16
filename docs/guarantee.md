# What Keyturn guarantees

## The claim

An agent connected through Keyturn cannot change a protected table. It can only propose. The database applies a proposal if, and only if, a different login approved that exact proposal and the rows still look the way they did when it was made.

## What each word means

| Word | Meaning |
| --- | --- |
| Connected through Keyturn | The agent's login is a member of `keyturn_agent` and of nothing that can write the table |
| Cannot change | The role holds no write privilege on the table. Nothing has to intercept the write: there is no write to intercept |
| Propose | Record the rows to change, as they are now and as they would be. Recording changes nothing else |
| A different login | Another database login, a member of `keyturn_approver`. Identity is the connection's, never a value the caller passes |
| That exact proposal | The approver names a hash of the proposal's content. The proposal is applied only if its content still has that hash |
| Still look the way they did | Every row the proposal touches is locked and compared with the row recorded when it was proposed. One difference and nothing is written |

## Who it holds against

| Actor | Cannot |
| --- | --- |
| The agent's role | Write a protected table; approve or reject; apply a proposal that is not approved; change a proposal after it is made |
| The agent's own code, wrong or manipulated | Do anything the agent's role cannot. The guarantee does not depend on that code |
| An approver | Approve their own proposal; approve content other than what they name |
| Two connections at once | Apply a proposal twice; apply it against rows that have changed |

## Outside the claim

- **The database owner and superusers.** They can do anything. Nothing should connect as them at run time.
- **An agent given the owner's credentials.** Then it is not connected through Keyturn.
- **An approver who approves without reading.** Keyturn puts the rows in front of a person. It cannot make them look.
- **Effects outside the database.** Emails, payments, calls to other services.
- **What a table's cascades do to other tables.** The approved rows are checked after the write. Rows a cascade changes elsewhere are that table's own design.

## How it differs from what exists

Keyturn approves the rows that will change, inside the database you already run.

| Approach | Where approval is enforced | What the approver sees |
| --- | --- | --- |
| Approval hooks in agent frameworks | In the agent's own process | The tool call's arguments |
| Access proxies and gateways | In front of the database | The SQL text |
| Branch-and-merge databases | In a different database engine | A row diff |
| Keyturn | In PostgreSQL, by privileges | The rows before and after |

A direct connection with the agent's credentials gets past the first two. The third means moving to another database.
