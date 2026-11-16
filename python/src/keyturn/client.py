"""The client. Every method is one call to a function in the database.

It adds no rights. The database decides by the login on the connection: an agent's login
can propose and apply, an approver's can approve and reject. Anything else is refused
there, and comes back as ``Refused``.
"""

from __future__ import annotations

import json
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from datetime import time as time_of_day
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

Status = Literal["pending", "approved", "rejected", "applied", "stale", "failed"]
Kind = Literal["string", "number", "boolean", "null", "array", "object", "absent"]


class Refused(Exception):
    """The database said no. ``str()`` is what it said, without the ``keyturn:`` it starts with."""

    def __init__(self, message: str, code: str | None) -> None:
        super().__init__(message)
        #: The PostgreSQL error code. ``42501`` when the caller may not do this.
        self.code = code


class Undecided(Exception):
    """The proposal ran out of time with nobody having decided, or the wait did."""


@dataclass(frozen=True)
class Outcome:
    status: Literal["applied", "stale", "failed"]
    changes: int | None = None
    reason: str | None = None


@dataclass(frozen=True)
class Proposal:
    id: str
    proposed_by: str
    note: str
    status: Status
    #: The hash of the content as it stands. An approval names it.
    content_hash: str
    proposed_at: datetime
    expires_at: datetime
    expired: bool
    decided_by: str | None
    decided_at: datetime | None
    reason: str | None
    changes: int
    outcome: Outcome | None


@dataclass(frozen=True)
class ColumnDiff:
    column: str
    #: The value as PostgreSQL writes it: text, so that no digit of a number is lost.
    before: str | None
    after: str | None
    #: ``absent`` when the row does not exist on that side, or the column was not given.
    before_kind: Kind
    after_kind: Kind
    changed: bool


@dataclass(frozen=True)
class RowDiff:
    seq: int
    table: str
    operation: Literal["insert", "update", "delete"]
    #: The row's primary key, each part as PostgreSQL writes it: text, so that a large
    #: number keeps every digit.
    key: dict[str, str | None]
    columns: list[ColumnDiff]


@dataclass(frozen=True)
class Extent:
    table: str
    operation: Literal["insert", "update", "delete"]
    rows: int


@dataclass(frozen=True)
class Step:
    event: str
    #: The login that did it.
    actor: str
    at: datetime
    detail: dict[str, Any]


@dataclass(frozen=True)
class Finding:
    level: Literal["fail", "note"]
    about: str
    finding: str
    fix: str | None


_PROPOSAL = """
    select p.id::text as id, p.proposed_by::text as proposed_by, p.note, p.status,
           keyturn.hash_of(p.id) as content_hash, p.proposed_at, p.expires_at,
           (p.status in ('pending', 'approved') and p.expires_at <= clock_timestamp()) as expired,
           p.decided_by::text as decided_by, p.decided_at, p.reason,
           (select count(*)::int from keyturn.changes c where c.proposal_id = p.id) as changes,
           p.outcome
      from keyturn.proposals p
"""


def _as_json(value: object) -> str:
    """Values JSON has no form for, that have one faithful text form PostgreSQL reads."""
    if isinstance(value, (Decimal, datetime, date, time_of_day, UUID)):
        return str(value)
    raise TypeError(f"{type(value).__name__} has no faithful form in a proposal; pass it as text")


def _outcome(value: Mapping[str, Any] | None) -> Outcome | None:
    if value is None:
        return None
    return Outcome(status=value["status"], changes=value.get("changes"), reason=value.get("reason"))


def _proposal(row: Mapping[str, Any]) -> Proposal:
    return Proposal(**{**row, "outcome": _outcome(row["outcome"])})


class Keyturn:
    """Keyturn, over one psycopg connection.

    Each call is a transaction of its own and is committed when it returns, whether or not
    the connection is in autocommit mode: an apply that says "applied" has been written.

    The one exception is a caller that has opened a transaction itself, with
    ``connection.transaction()`` or by running a statement first on a connection that is not
    in autocommit mode. The call then joins that transaction, and is kept or lost with it.
    """

    def __init__(self, connection: psycopg.Connection[Any]) -> None:
        self._connection = connection

    def propose(
        self,
        changes: Sequence[Mapping[str, Any]],
        *,
        note: str = "",
        valid_for: str = "1 day",
    ) -> Proposal:
        """Records changes for someone else to approve. Nothing is written to the tables.

        Each change is ``{"table", "operation": "insert", "values"}``,
        ``{"table", "operation": "update", "key", "set"}`` or
        ``{"table", "operation": "delete", "key"}``.
        """
        rows = self._run(
            "select proposal_id::text as id from keyturn.propose(%s::jsonb, %s, %s::interval)",
            (json.dumps(list(changes), default=_as_json), note, valid_for),
        )
        made = self.proposal(rows[0]["id"])
        if made is None:  # pragma: no cover - the proposer can always read its own proposal
            raise Refused("the proposal was made and cannot be read back", None)
        return made

    def proposal(self, proposal_id: str) -> Proposal | None:
        """One proposal, or None when there is none the caller may see."""
        rows = self._run(_PROPOSAL + " where p.id = %s", (proposal_id,))
        return _proposal(rows[0]) if rows else None

    def waiting(self) -> list[Proposal]:
        """The proposals nobody has decided, oldest first."""
        rows = self._run(
            _PROPOSAL
            + " where p.status = 'pending' and p.expires_at > clock_timestamp()"
            + " order by p.proposed_at, p.id"
        )
        return [_proposal(row) for row in rows]

    def extent(self, proposal_id: str) -> list[Extent]:
        """How many rows a proposal would change, by table and operation."""
        rows = self._run(
            'select relation as "table", operation, row_count::int as rows from keyturn.extent(%s)',
            (proposal_id,),
        )
        return [Extent(**row) for row in rows]

    def diff(self, proposal_id: str, *, start: int = 1, count: int = 100) -> list[RowDiff]:
        """The rows a proposal would change, before and after, ``count`` rows from ``start``."""
        rows = self._run(
            """select seq, relation, operation,
                      (select jsonb_object_agg(part.key, part.value #>> '{}')
                         from jsonb_each(d.key) as part) as key,
                      column_name, before, after, before_kind, after_kind, changed
                 from keyturn.diff(%s, %s, %s) as d""",
            (proposal_id, start, count),
        )
        result: list[RowDiff] = []
        for row in rows:
            if not result or result[-1].seq != row["seq"]:
                result.append(
                    RowDiff(row["seq"], row["relation"], row["operation"], row["key"], [])
                )
            result[-1].columns.append(
                ColumnDiff(
                    row["column_name"],
                    row["before"],
                    row["after"],
                    row["before_kind"],
                    row["after_kind"],
                    row["changed"],
                )
            )
        return result

    def approve(self, proposal_id: str, content_hash: str) -> None:
        """Approves the content with this hash, and no other.

        Pass the hash of what the approver was shown, not one read again at the last moment.
        """
        self._run("select keyturn.approve(%s, %s)", (proposal_id, content_hash))

    def reject(self, proposal_id: str, reason: str | None = None) -> None:
        self._run("select keyturn.reject(%s, %s)", (proposal_id, reason))

    def apply(self, proposal_id: str) -> Outcome:
        """Writes an approved proposal's changes, all or none.

        Safe to call again: a proposal already applied gives back what the first call gave.
        ``stale`` means a row had changed and nothing was written.
        """
        rows = self._run("select keyturn.apply(%s) as outcome", (proposal_id,))
        outcome = _outcome(rows[0]["outcome"])
        if outcome is None:  # pragma: no cover - apply always gives an outcome
            raise Refused("apply gave no outcome", None)
        return outcome

    def decision(
        self, proposal_id: str, *, timeout: float | None = None, every: float = 1.0
    ) -> Proposal:
        """Waits until someone has decided, and gives the proposal as it then stands.

        Raises ``Undecided`` if it expires first, or if ``timeout`` seconds pass.
        """
        until = None if timeout is None else time.monotonic() + timeout
        every = max(every, 0.05)
        while True:
            proposal = self.proposal(proposal_id)
            if proposal is None:
                raise Refused(f"there is no proposal {proposal_id} that this login can see", None)
            if proposal.status != "pending":
                return proposal
            if proposal.expired:
                raise Undecided(f"proposal {proposal_id} expired with nobody having decided")
            if until is not None and time.monotonic() + every > until:
                raise Undecided(f"nobody has decided proposal {proposal_id} yet")
            time.sleep(every)

    def recent(self, count: int = 50) -> list[Proposal]:
        """The latest proposals in any state, newest first."""
        rows = self._run(_PROPOSAL + " order by p.proposed_at desc, p.id limit %s", (count,))
        return [_proposal(row) for row in rows]

    def history(self, proposal_id: str) -> list[Step]:
        """What has happened to a proposal, in order, from the audit log."""
        rows = self._run(
            "select event, actor::text as actor, at, detail from keyturn.audit"
            " where proposal_id = %s order by seq",
            (proposal_id,),
        )
        return [Step(**row) for row in rows]

    def audit_head(self) -> tuple[int, str]:
        """The number of audit entries and one value for all of them, to keep elsewhere."""
        rows = self._run("select entries::int as entries, head from keyturn.audit_head()")
        return rows[0]["entries"], rows[0]["head"]

    def doctor(self) -> list[Finding]:
        """Whether the guarantee holds in this database. For the tables' owner."""
        return [
            Finding(**row)
            for row in self._run("select level, about, finding, fix from keyturn.doctor()")
        ]

    def verify_audit(self) -> list[tuple[str, str]]:
        """What does not fit in the audit log, as (proposal id, problem). Empty when it holds."""
        rows = self._run("select proposal_id::text as id, problem from keyturn.verify_audit()")
        return [(row["id"], row["problem"]) for row in rows]

    def _run(self, query: str, values: Sequence[Any] = ()) -> list[dict[str, Any]]:
        try:
            # A transaction of its own: committed on the way out, and rolled back on a refusal,
            # so that a refusal does not leave the connection unable to run the next call.
            with (
                self._connection.transaction(),
                self._connection.cursor(row_factory=dict_row) as cursor,
            ):
                cursor.execute(query, values)
                return cursor.fetchall()
        except psycopg.Error as error:
            message = error.diag.message_primary or str(error)
            if message.startswith("keyturn: "):
                raise Refused(message.removeprefix("keyturn: "), error.sqlstate) from error
            if error.sqlstate == "42501":
                raise Refused(message, error.sqlstate) from error
            raise
