# What Keyturn works with

Each line here is held in place by a test, named in the last column, on PostgreSQL 15, 16, 17 and 18. Where the answer is a refusal, the refusal is what is tested.

## Tables

| Kind of table                              | What happens                                                                                                    | Test             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------- |
| With a primary key, of one or more columns | Proposed to, applied and taken back                                                                             | `core`, `revert` |
| With no primary key                        | `keyturn protect` refuses it: a row could not be named                                                          | `support`        |
| Partitioned                                | Put under Keyturn by its parent. Rows go to their parts. The parts are closed to the agent too                  | `support`        |
| In another schema                          | Named with its schema, as `shop.orders`                                                                         | `support`        |
| A view or a materialized view              | `keyturn protect` refuses it                                                                                    | `support`        |
| With row-level security                    | Works. A rule on it needs a condition of its own: see the guarantee                                             | `attacks`        |
| With triggers or defaults                  | They run at apply. A row that comes out different fails the apply, unless the table is protected with `--loose` | `apply`          |
| With a foreign key that cascades           | Works, and `keyturn doctor` notes that rows elsewhere change with it                                            | `doctor`         |

## Columns

| Kind of column                                                | What happens                                                                                   | Test                |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------- |
| Numbers of any size, text, dates, times with zones, intervals | Kept digit for digit and shown as PostgreSQL writes them                                       | `support`, `review` |
| `uuid`, `inet`, `bytea`, ranges, `jsonb`, arrays              | Written, changed and taken back exactly                                                        | `support`           |
| Enums, domains, composite types and arrays of them            | The same                                                                                       | `support`           |
| A key the table makes itself (`serial`, identity)             | Proposed without it. The key the table made is recorded at apply, so the row can be taken back | `revert`            |
| A generated column                                            | Left out of every row: it follows from the others                                              | `apply`             |
| A value the column's type refuses                             | Refused when it is proposed                                                                    | `support`           |

## What an agent may try on the table itself

| Statement by the agent's login                                                    | What happens                                                              | Test                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------- |
| `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `COPY`, `TRUNCATE`                         | Permission denied                                                         | `attacks`           |
| `ALTER TABLE`, `DROP TABLE`, `CREATE INDEX`, `CREATE TRIGGER`, changing the owner | Refused: the agent is not the table's owner                               | `support`           |
| `GRANT` to itself                                                                 | PostgreSQL warns and grants nothing                                       | `support`           |
| Moving the table's sequence                                                       | Permission denied, unless the owner granted the sequence                  | `support`           |
| Calling a function that writes the table with its owner's rights                  | It writes. `keyturn doctor` fails until the function or the grant is gone | `support`, `doctor` |

## What the owner changes while a proposal waits

| Change                             | What happens to a proposal for that table           | Test                  |
| ---------------------------------- | --------------------------------------------------- | --------------------- |
| A column added, dropped or retyped | Stale when applied. Nothing is written              | `support`, `apply`    |
| The table renamed or dropped       | Stale when applied. Nothing is written              | `support`             |
| A row it touches written to        | Stale when applied. Nothing is written              | `apply`, `properties` |
| A rule written that forbids it     | Not approved and not applied while the rule forbids | `forbid`              |

## The server

| Where                                                 | State                                                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| PostgreSQL 15, 16, 17, 18                             | Every test, on every push                                                                                  |
| PostgreSQL 14 and earlier                             | Refused at install                                                                                         |
| An ordinary owner, with no superuser and no extension | How every test installs it. If the owner may not create roles, an administrator runs three statements once |
| Amazon RDS, Cloud SQL, Supabase, Neon                 | Not run there. It needs no superuser and no extension, which is what such services withhold                |
| A read replica                                        | Proposals are writes: connect to the primary                                                               |

## Not covered

- **Changes to the schema.** Keyturn is for rows. An agent cannot alter a protected table, and there is no way to propose that it be altered.
- **Tables not put under Keyturn.** What the agent's login may write elsewhere, it writes. `keyturn doctor` reports on protected tables only.
- **Sequences, large objects and files.** Outside it.
- **Other databases.** PostgreSQL only.
