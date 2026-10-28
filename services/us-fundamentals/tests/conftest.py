"""Shared fixtures — MONEY-979.

The one thing every test here needs is a KNOWN environment. ``settings.py``
reads ``os.environ`` per call precisely so a test can set a variable and have
the real code observe it; the flip side is that a variable left behind by one
test silently changes the next one's answer.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any

import pytest

#: Every variable this service reads. Cleared before AND after each test.
MANAGED_ENV = (
    "APP_ENV",
    "NODE_ENV",
    "ENABLE_PULL_SUBSCRIBER",
    "PUBSUB_ENV",
    "CLOUD_RUN_URL",
    "GCP_PROJECT_ID",
    "GCP_STORAGE_BUCKET",
    "DATABASE_URL",
    "REDIS_URL",
    "EDGAR_IDENTITY",
    "SEC_RATE_LIMIT_PER_SEC",
    "SEC_EGRESS",
    "OPENFIGI_API_KEY",
    "EDGAR_DETECT",
    "EDGAR_PARSE_APPLY",
    "EDGAR_EVICT_APPLY",
    "PUBSUB_DEDUPE_LEASE_MS",
    "DD_ENV",
    "DD_SERVICE",
    "DD_VERSION",
    # MONEY-1278 added these two, and leaving them out is not a cosmetic gap: an
    # exported DD_METRICS_TRANSPORT=http — the exact value the five Cloud Run
    # jobs now ship, so a plausible thing to have in a debugging shell — routes
    # every statsd assertion below down the HTTP branch and fails about ten of
    # them for a reason that has nothing to do with what they test.
    "DD_METRICS_TRANSPORT",
    "DD_API_KEY",
)


@pytest.fixture(autouse=True)
def clean_env() -> Iterator[None]:
    saved = {name: os.environ.get(name) for name in MANAGED_ENV}
    for name in MANAGED_ENV:
        os.environ.pop(name, None)
    try:
        yield
    finally:
        for name, value in saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


@pytest.fixture(autouse=True)
def reset_module_caches() -> Iterator[None]:
    """Drop the process-wide Mongo client and statsd handle between tests."""
    from app import db
    from app.store import outcome

    db.reset_for_tests()
    outcome.set_statsd_for_tests(None)
    yield
    db.reset_for_tests()
    outcome.set_statsd_for_tests(None)


class RecordingStatsd:
    """Captures every DogStatsD call as ``(kind, name, value, tags)``."""

    def __init__(self, fail: bool = False) -> None:
        self.calls: list[tuple[str, str, float, list[str]]] = []
        self._fail = fail

    def increment(self, name: str, value: float = 1, tags: list[str] | None = None) -> None:
        if self._fail:
            raise RuntimeError("statsd socket is gone")
        self.calls.append(("increment", name, value, list(tags or [])))

    def histogram(self, name: str, value: float, tags: list[str] | None = None) -> None:
        if self._fail:
            raise RuntimeError("statsd socket is gone")
        self.calls.append(("histogram", name, value, list(tags or [])))

    def names(self) -> list[str]:
        return [name for _, name, _, _ in self.calls]

    def value_of(self, name: str) -> float | None:
        for _, called, value, _ in self.calls:
            if called == name:
                return value
        return None


class FakeDedupeCollection:
    """An in-memory collection with a REAL unique index on ``messageId``.

    Not a mock. The claim protocol's whole correctness argument is "MongoDB
    serialises two inserts on the unique index and exactly one wins", so a fake
    that lets both inserts succeed would test the opposite of the property. This
    one raises a duplicate-key error the second time, exactly as the driver does.
    """

    def __init__(self) -> None:
        self.docs: dict[str, dict[str, Any]] = {}
        self.raise_on: set[str] = set()
        #: Set to simulate the `ok: 1` + writeErrors form some drivers surface.
        self.duplicate_as_write_error = False
        self.calls: list[str] = []

    def _guard(self, op: str) -> None:
        self.calls.append(op)
        if op in self.raise_on:
            raise RuntimeError(f"mongo unreachable during {op}")

    def insert_one(self, document: dict[str, Any]) -> Any:
        self._guard("insert_one")
        message_id = document["messageId"]
        if message_id in self.docs:
            if self.duplicate_as_write_error:
                from pymongo.errors import BulkWriteError

                raise BulkWriteError(
                    {"ok": 1, "n": 0, "writeErrors": [{"code": 11000, "errmsg": "E11000"}]}
                )
            from pymongo.errors import DuplicateKeyError

            raise DuplicateKeyError("E11000 duplicate key error collection")
        self.docs[message_id] = dict(document)
        return object()

    def find_one(self, filter: dict[str, Any]) -> dict[str, Any] | None:
        self._guard("find_one")
        return self.docs.get(filter.get("messageId", ""))

    def find_one_and_update(
        self, filter: dict[str, Any], update: dict[str, Any], **_: Any
    ) -> dict[str, Any] | None:
        self._guard("find_one_and_update")
        doc = self.docs.get(filter.get("messageId", ""))
        if doc is None:
            return None
        # A genuine CAS: every key in the filter must still match.
        for key, expected in filter.items():
            if doc.get(key) != expected:
                return None
        doc.update(update["$set"])
        return dict(doc)

    def update_one(self, filter: dict[str, Any], update: dict[str, Any]) -> Any:
        self._guard("update_one")
        doc = self.docs.get(filter.get("messageId", ""))
        if doc is not None:
            doc.update(update["$set"])
        return object()

    def create_indexes(self, indexes: Any) -> Any:
        self._guard("create_indexes")
        return [getattr(index, "document", {}).get("name", "") for index in indexes]


@pytest.fixture
def statsd() -> RecordingStatsd:
    from app.store import outcome

    client = RecordingStatsd()
    outcome.set_statsd_for_tests(client)
    return client


@pytest.fixture
def dedupe_collection() -> FakeDedupeCollection:
    return FakeDedupeCollection()
