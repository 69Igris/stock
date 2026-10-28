"""Pub/Sub publishing, byte-compatible with ``packages/pubsub/src/publish.ts`` — MONEY-979.

The consumers of these messages are Python handlers in this service, but the
ENVELOPE has to match what the TypeScript side produces, because both write to
the same topics and a worker's ``parse_pubsub_message`` (and this service's
:mod:`app.envelope`) is written against exactly one shape.

## The shape, and what each half of it costs to get wrong

``packages/pubsub/src/publish.ts`` publishes with
``topic.publishMessage({ json: data })``. Inside ``@google-cloud/pubsub`` that is
literally ``message.data = Buffer.from(JSON.stringify(message.json))`` — so:

* the payload is **JSON in ``data``**, and the client library base64-encodes
  ``data`` on the wire. We hand the Python client BYTES for the same reason: the
  library owns the base64, and a payload base64-ed by hand arrives
  double-encoded and fails ``json.loads`` on the consumer with a message that
  points at the consumer.
* **no attributes.** ``publishMessage({json})`` sets none, and
  ``app.envelope.parse_pubsub_message`` reads ``message.data`` only — a payload
  smuggled into attributes would decode to ``{}`` and the handler would run its
  DEFAULT behaviour rather than fail.
* **no ordering key.** Publishing with one on a subscription that does not
  enable message ordering makes Pub/Sub reject the publish outright; and the
  fan-out is deliberately unordered, because ordering would serialise every
  Form 4 behind whichever 13F happens to be parsing.

``JSON.stringify`` emits COMPACT JSON with no spaces and does not escape
non-ASCII, so :func:`encode_message` passes ``separators=(",", ":")`` and
``ensure_ascii=False``. Python dicts preserve insertion order, so the key order
matches an object literal's on the TypeScript side too.

## The topic name is resolved the same way on both sides

``getTopicName`` is ``${base}-${getPubSubEnv()}``, and ``getPubSubEnv`` reads
``PUBSUB_ENV`` when it is one of ``qa`` / ``prod`` / ``local`` and otherwise
falls back to ``NODE_ENV === "production" ? "prod" : "qa"``.
:func:`resolve_pubsub_env` mirrors that EXACTLY, including the fallback and
including that an unrecognised ``PUBSUB_ENV`` falls through rather than being
used. The topics were created by ``workers/scripts/setup-pubsub.sh`` under the
TypeScript spelling; a Python resolver that differed by one branch would publish
to a topic name that exists nowhere, and ``publish`` would raise ``NotFound`` in
production and nowhere else.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any

from app import settings

logger = logging.getLogger(__name__)

#: Seconds to wait for a publish to be acknowledged. Deliberately finite: the
#: caller is a push handler under a 600 s ack deadline, and a publish future
#: that never resolves would spend the whole of it.
PUBLISH_TIMEOUT_SECONDS = 30.0

#: The environments ``getPubSubEnv()`` recognises explicitly.
KNOWN_PUBSUB_ENVS: tuple[str, ...] = ("prod", "qa", "local")


class PublishError(RuntimeError):
    """A message could not be published.

    Its own type so the detect loop can tell "Pub/Sub refused" from a bug in the
    fan-out. The two need opposite responses: the first stops the fan-out and
    pins the cursor so the untried remainder is re-walked; the second is a 500
    and a redelivery.
    """


def resolve_pubsub_env() -> str:
    """``qa`` / ``prod`` / ``local`` — mirrors ``getPubSubEnv()`` exactly.

    ``NODE_ENV`` is read directly rather than through ``settings.app_env()``,
    which also considers ``APP_ENV``. That is not an oversight: the topics were
    created by the TypeScript resolver, and the only correct answer here is the
    one the TypeScript resolver would give for the same environment.
    """
    import os

    explicit = (os.environ.get("PUBSUB_ENV") or "").strip()
    if explicit in KNOWN_PUBSUB_ENVS:
        return explicit
    return "prod" if (os.environ.get("NODE_ENV") or "").strip() == "production" else "qa"


def topic_name(base_topic: str) -> str:
    """``edgar-parse-13f`` -> ``edgar-parse-13f-prod``."""
    return f"{base_topic}-{resolve_pubsub_env()}"


def encode_message(payload: dict[str, Any]) -> bytes:
    """The exact bytes ``Buffer.from(JSON.stringify(payload))`` would produce.

    Compact separators and ``ensure_ascii=False``: Python's defaults would emit
    ``", "`` / ``": "`` and escape every non-ASCII character to ``\\uXXXX``,
    both of which ``JSON.stringify`` does not do. The consumer parses either
    form, so this is not about correctness of decoding — it is so that a byte
    comparison against the TypeScript publisher is a test that can exist at all.
    """
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def iso_timestamp(moment: datetime | None) -> str | None:
    """``2026-08-29T01:53:58.000Z`` — the rendering ``JSON.stringify(new Date())`` gives.

    Milliseconds are always present and the zone is always the literal ``Z``.
    Python's own ``isoformat()`` emits ``+00:00`` and drops the fractional part
    when it is zero, so two messages describing the same instant would differ in
    their bytes depending on whether SEC's timestamp happened to land on a whole
    second.
    """
    if moment is None:
        return None
    aware = moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment.astimezone(UTC)
    return aware.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_parse_message(
    *,
    accession: str,
    cik10: str,
    form: str,
    parse_class: str,
    accepted_at: datetime | None,
) -> dict[str, Any]:
    """The fan-out payload. Key ORDER is the declaration order, as in TypeScript.

    Deliberately minimal. It carries what the parser needs to FIND the filing
    (``accession`` + ``cik10`` build the archive key and the SEC URL) and what it
    needs to route and stamp it — nothing that the parser could instead read
    from the ``us_filings`` row it is about to update. A message that duplicates
    stored state is a second copy of a fact that can disagree with the first.

    ``acceptedAt`` is the exception, and it earns its place: it is what the
    parser stamps on every row it writes so a downstream reader can measure
    freshness without joining back to ``us_filings``.
    """
    return {
        "accession": accession,
        "cik10": cik10,
        "form": form,
        "parseClass": parse_class,
        "acceptedAt": iso_timestamp(accepted_at),
    }


class Publisher:
    """Publishes one message at a time and waits for the id.

    The Google client batches by default (10 ms of latency, up to 1000
    messages), and resolving each future in turn defeats that. It is the right
    trade here: a detect run publishes at most a few dozen messages, and the
    caller must know whether THIS message was accepted before it decides whether
    to advance the cursor past THIS filing. A batched publish would report every
    failure after the loop had already moved on.
    """

    def __init__(self, *, project_id: str | None = None, client: Any | None = None) -> None:
        self._project_id = project_id
        self._client = client
        self.published: int = 0

    def _resolve_project(self) -> str:
        project = self._project_id or settings.gcp_project_id()
        if not project:
            raise PublishError(
                "GCP_PROJECT_ID is not set; cannot resolve a Pub/Sub topic path. "
                "Detection has nowhere to fan out to."
            )
        return project

    def _resolve_client(self) -> Any:
        """The real client, built lazily.

        Lazily because constructing ``PublisherClient()`` resolves Application
        Default Credentials, and importing this module must not require them —
        every test in this package would otherwise need a service account.
        """
        if self._client is None:
            from google.cloud import pubsub_v1

            self._client = pubsub_v1.PublisherClient()
        return self._client

    def publish(self, base_topic: str, payload: dict[str, Any]) -> str:
        """Publish ``payload`` as JSON to ``{base_topic}-{env}``; return the message id.

        Raises :class:`PublishError` for ANY failure, with the exception TYPE
        rather than the exception, because a Google API error renders the
        request — including its credentials — into its own ``str()``.
        """
        client = self._resolve_client()
        topic_path = client.topic_path(self._resolve_project(), topic_name(base_topic))
        data = encode_message(payload)
        try:
            # Positional `data` and nothing else: no `ordering_key`, no `**attrs`.
            future = client.publish(topic_path, data)
            message_id = future.result(timeout=PUBLISH_TIMEOUT_SECONDS)
        except Exception as err:
            raise PublishError(f"publish to {topic_path} failed: {type(err).__name__}") from err
        self.published += 1
        return str(message_id)
