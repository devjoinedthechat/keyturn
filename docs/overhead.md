# What Keyturn costs

Measured with `pnpm bench` ([bench/overhead.ts](../bench/overhead.ts)).

## Method

- PostgreSQL 18.3 in a container, default settings, on an Apple M4 Pro laptop.
- One table of 200,000 rows with a primary key, and a twin of it written directly for comparison.
- One connection each for the owner, the agent and the approver, on the same machine as the server.
- Each figure is the median of 100 runs for one row, and of fewer runs for large proposals.
- Times include the round trip from the client.

## Figures

| Step                         | 1 row   | 100 rows |
| ---------------------------- | ------- | -------- |
| Direct write, for comparison | 0.28 ms | 0.27 ms  |
| Propose by function          | 0.56 ms | 10.7 ms  |
| Propose through a view       | 0.37 ms | 6.5 ms   |
| Approve                      | 0.36 ms | 1.3 ms   |
| Apply                        | 0.46 ms | 5.9 ms   |

| Step                         | 1,000 rows | 10,000 rows |
| ---------------------------- | ---------- | ----------- |
| Direct write, for comparison | 0.9 ms     | 3.3 ms      |
| Propose by function          | 91 ms      | 920 ms      |
| Propose through a view       | 46 ms      | 460 ms      |
| Approve                      | 6.6 ms     | 60 ms       |
| Apply                        | 47 ms      | 461 ms      |

## Reading them

- **Each row costs about the same however large the proposal.** Roughly 0.05 ms to propose through a view and 0.05 ms to apply. A test holds this in place on every supported version: [test/scale.test.ts](../test/scale.test.ts).
- **A direct bulk write is far cheaper per row.** PostgreSQL deletes 10,000 rows in one pass. Keyturn records each row's content, hashes it, then locks, compares and writes each row on apply.
- **A statement through a view uses the table's indexes.** Naming one row reads one row.
- **Approval hashes the whole proposal**, so its time grows with the proposal's size.
- **These are for a table with no rule that forbids.** With one, its condition is worked out for every proposed row, and again for every row when the proposal is applied. That roughly doubled the time to propose in one measurement, before whatever the condition itself reads.

A proposal of thousands of rows is rare, and a person takes far longer to read it than the database takes to record it.
