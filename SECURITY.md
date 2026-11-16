# Security

Keyturn makes one claim, stated in [docs/guarantee.md](docs/guarantee.md). A way for an agent's login to change a protected table without an approval, or to get an approval it should not have, is a vulnerability.

## Reporting

Report privately through GitHub: the repository's **Security** tab, then **Report a vulnerability**. Please do not open a public issue.

Include the PostgreSQL version, how the logins were set up, and the statements that show the problem. The output of `keyturn doctor` helps.

## In scope

- Any write to a protected table by a login in `keyturn_agent` that `keyturn doctor` reports as sound.
- An approval or apply that does not match what the approver named.
- Reading another login's proposals, or rows the reader has no right to, through Keyturn.
- Changing or removing audit entries, or writing rules, as an agent or an approver.
- The review page: use of its connection by another site, another user of the machine, or content an agent wrote.
- The tool server: anything that gives a model more than its login has.

## Out of scope

- The database owner and superusers, who can do anything.
- An approver who approves a proposal without reading it.
- Configurations that `keyturn doctor` reports as failing.
