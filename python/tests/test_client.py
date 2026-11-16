"""The Python client against real PostgreSQL, with Keyturn installed from ../sql."""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import psycopg
import pytest
from testcontainers.community.postgres import PostgresContainer

from keyturn import Keyturn, Refused, Undecided

SQL = Path(__file__).resolve().parents[2] / "sql"


@pytest.fixture(scope="module")
def server() -> Iterator[PostgresContainer]:
    with PostgresContainer(os.environ.get("POSTGRES_IMAGE", "postgres:18.3")) as container:
        with _connect(container, container.username, container.password) as owner:
            owner.execute(
                """
                create role keyturn_agent nologin;
                create role keyturn_approver nologin;
                create role keyturn_rule nologin;
                create role agent_bot login password 'test-only' in role keyturn_agent;
                create role agent_two login password 'test-only' in role keyturn_agent;
                create role alice login password 'test-only' in role keyturn_approver;
                """
            )
            for file in sorted(SQL.glob("*.sql")):
                owner.execute(file.read_text())
            owner.execute(
                """
                create table accounts (
                  id integer primary key, holder text not null,
                  balance numeric(30, 4) not null default 100, memo text
                );
                insert into accounts (id, holder)
                  select n, 'holder ' || n from generate_series(1, 200) n;
                select keyturn.protect('accounts');
                grant select on accounts to keyturn_agent, keyturn_approver;
                """
            )
        yield container


def _connect(container: PostgresContainer, user: str, password: str) -> psycopg.Connection[Any]:
    return psycopg.connect(
        host=container.get_container_host_ip(),
        port=int(container.get_exposed_port(5432)),
        dbname=container.dbname,
        user=user,
        password=password,
        autocommit=True,
    )


@pytest.fixture
def connections(server: PostgresContainer) -> Iterator[dict[str, psycopg.Connection[Any]]]:
    opened = {
        "owner": _connect(server, server.username, server.password),
        "agent": _connect(server, "agent_bot", "test-only"),
        "other": _connect(server, "agent_two", "test-only"),
        "alice": _connect(server, "alice", "test-only"),
    }
    yield opened
    for connection in opened.values():
        connection.close()


def _balance(owner: psycopg.Connection[Any], account: int) -> str | None:
    row = owner.execute("select balance::text from accounts where id = %s", (account,)).fetchone()
    return None if row is None else row[0]


def test_propose_review_approve_apply(connections: dict[str, psycopg.Connection[Any]]) -> None:
    agent, alice = Keyturn(connections["agent"]), Keyturn(connections["alice"])
    made = agent.propose(
        [{"table": "accounts", "operation": "update", "key": {"id": 1}, "set": {"balance": 250}}],
        note="Deposit cleared.",
        valid_for="2 hours",
    )
    assert made.status == "pending" and made.proposed_by == "agent_bot" and made.changes == 1
    assert _balance(connections["owner"], 1) == "100.0000"

    assert made.id in [proposal.id for proposal in alice.waiting()]
    assert [(part.table, part.operation, part.rows) for part in alice.extent(made.id)] == [
        ("public.accounts", "update", 1)
    ]
    (row,) = alice.diff(made.id)
    assert (row.table, row.operation, row.key) == ("public.accounts", "update", {"id": 1})
    changed = [column for column in row.columns if column.changed]
    assert [(c.column, c.before, c.after, c.after_kind) for c in changed] == [
        ("balance", "100.0000", "250.0000", "number")
    ]

    with pytest.raises(Refused, match="pending, not approved"):
        agent.apply(made.id)
    alice.approve(made.id, made.content_hash)
    outcome = agent.apply(made.id)
    assert (outcome.status, outcome.changes) == ("applied", 1)
    assert agent.apply(made.id).status == "applied"
    assert _balance(connections["owner"], 1) == "250.0000"
    assert alice.verify_audit() == []


def test_a_reviewer_sees_every_digit(connections: dict[str, psycopg.Connection[Any]]) -> None:
    agent, alice = Keyturn(connections["agent"]), Keyturn(connections["alice"])
    made = agent.propose(
        [
            {
                "table": "accounts",
                "operation": "update",
                "key": {"id": 2},
                "set": {"balance": "12345678901234567890.1234", "memo": "null"},
            }
        ]
    )
    columns = {column.column: column for column in alice.diff(made.id)[0].columns}
    assert columns["balance"].after == "12345678901234567890.1234"
    assert (columns["memo"].before, columns["memo"].before_kind) == (None, "null")
    assert (columns["memo"].after, columns["memo"].after_kind) == ("null", "string")


def test_the_database_refuses_and_says_why(connections: dict[str, psycopg.Connection[Any]]) -> None:
    agent, alice = Keyturn(connections["agent"]), Keyturn(connections["alice"])
    other = Keyturn(connections["other"])
    made = agent.propose(
        [{"table": "accounts", "operation": "delete", "key": {"id": 3}}], note="Closed."
    )

    with pytest.raises(Refused) as own:
        agent.approve(made.id, made.content_hash)
    assert own.value.code == "42501"
    with pytest.raises(Refused) as swapped:
        alice.approve(made.id, "0" * 64)
    assert "keyturn:" not in str(swapped.value)
    with pytest.raises(Refused):
        agent.propose([{"table": "accounts", "operation": "delete", "key": {"id": 99999}}])
    # The table itself, with no client in between.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        connections["agent"].execute("update accounts set balance = 0")

    assert other.proposal(made.id) is None
    assert other.diff(made.id) == []

    alice.reject(made.id, "Account is in dispute.")
    decided = agent.decision(made.id)
    assert (decided.status, decided.reason, decided.decided_by) == (
        "rejected",
        "Account is in dispute.",
        "alice",
    )
    assert _balance(connections["owner"], 3) == "100.0000"


def test_waiting_for_a_decision(connections: dict[str, psycopg.Connection[Any]]) -> None:
    agent, alice = Keyturn(connections["agent"]), Keyturn(connections["alice"])
    made = agent.propose(
        [{"table": "accounts", "operation": "update", "key": {"id": 4}, "set": {"memo": "x"}}]
    )

    def approve_soon() -> None:
        time.sleep(0.3)
        alice.approve(made.id, made.content_hash)

    thread = threading.Thread(target=approve_soon)
    thread.start()
    decided = agent.decision(made.id, timeout=20, every=0.05)
    thread.join()
    assert (decided.status, decided.decided_by) == ("approved", "alice")

    ignored = agent.propose(
        [{"table": "accounts", "operation": "update", "key": {"id": 5}, "set": {"memo": "x"}}]
    )
    with pytest.raises(Undecided):
        agent.decision(ignored.id, timeout=0.2, every=0.05)
    brief = agent.propose(
        [{"table": "accounts", "operation": "update", "key": {"id": 6}, "set": {"memo": "x"}}],
        valid_for="0.3 seconds",
    )
    with pytest.raises(Undecided, match="expired"):
        agent.decision(brief.id, timeout=20, every=0.1)


def test_a_stale_row_writes_nothing(connections: dict[str, psycopg.Connection[Any]]) -> None:
    agent, alice = Keyturn(connections["agent"]), Keyturn(connections["alice"])
    made = agent.propose(
        [{"table": "accounts", "operation": "update", "key": {"id": 7}, "set": {"balance": 1}}]
    )
    alice.approve(made.id, made.content_hash)
    connections["owner"].execute("update accounts set memo = 'moved' where id = 7")
    outcome = agent.apply(made.id)
    assert outcome.status == "stale" and outcome.reason
    assert _balance(connections["owner"], 7) == "100.0000"


def test_a_rolled_back_proposal_was_never_made(server: PostgresContainer) -> None:
    with psycopg.connect(
        host=server.get_container_host_ip(),
        port=int(server.get_exposed_port(5432)),
        dbname=server.dbname,
        user="agent_bot",
        password="test-only",  # noqa: S106 - a login that exists only in this test's container
    ) as connection:
        made = Keyturn(connection).propose(
            [{"table": "accounts", "operation": "delete", "key": {"id": 8}}]
        )
        connection.rollback()
        assert Keyturn(connection).proposal(made.id) is None


def test_doctor(connections: dict[str, psycopg.Connection[Any]]) -> None:
    keeper = Keyturn(connections["owner"])
    assert [finding for finding in keeper.doctor() if finding.level == "fail"] == []
    connections["owner"].execute("grant update on accounts to keyturn_agent")
    try:
        failures = [finding for finding in keeper.doctor() if finding.level == "fail"]
        assert failures and all(finding.fix for finding in failures)
    finally:
        connections["owner"].execute("revoke update on accounts from keyturn_agent")
