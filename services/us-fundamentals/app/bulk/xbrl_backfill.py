"""Statement history for every filer we list — MONEY-979.

    python -m app.bulk.xbrl_backfill --from-fy=2020 --to-fy=2026 \\
        [--ciks=a,b] [--tasks=N] [--task-index=I] [--apply]

Walks ``us_filings`` — which the nightly ``submissions.zip`` job stocks — for
each in-universe filer's 10-K / 10-Q / 20-F / 40-F inside a fiscal-year window,
fetches each bundle ARCHIVE-FIRST and hands it to the one parse seam,
``app.parsers.dispatch.parse_and_store(..., parse_class="FINANCIALS")``. Nothing
here parses anything itself; a second statement parser is the thing this service
is built to not have.

## Run it AFTER submissions, or it walks an empty table and calls that success

The universe is the intersection of two facts we already hold: a CIK on an
ACTIVE ``us_instruments`` row (we list the security) and a ``us_filers`` row with
``inUniverse`` (the ledger has seen the filer). If ``us_filers`` is empty because
the submissions job has not run, the intersection is empty — and an empty walk
that exits 0 having selected nothing is byte-identical to a converged one. So
both component counts are reported and the run is named ``UNIVERSE_EMPTY``
rather than left to look healthy.

## The checkpoint is the whole performance argument, and it skips BEFORE the fetch

One checkpoint per ``(cik10, fiscal_year)``. A re-run must be nearly free, and
"nearly free" is only true if a DONE unit costs no SEC request — so the DONE set
is consulted before the filings query and before any fetch, and when EVERY unit
of a filer is DONE the filer is skipped without touching ``us_filings`` at all.
``tests/test_xbrl_backfill.py`` asserts the fetcher was called ZERO times on a
fully-checkpointed re-run, and the mutation that moves the check after the fetch
turns that assertion red.

A checkpoint is written ONLY on the branch that wrote rows. With
``--apply`` off the job still selects, fetches, parses and counts — but a
checkpoint beside zero rows marks the unit converged forever and the next armed
run skips it, which is the MONEY-1235 defect (a suppressed create stamped as
decided).

## Sharding is SHA-256, not ``hash()``

See :func:`app.bulk.backfill_logic.shard_of`. Python salts string hashing per
process, so ``hash(cik) % tasks`` gives two Cloud Run tasks of one execution two
different partitions — filers walked twice, filers never walked, every task
reporting a clean run.
"""

from __future__ import annotations

from app.logging_setup import install_logging

# Installed HERE, at module scope, and NOT inside `main()` — which is where all
# five of these jobs used to call it. `logging_setup` requires it to be the
# first statement for a reason a later call cannot recover: a record emitted
# while the imports below run (an `edgar` warning, a `pymongo` or `ddtrace`
# startup line) reaches Python's lastResort stderr handler with no filter
# attached, and boot-time failures are exactly the ones that still have
# credentials on them. `tests/test_logging_install_sites.py` enforces the
# placement for every entry point so a sixth job cannot regress it.
install_logging()

import argparse  # noqa: E402
import logging  # noqa: E402
from collections.abc import Callable, Iterable, Mapping, Sequence  # noqa: E402
from dataclasses import dataclass  # noqa: E402
from datetime import UTC, date, datetime  # noqa: E402
from typing import Any  # noqa: E402

from pymongo import UpdateOne  # noqa: E402

from app import db as db_module  # noqa: E402
from app import settings  # noqa: E402
from app.bulk.backfill_logic import (  # noqa: E402
    FINANCIALS_FORMS,
    XBRL_BUDGET_SECONDS,
    BackfillRunResult,
    budget_seconds,
    fiscal_year_of,
    fiscal_years,
    select_shard,
    validate_shard,
)
from app.bulk.common import (  # noqa: E402
    CHECKPOINT_COLLECTION,
    CHECKPOINT_DONE,
    CHECKPOINT_EMPTY,
    CHECKPOINT_ERROR,
    STATUS_BUDGET_EXHAUSTED,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_WRITE_DISARMED,
    RunBudget,
    ensure_checkpoint_indexes,
    install_sec_limiter,
    load_universe,
)
from app.logging_setup import log_error  # noqa: E402
from app.parsers import dispatch  # noqa: E402
from app.sec.client import SecClient  # noqa: E402
from app.sec.edgar_adapter import cik10 as normalise_cik  # noqa: E402
from app.sec.errors import SecEgressDisabled, SecError, SecNotFound, SecTransportError  # noqa: E402
from app.store import writers  # noqa: E402
from app.store.collections import collection_name  # noqa: E402
from app.store.models import STATUS_PARSED, utc_now  # noqa: E402
from app.store.outcome import report_job_outcome  # noqa: E402
from app.store.writers import WriteResult, write_operations  # noqa: E402

logger = logging.getLogger("us-fundamentals.bulk.xbrl-backfill")

#: Datadog ``job:`` tag and the Cloud Run job name minus the env suffix.
JOB_NAME = "edgar-xbrl-backfill"

#: ``backfill_checkpoints.jobKey``. Shorter than the job name on purpose: it is
#: the WALK's identity, and a second entry point over the same units (a repair
#: script, a narrowed re-run) must share it or the skip stops working.
CHECKPOINT_JOB_KEY = "edgar-xbrl"

#: Named because a bare ``"UNIVERSE_EMPTY"`` in three places drifts.
REASON_UNIVERSE_EMPTY = "UNIVERSE_EMPTY"

#: The parse seam's class for a statement filing.
PARSE_CLASS = "FINANCIALS"

#: Fetch failures that are about ONE filing and must not stop the walk. Every
#: other ``SecError`` — a rate block, an identity rejection, egress switched
#: off — is about the FLEET and propagates: continuing would spend the rest of
#: the budget issuing requests into a host that has already said no, and SEC's
#: documented remedy for a block is ten quiet minutes, not a retry.
PER_FILING_SEC_ERRORS = (SecNotFound, SecTransportError)


@dataclass(frozen=True, slots=True)
class UnitCheckpoint:
    """One ``(cik10, fiscal_year)`` unit's checkpoint row."""

    item_key: str
    scope: str
    status: str = CHECKPOINT_DONE
    detail: str = ""
    rows: int = 0


# ── Reads ───────────────────────────────────────────────────────────────────


def load_backfill_universe(db: Any) -> tuple[list[str], int, int]:
    """``(ciks, listed, filers)`` — the intersection and BOTH of its inputs.

    Returning the component counts is the point. An empty result has two
    completely different causes — no ACTIVE US instruments, or a ``us_filers``
    table the submissions job has never populated — and the fix is different for
    each. A bare ``0`` cannot tell them apart, and a job that reports ``0``
    without saying why is the shape this whole service exists to make impossible.
    """
    listed = load_universe(db).ciks
    cursor = db[collection_name("filers")].find({"inUniverse": True}, {"cik10": 1})
    filers = {normalise_cik(row.get("cik10")) for row in cursor if row.get("cik10")}
    filers.discard("")
    return sorted(listed & filers), len(listed), len(filers)


def load_done_units(db: Any, job_key: str = CHECKPOINT_JOB_KEY) -> set[tuple[str, str]]:
    """``{(cik10, "2024"), ...}`` for finished units. ONE query, not one per unit.

    Only ``DONE`` rows. An ``ERROR`` checkpoint records that the unit was
    ATTEMPTED, not that it succeeded; returning it here would make one bad night
    permanent — the unit skipped by every later run, the failure never retried
    and never reported again.
    """
    ensure_checkpoint_indexes(db)
    cursor = db[CHECKPOINT_COLLECTION].find(
        {"jobKey": job_key, "status": CHECKPOINT_DONE}, {"itemKey": 1, "scope": 1}
    )
    return {
        (str(row.get("itemKey") or ""), str(row.get("scope") or ""))
        for row in cursor
        if row.get("itemKey")
    }


def write_units(
    db: Any, entries: Sequence[UnitCheckpoint], *, job_key: str = CHECKPOINT_JOB_KEY
) -> WriteResult:
    """Upsert unit checkpoints on ``(jobKey, itemKey, scope)``.

    ``scope`` carries the fiscal year, which is why this is not
    ``app.bulk.common.write_checkpoints`` — that one pins ``scope`` to the empty
    string because its jobs have no second dimension. On a MongoDB unique index
    an ABSENT field compares equal to every other absent one, so a walk that
    omitted the scope would collapse every fiscal year of a filer onto one row
    and skip the whole filer after its first year.
    """
    if not entries:
        return WriteResult()
    now = utc_now()
    operations = [
        UpdateOne(
            {"jobKey": job_key, "itemKey": entry.item_key, "scope": entry.scope},
            {
                "$set": {
                    "status": entry.status,
                    "detail": entry.detail,
                    "rows": int(entry.rows),
                    "at": now,
                }
            },
            upsert=True,
        )
        for entry in entries
    ]
    result = WriteResult()
    for start in range(0, len(operations), writers.DEFAULT_CHUNK):
        result = result + write_operations(
            db[CHECKPOINT_COLLECTION], operations[start : start + writers.DEFAULT_CHUNK]
        )
    return result


def filings_by_fiscal_year(
    db: Any, cik10: str, *, from_fy: int, to_fy: int
) -> dict[int, list[dict[str, Any]]]:
    """One filer's statement filings, grouped by the fiscal year they REPORT ON.

    The fiscal year cannot be a Mongo filter: it is derived (``periodOfReport``
    first, ``filedAt`` only as a fallback — a 10-K is filed two to three months
    after the year it covers, so the filing date alone both invents a year and
    loses one). So the query narrows on CIK and form, which is small — a
    long-lived filer has a few hundred of these — and the window is applied in
    Python where the derivation lives.
    """
    cursor = db[collection_name("filings")].find(
        {"cik10": cik10, "form": {"$in": sorted(FINANCIALS_FORMS)}},
        {
            "_id": 0,
            "accession": 1,
            "cik10": 1,
            "form": 1,
            "filedAt": 1,
            "periodOfReport": 1,
            "status": 1,
        },
    )
    grouped: dict[int, list[dict[str, Any]]] = {}
    for row in cursor:
        fiscal_year = fiscal_year_of(
            _as_date(row.get("periodOfReport")), _as_date(row.get("filedAt"))
        )
        if fiscal_year is None or not from_fy <= fiscal_year <= to_fy:
            continue
        grouped.setdefault(fiscal_year, []).append(row)
    for filings in grouped.values():
        # ASCENDING by accession: a deterministic order, so two runs over the
        # same unit fetch in the same sequence and a budget stop leaves the same
        # remainder.
        filings.sort(key=lambda row: str(row.get("accession") or ""))
    return grouped


def _as_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return date.fromisoformat(value.strip()[:10])
        except ValueError:
            return None
    return None


# ── The walk ────────────────────────────────────────────────────────────────


def default_fetch_bundle(cik10: str, accession: str) -> bytes:
    """Archive-first, through T3's client. One client per run, not per filing."""
    with SecClient.from_settings() as client:
        return client.fetch_bundle(cik10, accession)


def run(
    *,
    db: Any,
    fetch_bundle: Callable[[str, str], bytes],
    from_fy: int,
    to_fy: int,
    ciks: Iterable[str] | None = None,
    tasks: int = 1,
    task_index: int = 0,
    apply_writes: bool | None = None,
    budget: RunBudget | None = None,
    parse: Callable[..., Mapping[str, Any]] | None = None,
    writer: Any = None,
    lookups: Any = None,
    now: datetime | None = None,
) -> BackfillRunResult:
    """One pass. Every collaborator is injectable so a test drives THIS code."""
    validate_shard(tasks, task_index)
    years = fiscal_years(from_fy, to_fy)
    applying = settings.parse_apply() if apply_writes is None else bool(apply_writes)
    clock = budget or RunBudget(budget_seconds(XBRL_BUDGET_SECONDS))
    parse_and_store = parse or dispatch.parse_and_store
    stamped = now or utc_now()

    counters = {
        "universeListed": 0,
        "universeFilers": 0,
        "universeSelected": 0,
        "filersWalked": 0,
        "filersSkipped": 0,
        "unitsSkipped": 0,
        "unitsEmpty": 0,
        "unitsDone": 0,
        "unitsError": 0,
        "filingsAlreadyParsed": 0,
        "filingsParsed": 0,
        "filingsFailed": 0,
        "scope": 0,
    }

    if ciks is not None:
        explicit = [normalise_cik(c) for c in ciks]
        universe = select_shard([c for c in explicit if c], tasks=tasks, task_index=task_index)
        counters["universeListed"] = len(explicit)
        counters["universeFilers"] = len(explicit)
    else:
        resolved, listed, filers = load_backfill_universe(db)
        counters["universeListed"] = listed
        counters["universeFilers"] = filers
        universe = select_shard(resolved, tasks=tasks, task_index=task_index)
    counters["universeSelected"] = len(universe)
    counters["scope"] = len(universe) * len(years)

    if not universe:
        # NAMED. `selected=0, written=0` with no reason is exactly what a healthy
        # converged run looks like, and the two must never be confusable.
        return BackfillRunResult(
            status=STATUS_COMPLETED,
            skipped_reason=REASON_UNIVERSE_EMPTY,
            counters=counters,
        )

    done = load_done_units(db)
    active_writer = writer
    if applying and active_writer is None:
        active_writer = dispatch.resolve_writer()
    active_lookups = lookups if lookups is not None else dispatch.resolve_lookups()

    selected = 0
    written = 0
    failed = 0
    transport_failures = 0
    pending_checkpoints: list[UnitCheckpoint] = []
    status = STATUS_COMPLETED

    try:
        for cik in universe:
            if clock.exhausted():
                status = STATUS_BUDGET_EXHAUSTED
                break

            # SKIP BEFORE THE FETCH — and before the filings query. This is the whole
            # reason a re-run is nearly free, and `tests/test_xbrl_backfill.py`
            # asserts the fetcher saw ZERO calls on a fully-checkpointed re-run.
            outstanding = [fy for fy in years if (cik, str(fy)) not in done]
            if not outstanding:
                counters["filersSkipped"] += 1
                counters["unitsSkipped"] += len(years)
                continue

            counters["unitsSkipped"] += len(years) - len(outstanding)
            counters["filersWalked"] += 1
            grouped = filings_by_fiscal_year(db, cik, from_fy=from_fy, to_fy=to_fy)

            for fiscal_year in outstanding:
                if clock.exhausted():
                    status = STATUS_BUDGET_EXHAUSTED
                    break

                filings = grouped.get(fiscal_year, [])
                if not filings:
                    # EMPTY, not DONE. A fiscal year with no filings TODAY may have
                    # them after the next submissions run, and `load_done_units`
                    # returns DONE only — so this row is triage information and
                    # never a skip. Re-examining it costs one grouped read, no fetch.
                    counters["unitsEmpty"] += 1
                    if applying:
                        pending_checkpoints.append(
                            UnitCheckpoint(
                                item_key=cik,
                                scope=str(fiscal_year),
                                status=CHECKPOINT_EMPTY,
                                detail="no filings in window",
                            )
                        )
                    continue

                unit_written = 0
                unit_parsed = 0
                unit_failed = False
                for filing in filings:
                    accession = str(filing.get("accession") or "").strip()
                    if not accession:
                        continue
                    if str(filing.get("status") or "") == STATUS_PARSED:
                        counters["filingsAlreadyParsed"] += 1
                        continue

                    selected += 1
                    filer_cik = normalise_cik(filing.get("cik10")) or cik
                    try:
                        bundle = fetch_bundle(filer_cik, accession)
                    except PER_FILING_SEC_ERRORS as err:
                        # AFTER the call it counts. A counter bumped before the
                        # request reports a full number for a source that refuses
                        # every one of them (MONEY-1255).
                        transport_failures += 1
                        unit_failed = True
                        log_error(f"[xbrl-backfill] {cik}/{accession}: bundle unavailable", err)
                        continue

                    outcome = parse_and_store(
                        accession,
                        bundle,
                        parse_class=PARSE_CLASS,
                        cik10=filer_cik,
                        form=str(filing.get("form") or "") or None,
                        writer=active_writer,
                        lookups=active_lookups,
                        apply=applying,
                        now=stamped,
                    )
                    unit_written += int(outcome.get("written") or 0)
                    row_failures = int(outcome.get("failed") or 0)
                    failed += row_failures
                    if row_failures:
                        unit_failed = True
                        counters["filingsFailed"] += 1
                    else:
                        unit_parsed += 1
                        counters["filingsParsed"] += 1

                written += unit_written
                if unit_failed:
                    counters["unitsError"] += 1
                else:
                    counters["unitsDone"] += 1
                if applying:
                    pending_checkpoints.append(
                        UnitCheckpoint(
                            item_key=cik,
                            scope=str(fiscal_year),
                            status=CHECKPOINT_ERROR if unit_failed else CHECKPOINT_DONE,
                            detail=f"{unit_parsed}/{len(filings)} parsed",
                            rows=unit_written,
                        )
                    )
                    if len(pending_checkpoints) >= writers.DEFAULT_CHUNK:
                        write_units(db, pending_checkpoints)
                        pending_checkpoints = []

            if status == STATUS_BUDGET_EXHAUSTED:
                break

    finally:
        # In `finally` for the same reason as the ownership walk (MONEY-1280):
        # an exception escaping the loop used to skip this flush, discarding
        # every unit finished since the last in-loop write. Bounded here — the
        # in-loop flush is over FILINGS and 500 is reachable — but the units it
        # loses were paid for with requests against SEC's shared per-IP budget,
        # and a resumed run must never re-buy work it already did.
        if applying and pending_checkpoints:
            write_units(db, pending_checkpoints)

    if not applying and status == STATUS_COMPLETED:
        status = STATUS_WRITE_DISARMED

    if status == STATUS_BUDGET_EXHAUSTED:
        logger.info(
            "[xbrl-backfill] budget exhausted after %.0fs; %d units done, re-run to resume",
            clock.elapsed(),
            counters["unitsDone"],
        )

    return BackfillRunResult(
        status=status,
        selected=selected,
        written=written,
        failed=failed,
        transport_failures=transport_failures,
        skipped_reason=STATUS_WRITE_DISARMED if not applying else None,
        counters=counters,
    )


# ── CLI ─────────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.bulk.xbrl_backfill")
    parser.add_argument("--from-fy", type=int, default=2020, help="First fiscal year (inclusive).")
    parser.add_argument(
        "--to-fy",
        type=int,
        default=datetime.now(UTC).year,
        help="Last fiscal year (inclusive). Defaults to the current UTC year.",
    )
    parser.add_argument(
        "--ciks",
        default="",
        help="Comma-separated cik10 list. Overrides the universe; use gcloud's ^:^ escape.",
    )
    parser.add_argument("--tasks", type=int, default=1, help="Total shards.")
    parser.add_argument("--task-index", type=int, default=0, help="This shard, 0-based.")
    parser.add_argument(
        "--apply",
        action="store_true",
        help=(
            "Write. Without it the job fetches, parses and counts but stores nothing "
            "AND checkpoints nothing, so the armed run re-selects every unit."
        ),
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point. Returns the process exit code."""
    args = build_parser().parse_args(argv)
    explicit = [c.strip() for c in args.ciks.split(",") if c.strip()] or None

    # `--apply` MAY ARM, unlike a Pub/Sub message. These jobs carry no Scheduler
    # trigger and no `EDGAR_PARSE_APPLY` in their Cloud Run spec, so the only
    # thing that can arm them is a human typing the flag on one execution —
    # which is the deliberate operator decision the env flag exists to represent
    # everywhere else.
    applying = bool(args.apply) or settings.parse_apply()

    result = BackfillRunResult(status=STATUS_FAILED, skipped_reason="DID_NOT_RUN")
    try:
        database = db_module.get_database()
        if database is None:
            raise RuntimeError("DATABASE_URL is not set; refusing to run with nowhere to write")
        # A Cloud Run JOB is its own process and does not share the service's
        # lifespan, so it installs its own shared 9 req/s budget. Without this
        # the first fetch raises LimiterUnavailable, which the handler below
        # classifies as a deterministic upstream refusal — a clean-looking run
        # that fetched nothing.
        install_sec_limiter()
        with SecClient.from_settings() as client:
            result = run(
                db=database,
                fetch_bundle=client.fetch_bundle,
                from_fy=args.from_fy,
                to_fy=args.to_fy,
                ciks=explicit,
                tasks=args.tasks,
                task_index=args.task_index,
                apply_writes=applying,
            )
    except SecEgressDisabled as err:
        result = BackfillRunResult(
            status=STATUS_FAILED, transport_failures=1, skipped_reason="SEC_EGRESS_DISABLED"
        )
        log_error("[xbrl-backfill] SEC egress is disabled in this environment", err)
    except SecError as err:
        result = BackfillRunResult(
            status=STATUS_FAILED, transport_failures=1, skipped_reason=type(err).__name__
        )
        log_error("[xbrl-backfill] upstream refusal — stopping rather than retrying", err)
    except Exception as err:
        result = BackfillRunResult(status=STATUS_FAILED, skipped_reason=type(err).__name__)
        log_error("[xbrl-backfill] run failed", err)
    finally:
        # In `finally`: a job that raises before reporting is invisible in
        # exactly the dimension this metric measures.
        report_job_outcome(
            JOB_NAME,
            selected=result.selected,
            written=result.written,
            failed=result.failed,
            transport_failures=result.transport_failures,
            skipped_reason=result.skipped_reason or result.status,
        )
        logger.info("[xbrl-backfill] %s", result.as_dict())
    return result.exit_code


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
