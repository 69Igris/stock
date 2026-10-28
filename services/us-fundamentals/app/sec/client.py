"""The ONLY thing in this service that opens a socket to sec.gov — MONEY-979.

## Identification, not impersonation

SEC publishes a fair-access policy that asks automated clients to **declare
themselves**: a descriptive ``User-Agent`` carrying a name and a contact address
(their own template is ``Name email``). This client sends exactly that, plus
``Accept-Encoding``. It sends **no cookies, no ``Origin``, no ``Referer``**, no
browser-shaped ``Sec-Fetch-*`` set, and nothing else whose only purpose would be
to make an automated client look like a person at a keyboard.

That is a deliberate line, and it is the reason this whole branch is legitimate
where a scraper would not be. Every byte we take is from a documented, keyless,
public endpoint, at a pace below the published ceiling, from a client that says
who it is and how to reach us. A test asserts the absence of those headers,
because the day someone adds a ``Referer`` to fix a 403 is the day the
arrangement stops being what this docstring claims.

## Three behaviours that are NOT ordinary HTTP-client behaviour

1. **Egress gate first.** ``SEC_EGRESS != "archive"`` raises
   :class:`~app.sec.errors.SecEgressDisabled` BEFORE a socket exists. That is
   what makes "QA cannot reach SEC" an assertion rather than a convention — and
   it is checked in ONE helper (:meth:`SecClient._before_request`) that every
   method calls, so a method added next year cannot forget it.
2. **Retry exactly one class.** Only :class:`~app.sec.errors.SecTransportError`
   is retried. A 403 is deterministic; retrying it lengthens a block.
3. **A rate block sleeps and then STOPS.** SEC's documented remedy is ten
   minutes below the threshold. The client sleeps that once and re-raises,
   because a retry after the sleep is a coin flip on whether the fleet has been
   quiet, and losing it restarts the ten minutes.
"""

from __future__ import annotations

import hashlib
import logging
import random
import time
from collections.abc import Callable
from typing import Any

import httpx

from app import settings

from . import archive
from . import limiter as limiter_module
from .archive_logic import accession_nodashes, filing_key
from .errors import (
    SecEgressDisabled,
    SecError,
    SecRateLimited,
    SecTransportError,
    body_excerpt,
    classify_sec_response,
)

logger = logging.getLogger(__name__)

#: Read timeout for an ordinary GET. The bulk zips use :meth:`stream_to_gcs`,
#: which sets its own.
DEFAULT_TIMEOUT_SECONDS = 60.0
CONNECT_TIMEOUT_SECONDS = 10.0

#: Attempts for a RETRYABLE failure only (5xx / connect / read timeout).
MAX_ATTEMPTS = 5
BACKOFF_BASE_SECONDS = 1.0
BACKOFF_CAP_SECONDS = 16.0

#: SEC: "resume after 10 minutes below the threshold". There is no
#: ``Retry-After`` on the throttle page to steer by, so this documented interval
#: is the whole of our knowledge.
RATE_LIMIT_COOLDOWN_SECONDS = 600.0

#: The value of ``Accept-Encoding``. Narrower than httpx's default
#: (``gzip, deflate, br, zstd``) on purpose: SEC serves gzip and deflate, and a
#: header advertising codecs we have no decoder for is noise in someone else's
#: logs.
ACCEPT_ENCODING = "gzip, deflate"

SEC_ARCHIVES_BASE = "https://www.sec.gov/Archives/edgar/data"

#: Headers a browser sends and an automated client has no business sending.
#: Named here so the test that asserts their absence and the code that must not
#: add them read from the same list.
IMPERSONATION_HEADERS = ("cookie", "origin", "referer", "sec-fetch-mode", "sec-fetch-site")


def bundle_url(cik: str, accession: str) -> str:
    """URL of a filing's full submission text file.

    ``https://www.sec.gov/Archives/edgar/data/{cik}/{accessionNoDashes}/{accession}.txt``

    Note the two DIFFERENT renderings of the same accession in one URL — the
    directory segment is undashed and the filename is dashed — and that the CIK
    segment is UNPADDED here while every key and every stored row uses the
    10-digit form. ``int()`` strips the padding; :func:`accession_nodashes`
    validates the accession on the way through, so a malformed value cannot
    become a 404 that looks like a missing filing.
    """
    return f"{SEC_ARCHIVES_BASE}/{int(cik)}/{accession_nodashes(accession)}/{accession}.txt"


class SecClient:
    """A rate-limited, identified, fail-closed HTTP client for sec.gov.

    ``acquire`` and ``sleep`` are injectable so the retry and cooldown paths can
    be driven in a unit test in milliseconds. They default to the REAL shared
    limiter and the REAL clock; a test asserts the defaults, because an injection
    seam whose production wiring is never checked is how a limiter ends up
    installed everywhere except in production.
    """

    def __init__(
        self,
        identity: str,
        *,
        acquire: Callable[[], None] | None = None,
        sleep: Callable[[float], None] | None = None,
        http_client: httpx.Client | None = None,
        jitter: Callable[[], float] | None = None,
    ) -> None:
        if not identity or not identity.strip():
            raise ValueError(
                "EDGAR_IDENTITY is empty. SEC rejects an undeclared agent with a 403 whose body "
                "reads 'Undeclared Automated Tool'; sending a blank User-Agent would be that."
            )
        self.identity = identity.strip()
        self._acquire = acquire or limiter_module.try_acquire
        self._sleep = sleep or time.sleep
        self._jitter = jitter or random.random
        self._client = http_client
        self._owns_client = http_client is None

    @classmethod
    def from_settings(cls, **kwargs: Any) -> SecClient:
        """Build from ``EDGAR_IDENTITY``. Raises when it is unset."""
        identity = settings.edgar_identity()
        if not identity:
            raise ValueError("EDGAR_IDENTITY is not set; refusing to call SEC unidentified")
        return cls(identity, **kwargs)

    # ── lifecycle ──────────────────────────────────────────────────────────

    def __enter__(self) -> SecClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        if self._client is not None and self._owns_client:
            self._client.close()
            self._client = None

    def headers(self) -> dict[str, str]:
        """Every header we send. Nothing else is added anywhere in this module."""
        return {"User-Agent": self.identity, "Accept-Encoding": ACCEPT_ENCODING}

    # ── the gate every method goes through ─────────────────────────────────

    def _before_request(self, url: str) -> None:
        """Egress gate, THEN the shared limiter. In that order, for every method.

        The egress check is the first statement so that a disabled environment
        spends nothing — no Redis round trip, no DNS, no socket — and so the
        assertion "QA issued zero requests" is about the code and not about
        timing.
        """
        egress = settings.sec_egress()
        if egress != "archive":
            raise SecEgressDisabled(
                f"SEC_EGRESS={egress!r}: this environment may not fetch from sec.gov ({url})"
            )
        self._acquire()

    def _http(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(
                headers=self.headers(),
                timeout=httpx.Timeout(DEFAULT_TIMEOUT_SECONDS, connect=CONNECT_TIMEOUT_SECONDS),
                follow_redirects=True,
            )
        return self._client

    # ── requests ───────────────────────────────────────────────────────────

    def get(self, url: str, *, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> bytes:
        """Fetch a URL and return its bytes. Retries transport failures only."""
        response = self._request("GET", url, timeout=timeout)
        return response.content

    def head(self, url: str, *, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> dict[str, Any]:
        """``Last-Modified`` / ``ETag`` / ``Content-Length`` without the body.

        This is how the bulk jobs decide whether today's ``companyfacts.zip`` is
        new: SEC documents a publish time of "approximately 3:00 a.m. ET" and was
        MEASURED publishing at 23:49 ET, so the clock is not evidence and the
        validators are. A HEAD carries no body, so a 403 here can only be
        classified as :class:`~app.sec.errors.SecForbidden` — the identity/rate
        distinction needs the page text and a GET.
        """
        response = self._request("HEAD", url, timeout=timeout)
        return {
            "status": response.status_code,
            "lastModified": response.headers.get("last-modified"),
            "etag": response.headers.get("etag"),
            "contentLength": _int_or_none(response.headers.get("content-length")),
            "acceptRanges": response.headers.get("accept-ranges"),
        }

    def stream_to_gcs(
        self,
        url: str,
        key: str,
        *,
        content_type: str = "application/zip",
        chunk: int = archive.DEFAULT_CHUNK_BYTES,
        timeout: float = 3600.0,
    ) -> dict[str, Any]:
        """Stream a large object straight into a GCS blob. Nothing is buffered.

        ``companyfacts.zip`` is 1,407,685,214 B and ``submissions.zip`` is
        1,560,992,008 B. Cloud Run's ``/tmp`` is a tmpfs — RAM — so "download
        then upload" would charge the instance for the file TWICE and be the
        first thing to OOM. Bytes go response -> blob in ``chunk``-sized blocks,
        hashed on the way past.

        There is deliberately NO retry here. Re-issuing a GET mid-stream would
        append a second copy of the prefix to a blob that already holds one, and
        the resulting object is a corrupt zip that stores and reads back
        perfectly. A failure raises, the writer's context manager terminates the
        upload so no partial object is left behind, and the job — which is
        checkpointed — runs again.
        """
        self._before_request(url)
        digest = hashlib.sha256()
        total = 0
        last_modified: str | None = None
        etag: str | None = None
        try:
            with self._http().stream("GET", url, timeout=timeout) as response:
                if not response.is_success:
                    # Read the body ONLY on a failure. `response.read()` on the
                    # success path would pull 1.4 GB into memory, which is the
                    # exact thing this method exists to avoid.
                    body = response.read()
                    kind = classify_sec_response(response.status_code, body) or SecError
                    raise _build(kind, response.status_code, body, url, response.headers)
                last_modified = response.headers.get("last-modified")
                etag = response.headers.get("etag")
                with archive.open_blob_writer(key, content_type=content_type, chunk=chunk) as sink:
                    for block in response.iter_bytes(chunk):
                        sink.write(block)
                        digest.update(block)
                        total += len(block)
        except httpx.HTTPError as exc:
            raise SecTransportError(f"stream failed for {url}: {type(exc).__name__}") from exc

        return {
            "key": key,
            "bytes": total,
            "sha256": digest.hexdigest(),
            "lastModified": last_modified,
            "etag": etag,
        }

    def fetch_bundle(self, cik10: str, accession: str) -> bytes:
        """The raw filing bundle, ARCHIVE FIRST.

        Reads ``edgar/filings/{cik10}/{accession}/submission.txt`` from GCS; on a
        miss, fetches it from SEC once and writes it back. This is the raw-first
        doctrine in one method: bytes are archived BEFORE anything parses them,
        so a mapping bump or an edgartools upgrade re-parses the same bytes and
        never re-hits SEC.

        With ``SEC_EGRESS=off`` a miss raises
        :class:`~app.sec.errors.SecEgressDisabled` — from :meth:`get`, before any
        socket. QA therefore parses exactly what prod archived and can prove it.
        """
        key = filing_key(cik10, accession)
        cached = archive.read_bytes(key)
        if cached is not None:
            return cached

        data = self.get(bundle_url(cik10, accession))
        archive.write_bytes(key, data, content_type=archive.BUNDLE_CONTENT_TYPE)
        return data

    # ── the retry / classification loop ────────────────────────────────────

    def _request(self, method: str, url: str, *, timeout: float) -> httpx.Response:
        attempt = 0
        while True:
            attempt += 1
            self._before_request(url)
            try:
                response = self._http().request(method, url, timeout=timeout)
            except httpx.HTTPError as exc:
                # TYPE only, never the exception object: httpx puts the Request
                # on it, and a rendered request carries every header we sent.
                error: SecError = SecTransportError(f"{method} {url} failed: {type(exc).__name__}")
            else:
                kind = classify_sec_response(response.status_code, response.content)
                if kind is None:
                    return response
                error = _build(kind, response.status_code, response.content, url, response.headers)

            if isinstance(error, SecRateLimited):
                # Once, and then stop. Not a retry: the block is measured at
                # SEC's edge across every process we run, so the only useful
                # contribution this one can make is to go quiet.
                cooldown = max(RATE_LIMIT_COOLDOWN_SECONDS, error.retry_after or 0.0)
                logger.warning(
                    "SEC rate block; sleeping once then stopping",
                    extra={"url": url, "cooldownSeconds": cooldown},
                )
                self._sleep(cooldown)
                raise error

            if isinstance(error, SecTransportError) and attempt < MAX_ATTEMPTS:
                delay = self._backoff(attempt)
                logger.info(
                    "retrying SEC request",
                    extra={"url": url, "attempt": attempt, "delaySeconds": delay},
                )
                self._sleep(delay)
                continue

            raise error

    def _backoff(self, attempt: int) -> float:
        """1, 2, 4, 8, 16 s with jitter, capped.

        Jittered because every Cloud Run instance and both bulk jobs share one
        upstream: a fixed ladder synchronises their retries into a burst against
        a host that is already unhappy.
        """
        base = min(BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)), BACKOFF_CAP_SECONDS)
        return base * (0.5 + self._jitter())


def _build(
    kind: type[SecError],
    status: int,
    body: bytes,
    url: str,
    headers: httpx.Headers | None = None,
) -> SecError:
    message = f"{status} from {url}: {body_excerpt(body)}"
    if kind is SecRateLimited:
        retry_after = _float_or_none(headers.get("retry-after")) if headers else None
        return SecRateLimited(message, retry_after=retry_after)
    return kind(message)


def _int_or_none(raw: str | None) -> int | None:
    try:
        return int(raw) if raw is not None else None
    except ValueError:
        return None


def _float_or_none(raw: str | None) -> float | None:
    """``Retry-After`` in seconds. The HTTP-date form reads as absent.

    Absent is safe: the cooldown floors at SEC's documented 600 s either way, and
    a header value is only ever allowed to make the wait LONGER.
    """
    try:
        return float(raw) if raw is not None else None
    except ValueError:
        return None
