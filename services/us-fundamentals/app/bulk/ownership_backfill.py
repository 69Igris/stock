"""The daily-index day walk — MONEY-979.

    python -m app.bulk.ownership_backfill --class=ownership \\
        --from-date=2021-01-01 --to-date=2026-08-29 [--apply]

Three walks, one shape. ``--class ownership`` is Forms 3/4/5 (~1.4M filings and
EXPECTED to span several 24-hour executions), ``--class 13f`` is 13F-HR/NT and
``--class 13dg`` is Schedule 13D/G in BOTH its spellings — the legacy ``SC 13D``
and the ``SCHEDULE 13D`` SEC's 2024-12-18 XML mandate introduced. The class is
never a form list of ours: rows are routed through
``app.store.models.parse_class``, the one form table in this tree.

## A daily ``form.idx`` is a DISSEMINATION-day index, and that is not pedantry

Measured on ``form.20220214.idx``:

* **19,412 rows are 11,870 filings.** There is one row per FILER, not per
  filing — a co-registered S-3ASR occupies sixteen, each with its own CIK and
  its own path. A walk that treats rows as filings fans out 1.6x and fetches one
  bundle sixteen times, against a shared 9 req/s fleet budget.
* **198 rows (1.0%) carry an earlier filing date**, reaching back nine months to
  2021-05-21. ``filedAt`` therefore comes from THE ROW and never from the date
  in the filename we asked for. That failure is silent: the row lands with a
  plausible date, in the wrong period, and nothing anywhere disagrees.

Both are enforced in ``app.bulk.backfill_logic.select_index_filings``, both are
asserted, and both mutations go red.

## NO_INDEX is a NAMED outcome, not a failure and not a success

SEC disseminates nothing on a Saturday or a Sunday. That rule is deterministic
and permanent, so a weekend is skipped WITHOUT a request. A holiday is not
predictable, so it is not guessed at: the day reports ABSENT and is recorded as
``NO_INDEX`` with an ``EMPTY`` checkpoint — deliberately NOT ``DONE``, because
"SEC has not published this day yet" and "SEC will never publish this day" are
indistinguishable here and only one of them is permanent. Checkpointing the
first as finished is how today's missing index becomes a hole nobody comes back
for.

**Absent is two status codes.** This said "the day 404s" for one release and it
was wrong: sec.gov's archive bucket denies ``ListBucket``, so a key that does not
exist answers **403 with an S3 ``AccessDenied`` body**, not 404. EVERY US market
holiday is that shape. Catching only 404 left the ``NO_INDEX`` branch below
unreachable for the exact case it was written for, and the first 5-year run died
on Labor Day 2021 having walked five days (MONEY-1279). Both codes now arrive as
:class:`~app.sec.errors.SecNotFound`.

## The index is archived before it is parsed

``edgar/bulk/daily-index/{YYYY-MM-DD}/form.{YYYYMMDD}.idx``, read archive-first
exactly like a filing bundle. A re-walk (a new class, a mapping change) re-reads
our own object, and QA — which runs with ``SEC_EGRESS=off`` — can replay prod's
bytes instead of being unable to run the walk at all.
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
from collections.abc import Callable, Mapping, Sequence  # noqa: E402
from datetime import date, datetime  # noqa: E402
from typing import Any  # noqa: E402

from app import db as db_module  # noqa: E402
from app import settings  # noqa: E402
from app.bulk.backfill_logic import (  # noqa: E402
    OWNERSHIP_BUDGET_SECONDS,
    BackfillRunResult,
    IndexFiling,
    budget_seconds,
    daily_index_key,
    daily_index_url,
    day_key,
    parse_class_for_alias,
    publishes_index,
    select_index_filings,
    walk_days,
)
from app.bulk.common import (  # noqa: E402
    CHECKPOINT_DONE,
    CHECKPOINT_EMPTY,
    CHECKPOINT_ERROR,
    STATUS_BUDGET_EXHAUSTED,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_WRITE_DISARMED,
    CheckpointEntry,
    RunBudget,
    install_sec_limiter,
    load_checkpoints,
    write_checkpoints,
)
from app.logging_setup import log_error  # noqa: E402
from app.parsers import dispatch  # noqa: E402
from app.sec import archive  # noqa: E402
from app.sec.client import SecClient  # noqa: E402
from app.sec.edgar_adapter import parse_daily_index  # noqa: E402
from app.sec.errors import SecEgressDisabled, SecError, SecNotFound, SecTransportError  # noqa: E402
from app.store import writers  # noqa: E402
from app.store.models import STATUS_INDEXED, UsFilingRow, parse_class, utc_now  # noqa: E402
from app.store.outcome import report_job_outcome  # noqa: E402

logger = logging.getLogger("us-fundamentals.bulk.ownership-backfill")

#: Fetch failures that are about ONE filing. Every other ``SecError`` is about
#: the FLEET — a rate block, an identity rejection, egress off — and propagates,
#: because continuing would spend the rest of the budget on a host that has
#: already refused and whose documented remedy is ten quiet minutes.
PER_FILING_SEC_ERRORS = (SecNotFound, SecTransportError)

#: The day produced no index file. NOT a failure; SEC publishes none.
REASON_NO_INDEX = "NO_INDEX"

#: How many finished DAYS may sit unflushed. Deliberately NOT
#: ``writers.DEFAULT_CHUNK`` (500), which is sized for ROWS: a 23h budget covers
#: ~300 days, so a 500-day threshold could never be reached and every checkpoint
#: waited for the end of the run. Ten days bounds the worst-case loss of an
#: aborted run to roughly an hour of walking instead of all of it (MONEY-1280).
CHECKPOINT_FLUSH_DAYS = 10


def job_name(alias: str) -> str:
    """Datadog ``job:`` tag.

    Per CLASS, not per Cloud Run job. All three walks execute under the one
    ``edgar-ownership-backfill-{env}`` job, and a zero-write monitor over a
    single merged series could never tell a silent Form 4 walk from a healthy
    13F one.
    """
    return f"edgar-{alias}-backfill"


def checkpoint_job_key(alias: str) -> str:
    """``backfill_checkpoints.jobKey``. One namespace per class, keyed by DAY."""
    return f"edgar-{alias}-day"


def default_fetch_index(client: Any, day: date) -> str | None:
    """One day's ``form.idx``, ARCHIVE FIRST. ``None`` means SEC published none.

    Mirrors :meth:`app.sec.client.SecClient.fetch_bundle`: read our own object,
    and on a miss fetch once and write it back.

    ONLY an ABSENCE becomes ``None`` — every other refusal propagates, so a rate
    block can never be recorded as "SEC published nothing that day". Absence is
    two status codes: a 404, and the **403 carrying an S3 ``AccessDenied`` body**
    that the archive returns for a key that does not exist. Both are
    :class:`~app.sec.errors.SecNotFound` — :class:`~app.sec.errors.SecArchiveAbsent`
    subclasses it — so the ``except`` below covers both by construction, and a
    genuine identity or rate block still propagates because
    :func:`~app.sec.errors.classify_sec_response` tests those markers FIRST.
    """
    key = daily_index_key(day)
    cached = archive.read_bytes(key)
    if cached is not None:
        return cached.decode("utf-8", "replace")
    try:
        data = client.get(daily_index_url(day))
    except SecNotFound:
        return None
    archive.write_bytes(key, data, content_type=archive.BUNDLE_CONTENT_TYPE)
    return data.decode("utf-8", "replace")


def build_filing_rows(
    filings: Sequence[IndexFiling], *, now: datetime | None = None
) -> list[UsFilingRow]:
    """``us_filings`` rows for one day's selected filings. PURE.

    ``filedAt`` is ``filing.filed_at`` — THE ROW's date. ``status`` is
    ``INDEXED`` and is written INSERT-ONLY by
    :func:`app.store.writers.upsert_filings`, so a filing a detector already saw
    keeps ``DETECTED`` and one a parser already finished keeps ``PARSED``: the
    backfill fills gaps and never downgrades what the live path recorded.
    """
    stamp = now or utc_now()
    return [
        UsFilingRow(
            accession=filing.accession,
            cik10=filing.cik10,
            form=filing.form,
            filedAt=filing.filed_at,
            parseClass=parse_class(filing.form),
            status=STATUS_INDEXED,
            ingestedAt=stamp,
            updatedAt=stamp,
        )
        for filing in filings
    ]


def run(
    *,
    db: Any,
    cls: str,
    from_date: date,
    to_date: date,
    fetch_index: Callable[[date], str | None],
    fetch_bundle: Callable[[str, str], bytes],
    apply_writes: bool | None = None,
    budget: RunBudget | None = None,
    parse: Callable[..., Mapping[str, Any]] | None = None,
    writer: Any = None,
    lookups: Any = None,
    now: datetime | None = None,
) -> BackfillRunResult:
    """One pass over ``[from_date, to_date]``. Every collaborator is injectable."""
    wanted_class = parse_class_for_alias(cls)
    job_key = checkpoint_job_key(cls.strip().lower())
    applying = settings.parse_apply() if apply_writes is None else bool(apply_writes)
    clock = budget or RunBudget(budget_seconds(OWNERSHIP_BUDGET_SECONDS))
    parse_and_store = parse or dispatch.parse_and_store
    stamped = now or utc_now()

    counters = {
        "daysInWindow": 0,
        "daysWalked": 0,
        "daysSkipped": 0,
        "daysNoIndex": 0,
        "weekendsSkipped": 0,
        "indexRows": 0,
        "indexFilings": 0,
        "filingsIndexed": 0,
        "filingsParsed": 0,
        "filingsFailed": 0,
    }

    done = load_checkpoints(db, job_key)
    active_writer = writer
    if applying and active_writer is None:
        active_writer = dispatch.resolve_writer()
    active_lookups = lookups if lookups is not None else dispatch.resolve_lookups()

    selected = 0
    written = 0
    failed = 0
    transport_failures = 0
    finished: list[CheckpointEntry] = []
    status = STATUS_COMPLETED

    try:
        for day in walk_days(from_date, to_date):
            counters["daysInWindow"] += 1
            if clock.exhausted():
                status = STATUS_BUDGET_EXHAUSTED
                break

            item = day_key(day)
            # BEFORE the fetch. A finished day must cost nothing — no index request,
            # no bundle request — or a resumed 1.4M-filing walk is not a resume.
            if item in done:
                counters["daysSkipped"] += 1
                continue

            if not publishes_index(day):
                # Deterministic and permanent: no request, and no checkpoint either.
                # 260 Saturdays a walk does not need 260 checkpoint writes to know.
                counters["weekendsSkipped"] += 1
                continue

            text = fetch_index(day)
            if text is None:
                # NAMED, counted, and checkpointed EMPTY — never DONE. `load_checkpoints`
                # returns DONE rows only, so tomorrow's run asks again: a holiday
                # costs one 404 per run, while a day SEC had simply not published yet
                # is still reachable.
                counters["daysNoIndex"] += 1
                if applying:
                    finished.append(
                        CheckpointEntry(
                            item_key=item, detail=REASON_NO_INDEX, status=CHECKPOINT_EMPTY
                        )
                    )
                continue

            counters["daysWalked"] += 1
            rows = parse_daily_index(text)
            counters["indexRows"] += len(rows)
            filings = select_index_filings(rows, wanted_class)
            counters["indexFilings"] += len(filings)

            if applying and filings:
                # BEFORE the parse. `mark_filing_status` is UPDATE-ONLY by design —
                # it must never create a row missing `form`/`filedAt`/`parseClass`,
                # which are REQUIRED in Prisma — so a parse that ran first would
                # stamp a status onto nothing and report a clean write.
                indexed = writers.upsert_filings(db, build_filing_rows(filings, now=stamped))
                counters["filingsIndexed"] += indexed.written
                written += indexed.written

            day_failed = False
            for filing in filings:
                if clock.exhausted():
                    # Mid-day. The day is deliberately NOT checkpointed, so the
                    # resumed run redoes it — cheap, because every bundle it already
                    # fetched is archived and every write is an idempotent upsert.
                    status = STATUS_BUDGET_EXHAUSTED
                    day_failed = True
                    break

                selected += 1
                try:
                    bundle = fetch_bundle(filing.cik10, filing.accession)
                except PER_FILING_SEC_ERRORS as err:
                    # Counted AFTER the call it counts.
                    transport_failures += 1
                    day_failed = True
                    log_error(f"[{cls}-backfill] {filing.accession}: bundle unavailable", err)
                    continue

                outcome = parse_and_store(
                    filing.accession,
                    bundle,
                    parse_class=wanted_class,
                    cik10=filing.cik10,
                    form=filing.form,
                    writer=active_writer,
                    lookups=active_lookups,
                    apply=applying,
                    now=stamped,
                )
                written += int(outcome.get("written") or 0)
                row_failures = int(outcome.get("failed") or 0)
                failed += row_failures
                if row_failures:
                    day_failed = True
                    counters["filingsFailed"] += 1
                else:
                    counters["filingsParsed"] += 1

            if status == STATUS_BUDGET_EXHAUSTED:
                break

            if applying:
                finished.append(
                    CheckpointEntry(
                        item_key=item,
                        detail=f"{counters['indexFilings']} filings",
                        status=CHECKPOINT_ERROR if day_failed else CHECKPOINT_DONE,
                        rows=len(filings),
                    )
                )
                if len(finished) >= CHECKPOINT_FLUSH_DAYS:
                    write_checkpoints(db, job_key, finished)
                    finished = []

    finally:
        # MONEY-1280 — in a `finally`, so a run that ABORTS still records every
        # day it genuinely finished. Previously an exception escaping the loop
        # skipped this flush entirely: the first wide run walked five days, threw
        # on a holiday 403 and left ZERO checkpoints, so 33 minutes of requests
        # against SEC's shared per-IP budget were spent again on the next retry.
        # It re-raises as before — a failed run must still fail.
        if applying and finished:
            write_checkpoints(db, job_key, finished)

    if not applying and status == STATUS_COMPLETED:
        status = STATUS_WRITE_DISARMED

    if status == STATUS_BUDGET_EXHAUSTED:
        logger.info(
            "[%s-backfill] budget exhausted after %.0fs; %d days done, re-run to resume",
            cls,
            clock.elapsed(),
            counters["daysWalked"],
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
    parser = argparse.ArgumentParser(prog="python -m app.bulk.ownership_backfill")
    parser.add_argument(
        "--class",
        dest="cls",
        default="ownership",
        help="ownership (Forms 3/4/5) | 13f (13F-HR/NT) | 13dg (Schedule 13D/G, both spellings).",
    )
    parser.add_argument("--from-date", required=True, help="First dissemination day (YYYY-MM-DD).")
    parser.add_argument("--to-date", required=True, help="Last dissemination day (YYYY-MM-DD).")
    parser.add_argument(
        "--apply",
        action="store_true",
        help=(
            "Write. Without it the job fetches, parses and counts but stores nothing "
            "AND checkpoints nothing, so the armed run re-walks every day."
        ),
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point. Returns the process exit code."""
    args = build_parser().parse_args(argv)
    alias = args.cls.strip().lower()
    # Validate the class BEFORE anything opens a connection: an unknown --class
    # must fail on the argv, not after a walk of the wrong several hundred
    # thousand filings under the right job name.
    parse_class_for_alias(alias)

    # `--apply` MAY ARM here. These jobs carry no Scheduler trigger and no
    # `EDGAR_PARSE_APPLY` in their Cloud Run spec, so the flag IS the deliberate
    # operator decision the env variable represents everywhere else.
    applying = bool(args.apply) or settings.parse_apply()

    job = job_name(alias)
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
                cls=alias,
                from_date=date.fromisoformat(args.from_date),
                to_date=date.fromisoformat(args.to_date),
                fetch_index=lambda day: default_fetch_index(client, day),
                fetch_bundle=client.fetch_bundle,
                apply_writes=applying,
            )
    except SecEgressDisabled as err:
        result = BackfillRunResult(
            status=STATUS_FAILED, transport_failures=1, skipped_reason="SEC_EGRESS_DISABLED"
        )
        log_error(f"[{alias}-backfill] SEC egress is disabled in this environment", err)
    except SecError as err:
        result = BackfillRunResult(
            status=STATUS_FAILED, transport_failures=1, skipped_reason=type(err).__name__
        )
        log_error(f"[{alias}-backfill] upstream refusal — stopping rather than retrying", err)
    except Exception as err:
        result = BackfillRunResult(status=STATUS_FAILED, skipped_reason=type(err).__name__)
        log_error(f"[{alias}-backfill] run failed", err)
    finally:
        report_job_outcome(
            job,
            selected=result.selected,
            written=result.written,
            failed=result.failed,
            transport_failures=result.transport_failures,
            skipped_reason=result.skipped_reason or result.status,
        )
        logger.info("[%s-backfill] %s", alias, result.as_dict())
    return result.exit_code


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
