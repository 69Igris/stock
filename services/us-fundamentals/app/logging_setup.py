"""Structured JSON logging with credential redaction — MONEY-979.

## Why redaction is a LOGGING concern and not a call-site concern

``httpx`` and ``google-auth`` both put the request into the exception. Printing
an exception object raw therefore prints the ``Authorization`` header, the
``X-OPENFIGI-APIKEY`` header, and any signed URL in the request line — to Cloud
Logging, which is retained and searchable. Asking every call site to remember
this is asking every future call site to remember it. The filter is installed
once, on the root logger, and applies to messages nobody wrote yet.

Named ``logging_setup`` rather than ``logging`` DELIBERATELY: a module named
``app/logging.py`` shadows the stdlib for absolute imports inside the package on
some tooling paths, and the failure is an import error at container start with a
stack trace that does not name the cause.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from typing import Any

#: Header / query-parameter names whose VALUES must never reach a log line.
#:
#: ``Authorization`` covers both the OIDC bearer token on an inbound push and
#: the SEC/Tiingo-style credential on an outbound call. ``X-OPENFIGI-APIKEY`` is
#: the one credential in this service that is sent as a bespoke header, so a
#: generic "redact Authorization" rule would miss it entirely.
REDACTED_KEYS: tuple[str, ...] = (
    "authorization",
    "x-openfigi-apikey",
    "api_key",
    "apikey",
    "token",
    "password",
    "secret",
)

REDACTED = "[REDACTED]"

#: An auth SCHEME word sits BETWEEN the key and the credential, and the value
#: run stops at the first space — so without this the match consumed exactly
#: ``Bearer`` and left the token standing next to the word ``[REDACTED]``:
#:
#:     Authorization: [REDACTED] eyJhbGciOiJSUzI1NiJ9.SUPERSECRETTOKEN.sig
#:
#: ``Token`` is the scheme the Tiingo client in this repo sends; ``Basic``
#: carries base64 credentials. Separated by ``[ \t]+`` and not ``\s+`` so a
#: scheme word at the end of a line cannot reach across the newline and redact
#: the first word of the next one.
_SCHEME = r"(?:Bearer|Token|Basic)[ \t]+"

# Matches `Authorization: Bearer xyz`, `'authorization': 'Bearer xyz'`,
# `authorization=Bearer+xyz`, the dict-repr forms an exception carries, and
# httpx's tuple/list form `[('x-openfigi-apikey', 'xyz'), ...]` — which it emits
# whenever a header name repeats.
_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(
        # key, optionally quoted, then the separator. `,` is a separator ONLY
        # between a QUOTED key and a QUOTED value (the tuple form). Accepting it
        # bare would redact the next word of any sentence containing
        # "... the token, and then ..." — precision here is what keeps the
        # filter from eating log lines that hold no credential at all.
        r"(['\"]?\b" + re.escape(key) + r"\b['\"]?"
        r"(?:\s*[:=]|(?<=['\"]),(?=\s*['\"]))\s*)"
        # value: a quoted string, or an optional scheme word plus a run of
        # non-delimiter characters.
        r"(?:(['\"])([^'\"]*)\2|(?:" + _SCHEME + r")?([^\s,;}\)]+))",
        re.IGNORECASE,
    )
    for key in REDACTED_KEYS
)


def redact(text: str) -> str:
    """Replace every credential-looking value in ``text``.

    Operates on the RENDERED string rather than on structured fields, because
    the dangerous case is exactly the one that is not structured: an exception
    ``repr`` that happens to contain a header dict.
    """
    out = text
    for pattern in _PATTERNS:
        out = pattern.sub(
            lambda m: f"{m.group(1)}{m.group(2) or ''}{REDACTED}{m.group(2) or ''}",
            out,
        )
    return out


class RedactingFilter(logging.Filter):
    """Redacts the rendered message of every record passing through."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            rendered = record.getMessage()
        except Exception:
            rendered = str(record.msg)
        redacted = redact(rendered)
        if redacted != rendered:
            record.msg = redacted
            record.args = ()
        if record.exc_info:
            # Never emit a traceback: the exception VALUE carries the
            # credentialed request. The type name is kept because it is the part
            # that identifies the failure, and it carries nothing secret.
            exc_type = record.exc_info[0]
            record.msg = (
                f"{record.getMessage()} exc_type={getattr(exc_type, '__name__', 'Exception')}"
            )
            record.args = ()
            record.exc_info = None
            record.exc_text = None
        return True


#: Every attribute a vanilla ``LogRecord`` already carries. Anything OUTSIDE
#: this set arrived through ``extra={...}``, which is how ``logging`` attaches
#: caller fields: it sets each key as an ATTRIBUTE on the record. The formatter
#: used to read ``record.extra_fields`` instead — a dict nothing in this tree
#: ever set, so every ``extra=`` payload in the service was silently dropped,
#: including the ``url`` / ``attempt`` / ``bucketKey`` fields you would need to
#: attribute a SEC block or prove the shared limiter was injected.
#:
#: Derived from a probe record rather than hard-coded: the set grows between
#: Python versions (3.12 added ``taskName``), and a stale hard-coded list emits
#: interpreter internals as if a call site had asked for them.
_RESERVED_RECORD_ATTRS: frozenset[str] = frozenset(
    logging.LogRecord(
        name="", level=0, pathname="", lineno=0, msg="", args=(), exc_info=None
    ).__dict__
) | {"message", "asctime"}


def _redact_field(name: str, value: Any) -> Any:
    """Redact one ``extra=`` field, by NAME and by CONTENT.

    Emitting these fields at all is what would newly expose them, so nothing
    reaches the payload unredacted — a ``url`` field carries a signed query
    string, and ``json.dumps(default=str)`` would otherwise stringify an
    ``httpx.Request`` (which holds every header we sent) with no filter in the
    path at all.

    A field whose NAME is itself a credential is replaced WHOLE, whatever its
    type: a number cannot be pattern-matched, and ``[REDACTED]`` keeps the line
    valid JSON where dropping the value would not.
    """
    if name.lower() in REDACTED_KEYS:
        return REDACTED
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {str(key): _redact_field(str(key), item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_redact_field(name, item) for item in value]
    if value is None or isinstance(value, bool | int | float):
        return value
    return redact(str(value))


class JsonFormatter(logging.Formatter):
    """One JSON object per line — the shape Cloud Logging parses natively."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "severity": record.levelname,
            "message": record.getMessage(),
            "logger": record.name,
        }
        for key, value in record.__dict__.items():
            # `key in payload` guards the envelope: `severity` and `logger` are
            # not LogRecord attributes, so `logging` would let an `extra=` of
            # that name through and Cloud Logging keys on both.
            if key in _RESERVED_RECORD_ATTRS or key in payload or key.startswith("_"):
                continue
            payload[key] = _redact_field(key, value)
        return json.dumps(payload, default=str)


def install_logging(level: int = logging.INFO) -> None:
    """Install the JSON formatter and the redaction filter on the ROOT logger.

    Idempotent: calling it twice does not double the handlers, which matters
    because uvicorn's reloader imports the app module more than once.

    MUST be the first statement of EVERY entry point — :mod:`app.main` and each
    of the five ``app.bulk`` jobs — and not the first statement of their
    ``main()``. A log line emitted during import (a library warning, a failed
    optional import, a ``pymongo`` or ``ddtrace`` startup line) is emitted before
    any later call could have installed the filter, and boot-time failures are
    exactly the ones that still have credentials attached.

    That is a placement no call inside this function can enforce, so
    ``tests/test_logging_install_sites.py`` parses each entry point and asserts
    it — the five jobs all called this from ``main()`` while this paragraph
    already said otherwise.
    """
    root = logging.getLogger()
    root.setLevel(level)

    for existing in list(root.handlers):
        if getattr(existing, "_usemoney_json", False):
            return

    handler = logging.StreamHandler(stream=sys.stdout)
    handler.setFormatter(JsonFormatter())
    handler.addFilter(RedactingFilter())
    handler._usemoney_json = True  # type: ignore[attr-defined]

    root.handlers = [handler]

    # uvicorn installs its own handlers on these three; leaving them attached
    # would emit every access line twice, once unredacted.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        child = logging.getLogger(name)
        child.handlers = []
        child.propagate = True


def log_error(message: str, err: BaseException | None = None) -> None:
    """Log an error WITHOUT the exception object.

    The type name and the ``str()`` are kept and redacted; the traceback and the
    exception's ``request`` attribute are dropped. This is the callable injected
    into :func:`app.auth_logic.create_jobs_auth_middleware` and the dedupe store.
    """
    logger = logging.getLogger("us-fundamentals")
    if err is None:
        logger.error(redact(message))
        return
    logger.error(redact(f"{message} ({type(err).__name__}: {err})"))
