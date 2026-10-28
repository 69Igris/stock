"""Machinery shared by the two bulk jobs — MONEY-979.

Both jobs have the same skeleton: ask whether SEC published a new file, stream it
to GCS, walk its members, skip the ones that have not changed, and stop cleanly
before the task timeout. Everything in that sentence is here; only the per-member
parsing lives in ``submissions.py`` / ``companyfacts.py``.

## "Not yet published" is an OUTCOME, not a failure and not a success

SEC documents these files as appearing "approximately 3:00 a.m. ET". Measured,
they were stamped 23:49 and 23:57 ET the previous day. The clock is therefore not
evidence and is never pinned: the job HEADs the URL and compares
``ETag``/``Last-Modified`` against what it last ingested.

An unchanged file produces :data:`STATUS_NOT_YET_PUBLISHED` — exit 0, zero rows,
``skippedReason`` set. It must be distinguishable from BOTH neighbours:

* not a FAILURE, because nothing is wrong and a red job every morning until SEC
  publishes trains everyone to ignore the alert;
* not a plain SUCCESS, because ``selected=0, written=0`` with no reason is
  byte-identical to the six jobs that ran on schedule for a week and wrote
  nothing (MONEY-1255).

## Validators, and what happens when there are none

ETag is preferred over ``Last-Modified`` when both sides carry it. When the
response carries NEITHER, the decision is ``VALIDATORS_ABSENT`` and the job
PROCESSES the file. That is the safe direction: treating "could not determine"
as "unchanged" would skip forever and report a green run every night, while
processing it costs one pass that the per-member hash-skip makes almost free.

## Members are read out of GCS, never extracted to disk

Cloud Run's ``/tmp`` is a tmpfs — RAM — so extracting a 1.45 GiB archive there
charges the instance for the file a second time and is the first thing to OOM.
``blob.open("rb")`` returns a SEEKABLE reader, which is exactly what
:class:`zipfile.ZipFile` needs to read the central directory, so members are
decompressed one at a time straight out of the object.

## A RESUME MUST NOT RE-READ WHAT IT ALREADY FINISHED — MONEY-1283

That last paragraph is also why the skip had to change. Because a member lives in
a live GCS object, ``ZipMember.read()`` is NETWORK I/O, and the walkers used to
spend it before they could decide anything::

    blobs  = [zip_archive.member(name).read() for name in group.names]  # network
    digest = sha256_hex(b"".join(blobs))                                # CPU
    if member_unchanged(checkpoints.get(cik), digest):                  # only NOW
        continue

So resuming cost one full download per member ALREADY DONE. Measured on prod
2026-08-30: 87,052 finished members took 51.5 minutes to skip — 1,691/min —
against a **988,373-member** universe. A 150-minute budget can therefore skip at
most 253,650, the walk stalled at ~25.7%, and every later run reported
``BUDGET_EXHAUSTED`` with ``selected=0, written=0`` forever. The cost was charged
to the same :class:`RunBudget` as real work, so the job could not buy its way
out: a bigger budget only buys time to repeat the same pointless reads.

:class:`zipfile.ZipFile` parses the CENTRAL DIRECTORY once when it opens the
stream, so every ``ZipInfo`` already holds ``CRC``, ``file_size`` and
``compress_size`` IN MEMORY. Comparing a stored CRC is therefore a dict lookup
costing **zero additional GCS requests** — see :meth:`ZipArchive.member_stamp`.
That is not a constant-factor win; it removes the network calls.

The stamp is a cheap NEGATIVE filter and never a replacement for the digest:
a member the run actually processes is still hashed with sha256, which stays the
recorded authority in ``detail``.
"""

from __future__ import annotations

import hashlib
import io
import logging
import os
import time
import zipfile
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import IO, Any

from pymongo import ASCENDING, UpdateOne

from app.sec import archive
from app.sec.archive_logic import bulk_key
from app.sec.edgar_adapter import cik10 as normalise_cik
from app.store import writers
from app.store.writers import WriteResult, write_operations

logger = logging.getLogger("us-fundamentals.bulk")

# ── The two feeds ───────────────────────────────────────────────────────────

FEED_SUBMISSIONS = "submissions"
FEED_COMPANYFACTS = "companyfacts"

#: SEC's own bulk endpoints. Public, keyless, documented; the only two URLs this
#: package fetches.
BULK_URLS: dict[str, str] = {
    FEED_SUBMISSIONS: "https://www.sec.gov/Archives/edgar/daily-index/bulkdata/submissions.zip",
    FEED_COMPANYFACTS: "https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip",
}

#: ``us_edgar_cursor.key`` holding each feed's watermark.
CURSOR_KEYS: dict[str, str] = {
    FEED_SUBMISSIONS: "bulk:submissions",
    FEED_COMPANYFACTS: "bulk:companyfacts",
}

#: ``backfill_checkpoints.jobKey`` for the per-member skip.
JOB_KEYS: dict[str, str] = {
    FEED_SUBMISSIONS: "edgar-submissions",
    FEED_COMPANYFACTS: "edgar-companyfacts",
}

#: Datadog ``job:`` tag. Matches the Cloud Run job names minus the env suffix.
JOB_NAMES: dict[str, str] = {
    FEED_SUBMISSIONS: "edgar-bulk-submissions",
    FEED_COMPANYFACTS: "edgar-bulk-companyfacts",
}

#: The collection the Tiingo security master writes. NOT one of our eleven, so
#: it is not in ``app.store.collections`` — we only ever READ it, to decide which
#: filers are in our universe.
INSTRUMENTS_COLLECTION = "us_instruments"

#: Shared with the TypeScript backfills. Same document shape, same unique key.
CHECKPOINT_COLLECTION = "backfill_checkpoints"

#: ``BackfillCheckpoint.scope`` for a bulk member.
#:
#: The empty string is a deliberate VALUE, not a placeholder. ``jobKey`` already
#: names the feed and ``itemKey`` is the cik10, so there is no second dimension
#: to record — but the column is part of the ``@@unique``, and on a MongoDB
#: unique index an ABSENT field compares equal to every other absent field, so
#: omitting it would make every checkpoint in the job collide on one row.
CHECKPOINT_SCOPE = ""

CHECKPOINT_DONE = "DONE"
CHECKPOINT_EMPTY = "EMPTY"
CHECKPOINT_ERROR = "ERROR"

# ── Run outcomes ────────────────────────────────────────────────────────────

STATUS_COMPLETED = "COMPLETED"
STATUS_NOT_YET_PUBLISHED = "NOT_YET_PUBLISHED"
STATUS_BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED"
STATUS_WRITE_DISARMED = "WRITE_DISARMED"
STATUS_FAILED = "FAILED"

#: Statuses that are a clean end to a run. Everything else is a failure and the
#: process exits non-zero so Cloud Run marks the execution failed.
CLEAN_STATUSES = frozenset(
    {STATUS_COMPLETED, STATUS_NOT_YET_PUBLISHED, STATUS_BUDGET_EXHAUSTED, STATUS_WRITE_DISARMED}
)


@dataclass(frozen=True, slots=True)
class BulkRunResult:
    """One run, reported honestly.

    ``selected`` counts members the run chose to PROCESS (changed ones), not
    members in the zip: a converged night selects zero and writes zero, and that
    is health. ``written`` is what MongoDB actually changed, never ``len(rows)``.
    """

    status: str
    selected: int = 0
    written: int = 0
    failed: int = 0
    transport_failures: int = 0
    skipped_reason: str | None = None
    counters: dict[str, int] = field(default_factory=dict)

    @property
    def exit_code(self) -> int:
        return 0 if self.status in CLEAN_STATUSES else 1


# ── Upstream freshness ──────────────────────────────────────────────────────

DECISION_FIRST_RUN = "FIRST_RUN"
DECISION_CHANGED = "CHANGED"
DECISION_UNCHANGED = "UNCHANGED"
DECISION_FORCED = "FORCED"
DECISION_VALIDATORS_ABSENT = "VALIDATORS_ABSENT"


@dataclass(frozen=True, slots=True)
class UpstreamDecision:
    """Whether today's file is worth reading, and on what evidence."""

    should_process: bool
    reason: str
    last_modified: str | None = None
    etag: str | None = None
    content_length: int | None = None

    @property
    def outcome(self) -> str:
        """The run status this decision implies when it says no."""
        return STATUS_COMPLETED if self.should_process else STATUS_NOT_YET_PUBLISHED

    def meta(self) -> dict[str, Any]:
        """The watermark to store on ``us_edgar_cursor.meta`` after a good run."""
        stamp: dict[str, Any] = {}
        if self.last_modified:
            stamp["lastModified"] = self.last_modified
        if self.etag:
            stamp["etag"] = self.etag
        if self.content_length is not None:
            stamp["contentLength"] = self.content_length
        return stamp


def decide_upstream(
    head: dict[str, Any],
    previous: dict[str, Any] | None,
    *,
    force: bool = False,
) -> UpstreamDecision:
    """Compare a HEAD response against the stored watermark. PURE.

    ``force`` exists for a manual re-run of a day already ingested and is the
    ONLY way to process a file whose validators say it has not moved.
    """
    last_modified = _clean(head.get("lastModified"))
    etag = _clean(head.get("etag"))
    length = head.get("contentLength")
    stored = previous or {}
    previous_last_modified = _clean(stored.get("lastModified"))
    previous_etag = _clean(stored.get("etag"))

    def decision(should: bool, reason: str) -> UpstreamDecision:
        return UpstreamDecision(
            should_process=should,
            reason=reason,
            last_modified=last_modified,
            etag=etag,
            content_length=int(length) if isinstance(length, int) else None,
        )

    if force:
        return decision(True, DECISION_FORCED)
    if not previous_etag and not previous_last_modified:
        return decision(True, DECISION_FIRST_RUN)
    # ETag is the stronger validator, so it decides whenever BOTH sides have one.
    if etag and previous_etag:
        changed = etag != previous_etag
        return decision(changed, DECISION_CHANGED if changed else DECISION_UNCHANGED)
    if last_modified and previous_last_modified:
        changed = last_modified != previous_last_modified
        return decision(changed, DECISION_CHANGED if changed else DECISION_UNCHANGED)
    # Neither validator is comparable. That is "could not determine", and it is
    # NOT the same value as "unchanged": skipping here would skip every night
    # forever while reporting a clean run.
    return decision(True, DECISION_VALIDATORS_ABSENT)


def check_upstream(
    client: Any,
    url: str,
    cursor_key: str,
    *,
    db: Any,
    force: bool = False,
) -> UpstreamDecision:
    """HEAD the bulk file and compare it with ``us_edgar_cursor[cursor_key]``."""
    previous = writers.read_cursor(db, cursor_key) if db is not None else None
    meta = (previous or {}).get("meta") or {}
    head = client.head(url)
    verdict = decide_upstream(head, meta, force=force)
    logger.info(
        "[bulk] upstream %s: %s (etag=%s lastModified=%s bytes=%s)",
        cursor_key,
        verdict.reason,
        verdict.etag,
        verdict.last_modified,
        verdict.content_length,
    )
    return verdict


def _clean(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


# ── Streaming the zip into the archive ──────────────────────────────────────


def stream_zip_to_gcs(
    client: Any,
    feed: str,
    *,
    day: date | str,
    url: str | None = None,
) -> dict[str, Any]:
    """Stream today's bulk zip to ``edgar/bulk/{feed}/{day}/{feed}.zip``.

    RAW-FIRST: the bytes are in our bucket before anything parses them, so a
    mapping change or an edgartools bump is a re-read of our own object and never
    a second 1.4 GiB pull from SEC. Returns the client's result dict with
    ``key``, ``bytes``, ``sha256``, ``lastModified`` and ``etag``.
    """
    key = bulk_key(feed, day, f"{feed}.zip")
    result = client.stream_to_gcs(url or BULK_URLS[feed], key, content_type="application/zip")
    logger.info(
        "[bulk] archived %s -> %s (%s bytes, sha256=%s)",
        feed,
        result.get("key"),
        result.get("bytes"),
        result.get("sha256"),
    )
    return result


# ── Reading members without touching the disk ───────────────────────────────


class ZipMember:
    """One member of a bulk zip, decompressed on demand.

    Bytes are cached after the first :meth:`read` because every caller needs them
    twice — once to hash, once to parse — and the alternative is decompressing
    the member a second time for no reason. The cache is per MEMBER, so at most
    one member's bytes are resident at a time as long as the caller iterates
    rather than materialising the list.
    """

    __slots__ = ("_cache", "_zipfile", "name", "size")

    def __init__(self, name: str, size: int, zip_file: zipfile.ZipFile) -> None:
        self.name = name
        self.size = size
        self._zipfile = zip_file
        self._cache: bytes | None = None

    def read(self) -> bytes:
        if self._cache is None:
            with self._zipfile.open(self.name) as handle:
                self._cache = handle.read()
        return self._cache

    def sha256(self) -> str:
        return sha256_hex(self.read())

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"ZipMember({self.name!r}, {self.size} bytes)"


#: Joins the per-member stamps of one GROUP. A byte that cannot occur inside a
#: stamp (which is hex, a colon and digits), so the join is unambiguous.
MEMBER_STAMP_SEPARATOR = "|"


class ZipArchive:
    """A bulk zip opened over a stream. Nothing is written to disk."""

    __slots__ = ("_zipfile",)

    def __init__(self, zip_file: zipfile.ZipFile) -> None:
        self._zipfile = zip_file

    def names(self) -> list[str]:
        """Member names, from the CENTRAL DIRECTORY — no member is decompressed.

        Sorted, so a run's order does not depend on how the archive happened to
        be built and two runs over the same object process members identically.
        """
        return sorted(self._zipfile.namelist())

    def member(self, name: str) -> ZipMember:
        info = self._zipfile.getinfo(name)
        return ZipMember(name, info.file_size, self._zipfile)

    def members(self) -> Iterator[ZipMember]:
        for name in self.names():
            yield self.member(name)

    def member_stamp(self, name: str) -> str:
        """``"{crc:08x}:{file_size}"`` for one member. ZERO additional I/O.

        ``getinfo`` is a dict lookup into ``NameToInfo``, which
        :meth:`zipfile.ZipFile._RealGetContents` filled from the CENTRAL
        DIRECTORY when the archive was opened. Both fields are therefore already
        in memory: nothing is seeked, nothing is decompressed, and — the whole
        point on a GCS-backed stream — no request is made. See the MONEY-1283
        section of this module's docstring.

        WHAT IS AND IS NOT IN THE STAMP, and why:

        * ``CRC`` is computed over the UNCOMPRESSED bytes, so identical content
          gives an identical value no matter how or when SEC rebuilt the zip.
        * ``file_size`` rides along because CRC-32 is weak on its own. It is not
          collision RESISTANCE — nothing here is adversarial — it is that an
          accidental 1-in-4-billion collision would have to land on a member
          whose byte count also matched exactly.
        * ``compress_size`` is DELIBERATELY OUT. It moves when SEC changes a
          compression level, which would report every member as changed and cost
          a full re-read of the universe — a false CHANGED, which is only slow.
        * ``date_time`` is DELIBERATELY OUT, and this is the one that would have
          silently undone the fix. It records when the member was written into
          the archive, not what is in it, so a nightly rebuild of an unchanged
          filer moves it — and every member would look changed every night while
          the code read as if it were comparing content.

        The format carries no version tag on purpose. If it ever changes, old
        stamps simply stop matching, each member is read and hashed once, and the
        new stamp is written beside its digest — the walk self-heals at the cost
        of one pass rather than needing a migration.
        """
        info = self._zipfile.getinfo(name)
        return f"{info.CRC:08x}:{info.file_size}"

    def group_stamp(self, names: Sequence[str]) -> str:
        """One stamp for a member GROUP, in the order the reader will read them.

        A submissions filer is its index PLUS its paging shards, and the digest
        it is compared against is taken over ``b"".join(blobs)`` in exactly that
        order. Joining the per-member stamps the same way means a shard appearing,
        vanishing or being reordered changes the stamp — a group is not the sum
        of its parts, it is the sequence of them.
        """
        return MEMBER_STAMP_SEPARATOR.join(self.member_stamp(name) for name in names)


def _gcs_opener(key: str) -> IO[bytes]:
    """Open an archived object as a SEEKABLE binary stream.

    ``zipfile`` reads the central directory from the END of the file, so a
    forward-only stream cannot be used at all — the whole design depends on this
    reader supporting ``seek``.
    """
    blob = archive.storage_client().bucket(archive.bucket_name()).blob(key)
    return blob.open("rb")


@contextmanager
def open_zip_archive(
    key: str,
    *,
    opener: Callable[[str], IO[bytes]] | None = None,
) -> Iterator[ZipArchive]:
    """Open the archived zip at ``key``. Members are read through the stream."""
    open_stream = opener or _gcs_opener
    stream = open_stream(key)
    try:
        with zipfile.ZipFile(stream) as zip_file:
            yield ZipArchive(zip_file)
    finally:
        close = getattr(stream, "close", None)
        if callable(close):
            close()


def iter_zip_members(
    key: str,
    *,
    opener: Callable[[str], IO[bytes]] | None = None,
) -> Iterator[ZipMember]:
    """Every member of the archived zip, one at a time, never extracted.

    STREAMING CONTRACT: a member must be read INSIDE the loop. The archive is
    closed when iteration ends, so a member hoarded past it raises — which is the
    honest failure. The alternative, pre-reading every member so they stay
    usable, would hold the whole 1.31 GiB uncompressed in memory, which is the
    one thing this function exists to avoid.
    """
    with open_zip_archive(key, opener=opener) as zip_archive:
        yield from zip_archive.members()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def zip_from_bytes(data: bytes) -> Callable[[str], IO[bytes]]:
    """An opener over an in-memory zip. Used by the tests and by nothing else."""

    def opener(_key: str) -> IO[bytes]:
        return io.BytesIO(data)

    return opener


# ── The wall clock ──────────────────────────────────────────────────────────

#: Wall-clock budget per feed, in seconds, and the reason each number is what it
#: is. Cloud Run JOBS have a task timeout, not Pub/Sub's 600 s ack deadline, so
#: each is sized ONE HOUR inside that job's own ``--task-timeout`` in
#: ``scripts/ops/setup-us-fundamentals-jobs.sh``, leaving room to finish the run
#: cleanly rather than be killed mid-write. The budget is checked BETWEEN
#: members, so the true wall is ``budget + one worst member`` — a few minutes for
#: the largest filer, not hours.
#:
#: submissions was 9000 (2.5 h) against a 3 h timeout. MONEY-1283 raised that
#: timeout to Cloud Run's 86400 maximum, because the real member count is 988,373
#: rather than the ~15k the original sizing assumed, and the budget did not move
#: with it — so the job stopped at 2.5 h and reported BUDGET_EXHAUSTED with the
#: walk barely started. Prod has been running 82800 through an explicit env var
#: since; this makes the default agree with the deployed value rather than
#: depending on one.
#:
#: These are PER FEED on purpose. ``EDGAR_BULK_BUDGET_SECONDS`` overrides all of
#: them at once, so setting it fleet-wide flattens four correct numbers into one
#: — see the note in the jobs script.
DEFAULT_BUDGET_SECONDS: dict[str, float] = {
    FEED_SUBMISSIONS: 82800.0,
    FEED_COMPANYFACTS: 18000.0,
}

#: Fallback for a feed with no entry above.
FALLBACK_BUDGET_SECONDS = 9000.0


def budget_seconds(feed: str) -> float:
    """Budget for one run, ``EDGAR_BULK_BUDGET_SECONDS`` overriding the default.

    Read PER CALL. A module-level ``os.getenv`` freezes at import — which happens
    before any test or any operator override — and the value that would then be
    used is the default, silently.
    """
    raw = (os.environ.get("EDGAR_BULK_BUDGET_SECONDS") or "").strip()
    if raw:
        try:
            value = float(raw)
        except ValueError:
            value = 0.0
        if value > 0:
            return value
    return DEFAULT_BUDGET_SECONDS.get(feed, FALLBACK_BUDGET_SECONDS)


class RunBudget:
    """A wall-clock budget, checked BETWEEN units of work.

    Never mid-member: stopping halfway through a filer would leave its rows
    partly written with no checkpoint, and the resumed run would have no way to
    know which half it had. Checking between members means the worst overshoot is
    one member, which is why the per-feed numbers above leave that much room.
    """

    __slots__ = ("_clock", "_started", "seconds")

    def __init__(self, seconds: float, *, clock: Callable[[], float] = time.monotonic) -> None:
        self.seconds = float(seconds)
        self._clock = clock
        self._started = clock()

    def elapsed(self) -> float:
        return self._clock() - self._started

    def remaining(self) -> float:
        return self.seconds - self.elapsed()

    def exhausted(self) -> bool:
        return self.remaining() <= 0


# ── Per-member checkpoints ──────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class CheckpointEntry:
    """One member's checkpoint. ``detail`` is the member's sha256.

    ``stamp`` is the central-directory stamp of the SAME bytes ``detail`` hashes
    — see :meth:`ZipArchive.member_stamp`. It is OPTIONAL because three other
    jobs (`ownership_backfill`, `xbrl_backfill`, `ftd`) checkpoint work items
    that are not zip members and have no stamp to give; they construct this
    dataclass unchanged and ``write_checkpoints`` writes no ``stamp`` field for
    them. Never set it on its own: a stamp is only trustworthy because the run
    that wrote it also verified the digest beside it.
    """

    item_key: str
    detail: str
    status: str = CHECKPOINT_DONE
    rows: int = 0
    bytes: int = 0
    stamp: str | None = None


@dataclass(frozen=True, slots=True)
class MemberCheckpoint:
    """What a finished bulk member left behind: its digest and its cheap stamp.

    ``stamp`` is the empty string for a LEGACY checkpoint — one written before
    MONEY-1283 — and that is a distinct state from a stamp that disagrees. The
    first costs one read (after which the row is upgraded in place); the second
    means the member genuinely changed.
    """

    sha256: str
    stamp: str = ""


def ensure_checkpoint_indexes(db: Any) -> None:
    """The compound unique that makes a checkpoint write idempotent."""
    try:
        db[CHECKPOINT_COLLECTION].create_index(
            [("jobKey", ASCENDING), ("itemKey", ASCENDING), ("scope", ASCENDING)], unique=True
        )
    except Exception as err:
        logger.error("[bulk] could not ensure checkpoint index: %s", type(err).__name__)


def load_checkpoints(db: Any, job_key: str) -> dict[str, str]:
    """``{itemKey: sha256}`` for members already finished. ONE query, not N.

    Only ``DONE`` rows are returned. An ``ERROR`` checkpoint records that the
    member was ATTEMPTED, not that it succeeded, and returning it here would
    make one bad night permanent: the member would be skipped every subsequent
    run and the failure would never be retried or reported again.
    """
    ensure_checkpoint_indexes(db)
    cursor = db[CHECKPOINT_COLLECTION].find(
        {"jobKey": job_key, "status": CHECKPOINT_DONE}, {"itemKey": 1, "detail": 1}
    )
    return {
        str(row.get("itemKey") or ""): str(row.get("detail") or "")
        for row in cursor
        if row.get("itemKey")
    }


def load_member_checkpoints(db: Any, job_key: str) -> dict[str, MemberCheckpoint]:
    """``{itemKey: MemberCheckpoint}`` for finished bulk members. ONE query.

    A SECOND loader rather than a widened :func:`load_checkpoints`, deliberately.
    That function's ``dict[str, str]`` contract is consumed by
    ``ownership_backfill``, ``xbrl_backfill`` and ``ftd``, none of which walk a
    zip or have any use for a stamp; changing its return type to serve the two
    bulk walkers would edit three jobs to fix two.

    Same ``DONE``-only rule as :func:`load_checkpoints`, for the same reason: an
    ``ERROR`` row records that the member was ATTEMPTED, and returning it here
    would make one bad night permanent.
    """
    ensure_checkpoint_indexes(db)
    cursor = db[CHECKPOINT_COLLECTION].find(
        {"jobKey": job_key, "status": CHECKPOINT_DONE},
        {"itemKey": 1, "detail": 1, "stamp": 1},
    )
    return {
        str(row.get("itemKey") or ""): MemberCheckpoint(
            sha256=str(row.get("detail") or ""), stamp=str(row.get("stamp") or "")
        )
        for row in cursor
        if row.get("itemKey")
    }


def stamp_unchanged(previous_stamp: str | None, stamp: str) -> bool:
    """Whether a member can be skipped WITHOUT reading it. PURE.

    Same shape as :func:`member_unchanged` and the same absent-is-never-a-match
    rule, and here it is load-bearing twice over. A missing stamp is a LEGACY
    checkpoint, not agreement: treating it as one would skip on the strength of a
    field nothing ever wrote, so a member that genuinely changed would be skipped
    forever and the table would freeze while the run reported converged. An empty
    freshly-computed stamp is the same refusal from the other side.
    """
    if not previous_stamp or not stamp:
        return False
    return previous_stamp == stamp


def member_unchanged(previous_detail: str | None, sha256: str) -> bool:
    """Whether a member can be skipped. PURE.

    An empty or missing stored hash is NEVER a skip. "We have no hash for this
    member" and "the hash matches" are different facts, and collapsing them would
    skip every member on the first run of a fresh environment and report the
    whole file as converged.
    """
    if not previous_detail or not sha256:
        return False
    return previous_detail == sha256


def _checkpoint_setter(entry: CheckpointEntry, now: datetime) -> dict[str, Any]:
    setter: dict[str, Any] = {
        "status": entry.status,
        "detail": entry.detail,
        "rows": int(entry.rows),
        "bytes": int(entry.bytes),
        "at": now,
    }
    # Only when the caller HAS one. Writing `stamp: None` for the three jobs that
    # checkpoint non-zip work items would put a null in every one of their rows
    # and make "no stamp because this job has none" indistinguishable from "a
    # stamp we failed to compute".
    if entry.stamp:
        setter["stamp"] = entry.stamp
    return setter


def write_checkpoints(db: Any, job_key: str, entries: Sequence[CheckpointEntry]) -> WriteResult:
    """Record what this run finished. Upsert on ``(jobKey, itemKey, scope)``."""
    if not entries:
        return WriteResult()
    now = datetime.now(UTC)
    operations = [
        UpdateOne(
            {"jobKey": job_key, "itemKey": entry.item_key, "scope": CHECKPOINT_SCOPE},
            {"$set": _checkpoint_setter(entry, now)},
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


def upgrade_checkpoint_stamps(db: Any, job_key: str, stamps: Mapping[str, str]) -> WriteResult:
    """Add a stamp to checkpoints that already exist. ``$set`` on ONE field.

    The legacy path: a member checkpointed before MONEY-1283 has a digest and no
    stamp, so the run has to read it once to recognise it. Having done that, it
    records the stamp so the NEXT run recognises it for free — the fix converges
    over one pass instead of needing a migration.

    Two properties, both deliberate and both asserted:

    * ``upsert=False``. This never CREATES a checkpoint. A row here is a claim
      that a member was processed and written; manufacturing one for a member
      this run only read is the MONEY-1235 shape (a suppressed create stamped as
      decided), and the member would be skipped forever having produced nothing.
    * It writes ``stamp`` and NOTHING else — not ``rows``, not ``bytes``, not
      ``at``. Those record the run that did the WORK. Re-``$set``ting them from
      here would zero the row count of every legacy member on the night it is
      upgraded, which reads afterwards as "processed, wrote nothing".
    """
    if not stamps:
        return WriteResult()
    operations = [
        UpdateOne(
            {"jobKey": job_key, "itemKey": item_key, "scope": CHECKPOINT_SCOPE},
            {"$set": {"stamp": stamp}},
            upsert=False,
        )
        for item_key, stamp in stamps.items()
        if stamp
    ]
    result = WriteResult()
    for start in range(0, len(operations), writers.DEFAULT_CHUNK):
        result = result + write_operations(
            db[CHECKPOINT_COLLECTION], operations[start : start + writers.DEFAULT_CHUNK]
        )
    return result


# ── The universe ────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Universe:
    """Which CIKs we hold a listing for, and each one's primary symbol."""

    ciks: frozenset[str]
    symbols: dict[str, str]

    def contains(self, cik: str) -> bool:
        return cik in self.ciks

    def symbol_for(self, cik: str) -> str | None:
        return self.symbols.get(cik)


def load_universe(db: Any) -> Universe:
    """ONE query over ``us_instruments``, never one per member.

    15,000 members x one lookup each is 15,000 round trips to Atlas inside a job
    whose whole budget is wall-clock; the whole ACTIVE set is ~41,000 small
    documents and fits in memory once.

    The filter is POSITIVE (``cik`` is a string) rather than ``{$ne: null}``.
    Both work in raw MongoDB, but the negative spelling is the one that returns
    ZERO through Prisma on a field that is ABSENT rather than null, and this
    query is copied by everyone who reads it next.
    """
    cursor = db[INSTRUMENTS_COLLECTION].find(
        {"listingStatus": "ACTIVE", "cik": {"$type": "string"}},
        {"cik": 1, "symbol": 1, "assetType": 1},
    )
    ciks: set[str] = set()
    candidates: dict[str, list[tuple[int, str]]] = {}
    for row in cursor:
        cik = normalise_cik(row.get("cik"))
        if not cik:
            continue
        ciks.add(cik)
        symbol = str(row.get("symbol") or "").strip()
        if not symbol or row.get("assetType") != "Stock":
            continue
        candidates.setdefault(cik, []).append((len(symbol), symbol))
    # One filer, many listings: BAC has 16 tickers (common + 15 preferreds) and
    # PSA has 17. The shortest symbol is the common share in every observed case
    # (`BAC` vs `BAC-PB`), and the lexicographic second key makes the choice
    # deterministic rather than dependent on cursor order.
    symbols = {cik: min(rows)[1] for cik, rows in candidates.items()}
    return Universe(ciks=frozenset(ciks), symbols=symbols)


def install_sec_limiter() -> None:
    """Install the shared 9 req/s SEC limiter in THIS process.

    ## Why every job entry point must call this

    The limiter is a process-local global (`app.sec.limiter._installed`) holding
    a Redis-backed bucket, and `try_acquire` raises `LimiterUnavailable` when it
    is absent. A Cloud Run JOB is its own process — it does not share the
    service's FastAPI lifespan — so each `main()` installs its own.

    That absence is not a loud failure, which is why it is worth a named helper
    rather than a line copied five times. `LimiterUnavailable` is a `SecError`,
    and the callers classify non-transport `SecError`s as deterministic upstream
    refusals: the run would report a clean `transportFailure` and a skip reason
    that reads like a quiet SEC, having fetched nothing. The MONEY-979 T21 audit
    found exactly this state — the function existed, was tested, and was called
    from nowhere in `app/`.

    Failure here is FATAL for a job, deliberately and unlike the service. A job
    exists only to fetch; one that starts without a budget either fetches
    nothing (fail-closed, its whole point) or — if the guard were ever softened
    — fetches unpaced against a per-IP limit shared with prod. Neither is worth
    starting for, and the exception carries the TLS/connection detail.
    """
    from app import settings
    from app.sec.limiter import install_shared_limiter

    install_shared_limiter(settings.redis_url(), settings.sec_rate_limit_per_sec())
