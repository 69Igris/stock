"""Pub/Sub push envelope decoding — MONEY-979.

Port of ``workers/src/lib/message.ts``. Two body shapes reach a ``/jobs/*``
route and both must work:

* a real push envelope, ``{"message": {"data": "<base64>", "messageId": "..."}}``
* a direct JSON body, ``{"mode": "efts"}`` — local dev, a manual curl, a
  ``gcloud pubsub topics publish`` replayed by hand.
"""

from __future__ import annotations

import base64
import binascii
import json
from typing import Any


def is_pubsub_envelope(body: Any) -> bool:
    """True when ``body`` carries ``message.data`` as a string."""
    if not isinstance(body, dict):
        return False
    message = body.get("message")
    return isinstance(message, dict) and isinstance(message.get("data"), str)


def parse_pubsub_message(body: Any) -> Any:
    """Decode the payload out of a push envelope, or pass a direct body through.

    A body that is not an envelope IS the payload. That is not a fallback for a
    malformed envelope — it is the documented local-development shape, and
    conflating the two would make every hand-published message fail with a
    base64 error.

    An envelope whose ``data`` is not valid base64/JSON RAISES: that is a
    genuinely corrupt delivery and swallowing it would run the job with an empty
    payload, which for a detect/parse job means "do the default thing", not
    "do nothing".
    """
    if not is_pubsub_envelope(body):
        return body

    raw = body["message"]["data"]
    if raw == "":
        # An EMPTY data field is how a scheduler publishes `{}` in some paths.
        # Decoding it yields b"" and json.loads("") raises, so answer with the
        # empty payload the publisher meant rather than a 500.
        return {}
    try:
        decoded = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as err:
        raise ValueError("pubsub message.data is not valid base64") from err
    text = decoded.decode("utf-8")
    if not text.strip():
        return {}
    return json.loads(text)


def get_message_id(body: Any) -> str | None:
    """The Pub/Sub delivery id, or ``None`` when the body carries none.

    ``None`` — never a synthesised ``local-<timestamp>``. The TypeScript
    ``getMessageId`` synthesises one so a LOG LINE always has something to
    print; this one feeds the DEDUPE, where a clock-derived id is actively
    harmful: two manual triggers inside the same millisecond would collide and
    the second would be silently skipped as a "duplicate" of an unrelated job.

    No id -> dedupe is SKIPPED, not keyed on a fabrication.
    """
    if not isinstance(body, dict):
        return None
    message = body.get("message")
    if not isinstance(message, dict):
        return None
    raw = message.get("messageId")
    if not isinstance(raw, str):
        return None
    trimmed = raw.strip()
    return trimmed or None
