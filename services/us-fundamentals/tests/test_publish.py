"""The Pub/Sub envelope — MONEY-979 (T6).

The contract is ``packages/pubsub/src/publish.ts``:
``topic.publishMessage({ json: data })``, which inside ``@google-cloud/pubsub``
is ``message.data = Buffer.from(JSON.stringify(message.json))`` and nothing
else. So: JSON in ``data``, base64 applied by the client library, no attributes,
no ordering key.

The strongest assertion here is :func:`test_bytes_match_node_json_stringify`,
which runs the real ``JSON.stringify`` and compares bytes. It skips when node is
not on PATH, so the hand-written expectations above it stay load-bearing.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from datetime import UTC, datetime
from typing import Any

import pytest

from app.publish import (
    KNOWN_PUBSUB_ENVS,
    Publisher,
    PublishError,
    build_parse_message,
    encode_message,
    iso_timestamp,
    resolve_pubsub_env,
    topic_name,
)

SAMPLE = {
    "accession": "0001214659-26-011109",
    "cik10": "0001211677",
    "form": "4",
    "parseClass": "OWNERSHIP",
    "acceptedAt": "2026-08-29T01:53:58.000Z",
}


# ── Fakes ───────────────────────────────────────────────────────────────────


class _FakeFuture:
    def __init__(self, message_id: str, error: Exception | None = None) -> None:
        self._message_id = message_id
        self._error = error

    def result(self, timeout: float | None = None) -> str:
        if self._error is not None:
            raise self._error
        return self._message_id


class FakePublisherClient:
    """Records exactly how ``publish`` was called.

    ``*args`` and ``**kwargs`` are captured rather than named, so the test can
    assert that NOTHING beyond the topic and the data was passed — an
    ``ordering_key`` or an attribute would show up as an extra entry rather than
    being silently absorbed by a named parameter.
    """

    def __init__(self, message_id: str = "8888", error: Exception | None = None) -> None:
        self.calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
        self._message_id = message_id
        self._error = error

    def topic_path(self, project: str, topic: str) -> str:
        return f"projects/{project}/topics/{topic}"

    def publish(self, *args: Any, **kwargs: Any) -> _FakeFuture:
        self.calls.append((args, kwargs))
        return _FakeFuture(self._message_id, self._error)


# ── Encoding ────────────────────────────────────────────────────────────────


def test_encoding_is_compact_json_bytes() -> None:
    """``JSON.stringify`` emits no spaces; Python's default emits ``", "`` and ``": "``."""
    assert encode_message({"a": 1, "b": "x"}) == b'{"a":1,"b":"x"}'
    assert b", " not in encode_message(SAMPLE)
    assert b'": ' not in encode_message(SAMPLE)


def test_encoding_preserves_declaration_order() -> None:
    """A TypeScript object literal keeps its key order and so must this."""
    decoded = encode_message(SAMPLE).decode()
    assert list(json.loads(decoded)) == [
        "accession",
        "cik10",
        "form",
        "parseClass",
        "acceptedAt",
    ]
    assert decoded.index('"accession"') < decoded.index('"cik10"') < decoded.index('"form"')


def test_encoding_does_not_escape_non_ascii() -> None:
    """``JSON.stringify`` emits UTF-8; ``json.dumps`` would emit ``\\uXXXX`` by default.

    Filer names carry accents and the occasional non-Latin character, so this is
    reachable rather than theoretical.
    """
    payload = {"company": "Société Générale"}
    assert encode_message(payload) == '{"company":"Société Générale"}'.encode()


def test_bytes_match_node_json_stringify() -> None:
    """The contract, checked against the actual implementation it mirrors."""
    node = shutil.which("node")
    if node is None:  # pragma: no cover - depends on the host
        pytest.skip("node is not on PATH")

    script = (
        "process.stdout.write(Buffer.from(JSON.stringify({"
        'accession:"0001214659-26-011109",'
        'cik10:"0001211677",'
        'form:"4",'
        'parseClass:"OWNERSHIP",'
        'acceptedAt:"2026-08-29T01:53:58.000Z"'
        "})))"
    )
    produced = subprocess.run([node, "-e", script], capture_output=True, check=True).stdout
    assert encode_message(SAMPLE) == produced


# ── Timestamps ──────────────────────────────────────────────────────────────


def test_iso_timestamp_matches_a_javascript_date() -> None:
    """``JSON.stringify(new Date())`` always has milliseconds and a literal ``Z``.

    Python's ``isoformat()`` emits ``+00:00`` and DROPS the fractional part when
    it is zero, so two messages describing the same instant would differ in
    their bytes depending on whether SEC's timestamp landed on a whole second.
    """
    assert iso_timestamp(datetime(2026, 8, 29, 1, 53, 58, tzinfo=UTC)) == "2026-08-29T01:53:58.000Z"
    assert (
        iso_timestamp(datetime(2026, 8, 29, 1, 53, 58, 123456, tzinfo=UTC))
        == "2026-08-29T01:53:58.123Z"
    )


def test_iso_timestamp_normalises_offsets_and_naive_values() -> None:
    from datetime import timedelta, timezone

    eastern = timezone(timedelta(hours=-4))
    assert (
        iso_timestamp(datetime(2026, 8, 28, 21, 53, 58, tzinfo=eastern))
        == "2026-08-29T01:53:58.000Z"
    )
    assert iso_timestamp(datetime(2026, 8, 29, 1, 53, 58)) == "2026-08-29T01:53:58.000Z"


def test_iso_timestamp_of_none_is_none() -> None:
    """An EFTS-recovered filing has no acceptance timestamp, and says so."""
    assert iso_timestamp(None) is None


# ── The parse message ───────────────────────────────────────────────────────


def test_build_parse_message_shape() -> None:
    message = build_parse_message(
        accession="0001214659-26-011109",
        cik10="0001211677",
        form="4",
        parse_class="OWNERSHIP",
        accepted_at=datetime(2026, 8, 29, 1, 53, 58, tzinfo=UTC),
    )
    assert message == SAMPLE
    assert list(message) == list(SAMPLE)


def test_build_parse_message_keeps_a_missing_acceptance_null() -> None:
    message = build_parse_message(
        accession="0001214659-26-011109",
        cik10="0001211677",
        form="8-K",
        parse_class="EIGHTK",
        accepted_at=None,
    )
    assert message["acceptedAt"] is None
    assert b'"acceptedAt":null' in encode_message(message)


# ── Topic resolution ────────────────────────────────────────────────────────


@pytest.mark.parametrize("env", KNOWN_PUBSUB_ENVS)
def test_explicit_pubsub_env_is_used(env: str) -> None:
    os.environ["PUBSUB_ENV"] = env
    assert resolve_pubsub_env() == env
    assert topic_name("edgar-parse-13f") == f"edgar-parse-13f-{env}"


def test_unrecognised_pubsub_env_falls_through_like_the_typescript_resolver() -> None:
    """``getPubSubEnv()`` only accepts ``prod`` / ``qa`` / ``local``; anything else falls back.

    Mirroring the fall-through matters more than mirroring the happy path: the
    topics were created by the TypeScript resolver, so a Python resolver that
    diverged on one branch would publish to a name that exists nowhere and raise
    ``NotFound`` in production and nowhere else.
    """
    os.environ["PUBSUB_ENV"] = "staging"
    assert resolve_pubsub_env() == "qa"

    os.environ["NODE_ENV"] = "production"
    assert resolve_pubsub_env() == "prod"


def test_pubsub_env_defaults_to_qa_when_nothing_is_set() -> None:
    assert resolve_pubsub_env() == "qa"


def test_node_env_production_selects_prod() -> None:
    os.environ["NODE_ENV"] = "production"
    assert topic_name("edgar-detect") == "edgar-detect-prod"


def test_blank_pubsub_env_is_not_a_topic_suffix() -> None:
    """An unexpanded Cloud Build substitution is an EMPTY string, not an absent one."""
    os.environ["PUBSUB_ENV"] = "   "
    assert resolve_pubsub_env() == "qa"


# ── Publishing ──────────────────────────────────────────────────────────────


def test_publish_sends_json_in_data_and_nothing_else() -> None:
    """No attributes, no ordering key — asserted by capturing every argument.

    ``app.envelope.parse_pubsub_message`` reads ``message.data`` only, so a
    payload smuggled into attributes would decode to ``{}`` and the handler
    would run its DEFAULT behaviour rather than fail. An ordering key on a
    subscription that has not enabled ordering makes Pub/Sub reject the publish
    outright.
    """
    os.environ["PUBSUB_ENV"] = "prod"
    client = FakePublisherClient(message_id="42")
    publisher = Publisher(project_id="stock-book", client=client)

    message_id = publisher.publish("edgar-parse-ownership", SAMPLE)

    assert message_id == "42"
    assert len(client.calls) == 1
    args, kwargs = client.calls[0]
    assert args == (
        "projects/stock-book/topics/edgar-parse-ownership-prod",
        encode_message(SAMPLE),
    )
    assert kwargs == {}
    assert publisher.published == 1


def test_publish_uses_the_env_suffixed_topic() -> None:
    os.environ["PUBSUB_ENV"] = "qa"
    client = FakePublisherClient()
    Publisher(project_id="p", client=client).publish("edgar-parse-13f", SAMPLE)
    assert client.calls[0][0][0] == "projects/p/topics/edgar-parse-13f-qa"


def test_publish_falls_back_to_the_configured_project() -> None:
    os.environ["GCP_PROJECT_ID"] = "from-settings"
    os.environ["PUBSUB_ENV"] = "prod"
    client = FakePublisherClient()
    Publisher(client=client).publish("edgar-parse-8k", SAMPLE)
    assert client.calls[0][0][0].startswith("projects/from-settings/topics/")


def test_publish_without_a_project_raises_publish_error() -> None:
    """Detection has nowhere to fan out to, and that must be its own failure type.

    The caller distinguishes "Pub/Sub refused" (stop the fan-out, pin the
    cursor) from a bug (500 and a redelivery).
    """
    client = FakePublisherClient()
    with pytest.raises(PublishError):
        Publisher(client=client).publish("edgar-parse-8k", SAMPLE)
    assert client.calls == []


def test_publish_failure_is_wrapped_without_the_original_message() -> None:
    """A Google API error renders the REQUEST into its own ``str()``.

    Only the exception TYPE crosses into our message, so a publish failure
    cannot put credentials into Cloud Logging.
    """
    secret = "Bearer ya29.SUPER-SECRET-TOKEN"
    client = FakePublisherClient(error=RuntimeError(secret))
    publisher = Publisher(project_id="p", client=client)

    with pytest.raises(PublishError) as caught:
        publisher.publish("edgar-parse-13dg", SAMPLE)

    assert "RuntimeError" in str(caught.value)
    assert secret not in str(caught.value)
    assert publisher.published == 0


def test_publish_counts_only_after_the_call_it_counts() -> None:
    """A counter bumped before its call reports a full number for a dead transport."""
    client = FakePublisherClient(error=RuntimeError("nope"))
    publisher = Publisher(project_id="p", client=client)
    with pytest.raises(PublishError):
        publisher.publish("edgar-parse-13f", SAMPLE)
    assert publisher.published == 0
