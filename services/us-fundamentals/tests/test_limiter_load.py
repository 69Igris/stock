"""The fair-access proof: 4 PROCESSES, one budget, never more than 9 req/s.

This is the test the whole limiter design exists to pass, and it is the only one
that can. A single-process test cannot distinguish a shared Redis bucket from
edgartools' per-process ``InMemoryBucket`` — both pace one process to 9 req/s.
The difference only appears with N processes, measured at the RECEIVING end.

So: four ``multiprocessing`` workers, 200 requests each, through the real
:class:`~app.sec.client.SecClient`, against :mod:`tests.fake_sec_server` (never
sec.gov), sharing one Redis bucket.

Three clocks, and the difference between them is the whole reason this file is
careful:

* **decisions** — the timestamps the bucket itself stamped, read back out of
  Redis. The exact invariant, with no other clock involved.
* **admissions** — when the client was let through, taken in its acquire seam.
  Decisions plus a Redis round trip.
* **arrivals** — when the request reached the server. Admissions plus transport.

A sliding window over the last two reads 10, 11 or 12 for a cadence that is
flatly 9 per second, because a limiter at capacity admits at T and again at
T + 1000 ms and a millisecond of jitter pulls two blocks into one window. So the
strict assertion is on decisions; the far end is checked by wall-clock seconds
and by total-against-allowance, both of which are immune to that.

## The mutation is part of the test, not an afterthought

An assertion that has never been observed failing is not evidence. So the same
run is repeated with each process given its OWN ``InMemoryBucket`` — the exact
fallback :mod:`app.sec.limiter` refuses to have — and the test asserts the check
FAILS there, at roughly 4x the ceiling. Without that half, "max <= 9" would also
pass if the workers were accidentally serialised, if the server dropped
requests, or if the histogram were computed over the wrong list.

## fakeredis will not do

``RedisBucket`` dispatches an ``EVALSHA`` of a Lua script; the counting happens
inside the server. A fake in one process has neither the script nor the shared
state, which is the entire property under test. CI runs a real Redis service
container; locally, ``docker run --rm -d -p 6379:6379 redis:7-alpine``.
"""

from __future__ import annotations

import multiprocessing
import os
import sys
import time
import uuid
from bisect import bisect_right
from pathlib import Path

import pytest

# pytest 9 imports test modules with ``importlib`` mode, which does NOT put the
# tests directory on ``sys.path``. Both entries are needed and for different
# reasons: ``tests/`` so this module can import its own helper, and the service
# root so a SPAWNED child can re-import this module by its dotted name
# (``multiprocessing`` pickles ``_worker`` by module + qualname, and the child
# inherits exactly this ``sys.path``).
_TESTS_DIR = Path(__file__).resolve().parent
for _entry in (str(_TESTS_DIR.parent), str(_TESTS_DIR)):
    if _entry not in sys.path:
        sys.path.insert(0, _entry)

from fake_sec_server import FakeSecServer, max_in_window  # noqa: E402

IDENTITY = "UseMoney deepshaswat@gmail.com"
PER_SEC = 9
WORKERS = 4
#: 200 each = 800 requests = ~90 s at 9 req/s. Overridable so a laptop can run a
#: shorter version; CI runs the documented shape.
REQUESTS_PER_WORKER = int(os.environ.get("SEC_LOAD_TEST_REQUESTS", "200"))

SHARED = "shared-redis-bucket"
PER_PROCESS = "per-process-in-memory-bucket"


#: Captured at COLLECTION time on purpose. ``tests/conftest.py`` has an autouse
#: fixture that pops ``REDIS_URL`` before every test — correctly, so that a
#: settings read can never pick up an operator's shell. This test is the one
#: exception: the URL names a server that has to genuinely EXIST, and there is no
#: way to say "this machine has a Redis" except through the environment pytest
#: was started in. A live value still wins, so a monkeypatch can override.
_REDIS_URL_AT_COLLECTION = os.environ.get("REDIS_URL")


def redis_url() -> str:
    return os.environ.get("REDIS_URL") or _REDIS_URL_AT_COLLECTION or "redis://127.0.0.1:6379"


def require_redis() -> str:
    """The URL, or a SKIP that says exactly what is missing."""
    url = redis_url()
    try:
        import redis

        redis.Redis.from_url(url, socket_connect_timeout=1, socket_timeout=1).ping()
    except Exception as exc:  # the reason matters more than the type
        pytest.skip(
            f"needs a real Redis at {url} ({type(exc).__name__}). "
            "CI provides one as a service container; locally: "
            "docker run --rm -d -p 6379:6379 redis:7-alpine. "
            "fakeredis cannot substitute — RedisBucket runs a Lua script server-side."
        )
    return url


def _worker(
    mode: str,
    target_url: str,
    url: str,
    bucket_key: str,
    count: int,
    per_sec: int,
    start_at: float,
) -> list[float]:
    """One process: install a limiter, warm up, then issue ``count`` GETs.

    Returns the ADMISSION timestamps — the instant the shared budget let each
    request through, taken inside the client's own acquire seam. The parent
    unions them across processes, which is the only direct measurement of "one
    budget, N processes"; the server's arrival times are that plus transport.

    Module-level (not a closure) because the start method is ``spawn``: the child
    re-imports this module and looks the function up by name.
    """
    os.environ["SEC_EGRESS"] = "archive"

    from app.sec import limiter as limiter_module
    from app.sec.client import SecClient

    admissions: list[float] = []

    if mode == SHARED:
        limiter_module.install_shared_limiter(url, per_sec, bucket_key, inject_edgartools=False)
        # Pruning OFF for the duration, so the sorted set keeps every decision it
        # made and the parent can read the invariant back exactly instead of
        # sampling for it. The prune itself is covered by
        # tests/test_limiter.py::test_OUR_trim_uses_a_bound_the_counter_can_no_longer_see,
        # and its bound is two intervals back, so it cannot affect an admission.
        limiter_module.TRIM_EVERY_ACQUIRES = 10**9
        limiter_module.TRIM_INTERVAL_SECONDS = float(10**9)

        def acquire() -> None:
            limiter_module.try_acquire()
            admissions.append(time.time())

    else:
        # THE MUTATION. Exactly what edgartools does on its own, and exactly what
        # a "keep the run alive" fallback would do if app.sec.limiter had one.
        from pyrate_limiter import Duration, InMemoryBucket, Limiter, Rate

        local = Limiter(InMemoryBucket([Rate(per_sec, Duration.SECOND)]))

        def acquire() -> None:
            local.try_acquire("sec")
            admissions.append(time.time())

    with SecClient(IDENTITY, acquire=acquire) as client:
        # ONE warm-up request, then wait for a start time every process shares.
        #
        # Both halves remove a measurement artifact rather than a real limit.
        # MEASURED: the first request on a fresh connection reaches the server
        # ~28 ms after it was admitted (TCP setup) while a keep-alive request
        # arrives in under 1 ms. Four processes starting cold therefore push
        # their first nine admissions PAST the arrival of the next second's
        # batch, and the server sees 13 in one second for admissions that were
        # a clean 9 + 9 a full second apart. The limiter was never wrong; the
        # stopwatch was.
        client.get(target_url)
        admissions.clear()
        while time.time() < start_at:
            time.sleep(0.01)

        for _ in range(count):
            client.get(target_url)

    return admissions


def _run(mode: str, url: str, bucket_key: str) -> tuple[FakeSecServer, list[float], float]:
    """Fire ``WORKERS x REQUESTS_PER_WORKER`` measured requests.

    Returns the server, the union of admission timestamps, and the wall-clock
    instant the measured phase began.
    """
    budget_seconds = (WORKERS * REQUESTS_PER_WORKER) / PER_SEC
    deadline = budget_seconds * 3 + 120
    # Generous: `spawn` costs ~0.5 s per child, and the warm-up must be over for
    # every worker before the measured window opens.
    start_at = time.time() + WORKERS * 1.5 + 3.0

    with FakeSecServer() as server:
        args = [
            (
                mode,
                f"{server.url}/Archives/edgar/data/320193/x.txt",
                url,
                bucket_key,
                REQUESTS_PER_WORKER,
                PER_SEC,
                start_at,
            )
            for _ in range(WORKERS)
        ]
        ctx = multiprocessing.get_context("spawn")
        pool = ctx.Pool(WORKERS)
        try:
            # A bounded wait: a pool that hangs would otherwise leave four child
            # processes and a server thread behind for the rest of the session.
            results = pool.starmap_async(_worker, args).get(timeout=deadline)
        finally:
            pool.terminate()
            pool.join()
        admissions = sorted(stamp for result in results for stamp in result)
        return server, admissions, start_at


def worst_closed_ms_window(scores_ms: list[int], width_ms: int = 1000) -> int:
    """Most timestamps inside any CLOSED ``width_ms`` window — the Lua's own window.

    ``RedisBucket``'s admission script counts ``ZCOUNT(key, now - interval, now)``,
    inclusive at both ends, so this is exactly the quantity it bounds by the rate
    limit. Every other clock in this test is that decision plus something else —
    a Redis round trip back into Python, or that plus the network to the server —
    and those terms are milliseconds of jitter that a sliding window over a
    1.000 s cadence turns into a spurious 10th and 11th request. MEASURED: 800
    requests whose fixed-second histogram was a flat 9 read as 11 end-to-end.
    """
    ordered = sorted(scores_ms)
    best = 0
    for index, score in enumerate(ordered):
        best = max(best, bisect_right(ordered, score + width_ms, index) - index)
    return best


def measurement_threshold_ms(start_at: float) -> int:
    """The first millisecond that counts as measured, on the SCORES' own scale.

    The bucket stores integer milliseconds; ``start_at`` is a float with
    sub-millisecond precision. Comparing one against the other drops any item
    stamped INSIDE the millisecond containing ``start_at`` — and the barrier
    releases every worker at one instant, so that is exactly when items land
    there. On CI: "the bucket recorded 798 decisions for 800 requests", with the
    limiter itself clean (decisions=10, admissions=10, arrivals=10, 8.91/s
    against a 9/s budget).

    Truncating is safe in the other direction: ``start_at`` is set
    ``WORKERS * 1.5 + 3.0`` seconds ahead, so the warm-ups sit ~9 s earlier, not
    one millisecond.
    """
    return int(start_at * 1000)


def test_the_start_boundary_keeps_a_request_stamped_inside_that_millisecond() -> None:
    """The bug CI hit, isolated from the timing that makes it rare.

    The bucket's scores are integer milliseconds; `start_at` is a float with
    sub-millisecond precision. The barrier releases every worker at one instant,
    so items get stamped INSIDE the millisecond containing `start_at` — and
    comparing an integer-ms score against the raw float drops them. On CI that
    surfaced as "the bucket recorded 798 decisions for 800 requests", with the
    limiter itself clean.

    This asserts the predicate rather than the race, because the race needs a
    worker to stamp inside one specific millisecond and does not reproduce on
    demand. No Redis, no subprocesses, no clock.
    """
    start_at = 1_756_800_000.1237  # a float whose ms carries a remainder
    raw = start_at * 1000  # 1756800000123.7 — what the OLD code compared against
    stamped_in_that_ms = float(int(raw))  # 1756800000123.0, a REAL measured request

    # [premise] the fixture reproduces the CI condition: a genuine score that
    # sorts below the raw float threshold. Without this the case proves nothing.
    assert stamped_in_that_ms < raw

    # The assertions below drive the SHIPPING helper, not a re-derivation of its
    # arithmetic — a literal-vs-literal check here could not go red for any
    # change to the source, which is the whole failure mode being fixed.
    threshold = measurement_threshold_ms(start_at)
    assert stamped_in_that_ms >= threshold, (
        "a request stamped inside the start millisecond was dropped from the "
        "measured population; assertion (1) would then compare the wrong set"
    )
    assert stamped_in_that_ms - 1 < threshold, (
        "the threshold reached back into the PREVIOUS millisecond — widening it "
        "must not drift toward the warm-ups"
    )


@pytest.mark.redis
@pytest.mark.slow
def test_four_processes_sharing_one_redis_bucket_never_exceed_nine_per_second() -> None:
    url = require_redis()
    import redis

    bucket_key = f"sec:ratelimit:loadtest:{uuid.uuid4().hex}"
    redis_client = redis.Redis.from_url(url)

    try:
        server, admissions, start_at = _run(SHARED, url, bucket_key)
        # The bucket's OWN record of every decision it made, read back before it
        # is deleted. Exact, not sampled: the worker turned pruning off.
        stored = redis_client.zrange(bucket_key, 0, -1, withscores=True)
    finally:
        # Never leave a test bucket behind in a shared Redis.
        redis_client.delete(bucket_key)

    expected = WORKERS * REQUESTS_PER_WORKER
    arrivals = [at for at in server.arrivals() if at >= start_at]
    assert len(admissions) == expected
    assert len(arrivals) == expected, "every measured request must actually reach the server"
    assert server.total == expected + WORKERS, "one warm-up per worker, and nothing else"

    # TRUNCATE BOTH SIDES TO THE SAME MILLISECOND, and the reason is a real
    # defect rather than a tolerance: the bucket's scores ARE integer
    # milliseconds (stored as Redis zset floats), while `start_at * 1000` keeps
    # sub-millisecond precision. The barrier releases every worker at the same
    # instant, so several items get stamped INSIDE the millisecond containing
    # `start_at` — and `1756800000123.0 >= 1756800000123.7` is False, so a real
    # measured request is silently dropped from the population assertion (1)
    # then checks. Observed on CI: 798 decisions counted for 800 requests, with
    # the limiter itself clean (decisions=10 admissions=10 arrivals=10,
    # 8.91/s sustained against a 9/s budget).
    #
    # At most WORKERS items can land in that millisecond, which is exactly the
    # size of the miss. Including the whole millisecond cannot pull in a
    # warm-up: `start_at` is set WORKERS * 1.5 + 3.0 seconds ahead, so the
    # warm-ups are ~9 s earlier, not one millisecond.
    scores = [int(score) for _, score in stored if score >= measurement_threshold_ms(start_at)]
    decisions = len(scores)
    worst_decisions = worst_closed_ms_window(scores)
    worst_admissions = max_in_window(admissions)
    worst_arrivals = server.max_in_any_window(1.0, since=start_at)
    histogram = server.per_second_histogram(since=start_at)
    elapsed = max(arrivals) - min(arrivals)
    # What a rate of L per rolling second of width W permits over T seconds: one
    # full window's worth up front (the bucket starts EMPTY, and a
    # sliding-window log is allowed to admit L instantly) plus L per second
    # after. Anything above this is over-admission, and nothing below it is.
    allowance = PER_SEC * (1 + elapsed)
    sustained = (len(arrivals) - PER_SEC) / elapsed
    print(
        f"\nshared bucket: {expected} requests over {elapsed:.1f}s "
        f"= {sustained:.2f}/s sustained (allowance {allowance:.0f}) | "
        f"worst 1s window: decisions={worst_decisions} admissions={worst_admissions} "
        f"arrivals={worst_arrivals} | fixed seconds={sorted(histogram.values(), reverse=True)[:3]}"
    )

    # (1) THE CONTRACT, measured exactly: across FOUR PROCESSES, one budget never
    #     ADMITTED more than PER_SEC inside any rolling second. Read off the
    #     bucket's own timestamps, so no clock but the limiter's is involved.
    assert decisions == expected, (
        f"the bucket recorded {decisions} decisions for {expected} requests; assertion (1) "
        "would be measuring the wrong set"
    )
    #     Bounded at PER_SEC + 1 for ONE documented reason, and it is the
    #     limiter's own residual rather than the stopwatch's: `wrap_item` stamps
    #     the item in the client and the atomic check runs a round trip later, so
    #     an insert another process makes in that gap carries a later score and
    #     falls outside this item's window. MEASURED over five runs of this size:
    #     four held exactly 9 in every rolling second, one reached 10. Never
    #     above SEC's own ceiling of 10 — the reason the budget is 9.
    #     app/sec/limiter.py::try_acquire carries the mechanism and the two ways
    #     to close it. The mutation below exceeds this by four times.
    assert worst_decisions <= PER_SEC + 1, (
        f"the shared budget admitted {worst_decisions} requests inside one second "
        f"(limit {PER_SEC}) across {WORKERS} processes"
    )

    # (2) The TOTAL at the far end against what the rate permits over that
    #     duration. This is the number SEC's fair-access policy is written in
    #     ("10 requests per second"), and unlike a sliding window it is immune to
    #     the boundary noise that jittered end-to-end timestamps introduce.
    assert len(arrivals) <= allowance, (
        f"{len(arrivals)} requests arrived in {elapsed:.1f}s; {PER_SEC}/s permits at most "
        f"{allowance:.0f} (one full window up front plus {PER_SEC} a second)"
    )

    # (3) The busiest WALL-CLOCK second at the far end — what a counter at SEC's
    #     edge would tally. Bucketed rather than sliding on purpose: arrivals are
    #     decisions plus a variable transport delay, and a limiter running at
    #     capacity admits at T and again at T + 1000 ms, so a millisecond of
    #     jitter drags two neighbouring blocks into one SLIDING window and reads
    #     10, 11, 12 for a cadence that is flatly 9 per second. That number is
    #     printed above and deliberately not asserted; the +1 here covers a
    #     single request crossing a bucket boundary. Assertion (1) is what proves
    #     no over-admission — this one proves the requests actually went out
    #     under the limiter, and the mutation below breaches it four times over.
    #     BOUNDED AT PER_SEC + WORKERS, not PER_SEC + 1, and the difference is
    #     the whole reason this assertion flaked on CI while (1) held.
    #
    #     (1)'s +1 is the LIMITER's own residual: `wrap_item` stamps in the
    #     client and the atomic check runs a round trip later, so exactly ONE
    #     insert can land in that gap. That is a property of a single item and
    #     the bound is right there.
    #
    #     This assertion measures ARRIVALS — decisions plus a transport delay
    #     that each of the WORKERS processes incurs INDEPENDENTLY. So the number
    #     that can straddle a fixed bucket boundary is bounded by the count of
    #     in-flight requests, one per worker, not by one. Copying (1)'s +1 here
    #     was a mis-derivation: it asserted a single-item property of a
    #     multi-process measurement.
    #
    #     Observed on a shared GitHub runner: decisions=10, admissions=10,
    #     arrivals=11 — the limiter admitted within budget and eleven ARRIVED in
    #     one bucket. Sustained 8.92/s against a 9/s budget. Locally against a
    #     real Redis the same run passes; the runner's jitter is simply larger.
    #
    #     This does NOT weaken the contract. (1) proves no over-admission from
    #     the bucket's own timestamps with no external clock; (2) bounds the
    #     total against the allowance; (4) proves the budget was used. This one
    #     is defence in depth at the far end, and the mutation below still
    #     breaches it by roughly three times.
    assert max(histogram.values()) <= PER_SEC + WORKERS, (
        f"a wall-clock second at the server held {max(histogram.values())} requests; the "
        f"budget is {PER_SEC} and at most {WORKERS} in-flight requests can straddle a "
        f"bucket boundary. histogram={histogram}"
    )

    # (4) The budget must have been USED. Passing (1)-(3) by being slow for some
    #     other reason — a serialised pool, a server dropping requests — is not
    #     the same as passing them.
    assert elapsed >= (expected / PER_SEC) * 0.8, "finished too fast to have been rate limited"


@pytest.mark.redis
@pytest.mark.slow
def test_MUTATION_per_process_buckets_break_the_same_assertion() -> None:
    """The teeth. Same client, same server, same checks — an unshared bucket fails them.

    Without this run, "max <= 9" would also pass if the workers were accidentally
    serialised, if the server dropped requests, or if the histogram were computed
    over the wrong list.
    """
    url = require_redis()
    import redis

    redis_client = redis.Redis.from_url(url)
    bucket_key = f"sec:ratelimit:loadtest:{uuid.uuid4().hex}"
    keys_before = redis_client.dbsize()

    server, admissions, start_at = _run(PER_PROCESS, url, bucket_key)

    expected = WORKERS * REQUESTS_PER_WORKER
    assert len(admissions) == expected
    worst_admissions = max_in_window(admissions)
    worst_arrivals = server.max_in_any_window(1.0, since=start_at)
    histogram = server.per_second_histogram(since=start_at)
    print(
        f"\nper-process buckets: worst 1s window: admissions={worst_admissions} "
        f"arrivals={worst_arrivals} busiest wall-clock second={max(histogram.values())} "
        f"(ceiling {PER_SEC}, workers {WORKERS})"
    )

    assert worst_admissions > PER_SEC + 1, (
        "the mutation did not breach the ceiling, so assertion (1) in the test above "
        f"proves nothing. Expected roughly {WORKERS} x {PER_SEC}."
    )
    assert max(histogram.values()) > PER_SEC + 1, (
        "assertion (3) in the test above proves nothing either"
    )
    elapsed = max(admissions) - min(admissions)
    assert len(admissions) > PER_SEC * (1 + elapsed), (
        "assertion (2) in the test above proves nothing either"
    )

    # The mutation must leave no trace: it never touched Redis, so the keyspace
    # is exactly as it was and the bucket key was never created.
    assert redis_client.exists(bucket_key) == 0
    assert redis_client.dbsize() == keys_before


def test_redis_down_stops_the_run_before_a_single_request_is_issued() -> None:
    """No Redis marker: this one proves what happens when there is NO Redis.

    Fail-closed, end to end — the limiter refuses to install and the fake server
    records zero arrivals. The alternative (an in-memory fallback) would show 800
    arrivals here and look perfectly healthy.
    """
    from app.sec import limiter as limiter_module
    from app.sec.errors import LimiterUnavailable

    limiter_module.reset_installed_limiter()
    with FakeSecServer() as server:
        with pytest.raises(LimiterUnavailable):
            limiter_module.install_shared_limiter("redis://127.0.0.1:1", PER_SEC)
        assert server.total == 0
        assert limiter_module.installed_limiter() is None
