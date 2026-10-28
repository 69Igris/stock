"""Credential redaction and the JSON envelope — MONEY-979.

Every case here was a MEASURED leak before the fix, not a hypothetical. The two
shapes that mattered:

* ``Authorization: Bearer <jwt>`` — the value alternative stopped at the first
  space, so the substitution replaced the word ``Bearer`` and left the token
  standing beside ``[REDACTED]``. The comment above the pattern claimed this
  exact string as an example, which is the worst version of the bug: a
  certification the code did not honour.
* ``Headers([('x-openfigi-apikey', 'KEY'), ...])`` — httpx's tuple/list form,
  emitted whenever a header name repeats, was not matched at all.

The negative cases are load-bearing in the other direction. A filter that eats
the rest of a log line every time the word "token" appears in a sentence is a
filter someone eventually turns off.
"""

from __future__ import annotations

import io
import json
import logging

import pytest

from app.logging_setup import REDACTED, JsonFormatter, RedactingFilter, redact

# A value that is obviously a secret if it survives. Asserted by ABSENCE — the
# question is never "did the output look redacted", it is "is the secret gone".
SECRET = "SUPERSECRETTOKENVALUE"


# ── redact(): the scheme word ───────────────────────────────────────────────


@pytest.mark.parametrize("scheme", ["Bearer", "Token", "Basic", "bearer", "TOKEN"])
def test_an_auth_scheme_word_does_not_shield_the_credential(scheme: str) -> None:
    """The whole ``<scheme> <credential>`` run is replaced, not just the word.

    ``Token`` is the scheme the Tiingo client in this repo sends; ``Bearer`` is
    the OIDC push token and SEC/OpenFIGI style; ``Basic`` carries base64
    credentials. All three used to leave the credential in the log line.
    """
    out = redact(f"Authorization: {scheme} {SECRET}.sig")

    assert SECRET not in out
    assert scheme not in out
    assert out == f"Authorization: {REDACTED}"


def test_the_jwt_shape_from_the_review_is_fully_redacted() -> None:
    """The exact demonstrated input, kept verbatim so it cannot drift."""
    out = redact("Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.SUPERSECRETTOKEN.sig")

    assert out == "Authorization: [REDACTED]"


def test_the_query_string_form_is_redacted_too() -> None:
    assert redact(f"authorization=Bearer {SECRET}") == f"authorization={REDACTED}"


def test_a_signed_url_parameter_is_redacted() -> None:
    out = redact(f"GET https://api.example.com/v1/x?token={SECRET}")

    assert SECRET not in out
    assert out.startswith("GET https://api.example.com/v1/x?token=")


# ── redact(): httpx's tuple/list header form ────────────────────────────────


def test_the_httpx_tuple_header_form_is_matched() -> None:
    """``Headers([('k', 'v'), ...])`` — what httpx emits on a repeated name.

    ``,`` was not a key/value separator, so this whole shape passed through
    untouched. The OpenFIGI key is the one credential in this service sent as a
    bespoke header, so a generic "redact Authorization" rule never sees it.
    """
    out = redact(f"Headers([('x-openfigi-apikey', '{SECRET}'), ('set-cookie','a')])")

    assert SECRET not in out
    assert out == "Headers([('x-openfigi-apikey', '[REDACTED]'), ('set-cookie','a')])"


def test_the_dict_repr_form_still_works() -> None:
    """Regression guard on the shape that DID work before the change."""
    out = redact(f"{{'Authorization': 'Token {SECRET}'}}")

    assert SECRET not in out
    assert out == "{'Authorization': '[REDACTED]'}"


# ── redact(): what must be left ALONE ───────────────────────────────────────


def test_a_sentence_containing_the_word_token_is_untouched() -> None:
    """Over-matching is the failure mode that gets a redactor deleted.

    ``token`` is in ``REDACTED_KEYS``, and accepting ``,`` as a bare separator
    (the naive fix for the tuple form above) would redact ``and`` here. The
    comma is a separator ONLY between a quoted key and a quoted value.
    """
    sentence = "we could not refresh the token because the upstream was slow"
    assert redact(sentence) == sentence

    listed = "listed the token, and then gave up after 3 attempts"
    assert redact(listed) == listed


def test_a_scheme_word_cannot_reach_across_a_newline() -> None:
    """``[ \\t]+`` and not ``\\s+`` between the scheme and the credential.

    A trailing ``Bearer`` at the end of a line must not swallow the first word
    of the next record in a multi-line rendering.
    """
    out = redact("Authorization: Bearer\nnextlinewordstays here")

    assert out == "Authorization: [REDACTED]\nnextlinewordstays here"


def test_redaction_is_idempotent() -> None:
    once = redact(f"Authorization: Bearer {SECRET}")
    assert redact(once) == once


# ── The JSON envelope: extra= fields ────────────────────────────────────────


def _emit(**kwargs: object) -> dict[str, object]:
    """Log one record through the REAL formatter + filter pair, return the JSON.

    Not a mock of either: the defect was that the formatter read a dict
    (``record.extra_fields``) nothing ever set, and only running a real
    ``logger.info(..., extra={...})`` through a real ``JsonFormatter`` shows it.
    """
    stream = io.StringIO()
    handler = logging.StreamHandler(stream=stream)
    handler.setFormatter(JsonFormatter())
    handler.addFilter(RedactingFilter())

    logger = logging.getLogger("us-fundamentals.test-probe")
    saved, saved_propagate, saved_level = logger.handlers, logger.propagate, logger.level
    logger.handlers = [handler]
    logger.propagate = False
    logger.setLevel(logging.INFO)
    try:
        logger.info("probe message", extra=dict(kwargs))
    finally:
        logger.handlers, logger.propagate, logger.level = saved, saved_propagate, saved_level

    line = stream.getvalue().strip()
    # Parsed, not substring-matched: a redaction that broke JSON validity would
    # take every log line in the service down with it, and Cloud Logging would
    # report that as a plain-text message rather than as an error.
    return json.loads(line)


def test_extra_fields_reach_the_log_line_at_all() -> None:
    """The SEC-block attribution fields, which were silently dropped.

    ``app/sec/client.py`` attaches ``url`` / ``attempt`` / ``delaySeconds`` and
    ``app/sec/limiter.py`` attaches ``bucketKey`` / ``perSec`` /
    ``edgartoolsInjected``. Those are precisely the fields needed to attribute a
    SEC block or to prove the shared limiter was injected, and every one of them
    was thrown away by the formatter.
    """
    payload = _emit(url="https://www.sec.gov/x", attempt=3, delaySeconds=2.5)

    assert payload["message"] == "probe message"
    assert payload["url"] == "https://www.sec.gov/x"
    assert payload["attempt"] == 3
    assert payload["delaySeconds"] == 2.5


def test_the_limiter_install_fields_survive_their_types() -> None:
    payload = _emit(bucketKey="sec:global", perSec=9, edgartoolsInjected=True)

    assert payload["bucketKey"] == "sec:global"
    assert payload["perSec"] == 9
    assert payload["edgartoolsInjected"] is True


def test_a_secret_inside_an_extra_value_is_redacted() -> None:
    """Emitting these fields is what would newly EXPOSE them.

    A ``url`` carries a signed query string. Adding the fields without routing
    them through ``redact`` would trade a dropped-diagnostics bug for a
    credential-in-Cloud-Logging bug.
    """
    payload = _emit(url=f"https://api.example.com/x?api_key={SECRET}&y=2")

    assert SECRET not in json.dumps(payload)
    assert REDACTED in str(payload["url"])


def test_a_field_whose_NAME_is_a_credential_is_replaced_whole() -> None:
    """Type-independent: a numeric secret cannot be pattern-matched."""
    payload = _emit(api_key=1234567890, token="x", password="hunter2")

    assert payload["api_key"] == REDACTED
    assert payload["token"] == REDACTED
    assert payload["password"] == REDACTED
    assert "hunter2" not in json.dumps(payload)


def test_a_secret_nested_in_a_dict_or_list_is_redacted() -> None:
    payload = _emit(
        headers={"Authorization": f"Bearer {SECRET}"},
        tried=[f"https://x/y?token={SECRET}"],
    )

    assert SECRET not in json.dumps(payload)


def test_an_object_stringified_by_json_default_is_redacted_too() -> None:
    """``json.dumps(default=str)`` is a hole if nothing filters ahead of it.

    ``httpx`` puts the Request on its exceptions and a Request's ``repr``
    carries the URL — so an ``extra=`` holding one would be stringified by
    ``default=`` with no filter in the path.
    """

    class FakeRequest:
        def __repr__(self) -> str:
            return f"<Request('GET', 'https://x/y?token={SECRET}')>"

    payload = _emit(request=FakeRequest())

    assert SECRET not in json.dumps(payload)


def test_record_internals_are_not_emitted_as_caller_fields() -> None:
    """Only genuine ``extra=`` keys, diffed against a vanilla record.

    A hard-coded reserved list goes stale between interpreter versions (3.12
    added ``taskName``) and starts emitting interpreter internals as if a call
    site had asked for them.
    """
    payload = _emit(url="https://www.sec.gov/x")

    assert set(payload) == {"severity", "message", "logger", "url"}


def test_an_extra_cannot_hijack_the_envelope_fields() -> None:
    """``severity`` and ``logger`` are not LogRecord attributes.

    ``logging`` therefore lets them through in ``extra=``, and Cloud Logging
    keys on both.
    """
    payload = _emit(severity="DEBUG", logger="something-else")

    assert payload["severity"] == "INFO"
    assert payload["logger"] == "us-fundamentals.test-probe"


def test_the_message_itself_is_still_redacted_by_the_filter() -> None:
    """The filter's job, asserted here because the formatter now shares the line."""
    stream = io.StringIO()
    handler = logging.StreamHandler(stream=stream)
    handler.setFormatter(JsonFormatter())
    handler.addFilter(RedactingFilter())

    logger = logging.getLogger("us-fundamentals.test-probe-2")
    logger.handlers = [handler]
    logger.propagate = False
    logger.setLevel(logging.INFO)
    logger.info("calling with Authorization: Bearer %s", SECRET)

    payload = json.loads(stream.getvalue().strip())
    assert SECRET not in json.dumps(payload)
