# Keyturn for Python

The Python client for [Keyturn](../README.md): PostgreSQL refuses an AI agent's write until a person has approved that exact change.

The client adds no rights. Every method is one call to a function in the database, which decides by the login on the connection.

```bash
pip install keyturn
```

Keyturn itself is installed into the database with the command line, as the main README describes.

```python
import psycopg
from keyturn import Keyturn, Refused

with psycopg.connect("postgresql://support_agent@localhost/shop", autocommit=True) as connection:
    keyturn = Keyturn(connection)
    made = keyturn.propose(
        [
            {
                "table": "orders",
                "operation": "update",
                "key": {"id": 7},
                "set": {"status": "refunded"},
            }
        ],
        note="Customer 7 was charged twice.",
    )

    decided = keyturn.decision(made.id, timeout=600)
    if decided.status == "approved":
        outcome = keyturn.apply(made.id)  # Outcome(status="applied", changes=1)
    else:
        print(decided.reason)
```

| Method                         | Who calls it           | What it does                                               |
| ------------------------------ | ---------------------- | ---------------------------------------------------------- |
| `propose`, `apply`, `decision` | An agent               | Propose rows, wait for a decision, write what was approved |
| `waiting`, `extent`, `diff`    | An approver            | Read what would change, values as PostgreSQL writes them   |
| `approve`, `reject`            | An approver            | Decide. An approval names the hash of what was read        |
| `doctor`, `verify_audit`       | The owner, an approver | Check the setup and the audit log                          |

A refusal from the database is raised as `Refused`, with the database's own sentence.

## Development

```bash
uv sync
uv run ruff check . && uv run ruff format --check . && uv run mypy
uv run pytest
```

Tests need Docker: they start PostgreSQL in a container and install Keyturn from `../sql`.
