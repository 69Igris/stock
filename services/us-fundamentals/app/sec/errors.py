"""Typed failures for every sec.gov interaction — MONEY-979.

## Why the classification is the point

SEC does not signal throttling the way an API does. There is **no 429 and no
documented ``Retry-After``**: a client over the fair-access ceiling gets an HTTP
**403 with an HTML body**, and a client with an unacceptable ``User-Agent`` gets
an HTTP **403 with a different HTML body**. Identical status, opposite remedies:

* rate block  → stop, wait 10 minutes below the threshold, resume  (transient)
* UA rejected → stop and page a human; the next request fails the same way
  (deterministic — retrying only lengthens the block)

So the status code alone can never decide, and anything that classifies on status
alone will retry an identity rejection into a longer block. Classification here
reads the **body text**, and the table lives in one pure function
(:func:`classify_sec_response`) so it can be driven from fixtures with no HTTP
anywhere near it.

## The retry rule, stated once

Exactly ONE class is retryable: :class:`SecTransportError`. Every other class is
either deterministic (identity, egress, not-found) or has its own single
prescribed wait (:class:`SecRateLimited`). A caller that retries on
:class:`SecError` broadly has re-introduced the defect this module exists to
prevent.
"""

from __future__ import annotations

# ── SEC's own words, verified 2026-08-29 against the live 403 pages ─────────
#
# Matched case-insensitively against the DECODED body. Keep these as the
# smallest distinctive fragment: SEC has reworded the surrounding page before,
# and a long exact-match phrase is how a classifier goes quietly blind.

#: An undeclared / unacceptable User-Agent. Deterministic.
IDENTITY_MARKERS: tuple[str, ...] = (
    "undeclared automated tool",
    "declare your user agent",
    "declare your user-agent",
    # The live page's actual instruction: "Please declare your traffic by
    # updating your user agent to include company specific information."
    "updating your user agent",
)

#: Over the fair-access request ceiling. Transient, 10-minute remedy.
RATE_MARKERS: tuple[str, ...] = (
    "request rate threshold",
    "exceeded the sec's traffic limit",
    "your request rate has exceeded",
    "you have exceeded",
    "too many requests",
)

#: A key that DOES NOT EXIST in sec.gov's archive bucket.
#:
#: Measured 2026-08-29 (MONEY-1279):
#: ``/Archives/edgar/daily-index/2021/QTR3/form.20210906.idx`` — Labor Day —
#: answers **403 with an S3 XML body**, while 09-03 and 09-07 answer 200 to the
#: same User-Agent. The bucket denies ``ListBucket``, and S3 will not confirm an
#: absence it has not authorised you to observe, so a missing key is
#: ``AccessDenied`` rather than ``NoSuchKey``.
#:
#: The marker is an XML ELEMENT, not prose. SEC's identity and rate pages are
#: HTML paragraphs and cannot contain it — that specificity is the entire safety
#: argument for mapping a 403 to absence, and it is why this is matched LAST.
ARCHIVE_ABSENT_MARKERS: tuple[str, ...] = ("<code>accessdenied</code>",)

#: How much of a body ever reaches a log line or an exception message.
BODY_EXCERPT_CHARS = 300


class SecError(Exception):
    """Base for every failure raised by the SEC client."""


class SecIdentityRejected(SecError):
    """403 whose body says our ``User-Agent`` was refused.

    DETERMINISTIC. Never retried, at any level. The run stops and the operator
    is paged, because every subsequent request in the fleet fails identically
    and each one deepens the block.
    """


class SecRateLimited(SecError):
    """We are over SEC's fair-access ceiling (or a genuine 429, should one appear).

    SEC's published remedy is to stay below the threshold for **10 minutes**;
    there is no ``Retry-After`` to steer by, so the client sleeps that documented
    interval ONCE and then re-raises. It does not re-issue the request: a block
    is measured at SEC's edge, and the only thing our process can usefully
    contribute is silence.

    ``retry_after`` is populated only when the response actually carried the
    header — a value we honour when it asks for LONGER than the documented
    600 s, and never one that would shorten the wait.
    """

    def __init__(self, message: str = "SEC rate limited", retry_after: float | None = None):
        super().__init__(message)
        self.retry_after = retry_after


class SecNotFound(SecError):
    """404. Callers usually map this to ``None`` — an absent filing is data, not a fault."""


class SecArchiveAbsent(SecNotFound):
    """403 from the archive bucket for a key that does not exist.

    Subclasses :class:`SecNotFound` DELIBERATELY: every caller that already maps
    "absent is data, not a fault" to ``None`` keeps working unchanged, and the
    distinct type stays visible to a log line or an ``except`` clause that wants
    to tell the two apart.

    It is NOT a licence to treat the day as permanently handled. The ownership
    walk records it ``NO_INDEX`` / ``CHECKPOINT_EMPTY`` — never ``DONE`` —
    because a market holiday and a day SEC has not published YET are
    indistinguishable from here, and only one of them is permanent.
    """


class SecTransportError(SecError):
    """5xx, connect timeout, read timeout, reset. The ONLY retryable class."""


class SecForbidden(SecError):
    """403 we could not classify — neither identity text nor rate text present.

    Its own value on purpose. Folding an unrecognised 403 into
    :class:`SecRateLimited` would make the client sleep and then continue as if
    the cause were known, and folding it into :class:`SecIdentityRejected` would
    page a human for a page we did not actually read. "Could not determine" is a
    distinct state everywhere in this codebase, and here it behaves the safe way:
    non-retryable, run stops, body excerpt in the message so the next reader can
    extend :data:`IDENTITY_MARKERS` or :data:`RATE_MARKERS`.
    """


class SecEgressDisabled(SecError):
    """``SEC_EGRESS`` is not ``"archive"`` and something tried to reach the network.

    Raised BEFORE a socket is opened, which is what makes "QA cannot talk to
    SEC" a property that can be asserted rather than a habit. QA reads the GCS
    archive; a miss is this exception, never a fetch.
    """


class LimiterUnavailable(SecError):
    """The SHARED rate limiter could not be reached — so we do not call SEC.

    FAIL CLOSED, and this is the single most important decision in the package.
    The tempting fallback is an in-process bucket, and it is exactly wrong: N
    Cloud Run instances each pacing themselves to 9 req/s is 9N req/s at SEC's
    edge, against a published ceiling of 10 — and it would be INVISIBLE, because
    every instance's own logs would show a perfectly obedient 9 req/s.
    """


def classify_sec_response(status: int, body: bytes) -> type[SecError] | None:
    """The whole SEC response table, as a pure function.

    Returns the exception CLASS to raise, or ``None`` when the response is a
    success. Pure and body-driven so the table is tested against real captured
    bodies with no HTTP, no clock and no network.

    Ordering is load-bearing: the identity markers are checked BEFORE the rate
    markers because SEC's UA-rejection page also contains the word "exceeded" in
    its explanatory paragraph, and mapping that page to
    :class:`SecRateLimited` would sleep 10 minutes and then retry a request that
    can never succeed.

    :data:`ARCHIVE_ABSENT_MARKERS` is checked LAST, after both block tests, for
    the same reason in the opposite direction: a real block downgraded to
    "absent" would be recorded as "SEC published nothing that day" and the walk
    would sail past it writing zeros. Absence is the least alarming reading of a
    403, so it must be the hardest to reach.
    """
    if 200 <= status < 300:
        return None

    text = _decode(body).lower()

    if status == 404:
        return SecNotFound

    if status == 403:
        if _contains_any(text, IDENTITY_MARKERS):
            return SecIdentityRejected
        if _contains_any(text, RATE_MARKERS):
            return SecRateLimited
        if _contains_any(text, ARCHIVE_ABSENT_MARKERS):
            return SecArchiveAbsent
        return SecForbidden

    if status == 429:
        # Undocumented and never observed from sec.gov, but a CDN in front of it
        # could produce one and the meaning would be unambiguous.
        return SecRateLimited

    if status >= 500:
        # A 503 carrying the throttle text is a block wearing a server error's
        # status; retrying it 5 times with backoff is the wrong remedy.
        if _contains_any(text, RATE_MARKERS):
            return SecRateLimited
        return SecTransportError

    # Any other 4xx (400, 401, 410, ...). Not retryable, not classified — the
    # base class carries the status and the excerpt to the log.
    return SecError


def body_excerpt(body: bytes, limit: int = BODY_EXCERPT_CHARS) -> str:
    """A short, single-line, control-character-free excerpt for a message.

    SEC error bodies are full HTML pages. Pasting one into an exception message
    turns a log line into a screenful, and the useful signal is always in the
    first sentence.
    """
    text = " ".join(_decode(body).split())
    if len(text) <= limit:
        return text
    return text[:limit] + "…"


def _decode(body: bytes) -> str:
    return body.decode("utf-8", errors="replace")


def _contains_any(haystack_lower: str, needles: tuple[str, ...]) -> bool:
    return any(needle in haystack_lower for needle in needles)
