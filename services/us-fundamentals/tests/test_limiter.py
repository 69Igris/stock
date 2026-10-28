"""The shared limiter's FAIL-CLOSED contract, without a Redis server.

What is covered here: every failure path, the edgartools injection, and the
structural guarantee that no in-memory fallback exists. What is NOT covered here
is the only thing a fake cannot show — that four SEPARATE PROCESSES share one
budget. That is :mod:`tests.test_limiter_load`, which needs a real server, and
this file deliberately does not pretend to stand in for it.

The Redis client is faked at the SOCKET boundary only: the real
:class:`~pyrate_limiter.RedisBucket`, the real :class:`~pyrate_limiter.Limiter`
and the real :func:`install_shared_limiter` all run.
"""

from __future__ import annotations

import ast
import inspect
from math import floor
from time import monotonic, time
from typing import Any

import pytest
from pyrate_limiter import InMemoryBucket, RedisBucket
from redis.exceptions import ConnectionError as RedisConnectionError

from app.sec import limiter as limiter_module
from app.sec.errors import LimiterUnavailable
from app.sec.limiter import (
    install_shared_limiter,
    installed_limiter,
    shared_bucket,
    try_acquire,
)

SCRIPT_HASH = "0123456789abcdef0123456789abcdef01234567"


class FakeRedis:
    """The four calls ``RedisBucket`` makes, and a switch to break any of them."""

    def __init__(self, *, fail_on: str | None = None) -> None:
        self.fail_on = fail_on
        self.calls: list[str] = []
        self.trims: list[tuple[object, ...]] = []

    def _maybe_fail(self, what: str) -> None:
        self.calls.append(what)
        if self.fail_on == what:
            raise RedisConnectionError(f"Error 61 connecting to redis:6379 ({what})")

    def ping(self) -> bool:
        self._maybe_fail("ping")
        return True

    def script_load(self, _script: str) -> str:
        self._maybe_fail("script_load")
        return SCRIPT_HASH

    def zremrangebyscore(self, *args: object, **_kw: object) -> int:
        self._maybe_fail("zremrangebyscore")
        self.trims.append(args)
        return 0

    def evalsha(self, *_args: object, **_kw: object) -> int:
        self._maybe_fail("evalsha")
        return -1  # -1 = "it fitted"


@pytest.fixture(autouse=True)
def _clean_process_state() -> Any:
    """No installed limiter leaks between tests — or into the client tests."""
    limiter_module.reset_installed_limiter()
    yield
    limiter_module.reset_installed_limiter()


# ── Install: fail closed on every path ──────────────────────────────────────


def test_no_redis_url_means_no_sec_calls() -> None:
    with pytest.raises(LimiterUnavailable, match="REDIS_URL"):
        install_shared_limiter(None, 9)
    with pytest.raises(LimiterUnavailable):
        install_shared_limiter("", 9)
    assert installed_limiter() is None


def test_a_nonsense_rate_is_refused() -> None:
    with pytest.raises(LimiterUnavailable):
        install_shared_limiter("redis://localhost:6379", 0, redis_client=FakeRedis())
    assert installed_limiter() is None


def test_redis_unreachable_at_INSTALL_raises_and_installs_nothing() -> None:
    fake = FakeRedis(fail_on="ping")

    with pytest.raises(LimiterUnavailable, match="unreachable at install"):
        install_shared_limiter("redis://down:6379", 9, redis_client=fake)

    # The important half: no half-installed limiter is left behind for the next
    # caller to find and trust.
    assert installed_limiter() is None
    assert fake.calls == ["ping"]


def test_a_bucket_that_cannot_be_built_raises_and_installs_nothing() -> None:
    fake = FakeRedis(fail_on="script_load")

    with pytest.raises(LimiterUnavailable, match="Redis bucket"):
        install_shared_limiter("redis://down:6379", 9, redis_client=fake)

    assert installed_limiter() is None


def test_the_LIBRARY_leaker_is_never_scheduled() -> None:
    """The library's background leaker over-admits, so we do not run it.

    ``leak_bound`` is ``now - interval`` and ``ZREMRANGEBYSCORE`` is inclusive of
    it, while the admission script counts ``ZCOUNT(key, now - interval, now)`` —
    inclusive of the SAME edge. The leaker therefore deletes the entry the
    counter would still have counted. MEASURED at 10 admissions in a rolling
    second against a budget of 9 (tests/test_limiter_load.py, 800 requests).
    """
    fake = FakeRedis()
    limiter = install_shared_limiter(
        "redis://localhost:6379", 9, redis_client=fake, inject_edgartools=False
    )

    # `BucketFactory.get_buckets()` is populated by the leaker registration and
    # by nothing else, so an empty list is the public evidence that no leak was
    # scheduled. And installing must not have pruned anything by itself.
    assert limiter.buckets() == []
    assert fake.trims == []


def test_OUR_trim_uses_a_bound_the_counter_can_no_longer_see() -> None:
    fake = FakeRedis()
    install_shared_limiter(
        "redis://localhost:6379",
        9,
        "sec:ratelimit:trim",
        redis_client=fake,
        inject_edgartools=False,
    )

    before_ms = time() * 1000
    try_acquire()
    after_ms = time() * 1000

    assert len(fake.trims) == 1, "the first acquire in a process prunes"
    key, low, high = fake.trims[0]
    assert key == "sec:ratelimit:trim"
    assert low == 0

    # Two full intervals back. Anything newer than one interval is still inside
    # a window some process may be counting.
    #
    # BOUNDED ON BOTH SIDES, and that is the fix for a real flake (~1 run in 5).
    # The bound is derived from `bucket.now()`, which is read INSIDE
    # `try_acquire()` and returns INTEGER milliseconds. `before_ms` is a float
    # read BEFORE the call. A one-sided `high <= before_ms - 2000` therefore
    # holds only while both reads land in the same millisecond: cross a
    # boundary and the integer read rounds UP past the float, by up to 1 ms.
    #
    # The honest statement is that the bound is `floor(t) - 2000` for some t
    # between the two reads — so assert exactly that. The lower side is what
    # gives the test teeth: without it, trimming at `now - 1000` (the library's
    # own off-by-one, the thing this test exists to reject) would still pass.
    assert floor(before_ms) - 2 * 1000 <= float(high) <= after_ms - 2 * 1000


def test_the_trim_is_not_run_on_every_single_acquire() -> None:
    fake = FakeRedis()
    install_shared_limiter("redis://localhost:6379", 9, redis_client=fake, inject_edgartools=False)

    for _ in range(5):
        try_acquire()

    # One prune (the process's first), not five: a ZREMRANGEBYSCORE per request
    # would double the round trips the limiter costs for no benefit.
    assert len(fake.trims) == 1


def test_a_failing_trim_does_not_reject_a_request_the_budget_ALLOWED() -> None:
    fake = FakeRedis()
    install_shared_limiter("redis://localhost:6379", 9, redis_client=fake, inject_edgartools=False)
    fake.fail_on = "zremrangebyscore"

    # The admission already succeeded; failing here would discard it. A genuinely
    # dead Redis is caught by the NEXT acquire, which fails closed.
    try_acquire()

    fake.fail_on = "evalsha"
    with pytest.raises(LimiterUnavailable):
        try_acquire()


def test_a_bad_redis_url_fails_closed_rather_than_falling_back() -> None:
    with pytest.raises(LimiterUnavailable):
        install_shared_limiter("not-a-redis-url", 9)
    assert installed_limiter() is None


# ── Install: the success path is Redis-backed, and provably so ──────────────


def test_a_successful_install_holds_a_REDIS_bucket_not_an_in_memory_one() -> None:
    limiter = install_shared_limiter(
        "redis://localhost:6379",
        9,
        "sec:ratelimit:test",
        redis_client=FakeRedis(),
        inject_edgartools=False,
    )

    bucket = shared_bucket(limiter)
    assert isinstance(bucket, RedisBucket)
    assert not isinstance(bucket, InMemoryBucket)
    assert bucket.bucket_key == "sec:ratelimit:test"
    assert [(r.limit, r.interval) for r in bucket.rates] == [(9, 1000)]
    assert installed_limiter() is limiter


def test_the_default_bucket_key_is_shared_by_construction() -> None:
    limiter = install_shared_limiter(
        "redis://localhost:6379", 9, redis_client=FakeRedis(), inject_edgartools=False
    )
    assert shared_bucket(limiter).bucket_key == "sec:ratelimit"


def test_an_in_memory_bucket_is_REJECTED_even_if_something_hands_one_over(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The regression this guards: a future edit that goes back to
    # `Limiter(Rate(...))`, which silently builds an InMemoryBucket. Behaviour
    # inside one process is identical; the fleet then runs at 9 x N.
    class SneakyBucket:
        @staticmethod
        def init(rates: list[Any], _redis: Any, _key: str) -> InMemoryBucket:
            return InMemoryBucket(rates)

    monkeypatch.setattr(limiter_module, "RedisBucket", SneakyBucket)

    with pytest.raises(LimiterUnavailable, match="in-process budget"):
        install_shared_limiter(
            "redis://localhost:6379", 9, redis_client=FakeRedis(), inject_edgartools=False
        )
    assert installed_limiter() is None


def test_the_module_never_MENTIONS_an_in_memory_bucket_in_code() -> None:
    # Structural, and it survives a rename of the fallback: walk the AST and
    # assert no identifier named InMemoryBucket is referenced anywhere. Comments
    # and the docstring (which discuss it at length) are invisible to the parser,
    # which is exactly the distinction that matters.
    tree = ast.parse(inspect.getsource(limiter_module))
    names = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)} | {
        node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)
    }
    assert "InMemoryBucket" not in names


# ── Acquire ─────────────────────────────────────────────────────────────────


def test_acquire_with_no_limiter_installed_raises_rather_than_letting_a_request_out() -> None:
    with pytest.raises(LimiterUnavailable, match="install_shared_limiter"):
        try_acquire()


def test_acquire_consumes_the_shared_budget() -> None:
    fake = FakeRedis()
    install_shared_limiter("redis://localhost:6379", 9, redis_client=fake, inject_edgartools=False)

    try_acquire()
    try_acquire(weight=2)

    assert fake.calls.count("evalsha") == 2


def test_redis_going_down_AT_ACQUIRE_raises_LimiterUnavailable() -> None:
    fake = FakeRedis()
    install_shared_limiter("redis://localhost:6379", 9, redis_client=fake, inject_edgartools=False)
    fake.fail_on = "evalsha"

    with pytest.raises(LimiterUnavailable, match="unreachable at acquire"):
        try_acquire()


def test_a_weight_that_can_never_fit_is_refused_IMMEDIATELY() -> None:
    # Arithmetically impossible from the first attempt, so it must not enter the
    # poll loop and spin until the timeout.
    install_shared_limiter(
        "redis://localhost:6379", 9, redis_client=FakeRedis(), inject_edgartools=False
    )

    started = monotonic()
    with pytest.raises(LimiterUnavailable, match="cannot fit in the rate"):
        try_acquire(weight=99)
    assert monotonic() - started < 1.0


def test_a_saturated_budget_TIMES_OUT_rather_than_blocking_forever() -> None:
    # A handler that waits indefinitely blows through Pub/Sub's 600 s ack
    # deadline, and the redelivery competes for the same budget.
    class NeverFits:
        def try_acquire(self, _name: str, weight: int = 1, blocking: bool = True) -> bool:
            return False

    started = monotonic()
    with pytest.raises(LimiterUnavailable, match="saturated"):
        try_acquire(limiter=NeverFits(), timeout=0.05)  # type: ignore[arg-type]
    assert monotonic() - started < 5.0


def test_every_attempt_is_NON_BLOCKING_so_the_timestamp_is_re_read_each_time() -> None:
    """Pins the fix for a MEASURED over-admission.

    ``Limiter.try_acquire(blocking=True)`` re-puts the same ``RateItem`` with
    ``item.timestamp += delay`` — a predicted stamp that drifts behind the clock
    — and the bucket's ``ZCOUNT`` window then misses inserts made after it. Four
    processes on one 9/s bucket delivered 11 requests in a second that way
    (tests/test_limiter_load.py, 2026-08-29). Polling with ``blocking=False``
    re-stamps from ``bucket.now()`` on every attempt.
    """
    attempts: list[dict[str, object]] = []

    class Recording:
        def try_acquire(self, name: str, weight: int = 1, blocking: bool = True) -> bool:
            attempts.append({"name": name, "weight": weight, "blocking": blocking})
            return len(attempts) >= 3

    try_acquire(limiter=Recording(), timeout=5.0)  # type: ignore[arg-type]

    assert len(attempts) == 3, "a refusal must be retried, not accepted"
    assert all(attempt["blocking"] is False for attempt in attempts)


# ── edgartools injection ────────────────────────────────────────────────────


class FakeHttpMgr:
    def __init__(self) -> None:
        self.rate_limiter: Any = "the library's own InMemoryBucket limiter"
        self.closes = 0

    def close(self) -> None:
        self.closes += 1


def _install_fake_edgar(monkeypatch: pytest.MonkeyPatch, mgr: Any) -> None:
    import sys
    import types

    edgar = types.ModuleType("edgar")
    httpclient = types.ModuleType("edgar.httpclient")
    httpclient.HTTP_MGR = mgr  # type: ignore[attr-defined]
    edgar.httpclient = httpclient  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "edgar", edgar)
    monkeypatch.setitem(sys.modules, "edgar.httpclient", httpclient)


def test_the_library_limiter_is_replaced_AND_its_cached_client_is_dropped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mgr = FakeHttpMgr()
    _install_fake_edgar(monkeypatch, mgr)

    limiter = install_shared_limiter("redis://localhost:6379", 9, redis_client=FakeRedis())

    assert mgr.rate_limiter is limiter
    # close() is not optional. HttpxThrottleCache caches ONE httpx.Client whose
    # transport chain was built around the OLD limiter; without the close the
    # assignment above is a no-op that reads as a success.
    assert mgr.closes == 1
    assert limiter_module.edgartools_injected() is True


def test_a_library_that_cannot_be_injected_is_a_HARD_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Unwritable:
        __slots__ = ()

        @property
        def rate_limiter(self) -> Any:
            return None

    _install_fake_edgar(monkeypatch, Unwritable())

    # Present-but-unpatchable means edgartools keeps its own 9 req/s alongside
    # ours: 18 at SEC's edge. Refusing to start is the only safe answer.
    with pytest.raises(LimiterUnavailable, match="could not be replaced"):
        install_shared_limiter("redis://localhost:6379", 9, redis_client=FakeRedis())


def test_a_missing_edgartools_is_reported_not_assumed(monkeypatch: pytest.MonkeyPatch) -> None:
    import builtins

    real_import = builtins.__import__

    def no_edgar(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == "edgar" or name.startswith("edgar."):
            raise ImportError("no module named edgar")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_edgar)

    install_shared_limiter("redis://localhost:6379", 9, redis_client=FakeRedis())

    # Our own client is still limited; /health surfaces this flag so an operator
    # can tell "not installed" from "installed and unmanaged".
    assert limiter_module.edgartools_injected() is False


def test_injection_can_be_skipped_explicitly() -> None:
    install_shared_limiter(
        "redis://localhost:6379", 9, redis_client=FakeRedis(), inject_edgartools=False
    )
    assert limiter_module.edgartools_injected() is False


def test_the_real_edgartools_still_exposes_the_attributes_we_assign() -> None:
    """Pins the library contract the fake above stands in for.

    The fake proves OUR code assigns and closes. This proves the two names it
    assigns still exist on edgartools 5.53.0 — the half a fake can never check,
    and the half that a silent library upgrade breaks.
    """
    httpclient = pytest.importorskip("edgar.httpclient")

    mgr = httpclient.HTTP_MGR
    original = mgr.rate_limiter
    try:
        assert hasattr(mgr, "rate_limiter")
        assert callable(mgr.close)
        mgr.rate_limiter = "sentinel"
        assert mgr.rate_limiter == "sentinel"
    finally:
        mgr.rate_limiter = original
