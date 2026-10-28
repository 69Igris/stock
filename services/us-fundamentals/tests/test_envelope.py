"""Pub/Sub envelope decoding — MONEY-979."""

from __future__ import annotations

import base64
import json

import pytest

from app.envelope import get_message_id, is_pubsub_envelope, parse_pubsub_message


def envelope(payload: dict, message_id: str | None = "msg-1") -> dict:
    data = base64.b64encode(json.dumps(payload).encode()).decode()
    message: dict = {"data": data}
    if message_id is not None:
        message["messageId"] = message_id
    return {"message": message, "subscription": "projects/p/subscriptions/s"}


def test_base64_round_trip() -> None:
    payload = {"accession": "0001214659-26-011109", "cik10": "0000320193", "form": "4"}
    assert parse_pubsub_message(envelope(payload)) == payload


def test_a_body_that_is_not_an_envelope_IS_the_payload() -> None:
    """The direct-JSON shape is the documented LOCAL-DEV form, not a fallback
    for a malformed envelope. Conflating the two would make every hand-published
    message fail with a base64 error."""
    direct = {"mode": "efts", "hours": 2}
    assert parse_pubsub_message(direct) == direct
    assert is_pubsub_envelope(direct) is False


def test_an_empty_data_field_decodes_to_an_empty_payload() -> None:
    """Some publish paths send `{}` as an empty `data`. b"" is not valid JSON,
    so a naive decode 500s on a message the publisher considers well-formed."""
    assert parse_pubsub_message({"message": {"data": "", "messageId": "m"}}) == {}


def test_whitespace_only_data_decodes_to_an_empty_payload() -> None:
    blank = base64.b64encode(b"  \n ").decode()
    assert parse_pubsub_message({"message": {"data": blank}}) == {}


def test_corrupt_base64_RAISES_rather_than_running_with_an_empty_payload() -> None:
    """A genuinely corrupt delivery must not silently become `{}`.

    For a detect or parse job an empty payload means "do the DEFAULT thing",
    not "do nothing" — so swallowing the error runs the wrong job quietly.
    """
    with pytest.raises(ValueError):
        parse_pubsub_message({"message": {"data": "!!!not base64!!!"}})


def test_valid_base64_of_non_json_raises() -> None:
    bad = base64.b64encode(b"this is not json").decode()
    with pytest.raises(json.JSONDecodeError):
        parse_pubsub_message({"message": {"data": bad}})


def test_get_message_id_reads_the_envelope() -> None:
    assert get_message_id(envelope({}, "9876543210")) == "9876543210"


def test_get_message_id_returns_None_when_absent() -> None:
    """NEVER a synthesised `local-<timestamp>`.

    The TypeScript `getMessageId` synthesises one so a LOG LINE always has
    something to print. This one feeds the DEDUPE, where a clock-derived id is
    actively harmful: two manual triggers inside the same millisecond would
    collide and the second would be silently skipped as a "duplicate" of an
    unrelated job. No id -> dedupe SKIPPED, not keyed on a fabrication.
    """
    assert get_message_id(envelope({}, None)) is None
    assert get_message_id({"mode": "efts"}) is None
    assert get_message_id({"message": {"messageId": "   "}}) is None
    assert get_message_id({"message": {"messageId": 12345}}) is None
    assert get_message_id(None) is None
