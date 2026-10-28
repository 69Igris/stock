"""SEC's Fails-to-Deliver files -> the ``SEC_FTD`` tier of ``us_cusip_map`` — MONEY-979.

    python -m app.bulk.ftd [--months=24] [--apply]

13F reports positions by CUSIP and nothing else, and SEC publishes no CUSIP ->
ticker file. The Fails-to-Deliver archive is the closest thing that exists: a
twice-monthly, pipe-delimited list that pairs CUSIP with SYMBOL directly, from
SEC itself. This job archives the raw zips, parses them, and fills the tier
``app/parsers/cusip_map.py`` has been reporting as ``"unavailable"``.

## Coverage is PARTIAL AND ROLLING, by construction

A security appears in one of these files only while it has an open fail to
deliver. That is a property of the FEED, not of this job, so the run reports the
hit count it actually achieved (``cusipsResolved`` against ``cusipsSeen``) rather
than a completion percentage. Measured on ``cnsfails202607b``: 13,496 distinct
CUSIPs in one half-month file. A CUSIP that never fails is never in any of them,
and no number of extra months would change that.

## Four things measured on the real feed, 2026-08-29

1. **The index page cannot be templated.** 410 ``cnsfails*.zip`` links across
   FOUR directories, two carrying a ``_0`` suffix. A URL built from the date is
   wrong for 201 of the 410, so this job reads the page — ONE request per run —
   and takes every path verbatim.
2. **Each file ends with TWO TRAILER RECORDS**, not just a blank line:
   ``Trailer record count 73337`` and ``Trailer total quantity of shares
   2739615364``. A parser that split every line on ``|`` would emit three
   garbage rows. The count is also a free integrity check and is compared.
3. **``PRICE`` is the literal ``"."`` on 345 of 73,337 rows** and ``SYMBOL`` is
   empty on at least one CUSIP. Neither drops the row: the column this feed
   exists for is CUSIP.
4. **39 CUSIPs carry more than one symbol inside one file** — a mid-month ticker
   change, or a pending-symbol placeholder (``AMDD`` / ``AMDDZZZZ``). Latest
   settlement date wins, which resolved all 39; a tie on that date REFUSES
   rather than picks. See ``backfill_logic.ftd_symbol_by_cusip``.

## A LOWER TIER MAY NEVER OVERWRITE A HIGHER ONE

``SEC_13DG`` and ``TIINGO_FIGI`` outrank ``SEC_FTD``. The guard is not
re-implemented here: candidate rows go through
``app.parsers.cusip_map_logic.plan_writes``, which is where every tier's
precedence is expressed exactly once. A 13D/G cover page names the subject's
CUSIP and CIK together, filed by the person who took the stake; a fails file
names a ticker. Letting the second silently replace the first would erase the
provenance ``UsCusipMap.source`` exists to record.
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
import io  # noqa: E402
import logging  # noqa: E402
import zipfile  # noqa: E402
from collections.abc import Mapping, Sequence  # noqa: E402
from datetime import datetime  # noqa: E402
from pathlib import PurePosixPath  # noqa: E402
from typing import Any  # noqa: E402

from app import db as db_module  # noqa: E402
from app import settings  # noqa: E402
from app.bulk.backfill_logic import (  # noqa: E402
    FTD_BUDGET_SECONDS,
    FTD_INDEX_URL,
    BackfillRunResult,
    FtdFile,
    budget_seconds,
    ftd_symbol_by_cusip,
    parse_ftd_file,
    parse_ftd_index,
    recent_ftd_files,
)
from app.bulk.common import (  # noqa: E402
    CHECKPOINT_COLLECTION,
    CHECKPOINT_DONE,
    STATUS_BUDGET_EXHAUSTED,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_WRITE_DISARMED,
    CheckpointEntry,
    RunBudget,
    install_sec_limiter,
    load_checkpoints,
    member_unchanged,
    write_checkpoints,
)
from app.logging_setup import log_error  # noqa: E402
from app.parsers import cusip_map_logic as tiers  # noqa: E402
from app.parsers.cusip_map import CUSIP_COLLECTION, CUSIP_KEY, resolve_sources  # noqa: E402
from app.sec import archive  # noqa: E402
from app.sec.client import SecClient  # noqa: E402
from app.sec.errors import SecEgressDisabled, SecError  # noqa: E402
from app.store import writers  # noqa: E402
from app.store.models import utc_now  # noqa: E402
from app.store.outcome import report_job_outcome  # noqa: E402

logger = logging.getLogger("us-fundamentals.bulk.ftd")

#: Datadog ``job:`` tag and the Cloud Run job name minus the env suffix.
JOB_NAME = "edgar-bulk-ftd"

#: ``backfill_checkpoints.jobKey``. ``itemKey`` is the PERIOD (``202607b``) and
#: ``detail`` is the BASENAME the period was archived from — not a content hash.
#: A published half-month is immutable, so the period alone would be enough to
#: skip; the basename is stored because SEC does occasionally re-post one under
#: a ``_0`` name, and comparing basenames makes that re-post a re-fetch instead
#: of a permanent skip.
CHECKPOINT_JOB_KEY = "edgar-ftd"

#: The tier this job writes. Ranked in ``cusip_map_logic.TIER_ORDER``.
SOURCE = "SEC_FTD"

ZIP_CONTENT_TYPE = "application/zip"

#: Parsed symbol maps by archive key. A published FTD file never changes, so
#: this is a cache of an immutable object — and only a NON-EMPTY parse is
#: cached, so a missing object or an unreadable one is re-attempted rather than
#: remembered as "this file has no mappings".
_symbol_map_cache: dict[str, dict[str, str]] = {}


def reset_lookup_cache() -> None:
    """Drop the memoised symbol maps. Tests and forked workers only."""
    _symbol_map_cache.clear()


# ── Fetching one file ───────────────────────────────────────────────────────


def fetch_ftd_file(client: Any, file: FtdFile) -> bytes:
    """The raw zip, ARCHIVE FIRST.

    ``get`` + ``write_bytes`` rather than ``stream_to_gcs``: these are ~1.6 MB,
    not the 1.4 GiB nightly bulk zips, and the bytes are needed in memory to
    parse anyway. Streaming them to GCS and reading them straight back would be
    two extra round trips for nothing.
    """
    key = file.archive_key
    cached = archive.read_bytes(key)
    if cached is not None:
        return cached
    data = client.get(file.url)
    archive.write_bytes(key, data, content_type=ZIP_CONTENT_TYPE)
    return data


def unzip_ftd(data: bytes) -> str:
    """The single text member of an FTD zip.

    Measured: ``cnsfails202607b.zip`` holds exactly one member,
    ``cnsfails202607b.txt``. The member is NOT located by a name derived from
    the zip's own, because the two have disagreed on the re-posted ``_0`` files
    and a name-derived lookup would raise a KeyError on a file that is perfectly
    readable.

    ## Why the extension is a PREFERENCE and not a requirement

    It used to be a requirement, and prod failed on it:

        ValueError: no .txt member in FTD zip (members: ['cnsfails202604a'])

    SEC ships some periods with the member carrying NO EXTENSION at all. The
    file is the same pipe-delimited text; only the name differs. Requiring
    ``.txt`` is an exact match against a string the upstream owns and changes
    without notice — the same shape as selecting on a ``content-type`` that
    turned out to carry parameters (MONEY-1255), and it fails the whole run
    rather than the one odd file.

    So: a zip holding exactly ONE file member is that member, whatever it is
    called. The ``.txt`` preference only DISAMBIGUATES when there are several,
    which is the case the original rule was actually written for. Directory
    entries are never candidates.
    """
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        files = [n for n in sorted(bundle.namelist()) if not n.endswith("/")]
        if not files:
            raise ValueError(f"FTD zip holds no file member (members: {bundle.namelist()})")
        texts = [n for n in files if n.lower().endswith(".txt")]
        if texts:
            return bundle.read(texts[0]).decode("utf-8", "replace")
        # No `.txt`. A LONE member with NO extension is the data file — that is
        # the shape SEC actually ships. A lone member with some OTHER extension
        # (`readme.pdf`) is not, and must still raise: "one member" is not the
        # same claim as "one member that could plausibly be the data".
        bare = [n for n in files if not PurePosixPath(n).suffix]
        if len(files) == 1 and bare:
            return bundle.read(files[0]).decode("utf-8", "replace")
        raise ValueError(
            f"no .txt member in FTD zip and no single extensionless member "
            f"(members: {bundle.namelist()})"
        )


# ── The tier T7 has been reporting as "unavailable" ─────────────────────────


def latest_archived_file(db: Any, *, job_key: str = CHECKPOINT_JOB_KEY) -> FtdFile | None:
    """The newest FTD file this service has actually archived, or ``None``.

    Read from the checkpoint ledger rather than by listing the bucket: the
    ledger records what a run FINISHED, and a half-written object in the bucket
    is exactly the thing a "latest" lookup must not pick.
    """
    cursor = db[CHECKPOINT_COLLECTION].find(
        {"jobKey": job_key, "status": CHECKPOINT_DONE}, {"itemKey": 1, "detail": 1}
    )
    best: FtdFile | None = None
    for row in cursor:
        period = str(row.get("itemKey") or "")
        basename = str(row.get("detail") or "")
        if not period or not basename:
            continue
        if best is None or period > best.period:
            best = FtdFile(period=period, url="", basename=basename)
    return best


def symbol_map_from_archive(archive_key: str) -> dict[str, str]:
    """``{cusip: symbol}`` for one archived FTD file. Memoised; empty on a miss."""
    cached = _symbol_map_cache.get(archive_key)
    if cached is not None:
        return cached
    data = archive.read_bytes(archive_key)
    if data is None:
        return {}
    parsed = parse_ftd_file(unzip_ftd(data))
    mapping, _ambiguous = ftd_symbol_by_cusip(parsed.rows)
    if mapping:
        # Only a real answer is cached. Caching an empty result would make a
        # missing object indistinguishable from a file with no mappings, and
        # permanent.
        _symbol_map_cache[archive_key] = mapping
    return mapping


def make_ftd_lookup(db: Any) -> Any | None:
    """An ``app.parsers.cusip_map.FtdLookup``, or ``None`` when nothing is archived.

    ``None`` is the point. ``resolve_cusips`` reports ``ftd: "unavailable"`` when
    no lookup is injected and ``ftd: "queried"`` when one is — a third value,
    distinct from "tried and found nothing". Returning an always-empty callable
    would collapse the two and let a permanently un-provisioned tier read as a
    tier with poor coverage forever.
    """
    latest = latest_archived_file(db)
    if latest is None:
        return None
    mapping = symbol_map_from_archive(latest.archive_key)
    if not mapping:
        return None

    def lookup(cusips: Sequence[str]) -> Mapping[str, str]:
        return {cusip: mapping[cusip] for cusip in cusips if cusip in mapping}

    return lookup


# ── The run ─────────────────────────────────────────────────────────────────


def plan_cusip_rows(
    symbol_by_cusip: Mapping[str, str],
    instruments: Mapping[str, Mapping[str, Any]],
    *,
    stamped: datetime,
) -> dict[str, dict[str, Any]]:
    """Candidate ``us_cusip_map`` rows. The tier guard is applied LATER, once.

    The symbol is stored whether or not our own master carries it — same as the
    tier (c) branch in ``app/parsers/cusip_map.py``, and unlike the OpenFIGI
    tier which stores only symbols an instrument backs. SEC's own ticker is a
    primary-source fact about the CUSIP; OpenFIGI's is a venue match. ``cik10``
    and ``compositeFigi`` are filled only from a real instrument row.
    """
    rows: dict[str, dict[str, Any]] = {}
    for cusip, symbol in symbol_by_cusip.items():
        instrument = instruments.get(symbol) or {}
        rows[cusip] = tiers.resolution_row(
            cusip,
            source=SOURCE,
            symbol=symbol,
            cik10=instrument.get("cik"),
            composite_figi=instrument.get("openFIGIComposite"),
            resolved_at=stamped,
            last_tried_at=stamped,
        )
    return rows


def run(
    *,
    db: Any,
    client: Any,
    months: int = 24,
    apply_writes: bool | None = None,
    budget: RunBudget | None = None,
    writer: Any = None,
    sources: Any = None,
    now: datetime | None = None,
) -> BackfillRunResult:
    """One pass. Every collaborator is injectable so a test drives THIS code."""
    applying = settings.parse_apply() if apply_writes is None else bool(apply_writes)
    clock = budget or RunBudget(budget_seconds(FTD_BUDGET_SECONDS))
    stamped = now or utc_now()
    src = sources if sources is not None else resolve_sources()

    counters = {
        "filesOnIndex": 0,
        "filesSelected": 0,
        "filesFetched": 0,
        "filesSkipped": 0,
        "rowsParsed": 0,
        "rowsDropped": 0,
        "trailerMismatch": 0,
        "trailerAbsent": 0,
        "cusipsSeen": 0,
        "cusipsAmbiguous": 0,
        "cusipsResolved": 0,
        "cusipsSuppressedByTier": 0,
        "instrumentsMatched": 0,
    }

    # ONE request to the index page per run. Every URL comes from it verbatim;
    # see the module docstring for why a templated URL is wrong for half of them.
    files = parse_ftd_index(client.get(FTD_INDEX_URL).decode("utf-8", "replace"))
    counters["filesOnIndex"] = len(files)
    selected = recent_ftd_files(files, months)
    counters["filesSelected"] = len(selected)

    done = load_checkpoints(db, CHECKPOINT_JOB_KEY)
    symbol_by_cusip: dict[str, str] = {}
    finished: list[CheckpointEntry] = []
    transport_failures = 0
    status = STATUS_COMPLETED

    # NEWEST FIRST, and `setdefault` below, so the most recent file's ticker
    # wins for a CUSIP that appears in several. Iterating oldest-first with a
    # plain assignment would give the same answer by accident today and the
    # opposite one the moment the ordering changed.
    for file in selected:
        if clock.exhausted():
            status = STATUS_BUDGET_EXHAUSTED
            break

        # BEFORE the fetch. A published half-month never changes, so a
        # checkpointed period costs no request at all.
        if member_unchanged(done.get(file.period), file.basename):
            counters["filesSkipped"] += 1
            continue

        try:
            data = fetch_ftd_file(client, file)
        except SecError as err:
            # Counted AFTER the call it counts, and the file is NOT checkpointed
            # so the next run tries it again.
            transport_failures += 1
            log_error(f"[ftd] {file.period}: could not fetch {file.url}", err)
            continue

        counters["filesFetched"] += 1
        parsed = parse_ftd_file(unzip_ftd(data))
        counters["rowsParsed"] += len(parsed.rows)
        counters["rowsDropped"] += parsed.dropped
        if parsed.trailer_matches is None:
            counters["trailerAbsent"] += 1
        elif not parsed.trailer_matches:
            counters["trailerMismatch"] += 1
            logger.warning(
                "[ftd] %s: trailer says %s rows, parsed %s",
                file.period,
                parsed.trailer_count,
                len(parsed.rows),
            )

        mapping, ambiguous = ftd_symbol_by_cusip(parsed.rows)
        counters["cusipsAmbiguous"] += ambiguous
        for cusip, symbol in mapping.items():
            symbol_by_cusip.setdefault(cusip, symbol)

        finished.append(
            CheckpointEntry(
                item_key=file.period,
                detail=file.basename,
                rows=len(parsed.rows),
                bytes=len(data),
            )
        )

    counters["cusipsSeen"] = len(symbol_by_cusip)

    written = 0
    planned = 0
    if symbol_by_cusip:
        instruments = src.instruments_by_symbol(sorted(set(symbol_by_cusip.values())))
        counters["instrumentsMatched"] = len(instruments)
        candidates = plan_cusip_rows(symbol_by_cusip, instruments, stamped=stamped)
        counters["cusipsResolved"] = len(candidates)
        written, planned = _write_cusip_rows(db, src, candidates, writer=writer, applying=applying)
        counters["cusipsSuppressedByTier"] = len(candidates) - planned

    if applying and finished:
        # AFTER the rows landed. A checkpoint written first would mark a file
        # converged whose mappings were never stored (MONEY-1235).
        write_checkpoints(db, CHECKPOINT_JOB_KEY, finished)

    if not applying and status == STATUS_COMPLETED:
        status = STATUS_WRITE_DISARMED

    return BackfillRunResult(
        status=status,
        selected=counters["cusipsSeen"],
        written=written,
        failed=0,
        transport_failures=transport_failures,
        skipped_reason=STATUS_WRITE_DISARMED if not applying else None,
        counters=counters,
    )


def _write_cusip_rows(
    db: Any,
    src: Any,
    candidates: Mapping[str, dict[str, Any]],
    *,
    writer: Any,
    applying: bool,
) -> tuple[int, int]:
    """``(written, planned)``. Chunked, and the tier guard runs on every chunk.

    Chunked because a whole run's union is tens of thousands of CUSIPs and
    ``existing()`` is an ``$in`` query — one of that size is a document nobody
    wants to send. The guard is ``cusip_map_logic.plan_writes``, unchanged and
    un-duplicated, so ``SEC_13DG`` and ``TIINGO_FIGI`` rows survive untouched.
    """
    cusips = sorted(candidates)
    written = 0
    planned = 0
    active = writer
    for start in range(0, len(cusips), writers.DEFAULT_CHUNK):
        batch = cusips[start : start + writers.DEFAULT_CHUNK]
        existing = src.existing(batch)
        rows = tiers.plan_writes({c: candidates[c] for c in batch}, existing)
        planned += len(rows)
        if not applying or not rows:
            continue
        if active is None:
            from app.parsers.dispatch import _require_writer

            active = _require_writer(None)
        written += int(active.upsert_rows(CUSIP_COLLECTION, rows, key=CUSIP_KEY) or 0)
    return written, planned


# ── CLI ─────────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.bulk.ftd")
    parser.add_argument(
        "--months",
        type=int,
        default=24,
        help=(
            "How many months back to take, as a COUNT of files (two per month). "
            "SEC publishes with a lag, so a calendar subtraction and a file count "
            "are different sets."
        ),
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write. Without it the files are fetched, archived, parsed and counted only.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point. Returns the process exit code."""
    args = build_parser().parse_args(argv)
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
            result = run(db=database, client=client, months=args.months, apply_writes=applying)
    except SecEgressDisabled as err:
        result = BackfillRunResult(
            status=STATUS_FAILED, transport_failures=1, skipped_reason="SEC_EGRESS_DISABLED"
        )
        log_error("[ftd] SEC egress is disabled in this environment", err)
    except SecError as err:
        result = BackfillRunResult(
            status=STATUS_FAILED, transport_failures=1, skipped_reason=type(err).__name__
        )
        log_error("[ftd] upstream refusal — stopping rather than retrying", err)
    except Exception as err:
        result = BackfillRunResult(status=STATUS_FAILED, skipped_reason=type(err).__name__)
        log_error("[ftd] run failed", err)
    finally:
        report_job_outcome(
            JOB_NAME,
            selected=result.selected,
            written=result.written,
            failed=result.failed,
            transport_failures=result.transport_failures,
            skipped_reason=result.skipped_reason or result.status,
        )
        logger.info("[ftd] %s", result.as_dict())
    return result.exit_code


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
