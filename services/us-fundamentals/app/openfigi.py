"""OpenFIGI ``/v3/mapping`` — tier (d) of the CUSIP map. MONEY-979.

A SEPARATE HOST WITH A SEPARATE BUDGET. ``api.openfigi.com`` is not sec.gov and
this client must never touch :mod:`app.sec.limiter`: that limiter is a shared
9 req/s allowance protecting SEC's per-IP fair-access policy, and spending it on
Bloomberg would slow the SEC pipeline down to pay for something SEC does not
care about. This module carries its own pacer, sized from OpenFIGI's own
documented ceilings.

PACED PROACTIVELY, not reactively. Like Tiingo, OpenFIGI publishes no quota
headers, so a 429 is the only feedback and it arrives after the damage. The
pacer therefore holds the request rate below the ceiling by construction:

    with an API key      25 requests / 6 seconds,  100 jobs per request
    without one          25 requests / 60 seconds,  10 jobs per request

Which of the two applies is DETECTED from whether ``OPENFIGI_API_KEY`` resolves,
per call — never captured at import, because a module-scope read freezes before
any test or any deploy-time secret injection can change it.

THE KEY IS NEVER LOGGED. It travels in ``X-OPENFIGI-APIKEY``, which
:mod:`app.logging_setup` redacts by name; nothing here logs a response object,
a request object or an exception object, all three of which carry headers.
"""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Callable, Sequence
from typing import Any

import httpx

from app import settings
from app.logging_setup import log_error
from app.parsers.cusip_map_logic import (
    batch_size,
    build_jobs,
    chunk,
    interpret_mapping,
    rate_limit,
)

#: The one endpoint this module talks to.
MAPPING_URL = "https://api.openfigi.com/v3/mapping"

#: Header name for the key. Spelled here once so the redaction filter and the
#: request agree on the string.
API_KEY_HEADER = "X-OPENFIGI-APIKEY"

DEFAULT_TIMEOUT_SECONDS = 30.0

#: Retries are for TRANSPORT only. A 4xx from OpenFIGI is a malformed request or
#: an exhausted quota, and repeating either makes it worse.
MAX_ATTEMPTS = 3
BACKOFF_SECONDS = (1.0, 4.0)


class OpenFigiError(RuntimeError):
    """OpenFIGI could not be reached or answered with a status we cannot use."""


class RatePacer:
    """A sliding-window pacer: at most ``requests`` starts per ``per_seconds``.

    A SLIDING window, not a fixed one. A fixed window permits 25 requests at
    5.9 s and 25 more at 6.1 s — 50 inside one 6-second span, which is exactly
    the burst the ceiling exists to prevent.

    ``clock`` and ``sleep`` are injected so the pacing property can be asserted
    against a VIRTUAL clock in milliseconds. A rate limiter tested by measuring
    wall time is a rate limiter tested by a stopwatch on a loaded CI box, which
    is why the load test for the SEC limiter needed a real Redis and this one
    does not need anything at all.
    """

    def __init__(
        self,
        requests: int,
        per_seconds: float,
        *,
        clock: Callable[[], float] | None = None,
        sleep: Callable[[float], None] | None = None,
    ) -> None:
        if requests <= 0 or per_seconds <= 0:
            raise ValueError(f"nonsensical rate: {requests} per {per_seconds}s")
        self.requests = requests
        self.per_seconds = per_seconds
        self._clock = clock or time.monotonic
        self._sleep = sleep or time.sleep
        self._starts: deque[float] = deque()

    def acquire(self) -> float:
        """Block until another request may start. Returns the time it started."""
        while True:
            now = self._clock()
            while self._starts and now - self._starts[0] >= self.per_seconds:
                self._starts.popleft()
            if len(self._starts) < self.requests:
                self._starts.append(now)
                return now
            wait = self.per_seconds - (now - self._starts[0])
            # A non-positive wait would spin. The window head is strictly newer
            # than `now - per_seconds` here, so `wait` is positive; the max()
            # is belt and braces against a clock that went backwards.
            self._sleep(max(wait, 0.001))


class OpenFigiClient:
    """Maps CUSIPs to tickers. Owns its pacer; borrows nothing from the SEC path."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        http_client: httpx.Client | None = None,
        clock: Callable[[], float] | None = None,
        sleep: Callable[[float], None] | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        # Resolved PER CONSTRUCTION rather than at import, and the constructor is
        # called per run. `settings.openfigi_api_key()` reads os.environ on every
        # call for the same reason.
        self.api_key = api_key if api_key is not None else settings.openfigi_api_key()
        self.has_key = bool(self.api_key)
        self.batch_jobs = batch_size(self.has_key)
        requests_allowed, per_seconds = rate_limit(self.has_key)
        self.pacer = RatePacer(requests_allowed, per_seconds, clock=clock, sleep=sleep)
        self._timeout = timeout
        self._sleep = sleep or time.sleep
        self._client = http_client
        self._owns_client = http_client is None
        #: Counted so a run that resolved nothing because OpenFIGI was down is
        #: distinguishable from one where every CUSIP was genuinely unmapped.
        self.requests_made = 0
        self.transport_failures = 0

    def __enter__(self) -> OpenFigiClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        if self._client is not None and self._owns_client:
            self._client.close()
            self._client = None

    def headers(self) -> dict[str, str]:
        """Every header we send. The key is present only when we have one."""
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers[API_KEY_HEADER] = self.api_key
        return headers

    def _http(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=self._timeout)
        return self._client

    def map_cusips(self, cusips: Sequence[str]) -> dict[str, dict[str, Any]]:
        """CUSIP -> match, for the ones OpenFIGI knows. Misses are simply absent.

        A miss is NOT recorded as an error and does not appear in the result;
        the caller turns the difference between what it asked for and what came
        back into ``UNRESOLVED`` rows with an ``attempts`` count. Conflating the
        two here would make a delisted CUSIP look like an outage.
        """
        results: dict[str, dict[str, Any]] = {}
        for batch in chunk(list(cusips), self.batch_jobs):
            entries = self._post(build_jobs(batch))
            if entries is None:
                continue
            for cusip, entry in zip(batch, entries, strict=False):
                match = interpret_mapping(entry)
                if match is not None:
                    results[cusip] = match
        return results

    def _post(self, jobs: list[dict[str, str]]) -> list[Any] | None:
        """One paced request. ``None`` when the batch could not be delivered."""
        for attempt in range(1, MAX_ATTEMPTS + 1):
            self.pacer.acquire()
            try:
                response = self._http().post(MAPPING_URL, json=jobs, headers=self.headers())
            except httpx.HTTPError as exc:
                # TYPE only. httpx puts the Request on the exception and a
                # rendered request carries X-OPENFIGI-APIKEY.
                if attempt < MAX_ATTEMPTS:
                    # Counted AFTER the call it counts, and only once the retry
                    # ladder is exhausted — a retried blip is not a failure.
                    self._sleep(BACKOFF_SECONDS[min(attempt - 1, len(BACKOFF_SECONDS) - 1)])
                    continue
                self.transport_failures += 1
                log_error(f"OpenFIGI request failed after {attempt} attempts", exc)
                return None
            self.requests_made += 1

            if response.status_code == 200:
                try:
                    payload = response.json()
                except ValueError as exc:
                    self.transport_failures += 1
                    log_error("OpenFIGI returned a body that is not JSON", exc)
                    return None
                return payload if isinstance(payload, list) else None

            if response.status_code == 429 and attempt < MAX_ATTEMPTS:
                # Undocumented but real. The pacer should make this unreachable;
                # reaching it means the ceiling moved, so back off and say so.
                self._sleep(BACKOFF_SECONDS[min(attempt - 1, len(BACKOFF_SECONDS) - 1)])
                continue

            self.transport_failures += 1
            log_error(f"OpenFIGI answered {response.status_code} for a batch of {len(jobs)} jobs")
            return None
        return None


def resolve_batch(cusips: Sequence[str], **kwargs: Any) -> dict[str, dict[str, Any]]:
    """Convenience wrapper that owns a client for one call. Closes it."""
    with OpenFigiClient(**kwargs) as client:
        return client.map_cusips(cusips)
