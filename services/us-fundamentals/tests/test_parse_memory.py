"""Memory accounting for the parse path — MONEY-979 T20.

The service ships `memory: 2Gi` with `containerConcurrency: 4`, and the sizing
argument behind those numbers rests on two facts that are easy to break silently.
This file pins both.

## 1. `ru_maxrss` is in different UNITS on different platforms

Linux reports KILOBYTES, macOS reports BYTES, and confusing them is a 1024x
error that still produces a plausible-looking number: 1.6 GB of parse on a 2Gi
container and 1.6 MB of parse look equally unremarkable in a log line. The
deployed platform is Linux (`python:3.12-slim`), which is the branch CI runs, so
this is one of the few places where the laptop and the container genuinely
disagree and the test must assert the platform's own answer rather than a
constant.

## 2. `containerConcurrency: 4` does not currently produce 4 concurrent parses

`app/main.py` registers `async def` endpoints that call `module.handle(payload)`
SYNCHRONOUSLY. Starlette awaits an `async def` endpoint on the event loop, so a
blocking call inside it blocks the loop and the next request cannot start until
it returns. Four simultaneous deliveries are therefore handled one at a time.

That is the assumption the T20 verdict rests on — measured worst case is
~299 MiB for four SIMULTANEOUS 10-K parses against a 2Gi limit, and if they
cannot even be simultaneous the real number is lower still. The moment somebody
moves `handle()` onto a threadpool (`run_in_threadpool`, `asyncio.to_thread`, a
`def` endpoint) that arithmetic goes live and needs re-deriving, so this test
fails on that change rather than letting it land quietly.

It documents the CURRENT behaviour. It is not an argument that serialising is
better — it is a tripwire on the input to a memory budget.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import logging
import os
import sys
import threading
import time
from typing import Any

import pytest

from app.store.outcome import RU_MAXRSS_TO_BYTES, peak_rss_bytes, report_job_outcome

# ── 1. The unit ─────────────────────────────────────────────────────────────


def test_ru_maxrss_is_scaled_by_the_units_THIS_platform_reports() -> None:
    """Linux: kilobytes. macOS/BSD: bytes. Getting it wrong is a 1024x error.

    Asserted against ``sys.platform`` rather than as a bare constant so the
    assertion is true in CI (Linux, the deployed platform) AND on the laptop the
    measurement was taken on — and so it goes red if someone "simplifies" the
    conditional to one value.
    """
    # Bound to a lowercase local first only to keep ruff's SIM300 quiet: it reads
    # a SCREAMING_SNAKE name on the left of `==` as a Yoda condition.
    multiplier = RU_MAXRSS_TO_BYTES
    assert multiplier == (1 if sys.platform == "darwin" else 1024)
    assert multiplier in (1, 1024)


def test_peak_rss_is_a_plausible_number_of_bytes_for_a_python_process() -> None:
    """The unit bug's whole danger is that both answers look reasonable in
    isolation. A bound catches it: a CPython process that has imported pytest is
    never 8 MB and never 64 GB, and the wrong multiplier lands outside on one
    side or the other.
    """
    peak = peak_rss_bytes()
    assert peak is not None
    assert 8 * 1024**2 < peak < 64 * 1024**3, f"{peak} B is not a plausible process RSS"


def test_peak_rss_rises_after_a_large_allocation() -> None:
    """It is a HIGH-WATER MARK, so it must move for an allocation and must not
    move back down when it is freed. Both halves matter: the first proves it is
    measuring something, the second is why the field is documented as a process
    mark rather than a per-job cost."""
    before = peak_rss_bytes()
    assert before is not None

    blob = bytearray(220 * 1024 * 1024)
    blob[::4096] = b"\x01" * len(blob[::4096])  # touch pages so they are RESIDENT
    during = peak_rss_bytes()
    del blob

    after = peak_rss_bytes()
    assert during is not None and after is not None
    assert during > before + 128 * 1024**2, "a 220 MB resident allocation did not move the peak"
    assert after >= during, "ru_maxrss must not fall; it is a high-water mark"


def test_an_undeterminable_peak_is_None_and_never_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    """A "could not determine" answer gets its own value.

    A 0 here would be indistinguishable from "this job used no memory" — a
    cached fail-open default wearing the one number nobody questions.
    """
    import resource

    from app.store import outcome

    def boom(_who: int) -> Any:
        raise OSError("getrusage refused")

    monkeypatch.setattr(resource, "getrusage", boom)
    assert outcome.peak_rss_bytes() is None


# ── 2. It reaches the job outcome line ──────────────────────────────────────


def test_the_job_outcome_line_carries_peak_rss(statsd, caplog) -> None:
    """Without this, measuring the parse path stays a one-off a person had to run.

    The value is in the LOG payload rather than a fifth DogStatsD series
    deliberately: a Datadog log-based metric off this JSON field needs no code
    change, and `test_outcome.py` asserts the emitted metric names as an EXACT
    list — a fifth `increment` would turn that assertion red for a reason that
    has nothing to do with what it guards.
    """
    with caplog.at_level(logging.INFO, logger="us-fundamentals.job-outcome"):
        report_job_outcome("edgar-parse-financials", selected=1, written=3)

    payload = json.loads(caplog.records[-1].getMessage().split("[job-outcome] ")[-1])
    assert payload["peakRssBytes"] > 8 * 1024**2
    assert payload["written"] == 3


def test_reporting_peak_rss_added_no_new_statsd_series(statsd) -> None:
    """Belt and braces on the paragraph above: the four counters, and only those.

    Stated here as well as in `test_outcome.py` because the two assertions guard
    opposite directions — that one protects the NAMES from a rename, this one
    protects the COUNT from an addition made over here.
    """
    report_job_outcome("edgar-parse-13f", selected=1, written=1)
    assert statsd.names() == [
        "stockbook.job.selected",
        "stockbook.job.written",
        "stockbook.job.failed",
        "stockbook.job.transport_failures",
    ]


# ── 3. Concurrency: what the container can actually reach ───────────────────


class _OverlapRecorder:
    """A stand-in job handler that reports the maximum simultaneous entry count."""

    def __init__(self, hold_seconds: float) -> None:
        self._hold = hold_seconds
        self._lock = threading.Lock()
        self.live = 0
        self.max_live = 0
        self.calls = 0

    def handle(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self.live += 1
            self.calls += 1
            self.max_live = max(self.max_live, self.live)
        # A BLOCKING sleep, on purpose: `parse_and_store` is CPU-bound Python and
        # blocks exactly like this. `asyncio.sleep` would yield and measure the
        # framework's ability to interleave awaits, which is not the question.
        time.sleep(self._hold)
        with self._lock:
            self.live -= 1
        return {"success": True, "written": 1}


async def _post_four(app_module: Any, recorder: _OverlapRecorder) -> float:
    import httpx

    transport = httpx.ASGITransport(app=app_module.app)
    started = time.monotonic()
    async with httpx.AsyncClient(transport=transport, base_url="http://svc") as client:
        await asyncio.gather(
            *(
                client.post(
                    "/jobs/edgar-parse-financials",
                    json={"accession": f"0000000000-00-00000{i}", "cik10": "0000320193"},
                )
                for i in range(4)
            )
        )
    return time.monotonic() - started


@pytest.mark.asyncio
async def test_four_concurrent_job_posts_do_NOT_run_four_parses_at_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The input to the memory budget, asserted rather than assumed.

    `_run_job` is `async def` and calls `module.handle(payload)` with no await.
    Starlette runs an `async def` endpoint ON the event loop, so that call blocks
    the loop: request 2 cannot enter the handler until request 1 has left it.
    `containerConcurrency: 4` therefore buys queueing, not parallel parsing.

    MUTATION that turns this red — and SHOULD, because it is the change that
    makes 4 x peak a live number instead of an upper bound:

        result = await run_in_threadpool(module.handle, payload)

    If that lands, re-run `scripts/bench_parse_memory.py --concurrency 4` before
    trusting the 2Gi sizing.
    """
    for name in ("app.main", "app.auth", "app.dedupe"):
        sys.modules.pop(name, None)
    os.environ["APP_ENV"] = "development"
    os.environ["ENABLE_PULL_SUBSCRIBER"] = "true"
    main = importlib.import_module("app.main")

    recorder = _OverlapRecorder(hold_seconds=0.05)
    monkeypatch.setattr(main, "_load_handler", lambda _name: recorder)

    try:
        elapsed = await _post_four(main, recorder)
    finally:
        sys.modules.pop("app.main", None)

    assert recorder.calls == 4, "all four requests must have reached the handler"
    assert recorder.max_live == 1, (
        f"{recorder.max_live} handlers ran at once — the parse path is no longer serialised "
        "by the event loop, so the 4 x peak RSS arithmetic in T20 is now live and the "
        "2Gi/containerConcurrency:4 sizing must be re-derived"
    )
    # Corroborates the same fact from the other side: serialised work takes the
    # sum of the parts. A threadpool would finish in roughly one hold.
    assert elapsed >= 4 * 0.05 * 0.8, f"four 50 ms handlers finished in {elapsed:.3f}s — overlapped"


# ── 4. The harness itself is real, not a description of one ─────────────────


def _load_bench() -> Any:
    """Import the harness the way a person runs it: as a script beside the app."""
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
    try:
        import bench_parse_memory

        return bench_parse_memory
    finally:
        sys.path.pop(0)


def test_the_bench_harness_measures_the_REAL_parse_path() -> None:
    """A benchmark that reimplements the thing it benchmarks measures nothing.

    Two halves, and the second is the one that matters. The source assertions are
    scoped to ``measure_one``'s OWN body via ``inspect.getsource`` rather than
    grepped over the whole file — a name that appears three times elsewhere in
    the module makes a file-wide grep pass after the measuring function has
    stopped using it, which is a shadow test of a benchmark.

    Then it RUNS the harness and checks the answer is a measurement: a real
    PARSED status with real rows, a plausible RSS, and a delta that exists.
    """
    import inspect

    bench = _load_bench()
    body = inspect.getsource(bench.measure_one)
    assert "parse_and_store(" in body, "the harness no longer drives the real parser"
    # The IMPORT line, not just a call to something with that name: a locally
    # redefined `peak_rss_bytes` reads identically at the call site and would let
    # the bench drift away from the deployed job outcome's unit handling — which
    # is the exact 1024x bug the first test in this file exists for.
    assert "from app.store.outcome import peak_rss_bytes" in body, (
        "the harness no longer reads RSS through app.store.outcome — the bench and "
        "the deployed job outcome would then be measuring by two different rules"
    )
    # `apply=False` is a REAL parse that writes nothing (see dispatch.py). A
    # benchmark that skipped the work would report a clean, meaningless zero;
    # `apply=True` with no writer raises WriterUnavailable, so this is also what
    # keeps the harness from needing a database.
    assert "apply=False" in body

    result = bench.measure_one(bench.CASES_BY_NAME["form4"])
    assert result["status"] == "PARSED", result.get("error")
    assert result["rowsParsed"] > 0
    assert result["peakRssBytes"] > 8 * 1024**2
    assert result["deltaRssBytes"] is not None and result["deltaRssBytes"] >= 0


def test_the_synthetic_13f_scaler_produces_a_parsable_filing() -> None:
    """The scaled 13F is the only case big enough to find the wall, so it has to
    actually PARSE. A synthetic fixture that fails measures the error path and
    reports it as a parse cost — a smaller number, in the reassuring direction.
    """
    bench = _load_bench()

    from app.parsers.dispatch import NullLookups, parse_and_store

    case = bench.scaled_13f_case(400)
    outcome = parse_and_store(
        case.accession,
        bench.load_bundle(case),
        parse_class=case.parse_class,
        cik10=case.cik10,
        form=case.form,
        lookups=NullLookups(),
        apply=False,
    )
    assert outcome["status"] == "PARSED"
    assert outcome["rows"]["thirteen_f_holdings"] == 400
