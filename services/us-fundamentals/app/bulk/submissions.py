"""``submissions.zip`` -> ``us_filers`` + ``us_filings`` — MONEY-979.

    python -m app.bulk.submissions [--day YYYY-MM-DD] [--force]

SEC's nightly archive of every filer's whole filing index: ~15,000 members named
``CIK0000320193.json``, plus paging members ``CIK0001067983-submissions-001.json``
for filers whose history overflows the ~1,000-entry ``filings.recent`` window.
This job turns each into ONE ``us_filers`` row and N ``us_filings`` rows.

## What this job is FOR, beyond stocking a table

It is the LEDGER. Detection (T6) polls a rolling feed and will miss things — a
page turned over between polls, a run that died, an hour SEC was slow. A filing
that appears here and was never DETECTED is written as ``INDEXED``, and the count
of those is the only direct measurement of what the detection loop dropped. That
is why the status is written with ``$setOnInsert``: overwriting the status of a
filing a detector DID see would destroy the measurement while making the table
look tidier.

## Three things it deliberately does not do

* **It never writes ``us_instruments``.** A filer is one entity and a listing is
  many rows — BAC has 16 tickers against one CIK — so filer-level facts on the
  listing table would store one company's SIC code sixteen times.
* **It never treats ``tickersAsFiled`` as our universe.** SEC lists what the
  filer wrote; we list what Tiingo's master carries. Divergence is information
  (a delisting we have not seen yet), so it is stored, not reconciled away.
* **It never checkpoints a member it did not write.** With ``EDGAR_PARSE_APPLY``
  off the job still reads, parses and counts — but a checkpoint written beside
  zero rows would mark the member converged forever, and the next armed run would
  skip it. That is the MONEY-1235 defect (a suppressed create stamped as decided)
  and it is why the checkpoint write is inside the same branch as the row write.

## It never reads a member to find out it is finished — MONEY-1283

There are **988,373** members, not the ~15,000 this job was sized for, and each
one is decompressed out of a live GCS object. Deciding the skip from the group's
CENTRAL-DIRECTORY stamp instead of from a hash of its bytes is what makes a
resume O(1) per finished filer rather than one network round trip. The whole
measurement is in ``common``'s module docstring.
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
import re  # noqa: E402
from collections.abc import Callable, Iterable, Sequence  # noqa: E402
from dataclasses import dataclass  # noqa: E402
from datetime import UTC, date, datetime  # noqa: E402
from typing import IO, Any  # noqa: E402

from app import db as db_module  # noqa: E402
from app import settings  # noqa: E402
from app.bulk.common import install_sec_limiter  # noqa: E402
from app.logging_setup import log_error  # noqa: E402
from app.sec.adapter_types import FilingRef, SubmissionsFiler  # noqa: E402
from app.sec.client import SecClient  # noqa: E402
from app.sec.edgar_adapter import PARSER_VERSION, json_loads, parse_submissions_json  # noqa: E402
from app.sec.errors import SecEgressDisabled, SecError  # noqa: E402
from app.store import writers  # noqa: E402
from app.store.models import (  # noqa: E402
    ANNUAL_REPORT_FORMS,
    STATUS_INDEXED,
    UsEdgarCursorRow,
    UsFilerRow,
    UsFilingRow,
    parse_class,
    utc_now,
)
from app.store.outcome import report_job_outcome  # noqa: E402
from app.store.writers import WriteResult  # noqa: E402

from .common import (  # noqa: E402
    BULK_URLS,
    CURSOR_KEYS,
    FEED_SUBMISSIONS,
    JOB_KEYS,
    JOB_NAMES,
    STATUS_BUDGET_EXHAUSTED,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_NOT_YET_PUBLISHED,
    STATUS_WRITE_DISARMED,
    BulkRunResult,
    CheckpointEntry,
    RunBudget,
    budget_seconds,
    check_upstream,
    load_member_checkpoints,
    load_universe,
    member_unchanged,
    open_zip_archive,
    sha256_hex,
    stamp_unchanged,
    stream_zip_to_gcs,
    upgrade_checkpoint_stamps,
    write_checkpoints,
)

logger = logging.getLogger("us-fundamentals.bulk.submissions")

#: ``us_edgar_cursor.key`` the detect loop reads. Seeded here on a FIRST run so
#: detection does not start by replaying SEC's entire rolling window.
DETECT_CURSOR_KEY = "getcurrent"

#: ``CIK0000320193.json`` and ``CIK0001067983-submissions-001.json``.
#:
#: Anchored, and the CIK is exactly ten digits. A looser pattern would match
#: ``placeholder.txt`` or a future sibling file and hand it to a JSON parser as
#: if it were a filer.
_MEMBER_RE = re.compile(r"^CIK(\d{10})(?:-submissions-(\d+))?\.json$", re.IGNORECASE)

#: A filer needs this many distinct fiscal years of annual reports to be inside
#: the coverage gate's denominator. Decision 5: fewer is not a failure, it is a
#: filer whose gate reads "everything available" — a SPAC or a 2025 IPO has one
#: year and must yield that one year rather than raise.
COVERAGE_YEARS = 5


@dataclass(frozen=True, slots=True)
class MemberGroup:
    """One filer's members: the primary index plus its paging shards."""

    cik10: str
    primary: str | None
    pages: tuple[str, ...] = ()

    @property
    def names(self) -> tuple[str, ...]:
        return ((self.primary,) if self.primary else ()) + self.pages


def group_members(names: Iterable[str]) -> tuple[dict[str, MemberGroup], list[str]]:
    """``({cik10: MemberGroup}, ignored)``. PURE.

    Grouping happens up front, from the zip's CENTRAL DIRECTORY, because the two
    member kinds do not sort together: ``CIK0001067983-submissions-001.json``
    sorts BEFORE ``CIK0001067983.json`` (``-`` is 0x2D, ``.`` is 0x2E), so a job
    that processed members in name order would meet a filer's pages before its
    index and have nowhere to put them.
    """
    primaries: dict[str, str] = {}
    pages: dict[str, list[str]] = {}
    ignored: list[str] = []
    for name in names:
        base = name.rsplit("/", 1)[-1]
        match = _MEMBER_RE.match(base)
        if not match:
            ignored.append(name)
            continue
        cik, page = match.group(1), match.group(2)
        if page is None:
            primaries[cik] = name
        else:
            pages.setdefault(cik, []).append(name)
    groups = {
        cik: MemberGroup(
            cik10=cik, primary=primaries.get(cik), pages=tuple(sorted(pages.get(cik, [])))
        )
        for cik in sorted(set(primaries) | set(pages))
    }
    return groups, ignored


def page_payload(cik10: str, page: dict[str, Any]) -> dict[str, Any]:
    """Wrap a paging member so the REAL submissions parser can read it.

    A paging file is the bare set of parallel arrays — ``accessionNumber``,
    ``form``, ``filingDate``, ... — at the TOP level, with no ``filings.recent``
    around it. Wrapping rather than writing a second parser matters because
    ``parse_submissions_json`` carries the guard that makes those arrays safe:
    they are zipped to the length of the SHORTEST one, so a truncated column
    drops entries instead of shifting every later field onto the wrong filing.
    """
    return {"cik": cik10, "filings": {"recent": page}}


def annual_fiscal_years(filings: Iterable[FilingRef]) -> set[int]:
    """Distinct fiscal years with a 10-K / 20-F / 40-F. PURE.

    Computed over the UNION of a filer's primary index and its paging shards,
    which is why it is not simply taken from ``SubmissionsFiler.fiscal_years_on_file``
    — that field counts ``filings.recent`` only and is documented as a FLOOR.
    Berkshire's recent window holds 1,001 filings back to 2017; the 1,394 older
    ones, and every 10-K among them, live in a paging shard.

    The year comes from ``periodOfReport`` when SEC published one and from
    ``filedAt`` otherwise. A 10-K is filed two to three months AFTER its fiscal
    year ends, so using the filing date alone shifts most annual reports into the
    following year and can both invent a year and lose one.
    """
    years: set[int] = set()
    for filing in filings:
        if filing.form not in ANNUAL_REPORT_FORMS:
            continue
        period = filing.period_of_report or filing.filed_at
        if period is not None:
            years.add(period.year)
    return years


def build_filer_row(
    filer: SubmissionsFiler,
    filings: Sequence[FilingRef],
    *,
    in_universe: bool,
    now: datetime | None = None,
) -> UsFilerRow:
    """One ``us_filers`` row, with the coverage counters over ALL members. PURE."""
    years = annual_fiscal_years(filings)
    filed_dates = [f.filed_at for f in filings if f.filed_at is not None]
    stamp = now or utc_now()
    return UsFilerRow(
        cik10=filer.cik10,
        name=filer.name,
        sic=filer.sic,
        sicDescription=filer.sic_description,
        fiscalYearEnd=filer.fiscal_year_end,
        entityType=filer.entity_type,
        stateOfInc=filer.state_of_inc,
        formerNames=[dict(entry) for entry in filer.former_names],
        tickersAsFiled=list(filer.tickers_as_filed),
        exchangesAsFiled=list(filer.exchanges_as_filed),
        firstFilingAt=min(filed_dates) if filed_dates else filer.first_filing_at,
        latestFiledAt=max(filed_dates) if filed_dates else filer.latest_filed_at,
        inUniverse=in_universe,
        fiscalYearsOnFile=len(years),
        eligibleForCoverage=len(years) >= COVERAGE_YEARS,
        ingestedAt=stamp,
        updatedAt=stamp,
    )


def build_filing_rows(
    filings: Sequence[FilingRef], *, now: datetime | None = None
) -> list[UsFilingRow]:
    """``us_filings`` rows, deduplicated on accession. PURE.

    ``status`` is ``INDEXED`` on every row and is written INSERT-ONLY by
    :func:`app.store.writers.upsert_filings`, so a filing a detector already saw
    keeps ``DETECTED`` and one a parser already finished keeps ``PARSED``.
    """
    stamp = now or utc_now()
    seen: set[str] = set()
    rows: list[UsFilingRow] = []
    for filing in filings:
        accession = (filing.accession or "").strip()
        if not accession or accession in seen:
            continue
        seen.add(accession)
        rows.append(
            UsFilingRow(
                accession=accession,
                cik10=filing.cik10,
                form=filing.form,
                filedAt=filing.filed_at,
                acceptedAt=filing.accepted_at,
                periodOfReport=filing.period_of_report,
                items=list(filing.items),
                primaryDocument=filing.primary_document,
                isXbrl=filing.is_xbrl,
                isInlineXbrl=filing.is_inline_xbrl,
                sizeBytes=filing.size_bytes,
                parseClass=parse_class(filing.form),
                status=STATUS_INDEXED,
                ingestedAt=stamp,
                updatedAt=stamp,
            )
        )
    return rows


def run(
    *,
    db: Any,
    client: Any,
    day: date | None = None,
    force: bool = False,
    apply_writes: bool | None = None,
    budget: RunBudget | None = None,
    opener: Callable[[str], IO[bytes]] | None = None,
    archive_key: str | None = None,
) -> BulkRunResult:
    """One full pass. Every collaborator is injectable so a test drives THIS code."""
    feed = FEED_SUBMISSIONS
    job_key = JOB_KEYS[feed]
    clock = budget or RunBudget(budget_seconds(feed))
    applying = settings.parse_apply() if apply_writes is None else apply_writes

    counters = {
        "membersTotal": 0,
        "membersIgnored": 0,
        "membersSkipped": 0,
        "filersSkipped": 0,
        "filersWritten": 0,
        "filingsWritten": 0,
    }
    totals = WriteResult()
    selected = 0

    decision = check_upstream(client, BULK_URLS[feed], CURSOR_KEYS[feed], db=db, force=force)
    if not decision.should_process:
        # A named, non-failing outcome. Exit 0 and say WHY, so a morning with no
        # new file is distinguishable from a morning the job wrote nothing.
        return BulkRunResult(
            status=STATUS_NOT_YET_PUBLISHED,
            skipped_reason=STATUS_NOT_YET_PUBLISHED,
            counters=counters,
        )

    if archive_key is None:
        stream = stream_zip_to_gcs(client, feed, day=day or datetime.now(UTC).date())
        key = str(stream.get("key") or "")
    else:
        key = archive_key

    checkpoints = load_member_checkpoints(db, job_key)
    universe = load_universe(db)
    finished: list[CheckpointEntry] = []
    upgrades: dict[str, str] = {}
    latest_accepted: datetime | None = None
    latest_accession: str | None = None
    status = STATUS_COMPLETED

    with open_zip_archive(key, opener=opener) as zip_archive:
        groups, ignored = group_members(zip_archive.names())
        counters["membersTotal"] = len(groups)
        counters["membersIgnored"] = len(ignored)

        for cik, group in groups.items():
            if clock.exhausted():
                # BETWEEN members, never inside one. A half-written filer with no
                # checkpoint is a filer the resumed run cannot reason about.
                status = STATUS_BUDGET_EXHAUSTED
                logger.info(
                    "[submissions] budget exhausted after %.0fs; %d of %d members done",
                    clock.elapsed(),
                    selected + counters["membersSkipped"],
                    len(groups),
                )
                break

            if group.primary is None:
                counters["filersSkipped"] += 1
                logger.warning("[submissions] %s: paging members with no index", cik)
                continue

            previous = checkpoints.get(cik)
            # BEFORE any read. `group_stamp` is a dict lookup into the central
            # directory `zipfile` parsed when the archive opened, so recognising
            # an already-finished filer costs ZERO GCS requests. This used to be
            # decided AFTER decompressing every member, which made a resume cost
            # one download per member already done — 1,691/min against 988,373
            # members, so the walk stalled at 25.7% and never reached the rest
            # (MONEY-1283).
            stamp = zip_archive.group_stamp(group.names)
            if previous is not None and stamp_unchanged(previous.stamp, stamp):
                counters["membersSkipped"] += 1
                continue

            try:
                blobs = [zip_archive.member(name).read() for name in group.names]
            except Exception as err:
                counters["filersSkipped"] += 1
                log_error(f"[submissions] {cik}: member unreadable", err)
                continue

            digest = sha256_hex(b"".join(blobs))
            if member_unchanged(previous.sha256 if previous else None, digest):
                counters["membersSkipped"] += 1
                # The digest agrees but the stamp did not, so the stored stamp is
                # either ABSENT (a checkpoint written before MONEY-1283 — which
                # is every one of them on prod today) or written in an older
                # stamp FORMAT. Both are the same fact: the cheap key on that row
                # cannot recognise these bytes. Record the one that can, so the
                # member is read this once and never again, and note the write
                # touches `stamp` alone — the rows/bytes on that row belong to
                # the run that wrote them.
                if applying and previous is not None:
                    upgrades[cik] = stamp
                    if len(upgrades) >= writers.DEFAULT_CHUNK:
                        upgrade_checkpoint_stamps(db, job_key, upgrades)
                        upgrades = {}
                continue

            selected += 1
            try:
                filer, filings = _parse_group(cik, group, blobs)
            except Exception as err:
                # NAMED and COUNTED, never fatal. One filer whose JSON SEC
                # truncated must not cost the other 14,999.
                counters["filersSkipped"] += 1
                _record_failure(db, job_key, cik, err, applying=applying)
                log_error(f"[submissions] {cik}: malformed member, skipped", err)
                continue

            filer_row = build_filer_row(filer, filings, in_universe=universe.contains(cik))
            filing_rows = build_filing_rows(filings)
            accepted, accession = _newest_acceptance(filings)
            if accepted is not None and (latest_accepted is None or accepted > latest_accepted):
                latest_accepted, latest_accession = accepted, accession

            if not applying:
                # Dry run: the parse is proven, nothing is written, and — crucially —
                # nothing is checkpointed, so the armed run selects this member again.
                continue

            written = writers.upsert_filers(db, [filer_row])
            written = written + writers.upsert_filings(db, filing_rows)
            totals = totals + written
            counters["filersWritten"] += 1
            counters["filingsWritten"] += len(filing_rows)
            # The checkpoint is written ONLY on the branch that wrote rows, and
            # only after the write returned. A checkpoint beside zero rows marks
            # the member converged forever.
            finished.append(
                CheckpointEntry(
                    item_key=cik,
                    detail=digest,
                    rows=written.written,
                    bytes=sum(len(blob) for blob in blobs),
                    # Written BESIDE the digest, never on its own: the stamp is
                    # only trustworthy because this run also verified the sha256
                    # of the same bytes.
                    stamp=stamp,
                )
            )
            if len(finished) >= writers.DEFAULT_CHUNK:
                write_checkpoints(db, job_key, finished)
                finished = []

    if applying and finished:
        write_checkpoints(db, job_key, finished)
    if applying and upgrades:
        upgrade_checkpoint_stamps(db, job_key, upgrades)

    if applying:
        _seed_detect_cursor(db, latest_accepted, latest_accession)
        # The watermark moves ONLY on a run that reached the end. Stamping it
        # after a budget-exhausted pass would make tomorrow's HEAD report
        # NOT_YET_PUBLISHED and the unprocessed remainder would never be read.
        if status == STATUS_COMPLETED:
            writers.upsert_cursor(
                db,
                UsEdgarCursorRow(
                    key=CURSOR_KEYS[feed],
                    lastRunAt=utc_now(),
                    meta={**decision.meta(), "parserVersion": PARSER_VERSION},
                ),
            )
    elif status == STATUS_COMPLETED:
        status = STATUS_WRITE_DISARMED

    return BulkRunResult(
        status=status,
        selected=selected,
        written=totals.written,
        failed=counters["filersSkipped"] + totals.failed,
        # A transport failure inside this function has no handler: it propagates
        # to `main`, which reports it. Counting one here that can never be
        # incremented would be a metric that reads healthy by construction.
        skipped_reason=STATUS_WRITE_DISARMED if not applying else None,
        counters=counters,
    )


def _parse_group(
    cik: str, group: MemberGroup, blobs: Sequence[bytes]
) -> tuple[SubmissionsFiler, list[FilingRef]]:
    """Primary + paging members -> one filer and every filing it has on file."""
    filer, filings = parse_submissions_json(json_loads(blobs[0]))
    combined = list(filings)
    for blob in blobs[1:]:
        _, page_filings = parse_submissions_json(page_payload(cik, json_loads(blob)))
        combined.extend(page_filings)
    return filer, combined


def _newest_acceptance(filings: Sequence[FilingRef]) -> tuple[datetime | None, str | None]:
    newest: datetime | None = None
    accession: str | None = None
    for filing in filings:
        if filing.accepted_at is None:
            continue
        if newest is None or filing.accepted_at > newest:
            newest, accession = filing.accepted_at, filing.accession
    return newest, accession


def _record_failure(db: Any, job_key: str, cik: str, err: BaseException, *, applying: bool) -> None:
    """Leave an ERROR checkpoint for triage. Never a DONE one.

    ``load_checkpoints`` returns DONE rows only, so this row is read by a human
    and never by the skip logic — the member is retried on the next run, which is
    the whole point of not marking it finished.
    """
    if not applying:
        return
    write_checkpoints(
        db,
        job_key,
        [CheckpointEntry(item_key=cik, detail=type(err).__name__, status="ERROR")],
    )


def _seed_detect_cursor(db: Any, accepted_at: datetime | None, accession: str | None) -> None:
    """Give the detect loop a starting point, ONCE.

    Only when no ``getcurrent`` cursor exists. Overwriting a live one would move
    detection's watermark forward to the newest filing in a 1.5 GiB nightly
    archive and silently skip everything accepted since the last poll.
    """
    if accepted_at is None:
        return
    if writers.read_cursor(db, DETECT_CURSOR_KEY) is not None:
        return
    writers.upsert_cursor(
        db,
        UsEdgarCursorRow(
            key=DETECT_CURSOR_KEY,
            lastAccession=accession,
            lastAcceptedAt=accepted_at,
            meta={"seededBy": JOB_NAMES[FEED_SUBMISSIONS]},
        ),
    )
    logger.info("[submissions] seeded detect cursor at %s (%s)", accepted_at, accession)


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point. Returns the process exit code."""
    parser = argparse.ArgumentParser(prog="python -m app.bulk.submissions")
    parser.add_argument("--day", help="Archive day (YYYY-MM-DD). Defaults to today, UTC.")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Process the file even when its validators say it has not changed.",
    )
    args = parser.parse_args(argv)
    day = date.fromisoformat(args.day) if args.day else datetime.now(UTC).date()

    job = JOB_NAMES[FEED_SUBMISSIONS]
    result = BulkRunResult(status=STATUS_FAILED, skipped_reason="DID_NOT_RUN")
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
            result = run(db=database, client=client, day=day, force=args.force)
    except SecEgressDisabled as err:
        # NAMED, not generic: this environment is configured never to reach SEC,
        # which is a deployment decision rather than an outage. It still fails
        # the run, because a bulk job that cannot fetch has done nothing.
        result = BulkRunResult(
            status=STATUS_FAILED, transport_failures=1, skipped_reason="SEC_EGRESS_DISABLED"
        )
        log_error("[submissions] SEC egress is disabled in this environment", err)
    except SecError as err:
        result = BulkRunResult(
            status=STATUS_FAILED, transport_failures=1, skipped_reason=type(err).__name__
        )
        log_error("[submissions] upstream failure", err)
    except Exception as err:
        result = BulkRunResult(status=STATUS_FAILED, skipped_reason=type(err).__name__)
        log_error("[submissions] run failed", err)
    finally:
        # In `finally`: a job that raises before reporting is invisible in
        # exactly the dimension this metric measures.
        report_job_outcome(
            job,
            selected=result.selected,
            written=result.written,
            failed=result.failed,
            transport_failures=result.transport_failures,
            skipped_reason=result.skipped_reason or result.status,
        )
        logger.info("[submissions] %s %s", result.status, result.counters)
    return result.exit_code


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
