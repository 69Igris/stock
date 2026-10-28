"""Every Python job's outcome is REACHED, not merely present — MONEY-1331.

The Python analogue of ``packages/datadog/__tests__/job-outcome-reachability.test.ts``,
which scans ``workers/src/processors/*.ts`` and therefore cannot see one line of
this service — the half that owns bulk submissions, companyfacts, FTD, the
ownership backfill and the minutely detector.

## The defect class, which this repo has already shipped twice

``stock-document-extract`` had its ``reportJobOutcome`` below an early return and
emitted NOTHING on idle nights. A zero-write monitor over a series that never
emits reads healthy precisely when the job is doing nothing — the monitor is not
merely uninformative, it is actively reassuring. MONEY-1328 then found four more
processors in that state on the TypeScript side.

The presence check that existed before could not see any of it: moving a call
below an early return leaves it present in the file.

## What is asserted, and why in two parts

1.  **REACHABILITY.** A module that calls ``report_job_outcome`` must call it
    from a ``try/finally``. That is the property — a job that raises before
    reporting is invisible in exactly the dimension the metric measures.
2.  **COVERAGE.** A dated set of modules that are EXPECTED to report. Rule 1
    alone is silent about a module that stops reporting altogether, which is the
    easier mistake to make and the harder one to notice.

Both ratchet. Measured 2026-09-05: 7 of 7 reporting modules already report from
a ``finally`` and none is bypassed, so this guard fixes nothing — it keeps a
property that is currently true from quietly stopping being true.

## Why the five ``parse_*`` handlers are not in the expected set

They are Pub/Sub PUSH handlers (``handle()``, not ``main()``), fanned out per
filing by the detector, and they issue no writer call of their own. A freshness
metric per filing is not a thing an operator can read, and their liveness is
already covered: ``apply-monitors.sh`` monitors ``edgar-detect``, which is what
notices when the fan-out stops. Recorded here rather than left implicit, because
the next reader's question is why the list is 7 and not 12.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parents[1] / "app"

#: Modules expected to report an outcome, measured 2026-09-05.
#:
#: Shrinking this set is a real change — a job that stops reporting goes dark to
#: every monitor — so it must be a deliberate edit rather than a silent drift.
EXPECTED_REPORTERS: frozenset[str] = frozenset(
    {
        "bulk/companyfacts.py",
        "bulk/ftd.py",
        "bulk/ownership_backfill.py",
        "bulk/submissions.py",
        "bulk/xbrl_backfill.py",
        "jobs/detect.py",
        "jobs/evict.py",
    }
)

#: Modules that legitimately report nothing, with the reason. An entry here is a
#: claim that nothing downstream needs the module's outcome — see the header.
NON_REPORTERS: dict[str, str] = {
    "bulk/backfill_logic.py": "pure logic, no run of its own",
    "bulk/common.py": "shared constants and helpers",
    "bulk/enqueue_logic.py": "pure selection logic",
    "jobs/parse_13dg.py": "push handler, per-filing; liveness via edgar-detect",
    "jobs/parse_13f.py": "push handler, per-filing; liveness via edgar-detect",
    "jobs/parse_8k.py": "push handler, per-filing; liveness via edgar-detect",
    "jobs/parse_financials.py": "push handler, per-filing; liveness via edgar-detect",
    "jobs/parse_ownership.py": "push handler, per-filing; liveness via edgar-detect",
}

CALL_NAME = "report_job_outcome"


def _modules() -> list[Path]:
    return sorted(
        p
        for p in list((APP / "bulk").glob("*.py")) + list((APP / "jobs").glob("*.py"))
        if p.name != "__init__.py"
    )


def _rel(path: Path) -> str:
    return str(path.relative_to(APP))


def _is_report_call(node: ast.AST) -> bool:
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    return (getattr(func, "id", None) or getattr(func, "attr", None)) == CALL_NAME


def _report_calls(tree: ast.AST) -> list[ast.Call]:
    return [n for n in ast.walk(tree) if _is_report_call(n)]


def _report_calls_in_finally(tree: ast.AST) -> list[ast.Call]:
    """Calls sitting in the ``finalbody`` of some ``try``, at any depth."""
    found: list[ast.Call] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Try):
            for stmt in node.finalbody:
                found.extend(n for n in ast.walk(stmt) if _is_report_call(n))
    return found


def _tree(path: Path) -> ast.Module:
    return ast.parse(path.read_text())


def test_premise_the_scan_resolved_the_modules() -> None:
    """A scan over nothing passes every assertion below it."""
    found = {_rel(p) for p in _modules()}
    assert len(found) >= 12, f"only {len(found)} modules scanned: {sorted(found)}"
    assert EXPECTED_REPORTERS <= found, sorted(EXPECTED_REPORTERS - found)


def test_premise_the_detector_finds_a_call_it_should() -> None:
    """Positive control: the finder is not simply returning empty everywhere.

    Without this, renaming ``report_job_outcome`` would make every reachability
    assertion below pass vacuously — the whole population would look like it has
    nothing to check.
    """
    calls = _report_calls(_tree(APP / "bulk" / "companyfacts.py"))
    assert calls, "the AST finder located no report call in a module that has one"


@pytest.mark.parametrize("path", _modules(), ids=_rel)
def test_a_reported_outcome_is_reached_on_every_exit(path: Path) -> None:
    """Rule 1 — if it reports, it reports from a ``finally``."""
    tree = _tree(path)
    everywhere = _report_calls(tree)
    if not everywhere:
        return  # rule 2 decides whether that is allowed
    in_finally = _report_calls_in_finally(tree)
    assert in_finally, (
        f"{_rel(path)}: {CALL_NAME} is present but reachable only on the paths that "
        "get to it. An early return or a raise then emits NOTHING, and a zero-write "
        "monitor over a series that never emits reads HEALTHY (MONEY-1328)."
    )


@pytest.mark.parametrize("path", _modules(), ids=_rel)
def test_every_module_is_classified(path: Path) -> None:
    """Rule 2 — a new module must be declared a reporter or given a reason."""
    rel = _rel(path)
    assert rel in EXPECTED_REPORTERS or rel in NON_REPORTERS, (
        f"{rel} is neither an expected reporter nor a listed non-reporter. "
        "If it runs as a job, it owes an outcome; if it does not, say why."
    )


@pytest.mark.parametrize("rel", sorted(EXPECTED_REPORTERS))
def test_an_expected_reporter_still_reports(rel: str) -> None:
    """The shrink arm. Rule 1 is silent about a report that was DELETED."""
    assert _report_calls(_tree(APP / rel)), (
        f"{rel} is an expected reporter and no longer calls {CALL_NAME}. "
        "It is now dark to every monitor; remove it from EXPECTED_REPORTERS "
        "deliberately, or restore the call."
    )


@pytest.mark.parametrize("rel", sorted(NON_REPORTERS))
def test_a_listed_non_reporter_has_not_started_reporting(rel: str) -> None:
    """The grow arm, and the reason the list carries prose.

    A module that gains an outcome has gained a monitorable surface, and its
    entry here — 'liveness via edgar-detect' — has stopped being true.
    """
    assert not _report_calls(_tree(APP / rel)), (
        f"{rel} now reports an outcome. Move it to EXPECTED_REPORTERS; its "
        f"exemption reason ({NON_REPORTERS[rel]}) no longer holds."
    )
