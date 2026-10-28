"""ONE 9 req/s budget for sec.gov, shared by every process — MONEY-979.

## The problem this solves, stated exactly

SEC's fair-access policy is **10 requests per second per requester**, measured at
their edge across everything we run. edgartools 5.53.0 paces itself to 9 req/s
using a ``pyrate_limiter`` ``Limiter`` over an **InMemoryBucket**, built per
process (``httpclient.py:196-221``). That is not a distributed limiter and was
never meant to be: N Cloud Run instances plus a bulk job plus a backfill job is
9N req/s at SEC, and every one of those processes logs a blameless 9 req/s.

So the mechanism is ours. One Redis-backed bucket, one key, every process:

* :func:`install_shared_limiter` builds it and **injects it into edgartools** by
  assigning ``edgar.httpclient.HTTP_MGR.rate_limiter``. ``HTTP_MGR`` is looked up
  at CALL time by ``http_client()`` and no module captures it, so the assignment
  takes effect for the whole library — but the already-built ``httpx.Client``
  holds a transport constructed around the OLD limiter, so ``HTTP_MGR.close()``
  must follow to force a rebuild. Without that call the injection is a no-op
  that reads as a success.
* :func:`try_acquire` is what OUR client calls, against the SAME
  :class:`~pyrate_limiter.Limiter` object, so the two paths cannot each get 9.

## Fail CLOSED, and never an in-memory fallback

If Redis is unreachable — at install or at acquire — we raise
:class:`~app.sec.errors.LimiterUnavailable` and stop calling SEC. We do NOT fall
back to an in-process bucket. That fallback is attractive (the run continues!)
and is precisely how an IP gets blocked, because the failure is invisible: each
instance would still pace at a virtuous-looking 9 req/s. A stopped run is a
paged operator; an unshared limiter is a 10-minute block on every environment we
own, arriving days later with no way to attribute it.

## Two `pyrate_limiter` behaviours we deliberately do NOT use

Both were found by ``tests/test_limiter_load.py`` (four processes, 800 requests,
a real Redis) and neither is visible in a single-process test or a short run.
Each is documented at the function that replaces it:

* **Blocking acquire drifts.** ``Limiter.try_acquire(blocking=True)`` re-puts the
  same ``RateItem`` with a PREDICTED timestamp instead of re-reading the clock,
  so the counting window falls behind real time and admits on a stale count.
  MEASURED at a sustained 9.4/s with FIXED per-second buckets of 10, 10, 11 and
  10 against a budget of 9. See :func:`try_acquire`, which polls with
  ``blocking=False``.
* **The background leaker over-admits.** Its delete bound and the admission
  script's count window share an inclusive edge, so it removes exactly the entry
  the counter would still have counted. See :func:`_maybe_trim`, which prunes one
  interval further back and needs no thread.

One residual is NOT fixed and is documented rather than hidden: the item is
stamped in this process and checked one round trip later, so a concurrent insert
can be invisible to it. MEASURED at 9 in every rolling second on four of five
800-request runs and 10 on the fifth — never above SEC's ceiling of 10, which is
what the 9-vs-10 headroom is for. :func:`try_acquire` has the mechanism and the
two ways to close it.

## HOW THIS GETS INSTALLED, and the audit that found it was not (MONEY-979)

The limiter is a PROCESS-LOCAL global. Nothing installs it implicitly, so every
process that can reach sec.gov installs its own:

* the **service** — a FastAPI `lifespan` in `app/main.py`, which covers every
  push handler (detect, the five parsers, evict) because they all run in that
  process. A failure there logs loudly and does NOT abort the boot: the limiter
  fails closed at acquire, so refusing to start buys no safety and costs the
  diagnosis.
* each **Cloud Run job** — `install_sec_limiter()` from `app/bulk/common.py`,
  called by all five `main()` entry points. A job is its own process and shares
  nothing with the service. Failure there IS fatal: a job exists only to fetch.

`tests/test_limiter_is_installed.py` holds both halves down by reading the
source of every module that constructs a `SecClient` and asserting the install
is CALLED, not merely imported.

That test exists because of what an audit found on 2026-08-29: this function was
written, unit-tested from nine angles, and **called from nowhere in `app/`** —
every call site was in `tests/`. Recorded because of how it would have
presented rather than because it is still true. `LimiterUnavailable` is a
`SecError`, and `run_parse_job` classifies every non-transport `SecError` as a
DETERMINISTIC upstream refusal — ACK, count a `transportFailure`, drop the
message. Correct for a real refusal and exactly wrong for this one:
`edgar-detect` would have died on its first `getcurrent` and every parse whose
bundle was not already archived would have ACKed having written nothing,
minutely, reporting a tidy `selected 1, written 0`. `/health` agreed with it,
deriving `redis-shared` from `REDIS_URL` merely being SET — true in precisely
the broken state.

Recorded here because it is the kind of gap that reads as working code. As of
2026-08-29 the only call sites in the tree are `tests/`: there is no FastAPI
`lifespan` or `on_event("startup")` in `app/main.py`, and no job or bulk module
installs it either. So in a deployed process `_installed` is `None` and the FIRST
`try_acquire` raises

    LimiterUnavailable("no shared SEC limiter installed in this process; ...")

`LimiterUnavailable` is a `SecError` and `run_parse_job` classifies every
non-transport `SecError` as a DETERMINISTIC upstream refusal — ACK, count a
`transportFailure`, drop the message. Which is the correct handling for a real
refusal and exactly wrong for this one: `edgar-detect` would die on its first
`getcurrent` and every parse whose bundle is not already archived would ACK
having written nothing, minutely, reporting a tidy `selected 1, written 0`.

Two things have to be true before the first run, and neither is code in this
module:

1. A deployed process must CALL `install_shared_limiter(settings.redis_url(),
   settings.sec_rate_limit_per_sec())` — the service at startup, and each Cloud
   Run job at entry (they are separate processes and share nothing).
2. `/health` must report the INSTALLED limiter, not the configured intent.
   `app/main.py` currently answers `"mode": "redis-shared" if
   settings.redis_url() else "unconfigured"` — derived from a variable being SET.
   That is true in precisely the broken state above, so T16's preflight
   assertion ("`/health.limiter` is redis, not in-memory, not unavailable")
   cannot fail on it. :func:`installed_limiter` and :func:`edgartools_injected`
   exist to be reported instead; `redis.ok` in the same payload is the separate
   fact that the wire works.

## Clock skew is a real dependency of the bucket

``RedisBucket.now()`` is ``time.time_ns() // 1e6`` — the LOCAL clock of whichever
process is inserting, not Redis's. Two instances whose clocks differ by ``d`` ms
share a budget that behaves as if the window were ``1000 + d`` ms wide. Cloud Run
instances are NTP-synced (single-digit ms), so the effect is far inside the 1
req/s of headroom we already hold back from SEC's ceiling of 10. It is worth
knowing before someone runs this on a fleet that is not NTP-synced.
"""

from __future__ import annotations

import logging
from random import random
from time import monotonic, sleep
from typing import Any

from pyrate_limiter import Duration, Limiter, Rate, RedisBucket, SingleBucketFactory

from .errors import LimiterUnavailable

logger = logging.getLogger(__name__)

#: The Redis key every process shares. Changing it splits the budget in two,
#: which is the one thing this module exists to prevent — so it is a constant,
#: overridable only by an explicit argument (the load test uses a unique key so
#: it cannot collide with a real one).
BUCKET_KEY = "sec:ratelimit"

#: Item name handed to ``Limiter.try_acquire``. With a single-bucket factory the
#: name does NOT select a bucket (``SingleBucketFactory.get`` ignores it), so
#: edgartools' own item name — ``"httpxthrottlecache.ratelimiter"`` — and ours
#: land in the same bucket. Kept distinct anyway: it is the only trace of which
#: caller consumed a slot.
ITEM_NAME = "sec"

#: Redis socket timeouts. A limiter that blocks forever on a half-open
#: connection is a stalled job, and Pub/Sub redelivers a job that runs past its
#: ack deadline — so a hung acquire manufactures duplicate work. Short, and
#: failure is loud.
SOCKET_TIMEOUT_SECONDS = 5.0

#: How often a refused acquire re-asks, and the jitter that keeps N instances
#: from waking in lockstep. 20 ms against a 111 ms slot spacing at 9/s: small
#: enough not to waste the budget, large enough that four processes polling cost
#: Redis ~200 trivial EVALSHAs a second.
POLL_INTERVAL_SECONDS = 0.02
POLL_JITTER_SECONDS = 0.01

#: A single acquire never waits longer than this. Pub/Sub's ack deadline is
#: 600 s and a handler that overruns it gets REDELIVERED — a second copy of the
#: same job, competing for the same budget. Failing loudly at 120 s is the
#: cheaper end of that trade.
ACQUIRE_TIMEOUT_SECONDS = 120.0

#: How often a process prunes the shared sorted set. See :func:`_maybe_trim`.
#: Either condition triggers it, so a process that makes only a handful of
#: requests still prunes and one that makes thousands does not prune on each.
TRIM_EVERY_ACQUIRES = 200
TRIM_INTERVAL_SECONDS = 60.0

_installed: Limiter | None = None
_acquires_since_trim = 0
_last_trim_at = 0.0
_edgartools_injected = False
_redis_error_types: tuple[type[BaseException], ...] | None = None


def install_shared_limiter(
    redis_url: str | None,
    per_sec: int,
    bucket_key: str = BUCKET_KEY,
    *,
    redis_client: Any | None = None,
    inject_edgartools: bool = True,
) -> Limiter:
    """Build the shared limiter, install it into edgartools, and return it.

    Raises :class:`~app.sec.errors.LimiterUnavailable` for every failure —
    missing URL, missing driver, unreachable server, unusable bucket. There is no
    success path that does not end with a Redis-backed bucket.
    """
    global _installed, _edgartools_injected

    if not redis_url and redis_client is None:
        raise LimiterUnavailable(
            "REDIS_URL is not set; refusing to call SEC without a shared rate limiter"
        )
    if per_sec < 1:
        raise LimiterUnavailable(f"rate limit must be >= 1 req/s, got {per_sec}")

    client = redis_client if redis_client is not None else _connect(redis_url)

    try:
        client.ping()
    except Exception as exc:  # every driver failure means the same thing here
        raise LimiterUnavailable(f"Redis unreachable at install: {describe(exc)}") from exc

    try:
        bucket = RedisBucket.init([Rate(per_sec, Duration.SECOND)], client, bucket_key)
        # schedule_leak=False: the library's leaker OVER-ADMITS. See _maybe_trim().
        limiter = Limiter(SingleBucketFactory(bucket, schedule_leak=False))
    except Exception as exc:
        raise LimiterUnavailable(f"could not build the Redis bucket: {type(exc).__name__}") from exc

    # Paranoia with a reason: `Limiter(rates)` and `Limiter(rate)` are legal
    # constructor forms that build an in-process bucket internally and log about
    # it at INFO. If this call ever regressed to one of those, every assertion in
    # this module would still pass and the fleet would quietly run at 9N req/s.
    # So the built limiter is asked what it actually holds — the OBJECT and the
    # TYPE, because a wrong bucket of the right identity is the same outage.
    adopted = shared_bucket(limiter)
    if adopted is not bucket or not isinstance(adopted, RedisBucket):
        raise LimiterUnavailable(
            "limiter did not adopt the Redis bucket; refusing to run on an in-process budget"
        )

    _installed = limiter
    _edgartools_injected = False
    if inject_edgartools:
        _edgartools_injected = _inject_into_edgartools(limiter)

    logger.info(
        "shared SEC limiter installed",
        extra={
            "bucketKey": bucket_key,
            "perSec": per_sec,
            "edgartoolsInjected": _edgartools_injected,
        },
    )
    return limiter


def installed_limiter() -> Limiter | None:
    """The limiter this process installed, or ``None``."""
    return _installed


def edgartools_injected() -> bool:
    """Whether the last install actually replaced edgartools' in-process limiter.

    ``False`` is legitimate only where ``edgar`` is not importable at all (unit
    tests, a job that never touches the library). In a deployed process it means
    edgartools is still pacing itself independently, and ``/health`` reports it.
    """
    return _edgartools_injected


def reset_installed_limiter() -> None:
    """Forget the installed limiter and the trim schedule. Tests and post-fork children only."""
    global _installed, _edgartools_injected, _acquires_since_trim, _last_trim_at
    _installed = None
    _edgartools_injected = False
    _acquires_since_trim = 0
    _last_trim_at = 0.0


def shared_bucket(limiter: Limiter) -> Any | None:
    """The single bucket behind a limiter, for inspection.

    Exposed so a test can assert the TYPE — the difference between a shared
    budget and a per-process one is invisible in behaviour until it is measured
    at SEC's edge, and by then it is a block.

    Total by design: it answers ``None`` for any limiter that does not hold a
    single bucket, rather than raising. Every caller treats ``None`` as "not the
    bucket we built", which keeps the install guard strict while letting this be
    safe to call on an arbitrary limiter-like object.
    """
    return getattr(getattr(limiter, "bucket_factory", None), "bucket", None)


def try_acquire(
    weight: int = 1,
    *,
    name: str = ITEM_NAME,
    limiter: Limiter | None = None,
    timeout: float = ACQUIRE_TIMEOUT_SECONDS,
) -> None:
    """Consume ``weight`` from the shared budget, waiting until it is available.

    Returns ``None`` on success and raises :class:`LimiterUnavailable` otherwise
    — never ``False``. A boolean return is a value a caller can ignore, and the
    one thing that must not happen is a request going out on a failed acquire.

    ## Why this polls instead of using the library's blocking mode

    MEASURED, 2026-08-29, by ``tests/test_limiter_load.py``: with
    ``Limiter.try_acquire(blocking=True)`` across four processes on ONE Redis
    bucket rated 9/s, the fake SEC server's FIXED per-second histogram read
    ``{9, 10, 10, 11, 10, 9, 9, 9, 3}`` — a sustained 9.4/s. Over SEC's ceiling
    of 10, from a budget of 9, and not a boundary artifact: fixed buckets, four
    consecutive seconds above the limit.

    The cause is in ``Limiter._delay_waiter``: on a refusal it sleeps and then
    re-puts the SAME ``RateItem`` with ``item.timestamp += delay`` — a PREDICTED
    timestamp, never re-read from the clock. Sleep overshoot plus the Redis round
    trip make the recorded score drift behind real time, and the bucket's Lua
    counts ``ZCOUNT(key, ts - interval, ts)``: an item whose ``ts`` lags does not
    see inserts stamped after it, so it is admitted on a stale count. The drift
    accumulates across retries and grows with contention — exactly the
    fleet-shaped case.

    Polling with ``blocking=False`` re-enters ``wrap_item`` on every attempt, so
    each attempt carries a fresh ``bucket.now()`` and the drift cannot
    accumulate. A refused attempt inserts NOTHING (the script returns before its
    ``ZADD``), so polling costs a round trip and never a slot.

    ## What this does NOT fix, stated plainly

    ``wrap_item`` stamps the item in THIS process and the atomic check runs one
    round trip later, so an item another process inserts during that gap carries
    a LATER score and is therefore outside our window ``[ts - 1000, ts]`` — we
    can be admitted against a count that is already full. The excess is one
    admission per such inversion.

    MEASURED at this scale: five runs of 800 requests through four processes,
    read back from the bucket's own timestamps — four runs held **exactly 9** in
    every rolling second, one reached **10**. Never above SEC's ceiling of 10,
    which is the reason the budget is 9 rather than 10.

    Closing it properly means stamping inside Redis (our own Lua, using server
    ``TIME``) or holding a distributed lock across wrap-and-put — a new
    correctness surface either way, and out of scope here. It is written down
    rather than left to be rediscovered.
    """
    active = limiter if limiter is not None else _installed
    if active is None:
        raise LimiterUnavailable(
            "no shared SEC limiter installed in this process; call install_shared_limiter() first"
        )

    _reject_impossible_weight(active, weight)

    deadline = monotonic() + timeout
    while True:
        try:
            acquired = active.try_acquire(name, weight=weight, blocking=False)
        except _redis_errors() as exc:
            raise LimiterUnavailable(f"Redis unreachable at acquire: {describe(exc)}") from exc

        if acquired:
            _maybe_trim(active)
            return
        if monotonic() >= deadline:
            # Not a soft failure: a job that cannot get a slot in two minutes is
            # a job whose Pub/Sub message is heading for its 600 s ack deadline,
            # and a redelivery would add a SECOND copy to the same contention.
            raise LimiterUnavailable(
                f"could not acquire a SEC slot within {timeout:.0f}s; the shared budget is saturated"
            )
        # Jittered so four instances that were refused together do not wake in
        # lockstep and race for the one slot that freed.
        sleep(POLL_INTERVAL_SECONDS + random() * POLL_JITTER_SECONDS)


def _maybe_trim(limiter: Limiter) -> None:
    """Drop entries the window can no longer see. OURS, because the library's is wrong.

    The bucket is a Redis sorted set that only ever grows: the Lua script adds a
    member per admitted request and removes nothing. Something has to prune it —
    9 req/s is ~777k members a day.

    ``pyrate_limiter``'s answer is a daemon thread calling
    ``bucket.leak(now)``, and it OVER-ADMITS. ``leak_bound`` is ``now -
    interval`` and ``ZREMRANGEBYSCORE`` is inclusive of that bound, while the
    admission script counts ``ZCOUNT(key, now - interval, now)`` — also inclusive
    of the same edge. So the leaker deletes exactly the entry the counter would
    still have counted, and the next request in that millisecond sees 8 instead
    of 9 and is let through.

    That reading is from the SOURCE, not from a measurement: the leaker fires
    every 10 s, so reproducing it needs a tick that lands on a boundary
    millisecond, and the load test's separate client-stamp race (see
    :func:`try_acquire`) produces an indistinguishable +1. The defect is an
    off-by-one either way, and the fix costs nothing.

    Ours trims at ``now - 2 * interval`` (by handing ``leak()`` a timestamp one
    interval in the past), which is strictly older than anything any window can
    still count. No thread either: one fewer daemon per process, and one fewer
    thing to leave running after a test.
    """
    global _acquires_since_trim, _last_trim_at

    _acquires_since_trim += 1
    now = monotonic()
    if _acquires_since_trim < TRIM_EVERY_ACQUIRES and now - _last_trim_at < TRIM_INTERVAL_SECONDS:
        return
    _acquires_since_trim = 0
    _last_trim_at = now

    bucket = shared_bucket(limiter)
    rates = getattr(bucket, "rates", None)
    if not bucket or not rates:
        return
    widest = max(rate.interval for rate in rates)
    try:
        bucket.leak(bucket.now() - widest)
    except _redis_errors() as exc:
        # The admission this trim followed already succeeded, so failing here
        # would reject a request the budget had authorised. If Redis is really
        # gone, the NEXT acquire fails closed, which is the correct place for it.
        logger.debug("limiter trim skipped: %s", type(exc).__name__)


def _reject_impossible_weight(limiter: Limiter, weight: int) -> None:
    """A weight above the whole per-second rate can never fit; say so immediately.

    Without this the poll loop would spin until its timeout for a request that
    was arithmetically impossible from the first attempt.
    """
    if weight < 1:
        raise LimiterUnavailable(f"limiter refused weight {weight}; it must be >= 1")
    bucket = shared_bucket(limiter)
    rates = getattr(bucket, "rates", None)
    if rates and weight > min(rate.limit for rate in rates):
        raise LimiterUnavailable(f"limiter refused weight {weight}; it cannot fit in the rate")


def _connect(redis_url: str | None) -> Any:
    try:
        import redis  # lazy: see the module docstring: keeps this module unit-testable
    except ImportError as exc:  # pragma: no cover - the dependency is pinned in pyproject
        raise LimiterUnavailable("the `redis` package is not installed") from exc

    try:
        return redis.Redis.from_url(
            redis_url,
            socket_timeout=SOCKET_TIMEOUT_SECONDS,
            socket_connect_timeout=SOCKET_TIMEOUT_SECONDS,
            decode_responses=False,
        )
    except Exception as exc:
        raise LimiterUnavailable(f"could not build a Redis client: {type(exc).__name__}") from exc


def describe(exc: BaseException) -> str:
    """A SAFE, greppable one-liner for why Redis did not answer.

    ## Why the type name alone was not enough (MONEY-979 T21)

    DigitalOcean's managed Redis is TLS-only (``rediss://``), and this module
    FAILS CLOSED — so a TLS problem is total SEC ingestion failure that reports
    itself as a tidy ``LimiterUnavailable``. Until this function existed that
    message read ``Redis unreachable at install: ConnectionError``, which is
    **byte-identical to a wrong port, a firewall, a down cluster and an expired
    certificate**. Those have four different fixes and one of them is not an
    outage at all.

    MEASURED against redis-py 8.1.0: a ``rediss://`` URL pointed at a
    TLS-less port raises ``redis.exceptions.ConnectionError`` whose
    ``__context__`` is ``ssl.SSLError(reason="WRONG_VERSION_NUMBER")``. The TLS
    fact is in the chain; only the top-level class name is thrown away. So this
    walks the chain and appends the reason.

    ## Only two whitelisted tokens ever leave this function

    The exception TYPE NAME and ``ssl.SSLError.reason`` — an OpenSSL constant
    like ``CERTIFICATE_VERIFY_FAILED`` or ``WRONG_VERSION_NUMBER``. NEVER
    ``str(exc)``: redis-py builds its message with ``_error_message``, and the
    house rule is that an exception's rendered text is untrusted for logging
    because httpx and google-auth both put the credentialed request inside it.
    A fixed vocabulary cannot leak a URL, a password or a header no matter what
    a future driver decides to put in its message.
    """
    import ssl

    name = type(exc).__name__
    seen: set[int] = set()
    cursor: BaseException | None = exc
    while cursor is not None and id(cursor) not in seen:
        seen.add(id(cursor))
        if isinstance(cursor, ssl.SSLError):
            reason = getattr(cursor, "reason", None)
            return f"{name}/TLS:{reason}" if reason else f"{name}/TLS"
        cursor = cursor.__cause__ or cursor.__context__
    return name


def _redis_errors() -> tuple[type[BaseException], ...]:
    """Exception classes that mean "Redis did not answer".

    Cached because it is a class lookup, not a configuration read — the values
    cannot change at runtime, which is what makes caching safe here and unsafe
    for anything read out of ``os.environ``.

    ## Both halves are load-bearing, and the surprising one is ``RedisError``

    MEASURED, redis-py 8.1.0: a TLS handshake failure arrives as
    ``redis.exceptions.ConnectionError``, which is **NOT an ``OSError``** —
    ``connect_check_health`` catches the underlying ``ssl.SSLError`` (which IS
    an ``OSError``) and re-raises it as redis's own class, whose only base is
    ``RedisError``. Narrowing this tuple to ``(OSError,)`` on the reasoning that
    "a socket failure is an OSError" would let every TLS failure ESCAPE
    ``try_acquire`` as a bare ``ConnectionError``, past the fail-closed contract
    and into the request handler as a 500 — while the in-memory tests all stayed
    green. ``tests/test_limiter_transport.py`` drives a real TLS failure so the
    narrowing goes red.
    """
    global _redis_error_types
    if _redis_error_types is None:
        try:
            from redis.exceptions import RedisError

            _redis_error_types = (RedisError, OSError)
        except ImportError:  # pragma: no cover - the dependency is pinned
            _redis_error_types = (OSError,)
    return _redis_error_types


def _inject_into_edgartools(limiter: Limiter) -> bool:
    """Replace edgartools' per-process limiter with ours. Returns whether it happened.

    Two facts make this work, both verified against edgartools 5.53.0:

    * ``HTTP_MGR`` (``httpclient.py:433``) is resolved at call time by
      ``http_client()``; nothing captures it at import, so a late assignment is
      seen by every subsequent request.
    * ``HttpxThrottleCache`` caches ONE ``httpx.Client`` whose transport chain was
      built around the limiter present at first use
      (``httpxclientmanager.py:241-243``). ``close()`` drops that client
      (``:197-200``) so the next call rebuilds the chain around ours.

    A missing ``edgar`` is not an error (unit tests, jobs that never import it).
    A PRESENT ``edgar`` that cannot be injected IS: it would keep its own 9 req/s
    alongside ours, which is 18 at SEC's edge.
    """
    try:
        from edgar import httpclient  # lazy: optional dependency
    except ImportError:
        logger.info("edgartools not importable; shared limiter applies to app.sec.client only")
        return False

    try:
        httpclient.HTTP_MGR.rate_limiter = limiter
        httpclient.HTTP_MGR.close()
    except Exception as exc:
        raise LimiterUnavailable(
            f"edgartools is installed but its limiter could not be replaced: {type(exc).__name__}"
        ) from exc
    return True
