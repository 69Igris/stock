"""GCS key builders and the cold-shard codec — PURE. No GCS, no network, no clock.

Everything here is a decision, so everything here is testable without a bucket.
:mod:`app.sec.archive` is the thin I/O wrapper that calls into it.

## Why the keys are validated instead of formatted

A key is the ONLY handle an archived object has. There is no index, no foreign
key and no listing that would notice a wrong one: an object written to
``edgar/filings//0001-25-000001/submission.txt`` (empty CIK) or to
``edgar/facts/0000320193/us-gaap/v2`` (a taxonomy carrying a slash) is stored
successfully, reported successfully, and is then unreachable by every reader
that builds the same key correctly. Nothing fails; the object is simply lost.

So every segment is checked and a bad one RAISES. The failure has to land on the
writer, at the moment the bad value exists, because that is the last point where
anyone knows what it was supposed to be.

## Why the shard format is gzipped JSONL

Byte-compatible with ``packages/core/src/market-data/candles/candle-logic.ts``
(:func:`serializeColdShard` / :func:`parseColdShard`, lines 579-760) — one
compact JSON object per line, rows sorted, ``\\n``-joined, **no trailing
newline**, gzipped, and the key carries **no extension** so a parquet writer can
later take the same keys. Readers sniff the magic bytes rather than trusting the
key, and this module recognises ``PAR1`` explicitly so a future parquet shard
fails LOUDLY instead of decoding as an empty shard — absence and unreadability
must never look alike (the MONEY-1189 shape: a completeness check reporting
SUCCESS for work that never happened).

Two Python-specific details that byte-compatibility depends on:

* ``json.dumps`` must use ``separators=(",", ":")``. Python's default puts a
  space after every ``:`` and ``,``; ``JSON.stringify`` does not.
* ``ensure_ascii=False``. ``JSON.stringify`` emits raw UTF-8; Python's default
  escapes every non-ASCII character to ``\\uXXXX``. Both parse identically, but
  an issuer name like ``Bâloise`` would otherwise make the two writers produce
  different bytes for the same row — and the sha256 of a shard is how a re-write
  is recognised as a no-op.

``gzip.compress(..., mtime=0)`` for the same reason: the default stamps the
current time into the gzip header, so re-encoding identical rows would produce
different bytes every time and no hash could ever match. Node's ``gzipSync``
writes a zero mtime, so this also matches the TypeScript writer byte for byte.
"""

from __future__ import annotations

import gzip
import json
import re
import zlib
from collections.abc import Callable, Iterable, Sequence
from datetime import date
from typing import Any, NamedTuple

# ── Types ───────────────────────────────────────────────────────────────────

#: One shard row. Shapes differ per feed (facts vs 13F holdings); the codec does
#: not care, which is why it is shared.
Row = dict[str, Any]

#: A shard is stored gzipped, and the object's content type says so.
SHARD_CONTENT_TYPE = "application/gzip"

#: Everything this service archives lives under one top-level prefix.
#:
#: NOT ``feeds/``: the prod->QA mirror rsyncs that whole prefix twice a day
#: (``sync-prod-to-qa-feeds``), and the raw filing bundles run to ~330 GB/yr.
#: One wrong prefix here would silently double that bill in QA.
ROOT_PREFIX = "edgar"

GZIP_MAGIC = b"\x1f\x8b"
#: Parquet files begin AND end with these four bytes.
PARQUET_MAGIC = b"PAR1"

_ACCESSION_RE = re.compile(r"^\d{10}-\d{2}-\d{6}$")
_CIK10_RE = re.compile(r"^\d{10}$")
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class ArchiveKeyError(ValueError):
    """A key segment was empty, malformed, or carried a separator/control character."""


class ShardFormatError(ValueError):
    """Stored bytes are not a shard this build can read."""


class ShardCorruptError(ShardFormatError):
    """The gzip member is truncated or damaged. NOT an empty shard."""


class ShardEncodeError(ValueError):
    """A row could not be serialised — non-finite number, or a non-JSON type."""


class ShardParse(NamedTuple):
    """Rows that decoded, and how many lines did not.

    ``dropped`` is returned rather than logged-and-forgotten because a shard that
    silently loses 40% of its lines reads exactly like a shard that was written
    with 60% of the rows. The caller reports it as a counter; a run that drops
    lines is visible.
    """

    rows: list[Row]
    dropped: int


# ── Key builders ────────────────────────────────────────────────────────────


def bulk_key(feed: str, day: str | date, basename: str | None = None) -> str:
    """``edgar/bulk/{feed}/{YYYY-MM-DD}/{basename}`` — a dated raw upstream file.

    Dated, unlike the feed archive's undated ``current/`` objects, because these
    two zips are REPLACED daily upstream and the bytes of a given day are what a
    reparse must be able to reproduce. Lifecycle deletes them after 30 days.
    """
    feed_seg = _segment(feed, "feed")
    day_seg = _iso_day(day)
    name = basename if basename is not None else f"{feed_seg}.zip"
    return f"{ROOT_PREFIX}/bulk/{feed_seg}/{day_seg}/{_segment(name, 'basename')}"


def filing_key(cik10: str, accession: str) -> str:
    """``edgar/filings/{cik10}/{accession}/submission.txt`` — the raw SGML bundle.

    Fetched ONCE and kept forever. This key is the raw-first doctrine in one
    line: every parser reads bytes from here, so a mapping change or an
    edgartools upgrade re-parses from the archive and never re-hits SEC.
    """
    return f"{ROOT_PREFIX}/filings/{_cik10(cik10)}/{_accession(accession)}/submission.txt"


def text_key(cik10: str, accession: str, sequence: int) -> str:
    """``edgar/text/{cik10}/{accession}/{sequence}.txt`` — one extracted exhibit.

    Derived and re-derivable from :func:`filing_key`; safe to delete, unlike the
    bundle it came from.
    """
    return f"{ROOT_PREFIX}/text/{_cik10(cik10)}/{_accession(accession)}/{_sequence(sequence)}.txt"


def facts_shard_key(cik10: str, taxonomy: str) -> str:
    """``edgar/facts/{cik10}/{taxonomy}`` — EVERY as-reported fact for one filer.

    No extension, deliberately: the format is sniffed from the bytes, so a
    parquet producer can write these exact keys later without moving an object
    or touching a reader.
    """
    return f"{ROOT_PREFIX}/facts/{_cik10(cik10)}/{_segment(taxonomy, 'taxonomy')}"


def thirteenf_shard_key(manager_cik10: str, period: str | date) -> str:
    """``edgar/13f/{managerCik10}/{periodOfReport}`` — evicted 13F holdings.

    Also extension-free, same reason.
    """
    return f"{ROOT_PREFIX}/13f/{_cik10(manager_cik10)}/{_iso_day(period)}"


def accession_nodashes(accession: str) -> str:
    """``0001214659-26-011109`` -> ``000121465926011109``.

    SEC's ``/Archives`` directory segment uses the undashed form while the file
    inside it uses the dashed one, and the two appear in the same URL. Validated
    on the way through so a caller cannot build the URL from a malformed value.
    """
    return _accession(accession).replace("-", "")


# ── Segment validation ──────────────────────────────────────────────────────


def _segment(value: object, what: str) -> str:
    """One path segment: non-empty, no ``/``, no control characters, no ``..``."""
    if not isinstance(value, str):
        raise ArchiveKeyError(f"{what}: expected a string, got {type(value).__name__}")
    if value != value.strip():
        raise ArchiveKeyError(f"{what}: surrounding whitespace in {value!r}")
    if not _SEGMENT_RE.match(value):
        # Covers empty, "/", "\\", "..", leading ".", spaces, newlines, NULs and
        # every other control character in one rule.
        raise ArchiveKeyError(
            f"{what}: {value!r} is not a usable key segment "
            "(need [A-Za-z0-9][A-Za-z0-9._-]*, no separators, no control characters)"
        )
    if ".." in value:
        raise ArchiveKeyError(f"{what}: {value!r} contains '..'")
    return value


def _cik10(value: object) -> str:
    """Exactly ten digits — the ``cik10`` the Prisma models are keyed on.

    Rejecting the unpadded form is deliberate. ``320193`` and ``0000320193`` are
    the same company and would be two different prefixes in the bucket, so the
    archive would be half-written under each and neither would be complete.
    """
    if not isinstance(value, str) or not _CIK10_RE.match(value):
        raise ArchiveKeyError(f"cik10: expected 10 digits, got {value!r}")
    return value


def _accession(value: object) -> str:
    """The dashed canonical form, ``0001214659-26-011109``."""
    if not isinstance(value, str) or not _ACCESSION_RE.match(value):
        raise ArchiveKeyError(f"accession: expected NNNNNNNNNN-NN-NNNNNN, got {value!r}")
    return value


def _sequence(value: object) -> str:
    """A 1-based document sequence within a filing."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ArchiveKeyError(f"sequence: expected an integer >= 1, got {value!r}")
    return str(value)


def _iso_day(value: str | date) -> str:
    """``YYYY-MM-DD``, and it must be a REAL date.

    A shape-only check would accept ``2026-02-31``, which sorts between two real
    days and can never be produced again by a reader computing the same date.
    """
    if isinstance(value, date):
        return value.isoformat()
    if not isinstance(value, str) or not _ISO_DATE_RE.match(value):
        raise ArchiveKeyError(f"date: expected YYYY-MM-DD, got {value!r}")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise ArchiveKeyError(f"date: {value!r} is not a real calendar date") from exc
    return value


# ── Shard codec ─────────────────────────────────────────────────────────────


def sniff_shard_format(head: bytes) -> str:
    """``"JSONL_GZ"`` or ``"PARQUET"`` from the leading bytes; RAISES otherwise.

    Unrecognised bytes are an error and never a third "unknown" value that a
    caller could shrug at, because the only two things a reader could do with
    such a value are (a) raise, or (b) treat the shard as empty — and (b) is the
    failure mode this codebase keeps rediscovering.
    """
    if head[:2] == GZIP_MAGIC:
        return "JSONL_GZ"
    if head[:4] == PARQUET_MAGIC:
        return "PARQUET"
    raise ShardFormatError(
        f"unrecognised shard format (first bytes {head[:4].hex() or '<empty>'}); expected gzip (1f8b)"
    )


def serialize_shard(
    rows: Iterable[Row],
    *,
    sort_key: Callable[[Row], str] | None = None,
) -> str:
    """Rows -> the shard's uncompressed text. Sorted, compact, NO trailing newline.

    The missing trailing newline is a contract, not an oversight: the TypeScript
    reader splits on ``\\n`` and a trailing one yields a final empty element. It
    tolerates that (it skips blank lines) — but "tolerated" and "correct" differ
    the moment someone counts lines to count rows, so the writers agree on the
    stricter shape and a test asserts it.

    Ordering is ``(sort_key(row), line)`` so the bytes depend only on the SET of
    rows, never on the order they were handed over. Two runs that write the same
    rows produce the same object, and a no-op re-write is provably a no-op.
    """
    lines: list[tuple[str, str]] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ShardEncodeError(f"row {index}: expected an object, got {type(row).__name__}")
        line = _dump_row(row, index)
        lines.append((sort_key(row) if sort_key else line, line))
    lines.sort()
    return "\n".join(line for _, line in lines)


def parse_shard(text: str) -> ShardParse:
    """Shard text -> rows, tolerant PER LINE and strict about nothing else.

    One corrupt line is dropped and COUNTED; it must not cost the whole shard —
    a 13F shard is a manager-quarter and a facts shard is a filer's entire
    reported history. Blank lines are not "dropped": they are separators, and
    counting them would make a well-formed shard look damaged.
    """
    rows: list[Row] = []
    dropped = 0
    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            parsed = json.loads(stripped)
        except ValueError:
            dropped += 1
            continue
        if not isinstance(parsed, dict):
            # A bare array or scalar is not a row. Accepting it would push the
            # type error downstream into a writer, which is the worst place for
            # it to surface.
            dropped += 1
            continue
        rows.append(parsed)
    return ShardParse(rows=rows, dropped=dropped)


def encode_shard(
    rows: Iterable[Row],
    *,
    sort_key: Callable[[Row], str] | None = None,
) -> bytes:
    """Rows -> the exact bytes stored at the shard key."""
    text = serialize_shard(rows, sort_key=sort_key)
    return gzip.compress(text.encode("utf-8"), compresslevel=9, mtime=0)


def decode_shard(body: bytes) -> ShardParse:
    """Stored bytes -> rows, format chosen by magic bytes rather than by key."""
    fmt = sniff_shard_format(body)
    if fmt == "PARQUET":
        raise ShardFormatError(
            "shard is parquet, but no parquet decoder is installed. Add a branch here; "
            "the key layout and every caller stay unchanged (see the format note in "
            "candle-logic.ts)."
        )
    try:
        text = gzip.decompress(body).decode("utf-8", errors="replace")
    except (OSError, EOFError, zlib.error) as exc:
        # Truncated or damaged. NOT an empty shard: returning zero rows here
        # would let an eviction "verify" its archive against nothing and then
        # delete the hot rows it was supposed to have preserved.
        raise ShardCorruptError(f"shard gzip member is unreadable: {exc}") from exc
    return parse_shard(text)


def merge_shard(
    existing: Sequence[Row],
    incoming: Sequence[Row],
    key_fn: Callable[[Row], str],
) -> list[Row]:
    """Read-merge-write. INCOMING wins; everything else is preserved.

    A GCS put REPLACES the object. A writer that encodes only the rows it happens
    to hold destroys every other row in the shard — and destroys them silently,
    because the put succeeds. So every shard write reads first and merges here.

    Incoming wins because the caller has just derived it; the alternative
    (existing wins) would make a repair re-run a no-op, which is the one thing a
    repair must not be.
    """
    merged: dict[str, Row] = {}
    for row in existing:
        merged[key_fn(row)] = row
    for row in incoming:
        merged[key_fn(row)] = row
    return [merged[key] for key in sorted(merged)]


def _dump_row(row: Row, index: int) -> str:
    try:
        # allow_nan=False: Python would otherwise emit the literals `NaN` and
        # `Infinity`, which are not JSON. Every strict reader (JSON.parse
        # included) rejects the line, so the row would be written and then
        # silently dropped on read — the "₹NaN" poison, archived.
        return json.dumps(row, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ShardEncodeError(f"row {index}: {exc}") from exc
