#!/usr/bin/env python3
"""How much memory does one parse cost? — MONEY-979 T20.

The service ships `memory: 2Gi`, `cpu: "2"`, `containerConcurrency: 4`, and the
heaviest thing it does is edgartools+pandas resolving the XBRL of a 10-K. Nobody
had measured it. Cloud Run enforces the limit with SIGKILL, and the surviving
evidence is a **137 exit that reads as a crash rather than as "the limit is too
small"** — so the cost of not measuring is a bug report pointed at the wrong
thing.

    python scripts/bench_parse_memory.py                 # every case, one fresh process each
    python scripts/bench_parse_memory.py --json          # machine-readable
    python scripts/bench_parse_memory.py --case 13f_synthetic_7160
    python scripts/bench_parse_memory.py --concurrency 4 # 4 simultaneous parses, one process

## Why a fresh subprocess per case

``ru_maxrss`` is a HIGH-WATER MARK for the life of the process and never comes
back down. Measure two parses in one process and the second one's number is
whichever was bigger, reported as if it belonged to the second. So each case
re-execs this file with ``--child`` and prints one JSON line.

That also removes the other half of the problem: import cost. ``import edgar``
pulls pandas and numpy, and a measurement that includes the import in the first
case and not in the rest is not a comparison. The child records BASELINE after
the imports and DELTA is what the parse itself added.

## Two numbers, and neither one alone is the answer

``peakRssBytes``    what the OS charged the process. Includes pandas' numpy
                    buffers, the interpreter, and every arena glibc did not
                    return. This is the number Cloud Run kills on.
``tracemallocPeak`` what the CPython allocator handed out. **Systematically
                    lower**, because numpy allocates its data buffers outside
                    the Python allocator and tracemalloc cannot see them. It is
                    here to show which part of a parse is Python objects and
                    which is the array libraries — not as a second opinion on
                    the first number.

## The measurement is INDICATIVE on a laptop, not authoritative

This is macOS/arm64 with libSystem's allocator; the container is
`python:3.12-slim` on Linux/amd64 with glibc. Allocators differ in how
aggressively they return freed arenas to the OS, so RSS is exactly the metric
that does not port. Run this inside the real base image and use THAT number:

    docker run --rm -v "$PWD":/src -w /src python:3.12-slim \\
      bash -c "pip install -q -e '.[dev]' && python scripts/bench_parse_memory.py --json"

The output labels its own platform for precisely this reason. A number that does
not say where it was taken is a number that will be quoted in the wrong place.

## The 13F case is deliberately larger than any fixture

The biggest 13F on disk is Berkshire's, 179 holdings / 96 KB. Real 13F-HRs from
the large index managers carry thousands of positions, so ``13f_synthetic_7160``
repeats the fixture's own ``<infoTable>`` block to that scale. It is SYNTHETIC
and labelled as such: the rows are real rows, the count is not a real filing.

## WHAT IT MEASURED — darwin/arm64, py3.12.9, 2026-08-29. INDICATIVE.

Docker was down, so this is the laptop number and not the container's. Re-run in
`python:3.12-slim` before quoting it as the container's.

    case                 class        bundle  baseline    peak   delta  tracemalloc
    form4                OWNERSHIP       0.0     149.6   149.6     0.0      0.1
    13f_post2023         THIRTEENF       0.0     149.5   150.9     1.4      0.2
    13f_pre2023          THIRTEENF       0.1     149.2   151.4     2.2      0.3
    13f_synthetic_7160   THIRTEENF       3.4     158.6   213.4    54.8     10.5
    schedule13d          SCHEDULE13      0.7     149.6   150.2     0.6      0.1
    eightk               EIGHTK          0.3     149.3   158.6     9.4      3.4
    tenk_aapl            FINANCIALS      9.0     175.5   222.1    46.6     18.1   (MiB)

**BASELINE IS THE BIG NUMBER.** ~149 MiB before a single byte is parsed —
edgartools, pandas and numpy imported. It rises to ~176 MiB once the XBRL
machinery loads, and that is 8.6% of the 2Gi limit spent on imports. Every parse
delta is small beside it.

Four SIMULTANEOUS parses in one process, the shape `containerConcurrency: 4`
would produce if the handler ever ran on a threadpool:

    workers   1        2        4        8
    tenk_aapl 208.2    239.1    300.0    392.5   MiB peak

Linear at ~31 MiB per additional concurrent 10-K. **4 x tenk_aapl = 300 MiB
against a 2Gi limit: 14.6%.** The shipped configuration is not close to its
ceiling; it has roughly 5x headroom.

WHERE IT WOULD BITE, from the synthetic sweep at concurrency 4:

    13f_synthetic_7160   ( 3.4 MiB bundle)    364 MiB     fine
    13f_synthetic_20000  ( 9.5 MiB bundle)    737 MiB     fine
    13f_synthetic_50000  (23.7 MiB bundle)  1,613 MiB     79% of 2Gi — too close

A 13F costs ~15.5x its bundle size in peak RSS (measured across three scales); a
10-K costs ~5x, because its cost is XBRL resolution rather than row count. So the
binding constraint is a SINGLE LARGE FILING, not concurrency: at 4 workers the
wall is around a **20-25 MB filing**, and one 50 MB filing arriving four times at
once would be an OOM.

Nothing on disk is near that, and `UsFiling.sizeBytes` already exists — so the
honest guard is to check the observed distribution once the detector has run
rather than to raise the limit against a filing nobody has seen.
"""

from __future__ import annotations

import argparse
import contextlib
import gzip
import json
import re
import subprocess
import sys
import tracemalloc
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SERVICE_ROOT = Path(__file__).resolve().parent.parent
FIXTURES = SERVICE_ROOT / "tests" / "fixtures"

#: The container's limit for the APP container. The Datadog sidecar's 256Mi is a
#: separate allocation in the same Cloud Run instance, not a slice of this.
CONTAINER_MEMORY_MIB = 2048

#: `containerConcurrency` from both cloudbuild specs.
CONTAINER_CONCURRENCY = 4

#: Fraction of the limit that must remain unused for the verdict to read PASS.
#: Not a round number for its own sake: the interpreter, the uvicorn workers, the
#: httpx connection pools and the dedupe client all live in that container
#: alongside whatever a parse holds, and glibc does not return every freed arena.
HEADROOM_FRACTION = 0.25

MIB = 1024 * 1024


@dataclass(frozen=True)
class Case:
    """One measurable parse: a fixture, the class to parse it as, and its header facts."""

    name: str
    fixture: str
    parse_class: str
    accession: str
    cik10: str
    form: str
    note: str = ""
    #: Repeat the fixture's `<infoTable>` block to this many holdings. Synthetic.
    scale_infotables_to: int | None = None


#: Every parse class the service dispatches on, plus the two worst cases.
#: Taken from the fixtures' own SGML headers — the same table
#: `tests/test_dispatch.py` drives its parser matrix from.
CASES: tuple[Case, ...] = (
    Case(
        "form4",
        "form4_jefferies.txt.gz",
        "OWNERSHIP",
        "0001214659-26-011109",
        "0000096223",
        "4",
        "13,713 B — the light end, and 80% of EDGAR by volume",
    ),
    Case(
        "13f_post2023",
        "thirteenf_post2023.txt.gz",
        "THIRTEENF",
        "0001193125-26-352200",
        "0001067983",
        "13F-HR",
        "51,654 B / 89 holdings",
    ),
    Case(
        "13f_pre2023",
        "thirteenf_pre2023.txt.gz",
        "THIRTEENF",
        "0000950123-22-012275",
        "0001067983",
        "13F-HR",
        "96,598 B / 179 holdings — the largest 13F ON DISK",
    ),
    Case(
        "13f_synthetic_7160",
        "thirteenf_pre2023.txt.gz",
        "THIRTEENF",
        "0000950123-22-012275",
        "0001067983",
        "13F-HR",
        "SYNTHETIC — the fixture's rows repeated to index-manager scale",
        scale_infotables_to=7160,
    ),
    Case(
        "schedule13d",
        "schedule13d_expion.txt.gz",
        "SCHEDULE13",
        "0001903596-26-000330",
        "0001894954",
        "SCHEDULE 13D",
        "716,013 B",
    ),
    Case(
        "eightk",
        "eightk_ibio.txt.gz",
        "EIGHTK",
        "0001420720-26-000019",
        "0001420720",
        "8-K",
        "332,421 B — exhibit text extraction",
    ),
    Case(
        "tenk_aapl",
        "tenk_aapl.txt.gz",
        "FINANCIALS",
        "0000320193-25-000079",
        "0000320193",
        "10-K",
        "9,392,337 B — THE HEAVY ONE: full XBRL + three pandas statements",
    ),
)

CASES_BY_NAME = {case.name: case for case in CASES}


def scaled_13f_case(holdings: int) -> Case:
    """A synthetic 13F of ``holdings`` positions, for finding where the limit bites.

    Not in :data:`CASES` because it is a probe, not a workload: the answer to
    "does the shipped configuration fit" comes from the real fixtures, and the
    answer to "how far from the wall are we" comes from sweeping this.
    """
    base = CASES_BY_NAME["13f_pre2023"]
    return Case(
        name=f"13f_synthetic_{holdings}",
        fixture=base.fixture,
        parse_class=base.parse_class,
        accession=base.accession,
        cik10=base.cik10,
        form=base.form,
        note=f"SYNTHETIC — {holdings} holdings",
        scale_infotables_to=holdings,
    )


def resolve_case(name: str) -> Case:
    if name in CASES_BY_NAME:
        return CASES_BY_NAME[name]
    match = re.fullmatch(r"13f_synthetic_(\d+)", name)
    if match:
        return scaled_13f_case(int(match.group(1)))
    raise SystemExit(f"unknown case {name!r}; known: {sorted(CASES_BY_NAME)}")


# ── fixture loading ─────────────────────────────────────────────────────────


def load_bundle(case: Case) -> str:
    """The fixture's text, scaled if the case asks for it."""
    text = gzip.decompress((FIXTURES / case.fixture).read_bytes()).decode("utf-8", "replace")
    if case.scale_infotables_to is None:
        return text
    return _scale_infotables(text, case.scale_infotables_to)


_INFOTABLE_RE = re.compile(r"<(?:\w+:)?infoTable>.*?</(?:\w+:)?infoTable>", re.DOTALL)


def _scale_infotables(text: str, target: int) -> str:
    """Repeat the information table's rows until there are ``target`` of them.

    The rows are REAL rows from a real filing — only the count is invented. That
    keeps every field the parser reads structurally valid, which a hand-written
    row would not: a synthetic fixture that fails to parse measures the error
    path and reports it as a parse cost.
    """
    blocks = _INFOTABLE_RE.findall(text)
    if not blocks:
        raise SystemExit("fixture has no <infoTable> block to scale")
    have = len(blocks)
    if target <= have:
        return text
    # Appended after the LAST existing row so the surrounding document — SGML
    # header, <informationTable> open/close, the primary document boundary — is
    # untouched.
    last = blocks[-1]
    end = text.rindex(last) + len(last)
    filler = "".join(blocks[i % have] for i in range(target - have))
    return text[:end] + filler + text[end:]


# ── the child: one parse, one process, one JSON line ────────────────────────


def measure_one(case: Case) -> dict[str, Any]:
    """Measure a single parse in THIS process. Only ever called by a child."""
    # Imported here, not at module scope, so the baseline below is taken with the
    # library fully loaded — the state a warm container is actually in.
    from app.parsers.dispatch import NullLookups, parse_and_store
    from app.store.outcome import peak_rss_bytes

    bundle = load_bundle(case)
    bundle_bytes = len(bundle.encode("utf-8"))

    # Touch the parse path once with a trivially small input so first-call
    # imports inside edgartools (its XBRL machinery is imported lazily) are
    # charged to the baseline rather than to the case under test. A failure here
    # is expected and irrelevant: what is being paid for is the import.
    with contextlib.suppress(Exception):
        # A failure here is EXPECTED and irrelevant — an empty bundle does not
        # parse. What is being paid for is the import, not the result.
        parse_and_store(
            "0000000000-00-000000",
            "",
            parse_class=case.parse_class,
            lookups=NullLookups(),
            apply=False,
        )

    baseline = peak_rss_bytes()
    tracemalloc.start()
    outcome = parse_and_store(
        case.accession,
        bundle,
        parse_class=case.parse_class,
        cik10=case.cik10,
        form=case.form,
        lookups=NullLookups(),
        apply=False,  # a REAL parse that writes nothing — see dispatch.py
    )
    _, tm_peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    peak = peak_rss_bytes()

    return {
        "case": case.name,
        "parseClass": case.parse_class,
        "note": case.note,
        "synthetic": case.scale_infotables_to is not None,
        "bundleBytes": bundle_bytes,
        "baselineRssBytes": baseline,
        "peakRssBytes": peak,
        # `None` propagates rather than becoming 0: an undeterminable measurement
        # must not arrive downstream as a very good result.
        "deltaRssBytes": (None if peak is None or baseline is None else peak - baseline),
        "tracemallocPeakBytes": tm_peak,
        "status": outcome.get("status"),
        "rowsParsed": outcome.get("rowsParsed"),
        "rows": outcome.get("rows"),
        "error": outcome.get("error"),
    }


def measure_concurrent(case: Case, workers: int) -> dict[str, Any]:
    """``workers`` parses of ``case`` running SIMULTANEOUSLY in one process.

    Threads, not processes, and that is the point: this models the shape where
    one container serves `containerConcurrency` requests whose working sets are
    all live at once. The GIL makes them slow, not sequential — each thread's
    DataFrames exist at the same time, which is the only property being measured.

    Whether the deployed app can even REACH this shape is a separate question
    with a separate answer; see `tests/test_parse_memory.py`.
    """
    import threading

    from app.parsers.dispatch import NullLookups, parse_and_store
    from app.store.outcome import peak_rss_bytes

    # ONE source of bytes, but every thread decodes its OWN string. That is not
    # a detail: handing the same `str` object to four threads would share the
    # 9 MB bundle between them, and the four concurrent requests this models are
    # four DIFFERENT filings with four separate copies. `bytes.decode()` always
    # allocates, so the copy is real — `bytes(b)`, `b[:]` and `"".join([s])` all
    # hand back the same object in CPython and would have measured nothing.
    raw = load_bundle(case).encode("utf-8")
    barrier = threading.Barrier(workers)
    results: list[Any] = [None] * workers

    def run(index: int) -> None:
        own_copy = raw.decode("utf-8", "replace")
        # Every thread waits until all of them are ready, so the parses OVERLAP.
        # Without the barrier a fast thread finishes before a slow one starts and
        # the measurement is of one parse with extra steps.
        barrier.wait()
        results[index] = parse_and_store(
            case.accession,
            own_copy,
            parse_class=case.parse_class,
            cik10=case.cik10,
            form=case.form,
            lookups=NullLookups(),
            apply=False,
        )

    # Same warm-up as the single-parse path, for the same reason: the baseline
    # must be a WARM container, or the library's lazy imports land in the delta.
    with contextlib.suppress(Exception):
        parse_and_store(
            "0000000000-00-000000",
            "",
            parse_class=case.parse_class,
            lookups=NullLookups(),
            apply=False,
        )

    baseline = peak_rss_bytes()
    threads = [threading.Thread(target=run, args=(i,)) for i in range(workers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    peak = peak_rss_bytes()

    return {
        "case": case.name,
        "mode": "concurrent",
        "workers": workers,
        "baselineRssBytes": baseline,
        "peakRssBytes": peak,
        "deltaRssBytes": (None if peak is None or baseline is None else peak - baseline),
        "statuses": [(r or {}).get("status") for r in results],
    }


# ── the parent: fan out, tabulate, judge ────────────────────────────────────


def run_child(args: list[str]) -> dict[str, Any]:
    """Re-exec this file and read back the one JSON line it prints."""
    proc = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), *args],
        capture_output=True,
        text=True,
        cwd=str(SERVICE_ROOT),
    )
    if proc.returncode != 0:
        return {"error": f"child exited {proc.returncode}", "stderr": proc.stderr[-2000:]}
    for line in reversed(proc.stdout.strip().splitlines()):
        if line.startswith("{"):
            return json.loads(line)
    return {"error": "child printed no JSON", "stdout": proc.stdout[-2000:]}


def platform_note() -> dict[str, Any]:
    import platform

    from app.store.outcome import RU_MAXRSS_TO_BYTES

    return {
        "platform": sys.platform,
        "machine": platform.machine(),
        "python": platform.python_version(),
        "ruMaxrssUnit": "bytes" if RU_MAXRSS_TO_BYTES == 1 else "kilobytes",
        "authoritative": sys.platform == "linux",
        "caveat": (
            ""
            if sys.platform == "linux"
            else "INDICATIVE ONLY — the container is python:3.12-slim on Linux/glibc; "
            "allocator behaviour differs and RSS is the metric that does not port."
        ),
    }


def mib(value: int | None) -> str:
    return "n/a" if value is None else f"{value / MIB:8.1f}"


def verdict(results: list[dict[str, Any]], limit_mib: int, concurrency: int) -> dict[str, Any]:
    """Does ``concurrency`` simultaneous copies of the worst case fit the limit?

    Two arithmetics, reported side by side because they disagree and the
    disagreement is the interesting part:

    ``conservative``  ``concurrency x peak + baseline``, the brief's formula. It
                      charges the interpreter, pandas and edgartools once per
                      request even though they are shared — an upper bound that
                      cannot be exceeded by this workload.
    ``realistic``     ``baseline + concurrency x delta``. The baseline is ONE
                      copy because the imports, the code objects and the module
                      globals are shared across threads in one container; only
                      the per-parse working set multiplies.
    """
    usable = [r for r in results if r.get("peakRssBytes") and not r.get("error")]
    if not usable:
        return {"verdict": "UNKNOWN", "reason": "no case produced a measurement"}
    worst = max(usable, key=lambda r: r["peakRssBytes"])
    peak = worst["peakRssBytes"]
    baseline = worst.get("baselineRssBytes") or 0
    delta = worst.get("deltaRssBytes") or 0
    limit = limit_mib * MIB

    conservative = concurrency * peak + baseline
    realistic = baseline + concurrency * delta
    budget = limit * (1 - HEADROOM_FRACTION)
    return {
        "worstCase": worst["case"],
        "limitMib": limit_mib,
        "concurrency": concurrency,
        "headroomFraction": HEADROOM_FRACTION,
        "budgetMib": round(budget / MIB, 1),
        "conservativeMib": round(conservative / MIB, 1),
        "realisticMib": round(realistic / MIB, 1),
        "conservativeFits": conservative <= budget,
        "realisticFits": realistic <= budget,
        "verdict": (
            "PASS" if conservative <= budget else ("MARGINAL" if realistic <= budget else "FAIL")
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--child", metavar="CASE", help=argparse.SUPPRESS)
    parser.add_argument("--child-concurrent", metavar="CASE", help=argparse.SUPPRESS)
    parser.add_argument("--case", action="append", help="measure only these cases")
    parser.add_argument("--concurrency", type=int, default=0, help="also run N simultaneous parses")
    parser.add_argument("--limit-mib", type=int, default=CONTAINER_MEMORY_MIB)
    parser.add_argument("--workers-for-verdict", type=int, default=CONTAINER_CONCURRENCY)
    parser.add_argument("--json", action="store_true", help="emit JSON instead of a table")
    args = parser.parse_args()

    if args.child:
        print(json.dumps(measure_one(resolve_case(args.child))))
        return 0
    if args.child_concurrent:
        print(json.dumps(measure_concurrent(resolve_case(args.child_concurrent), args.concurrency)))
        return 0

    names = args.case or [case.name for case in CASES]
    results = [run_child(["--child", name]) for name in names]

    concurrent: dict[str, Any] | None = None
    if args.concurrency:
        heaviest = max(
            (r for r in results if r.get("peakRssBytes")),
            key=lambda r: r["peakRssBytes"],
            default=None,
        )
        if heaviest:
            concurrent = run_child(
                ["--child-concurrent", heaviest["case"], "--concurrency", str(args.concurrency)]
            )

    report = {
        "platform": platform_note(),
        "cases": results,
        "concurrent": concurrent,
        "verdict": verdict(results, args.limit_mib, args.workers_for_verdict),
    }

    if args.json:
        print(json.dumps(report, indent=2))
        return 0

    plat = report["platform"]
    print(f"\nparse memory — {plat['platform']}/{plat['machine']} py{plat['python']}")
    print(f"ru_maxrss unit: {plat['ruMaxrssUnit']}")
    if plat["caveat"]:
        print(f"!! {plat['caveat']}")
    print()
    print(
        f"{'case':<20} {'class':<11} {'bundle':>9} {'baseline':>9} "
        f"{'peak':>9} {'delta':>9} {'tracemalloc':>12}  status"
    )
    print("-" * 100)
    for row in results:
        if row.get("error"):
            print(f"{row.get('case', '?'):<20} ERROR {row['error']}")
            continue
        print(
            f"{row['case']:<20} {row['parseClass']:<11} "
            f"{mib(row['bundleBytes'])} {mib(row['baselineRssBytes'])} "
            f"{mib(row['peakRssBytes'])} {mib(row['deltaRssBytes'])} "
            f"{mib(row['tracemallocPeakBytes'])}  {row['status']}"
            f"{' (synthetic)' if row['synthetic'] else ''}"
        )
    print("\nall figures MiB\n")

    if concurrent:
        print(
            f"{concurrent['workers']} simultaneous {concurrent['case']} parses in ONE process: "
            f"baseline {mib(concurrent['baselineRssBytes'])} -> "
            f"peak {mib(concurrent['peakRssBytes'])} MiB "
            f"(delta {mib(concurrent['deltaRssBytes'])})"
        )
        print()

    v = report["verdict"]
    print(f"verdict: {v['verdict']}")
    if "budgetMib" in v:
        print(
            f"  worst case {v['worstCase']} at concurrency {v['concurrency']}\n"
            f"  budget          {v['budgetMib']:>8} MiB "
            f"({v['limitMib']} MiB limit less {int(v['headroomFraction'] * 100)}% headroom)\n"
            f"  conservative    {v['conservativeMib']:>8} MiB "
            f"(N x peak + baseline)  fits={v['conservativeFits']}\n"
            f"  realistic       {v['realisticMib']:>8} MiB "
            f"(baseline + N x delta) fits={v['realisticFits']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
