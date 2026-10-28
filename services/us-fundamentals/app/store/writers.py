"""Idempotent MongoDB writers for the eleven ``us_*`` collections — MONEY-979.

Every function here is safe to run twice. That is not a nicety: the bulk jobs are
checkpointed and resumable, Pub/Sub redelivers, and a backfill is expected to be
re-run over a window it has already covered. A writer that is not idempotent
turns each of those into duplicate rows that no reader can tell apart.

## The three rules the whole module is built on

**1. Every write is an upsert keyed on the Prisma ``@@unique``.** Never an
insert, never a blind update. The unique index is what makes the upsert atomic:
without it two concurrent runs both miss, both insert, and the collection quietly
holds two versions of one filing.

**2. ``$setOnInsert`` for ``ingestedAt``/``createdAt``, ``$set`` for the rest.**
Prisma's ``@default(now())`` is applied by PRISMA, not by MongoDB, so a pymongo
write that does not supply the value leaves the column absent forever. And a
``$set`` of it would move the ingest timestamp on every nightly re-run, which
destroys the one column that answers "when did we first see this".
``updatedAt`` is the one field whose operator depends on the ROW rather than the
collection — insert-only when :func:`_with_storage_timestamps` invented it,
``$set`` when the row declared it. That helper's docstring says why.

**3. An unknown field is ABSENT, never ``null``.** :meth:`app.store.models.Row.to_doc`
drops ``None`` before the document ever reaches here, so a field this run could
not determine keeps whatever a previous run stored and is never overwritten with
an explicit null. Four tickets in this repo (MONEY-1050, -1234, -1235, -1236)
come from the opposite arrangement.

## Why a write result carries four numbers

``matched`` / ``upserted`` / ``modified`` / ``failed``, and the job outcome is
built from them rather than from ``len(rows)``. ``len(rows)`` is what the job
INTENDED; these are what MongoDB DID. Reporting the first as the second is
exactly how six scheduled jobs ran green for a week having written nothing
(MONEY-1255). ``upserted + modified`` is the honest "written" number, and it is
legitimately ZERO on a converged re-run — which is why the bulk jobs skip
unchanged members instead of re-writing them, so that ``written == 0`` keeps
meaning "something is wrong".

## ``ordered=False``

One bad row must not discard the rest of the chunk. A :class:`BulkWriteError` is
caught, its partial counters are read out of ``details``, and the failing rows
are COUNTED. The alternative — letting it propagate — loses both the successful
writes' counts and the count of what failed.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

from pymongo import ASCENDING, UpdateOne
from pymongo.errors import BulkWriteError, OperationFailure

from app.store.collections import collection_name
from app.store.models import (
    ANNUAL_REPORT_FORMS,
    MAPPING_COMPANYFACTS,
    MAPPING_FILING_XBRL,
    Row,
    UsBeneficialOwnershipRow,
    UsCompanyFactRow,
    UsCusipMapRow,
    UsEdgarCursorRow,
    UsFilerRow,
    UsFilingDocumentRow,
    UsFilingRow,
    UsFundamentalsRow,
    UsInsiderTransactionRow,
    UsThirteenFFilingRow,
    UsThirteenFHoldingRow,
    utc_now,
)

logger = logging.getLogger("us-fundamentals.writers")

#: Operations per ``bulk_write``. Bounded so a filer with 40,000 filings does not
#: build one 40,000-operation list in memory next to the zip member it came from.
#: MongoDB's own ceiling is far higher; this is about the writer's footprint, not
#: the server's.
DEFAULT_CHUNK = 500

#: Fields MongoDB must set on INSERT and never touch again, for EVERY row.
#: ``updatedAt`` is deliberately not here: it is insert-only only for the rows
#: whose value :func:`_with_storage_timestamps` invented, and must keep moving
#: for the typed rows in ``app/bulk/*`` and ``app/jobs/*`` that declare it.
#: Widening this set unconditionally would freeze those at their first write.
INSERT_ONLY_ALWAYS = frozenset({"ingestedAt", "createdAt"})


@dataclass(frozen=True, slots=True)
class WriteResult:
    """What MongoDB actually did. Never what the caller hoped it would do."""

    matched: int = 0
    upserted: int = 0
    modified: int = 0
    failed: int = 0
    #: Rows an :class:`AuthorityGuard` deliberately did NOT overwrite because a
    #: stronger source already holds the row. Counted separately because it is
    #: the one case where ``written == 0`` is CORRECT: without it, a
    #: companyfacts run over periods the per-filing parser already covered is
    #: indistinguishable from the silent-zero-write failure the job monitor
    #: exists to catch.
    suppressed: int = 0

    @property
    def written(self) -> int:
        """Rows that changed the collection — the number a job outcome reports.

        ``matched`` is excluded deliberately: a matched-but-unmodified row is a
        row this run agreed with, not a row this run wrote.
        """
        return self.upserted + self.modified

    @property
    def touched(self) -> int:
        """Rows the filter reached, changed or not."""
        return self.upserted + self.matched

    def __add__(self, other: WriteResult) -> WriteResult:
        return WriteResult(
            matched=self.matched + other.matched,
            upserted=self.upserted + other.upserted,
            modified=self.modified + other.modified,
            failed=self.failed + other.failed,
            suppressed=self.suppressed + other.suppressed,
        )

    def as_dict(self) -> dict[str, int]:
        return {
            "matched": self.matched,
            "upserted": self.upserted,
            "modified": self.modified,
            "failed": self.failed,
            "suppressed": self.suppressed,
            "written": self.written,
        }


# ── Index management ────────────────────────────────────────────────────────
#
# `prisma db push` owns these in a deployed environment. They are ensured here
# anyway because the UNIQUE ones are what make an upsert atomic, and a fresh
# environment (a test cluster, a restored QA) can otherwise run for a whole night
# accumulating duplicates that every reader then reports as real history.
#
# NO EXPLICIT INDEX NAMES. pymongo's generated name (`cik10_1`) is MongoDB's
# default, which is also what Prisma's Mongo connector emits for an unnamed
# `@@unique`/`@@index`. Passing a name of our own would create a SECOND index
# with identical keys — invisible in every query plan, paid for on every write.

#: ``logical collection -> ((keys, unique), ...)``.
INDEX_SPECS: dict[str, tuple[tuple[tuple[tuple[str, int], ...], bool], ...]] = {
    "filers": (
        ((("cik10", ASCENDING),), True),
        ((("inUniverse", ASCENDING), ("eligibleForCoverage", ASCENDING)), False),
    ),
    "filings": (
        ((("accession", ASCENDING),), True),
        ((("cik10", ASCENDING), ("filedAt", ASCENDING)), False),
        ((("status", ASCENDING), ("parseClass", ASCENDING)), False),
    ),
    "fundamentals": (
        (
            (
                ("cik10", ASCENDING),
                ("statementType", ASCENDING),
                ("periodType", ASCENDING),
                ("periodEnd", ASCENDING),
                ("accession", ASCENDING),
            ),
            True,
        ),
        (
            (
                ("cik10", ASCENDING),
                ("statementType", ASCENDING),
                ("periodType", ASCENDING),
                ("periodEnd", ASCENDING),
            ),
            False,
        ),
        ((("cik10", ASCENDING), ("isLatest", ASCENDING)), False),
    ),
    "company_facts": (
        (
            (
                ("cik10", ASCENDING),
                ("taxonomy", ASCENDING),
                ("concept", ASCENDING),
                ("unit", ASCENDING),
            ),
            True,
        ),
    ),
    "insider_transactions": (((("accession", ASCENDING), ("rowIndex", ASCENDING)), True),),
    "thirteen_f_filings": (((("accession", ASCENDING),), True),),
    "thirteen_f_holdings": (((("accession", ASCENDING), ("rowIndex", ASCENDING)), True),),
    "beneficial_ownership": (((("accession", ASCENDING), ("rowIndex", ASCENDING)), True),),
    "filing_documents": (((("accession", ASCENDING), ("sequence", ASCENDING)), True),),
    "cusip_map": (((("cusip", ASCENDING),), True),),
    "edgar_cursor": (((("key", ASCENDING),), True),),
}

_ensured: set[tuple[int, str]] = set()


def reset_index_cache() -> None:
    """Forget which collections have had their indexes ensured. Test-only."""
    _ensured.clear()


def ensure_indexes(db: Any, logical: str) -> None:
    """Create the indexes for one logical collection, once per process.

    NEVER RAISES. An index this service does not own is Prisma's to create, and
    failing the whole nightly run over an ``IndexOptionsConflict`` — which means
    an equivalent index already exists under a different spelling — would be a
    self-inflicted outage. The failure is LOGGED at error level with the driver's
    code, because a genuinely missing unique index is a real correctness problem
    and must not be silent either.
    """
    marker = (id(db), logical)
    if marker in _ensured:
        return
    _ensured.add(marker)
    collection = db[collection_name(logical)]
    for keys, unique in INDEX_SPECS.get(logical, ()):
        try:
            collection.create_index(list(keys), unique=unique)
        except OperationFailure as err:
            logger.error(
                "[writers] could not ensure index on %s %s (unique=%s): %s %s",
                collection_name(logical),
                list(keys),
                unique,
                getattr(err, "code", "?"),
                type(err).__name__,
            )
        except Exception as err:
            logger.error(
                "[writers] could not ensure index on %s %s: %s",
                collection_name(logical),
                list(keys),
                type(err).__name__,
            )


def collection(db: Any, logical: str) -> Any:
    """The physical collection handle, with its indexes ensured."""
    ensure_indexes(db, logical)
    return db[collection_name(logical)]


# ── The generic upsert ──────────────────────────────────────────────────────


def _chunks(items: Sequence[Any], size: int) -> Iterator[Sequence[Any]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


@dataclass(frozen=True, slots=True)
class AuthorityGuard:
    """Refuse to overwrite a row a STRONGER source already wrote.

    ## Why a rank table alone is not enough

    ``MAPPING_SOURCE_RANK`` used to be consulted in exactly one place —
    :func:`recompute_is_latest`, which decides which row carries the
    ``isLatest`` pointer. That runs AFTER the write. A declared authority order
    that the WRITER never reads does not protect anything: it ranks the corpses.

    ``us_fundamentals`` has two writers and ``mappingSource`` is NOT in its
    unique key, deliberately (adding it would make one period two rows, which
    every reader would double-count while looking entirely normal — the same
    trap documented for ``StockFinancials.basis``). Both writers derive their
    rows from the SAME filing and therefore the same ``accession``, so they
    collide on the full key. The per-filing XBRL parse produces the rich view —
    dimensional segments, company extension concepts — and the
    ``companyfacts.zip`` fallback produces a strictly poorer one. Without this
    guard the nightly bulk pass ``$set``s the poor view over the rich one and
    the richer data is simply gone; nothing is left to reconcile against.

    This is the same defect the India side already paid for twice, recorded in
    the root ``CLAUDE.md``: ``StockFinancials`` has no ``source`` in its unique
    key, "so the FIRST XBRL write for a period destroys the value it replaced".

    ## How it is enforced

    A plain conditional filter cannot be combined with ``upsert=True``: when a
    stronger incumbent makes the filter miss, MongoDB would INSERT rather than
    skip, and the insert violates the unique index. So an authority-guarded
    write is TWO passes, in order:

    1. ``$setOnInsert`` the whole document, ``upsert=True`` — creates the row
       when absent, no-ops when present.
    2. ``$set`` the mutable fields, ``upsert=False``, filtered on the incumbent
       NOT being a strictly-stronger source.

    ``$nin`` is deliberate: it matches documents where the field is ABSENT as
    well, so a legacy row written before this field existed ranks lowest and may
    be replaced — rather than being unreachable, which is how a Mongo
    ``{field: null}`` filter silently selects nothing.
    """

    #: Document field carrying the source name, e.g. ``"mappingSource"``.
    field: str
    #: Source name -> rank. Higher wins; an unlisted value ranks 0 (weakest).
    rank: Mapping[str, int]

    def stronger_than(self, value: Any) -> list[str]:
        """Sources that OUTRANK ``value`` and must therefore not be overwritten."""
        mine = self.rank.get(str(value or ""), 0)
        return sorted(name for name, r in self.rank.items() if r > mine)


@dataclass(frozen=True, slots=True)
class WritePolicy:
    """Per-collection write protections, declared ONCE for every path.

    ``us_fundamentals`` is reached two ways and this is why the table exists:

      * ``upsert_fundamentals`` — the bulk companyfacts fallback
      * ``MongoRowWriter.upsert_rows`` — the per-filing parse, via
        ``dispatch.py``, which passes a LOGICAL collection name and a key and
        nothing else

    The second path used to call :func:`bulk_upsert` bare. So the per-filing
    parse — the AUTHORITATIVE writer — wrote `isLatest: False` from its own row
    model into ``$set`` on every re-parse, demoting the current winner. The
    dispatch loop recomputes the pointer immediately afterwards, but in a
    SEPARATE loop after ALL writes: a crash, a throw, or an unwired recompute in
    between leaves the period with no latest row at all, which is exactly the
    failure ``upsert_fundamentals``' docstring reasons about and protects
    against. One path was protected and its twin was not.

    Keyed by LOGICAL collection name (``app.store.collections.COLLECTIONS``), so
    both paths resolve the same entry and neither can drift from the other.

    ``filings`` is deliberately ABSENT. Its ``status`` is insert-only only when
    the caller says so (``upsert_filings(status_on_insert_only=...)``), because
    the nightly ledger must not downgrade a status a parser already advanced.
    A policy here would have to pick one of the two and would silently override
    the caller. The parse path does not write ``filings`` through
    ``upsert_rows`` — it uses ``set_filing_status`` — so nothing needs it.
    """

    insert_only: frozenset[str] = frozenset()
    authority: AuthorityGuard | None = None


def write_policy(collection_key: str) -> WritePolicy:
    """The policy for a LOGICAL collection name. Unknown -> no extra protection.

    Deliberately total rather than raising: a collection with nothing to protect
    is the common case, and a KeyError here would turn "no policy needed" into a
    failed parse.
    """
    return _WRITE_POLICY.get(collection_key, WritePolicy())

def _with_storage_timestamps(
    document: dict[str, Any], now: datetime
) -> tuple[dict[str, Any], frozenset[str]]:
    """Stamp the two fields Prisma fills CLIENT-SIDE and pymongo never would.

    MONEY-1317. ``ingestedAt DateTime @default(now())`` and
    ``updatedAt DateTime @updatedAt`` are REQUIRED in ``schema.prisma`` and both
    are applied by the Prisma CLIENT. This service writes through pymongo, so a
    document that does not carry them is stored with the column ABSENT — and
    every Prisma read of that row then raises::

        PrismaClientKnownRequestError  P2032
        Error converting field "ingestedAt" of expected non-nullable type

    Measured on prod 2026-09-01, before this existed: **785,352 rows across
    SEVEN collections** — `us_filing_documents`, `us_insider_transactions`,
    `us_cusip_map`, `us_13f_filings`, `us_13f_holdings`,
    `us_beneficial_ownership` entirely, and 21,725 of `us_fundamentals`. That
    last one has a live reader (``getStatements``) and a MIXED population, so it
    failed per-symbol and intermittently rather than outright, which is why
    nobody saw it.

    ## Why HERE and not in the row builders

    Four ``build_rows`` functions produce these dicts, and stamping them there
    was the first attempt. It broke ``test_parsing_twice_produces_identical_rows``
    in two suites — correctly. A parse is a pure function of the filing's bytes;
    the same bytes must yield the same rows or a reparse is not detectably a
    no-op. **These timestamps are storage metadata, not parse output.** Putting
    them in the writer keeps parses deterministic AND covers every collection,
    including ones whose builders nobody has written yet.

    ## FILL, never OVERRIDE — and the fill must not reach ``$set``

    Both are set only when the document does not carry them, which is why the
    SECOND return value exists: the caller has to know which of the two THIS
    helper supplied, because a filled value and a declared one must reach
    MongoDB through different operators.

    ``ingestedAt`` is insert-only for everyone (``INSERT_ONLY_ALWAYS``), so it
    was never at risk. ``updatedAt`` is not, and must not be: the typed rows in
    ``app/bulk/*`` and ``app/jobs/*`` pass an explicit ``updatedAt=stamp`` and
    MEAN it to move — a cursor row whose ``updatedAt`` froze at first insert
    would stop answering "when did this job last run", which is the only
    question it is asked. So those keep Prisma's ``@updatedAt`` semantics and
    stay in ``$set``.

    A value we invented for a row that never mentioned the field carries no such
    intent, and putting it in ``$set`` is actively destructive: ``now`` differs
    on every run, so every re-parse of an UNCHANGED filing reports
    ``modified == N``. That is the number
    :meth:`MongoRowWriter.upsert_rows` returns and a zero-write monitor reads —
    make it always non-zero and an idempotent no-op becomes indistinguishable
    from real work, in the one direction the monitor cannot alarm on.

    The first version of this helper had exactly that defect, and the two tests
    named as its guards could not see it: both
    ``test_ingested_at_is_set_on_insert_and_never_moved`` and
    ``test_second_run_touches_the_row_and_reports_written_zero_when_nothing_changed``
    construct a TYPED row with an explicit ``updatedAt=stamp``, so the fill
    never fires and the fixture supplies the very thing under test. The guards
    for the dict path are the ones under "MONEY-1317 round 2" in
    ``tests/test_store_writers.py``, which pass NO timestamps at all.

    The cost of routing the fill through ``$setOnInsert`` is that a
    writer-stamped ``updatedAt`` records the row's CREATION, not its last
    change — the same instant as ``ingestedAt``. That is honest: nothing here
    knows when the row last changed, and the field exists to satisfy a
    non-nullable Prisma read. A caller that wants a real change clock declares
    the field, which is what the typed rows already do.
    """
    filled: set[str] = set()
    if "ingestedAt" not in document:
        document["ingestedAt"] = now
        filled.add("ingestedAt")
    if "updatedAt" not in document:
        document["updatedAt"] = now
        filled.add("updatedAt")
    return document, frozenset(filled)



def bulk_upsert(
    target: Any,
    rows: Iterable[Row],
    key_fields: Sequence[str],
    *,
    insert_only: Iterable[str] = (),
    authority: AuthorityGuard | None = None,
    chunk: int = DEFAULT_CHUNK,
) -> WriteResult:
    """Upsert rows onto ``target`` keyed on ``key_fields``.

    ``insert_only`` names fields that go into ``$setOnInsert`` — a field may be
    in exactly one of the two operators, because MongoDB rejects an update that
    names the same path in both ("would create a conflict at ...") and rejects
    the WHOLE operation, not just that field.

    ``authority`` makes the write REFUSE to overwrite a row a stronger source
    already holds; see :class:`AuthorityGuard`. It costs a second round trip per
    chunk and reports the refusals as ``WriteResult.suppressed``.
    """
    insert_only_fields = INSERT_ONLY_ALWAYS | frozenset(insert_only)
    if authority is not None:
        return _bulk_upsert_guarded(
            target, rows, key_fields, insert_only_fields, authority, chunk
        )
    now = utc_now()
    operations: list[UpdateOne] = []
    for row in rows:
        document, filled = _with_storage_timestamps(row.to_doc(), now)
        try:
            criteria = {field: document[field] for field in key_fields}
        except KeyError as err:
            # The unique key cannot be absent. Raising here is the only place
            # anyone still knows which row it was; a write with a partial filter
            # would silently upsert onto some OTHER row.
            raise ValueError(
                f"{type(row).__name__}: key field {err.args[0]!r} is missing or None; "
                f"cannot upsert onto {key_fields}"
            ) from err
        # PER ROW, not per batch. `filled` names the timestamps the writer
        # invented for THIS document because the row did not carry them; they
        # are insert-only for this row alone. A row that DECLARES `updatedAt`
        # keeps it in `$set`, which is Prisma's semantics and what the typed
        # `app/bulk/*` / `app/jobs/*` rows intend. See
        # `_with_storage_timestamps`.
        row_insert_only = insert_only_fields | filled
        setter = {k: v for k, v in document.items() if k not in row_insert_only}
        on_insert = {k: v for k, v in document.items() if k in row_insert_only}
        update: dict[str, Any] = {"$set": setter}
        if on_insert:
            update["$setOnInsert"] = on_insert
        operations.append(UpdateOne(criteria, update, upsert=True))

    result = WriteResult()
    for batch in _chunks(operations, max(1, chunk)):
        result = result + write_operations(target, list(batch))
    return result


def _bulk_upsert_guarded(
    target: Any,
    rows: Iterable[Row],
    key_fields: Sequence[str],
    insert_only_fields: frozenset[str],
    authority: AuthorityGuard,
    chunk: int,
) -> WriteResult:
    """:func:`bulk_upsert` with an :class:`AuthorityGuard`. Two passes, ordered.

    The CREATE pass must complete before the UPDATE pass, so that
    ``suppressed`` means "a stronger source holds this row" and never "the row
    did not exist yet". After the create pass every row exists, so the update
    pass matches exactly the rows the guard permits, and the arithmetic
    ``suppressed = len(rows) - matched`` is exact rather than inferred.
    """
    if authority.field in key_fields:
        # The guarded filter replaces `field` with a `$nin`, so a guard on a KEY
        # field would destroy the key equality and the update could land on a
        # DIFFERENT row. Refuse loudly: the whole reason `mappingSource` is
        # outside the unique key is that putting it in makes one period two rows.
        raise ValueError(
            f"AuthorityGuard field {authority.field!r} is part of the unique key "
            f"{tuple(key_fields)}; guarding a key field would corrupt the filter"
        )
    now = utc_now()
    creates: list[UpdateOne] = []
    updates: list[UpdateOne] = []
    for row in rows:
        document, filled = _with_storage_timestamps(row.to_doc(), now)
        try:
            criteria = {field: document[field] for field in key_fields}
        except KeyError as err:
            raise ValueError(
                f"{type(row).__name__}: key field {err.args[0]!r} is missing or None; "
                f"cannot upsert onto {key_fields}"
            ) from err
        # Same per-row rule as `bulk_upsert`, and it has to be stated again
        # because this path builds `setter` separately. The CREATE pass below
        # `$setOnInsert`s the WHOLE document, so a writer-filled timestamp
        # already lands on a new row; leaving it in `setter` as well would
        # refresh it on every re-parse and turn each one into a modification —
        # which on THIS collection (`us_fundamentals`, the one with a live
        # reader) is the number the zero-write monitor watches.
        setter = {k: v for k, v in document.items() if k not in (insert_only_fields | filled)}
        creates.append(UpdateOne(criteria, {"$setOnInsert": document}, upsert=True))
        stronger = authority.stronger_than(document.get(authority.field))
        guarded = dict(criteria)
        if stronger:
            guarded[authority.field] = {"$nin": stronger}
        updates.append(UpdateOne(guarded, {"$set": setter}, upsert=False))

    result = WriteResult()
    for create_batch, update_batch in zip(
        _chunks(creates, max(1, chunk)), _chunks(updates, max(1, chunk)), strict=True
    ):
        create_batch = list(create_batch)
        update_batch = list(update_batch)
        created = write_operations(target, create_batch)
        updated = write_operations(target, update_batch)
        # `matched` on the UPDATE pass is the number the guard let through; every
        # row exists by now, so the remainder was refused. `created.matched` is
        # not part of this arithmetic and is dropped: it counts rows that already
        # existed, which says nothing about authority.
        # A row is SUPPRESSED only if it exists and the guard refused it. Every
        # other outcome must be subtracted, or `suppressed` absorbs them:
        #
        #   permitted        the guard let it through (created or pre-existing)
        #   updated.failed   the guarded $set itself errored
        #   created.failed   the CREATE errored, so the row may not exist at all
        #                    and its $set matched nothing
        #
        # Dropping that last term is not a rounding error, it INVERTS the
        # signal: a batch whose creates all failed reported `written=0,
        # suppressed=N`, which is exactly the signature this counter exists to
        # certify as healthy. It also over-subtracts nothing — a create that
        # failed on a duplicate key means a concurrent writer inserted the row,
        # so the $set matched and the row is already inside `permitted`.
        permitted = updated.matched + updated.upserted
        result = result + WriteResult(
            matched=updated.matched,
            upserted=created.upserted,
            modified=updated.modified,
            failed=created.failed + updated.failed,
            suppressed=max(
                0,
                len(update_batch) - permitted - updated.failed - created.failed,
            ),
        )
    return result


def write_operations(target: Any, operations: list[UpdateOne]) -> WriteResult:
    """Run one already-built batch of operations. Partial failures are COUNTED."""
    if not operations:
        return WriteResult()
    try:
        outcome = target.bulk_write(operations, ordered=False)
    except BulkWriteError as err:
        details = err.details or {}
        errors = details.get("writeErrors") or []
        logger.error(
            "[writers] %d of %d operations failed: first=%s",
            len(errors),
            len(operations),
            (errors[0] or {}).get("code") if errors else "?",
        )
        return WriteResult(
            matched=int(details.get("nMatched", 0)),
            upserted=int(details.get("nUpserted", 0)),
            modified=int(details.get("nModified", 0)),
            failed=len(errors),
        )
    return WriteResult(
        matched=int(getattr(outcome, "matched_count", 0) or 0),
        upserted=int(getattr(outcome, "upserted_count", 0) or 0),
        modified=int(getattr(outcome, "modified_count", 0) or 0),
    )


# ── One writer per collection ───────────────────────────────────────────────


def upsert_filers(
    db: Any, rows: Sequence[UsFilerRow], *, chunk: int = DEFAULT_CHUNK
) -> WriteResult:
    """``us_filers``, keyed on ``cik10``."""
    return bulk_upsert(collection(db, "filers"), rows, ("cik10",), chunk=chunk)


def upsert_filings(
    db: Any,
    rows: Sequence[UsFilingRow],
    *,
    status_on_insert_only: bool = True,
    chunk: int = DEFAULT_CHUNK,
) -> WriteResult:
    """``us_filings``, keyed on ``accession``.

    ``status_on_insert_only`` (the default, and what the nightly ledger uses)
    routes ``status`` through ``$setOnInsert``, so the ledger can record a filing
    it has never seen as ``INDEXED`` without DOWNGRADING one a detector already
    saw (``DETECTED``) or a parser already finished (``PARSED``). The ledger's
    whole purpose is to find filings detection missed; overwriting the status of
    the ones it did not miss would erase that measurement.

    ``detectedAt`` is insert-only for the same reason: it is set by whichever
    detector saw the filing live, and the ledger — which by definition did not —
    must not restate it.
    """
    insert_only = {"detectedAt"}
    if status_on_insert_only:
        insert_only.add("status")
    return bulk_upsert(
        collection(db, "filings"), rows, ("accession",), insert_only=insert_only, chunk=chunk
    )


def upsert_fundamentals(
    db: Any, rows: Sequence[UsFundamentalsRow], *, chunk: int = DEFAULT_CHUNK
) -> WriteResult:
    """``us_fundamentals``, keyed on ``(cik10, statementType, periodType, periodEnd, accession)``.

    ``isLatest`` is INSERT-ONLY. It is a derived pointer owned by
    :func:`recompute_is_latest`, and a row model carrying the default ``False``
    would otherwise demote the current winner on every re-write — leaving a
    window in which a period has no latest row at all, and leaving it permanently
    if the recompute is not reached.

    THE WRITE IS AUTHORITY-GUARDED. Two writers land here — the per-filing XBRL
    parse and the ``companyfacts.zip`` fallback — and because both derive from
    the same filing they produce the same ``accession`` and therefore collide on
    the whole unique key. ``mappingSource`` is not in that key by design, so
    without :class:`AuthorityGuard` the weaker COMPANYFACTS row ``$set``s over
    the richer FILING_XBRL one and the dimensional segments are gone. See
    :data:`MAPPING_SOURCE_RANK` for why FILING_XBRL outranks COMPANYFACTS.
    """
    return bulk_upsert(
        collection(db, "fundamentals"),
        rows,
        ("cik10", "statementType", "periodType", "periodEnd", "accession"),
        insert_only=write_policy("fundamentals").insert_only,
        authority=write_policy("fundamentals").authority,
        chunk=chunk,
    )


def upsert_company_facts(
    db: Any, rows: Sequence[UsCompanyFactRow], *, chunk: int = DEFAULT_CHUNK
) -> WriteResult:
    """``us_company_facts``, keyed on ``(cik10, taxonomy, concept, unit)``.

    ``values`` is REPLACED, not appended: the caller derives the whole series
    from one companyfacts member, so the incoming array is authoritative and an
    append would double every value on the second run.
    """
    return bulk_upsert(
        collection(db, "company_facts"),
        rows,
        ("cik10", "taxonomy", "concept", "unit"),
        chunk=chunk,
    )


def upsert_insider_transactions(
    db: Any, rows: Sequence[UsInsiderTransactionRow], *, chunk: int = DEFAULT_CHUNK
) -> WriteResult:
    """``us_insider_transactions``, keyed on ``(accession, rowIndex)``."""
    return bulk_upsert(
        collection(db, "insider_transactions"), rows, ("accession", "rowIndex"), chunk=chunk
    )


def upsert_thirteenf_filings(
    db: Any, rows: Sequence[UsThirteenFFilingRow], *, chunk: int = DEFAULT_CHUNK
) -> WriteResult:
    """``us_13f_filings``, keyed on ``accession``.

    ``tier`` is INSERT-ONLY. It is owned by the evictor (T9), which moves a
    quarter's rows to a cold shard and then sets ``COLD``; a re-parse writing the
    model default ``HOT`` back over it would tell every reader to look in
    ``us_13f_holdings`` for rows that have been deleted.
    """
    return bulk_upsert(
        collection(db, "thirteen_f_filings"),
        rows,
        ("accession",),
        insert_only=write_policy("thirteen_f_filings").insert_only,
        chunk=chunk,
    )


def upsert_thirteenf_holdings(
    db: Any, rows: Sequence[UsThirteenFHoldingRow], *, chunk: int = DEFAULT_CHUNK
) -> WriteResult:
    """``us_13f_holdings``, keyed on ``(accession, rowIndex)``."""
    return bulk_upsert(
        collection(db, "thirteen_f_holdings"), rows, ("accession", "rowIndex"), chunk=chunk
    )


def upsert_beneficial_ownership(
    db: Any, rows: Sequence[UsBeneficialOwnershipRow], *, chunk: int = DEFAULT_CHUNK
) -> WriteResult:
    """``us_beneficial_ownership``, keyed on ``(accession, rowIndex)``."""
    return bulk_upsert(
        collection(db, "beneficial_ownership"), rows, ("accession", "rowIndex"), chunk=chunk
    )


def upsert_filing_documents(
    db: Any, rows: Sequence[UsFilingDocumentRow], *, chunk: int = DEFAULT_CHUNK
) -> WriteResult:
    """``us_filing_documents``, keyed on ``(accession, sequence)``."""
    return bulk_upsert(
        collection(db, "filing_documents"), rows, ("accession", "sequence"), chunk=chunk
    )


def upsert_cusip_map(
    db: Any, rows: Sequence[UsCusipMapRow], *, chunk: int = DEFAULT_CHUNK
) -> WriteResult:
    """``us_cusip_map``, keyed on ``cusip``."""
    return bulk_upsert(collection(db, "cusip_map"), rows, ("cusip",), chunk=chunk)


def upsert_cursor(db: Any, row: UsEdgarCursorRow) -> WriteResult:
    """``us_edgar_cursor``, keyed on ``key``."""
    return bulk_upsert(collection(db, "edgar_cursor"), [row], ("key",))


def read_cursor(db: Any, key: str) -> dict[str, Any] | None:
    """One cursor document, or ``None`` when the stream has never run."""
    return collection(db, "edgar_cursor").find_one({"key": key})


def bump_filer_coverage(
    db: Any,
    cik10: str,
    *,
    name: str,
    fiscal_years_on_file: int,
    eligible_for_coverage: bool,
) -> WriteResult:
    """Raise a filer's coverage counters, using ``$max``. Never lowers them.

    TWO SOURCES MEASURE THIS ONE FACT AND BOTH UNDERCOUNT, in different
    directions. ``submissions.zip`` counts annual forms in ``filings.recent``,
    which is a rolling window — a prolific filer's older 10-Ks live in the paging
    shards. ``companyfacts.zip`` counts fiscal years carrying tagged XBRL facts,
    which floors at the filer's first XBRL filing (2009 for most, later for a
    recent IPO). Whichever ran last would win a plain ``$set``, so the number
    would oscillate between two wrong values on alternate nights.

    ``$max`` makes it a floor that only ever rises, which is the safe direction
    for a COVERAGE GATE: it can under-report our history but can never claim
    history we do not have. Booleans compare ``false < true`` in BSON, so
    ``eligibleForCoverage`` rides the same operator.
    """
    now = utc_now()
    target = collection(db, "filers")
    return write_operations(
        target,
        [
            UpdateOne(
                {"cik10": cik10},
                {
                    "$max": {
                        "fiscalYearsOnFile": int(fiscal_years_on_file),
                        "eligibleForCoverage": bool(eligible_for_coverage),
                    },
                    "$set": {"updatedAt": now},
                    "$setOnInsert": {
                        "cik10": cik10,
                        "name": name,
                        "source": "SEC_EDGAR",
                        "inUniverse": False,
                        "ingestedAt": now,
                    },
                },
                upsert=True,
            )
        ],
    )


def mark_filing_status(
    db: Any,
    accession: str,
    status: str,
    *,
    parser_version: str | None = None,
    parsed_at: datetime | None = None,
    error: str | None = None,
    raw_path: str | None = None,
) -> WriteResult:
    """Set one filing's parse state. UPDATE-ONLY — never creates the row.

    ``upsert=False`` on purpose: the row is created by detection or by the
    nightly ledger, both of which know the filing's ``form``, ``filedAt`` and
    ``parseClass``. An upsert here would create a row missing every one of them,
    and ``form``/``filedAt``/``parseClass`` are REQUIRED in Prisma — so the
    partial row would not read as incomplete, it would make every Prisma query
    that touched it THROW (the dangling-required-field class).
    """
    update: dict[str, Any] = {"status": status, "updatedAt": utc_now()}
    if parser_version is not None:
        update["parserVersion"] = parser_version
    if parsed_at is not None:
        update["parsedAt"] = parsed_at
    if error is not None:
        update["error"] = error
    if raw_path is not None:
        update["rawPath"] = raw_path
    return write_operations(
        collection(db, "filings"),
        [UpdateOne({"accession": accession}, {"$set": update}, upsert=False)],
    )


# ── isLatest ────────────────────────────────────────────────────────────────
#
# PURE ranking below, I/O after it. The rank function takes a plain document, so
# a test drives the REAL comparison rather than a re-declared copy of it.

#: Source authority. HIGHER WINS, and an unrecognised value ranks LAST — a new
#: upstream can fill a gap but can never displace a source we have reasoned
#: about. Same shape as `FINANCIALS_AUTHORITY` on the India side.
#:
#: FILING_XBRL beats COMPANYFACTS because the two are not two opinions about one
#: number: `companyfacts.zip` carries no dimensional facts and no company
#: extension concepts AT ALL, so a COMPANYFACTS row is a strictly poorer view of
#: the same period. It is a FALLBACK for periods no per-filing parse has reached.
#:
#: The cost of putting authority above recency is written down rather than
#: discovered later: a restatement that exists ONLY in companyfacts — the prior
#: year re-presented inside a later 10-K — will not become `isLatest` while a
#: FILING_XBRL row exists for that period. It is still STORED under its OWN
#: accession and still reachable through the point-in-time read on `filedAt`,
#: which is the read a backtest uses.
#:
#: THAT LAST CLAIM USED TO READ "the accession is in the unique key, so nothing
#: is destroyed", FULL STOP, and it was false in the case that mattered. It is
#: true only for two DIFFERENT accessions. Both writers derive their rows from
#: the same filing, so for the SAME accession they collide on the entire unique
#: key, and the blind `$set` destroyed the richer row. This table decided
#: `isLatest` and nothing else; the WRITE consulted no authority at all. That is
#: now enforced at the write by `AuthorityGuard` — see `upsert_fundamentals`.
MAPPING_SOURCE_RANK: dict[str, int] = {
    MAPPING_FILING_XBRL: 2,
    MAPPING_COMPANYFACTS: 1,
}

#: Per-collection write protections. Read by BOTH write paths — see
#: :class:`WritePolicy`. Declared here, below :data:`MAPPING_SOURCE_RANK`,
#: because it references it.
_WRITE_POLICY: dict[str, WritePolicy] = {
    "fundamentals": WritePolicy(
        insert_only=frozenset({"isLatest"}),
        authority=AuthorityGuard(field="mappingSource", rank=MAPPING_SOURCE_RANK),
    ),
    # `tier` is owned by the EVICTOR, which archives a filing's holdings to GCS,
    # DELETES them from Mongo and then sets COLD. A re-parse carrying the model
    # default `HOT` would tell every reader to look in `us_13f_holdings` for rows
    # that are not there.
    #
    # This protection previously lived only on `upsert_thirteenf_filings`, which
    # has ZERO callers — the live writer is the parse path through
    # `MongoRowWriter.upsert_rows`, which had no protection at all. So the rule
    # was declared on a dead function and did nothing, the same shape as the
    # authority order above. Reading the policy from here is what turned it on.
    #
    # KNOWN OPEN INTERACTION, written down rather than discovered later: a
    # re-parse of an ALREADY-EVICTED filing restores its holdings to Mongo, but
    # `tier` stays COLD, so `evict_logic`'s `{"tier": {"$ne": "COLD"}}` never
    # selects it again — the rows stay hot forever while `coldPath` points at a
    # shard that no longer matches. Nothing evicts today (`EDGAR_EVICT_APPLY`
    # ships off), so this is latent. The fix belongs to the evictor or to a
    # deliberate re-promotion at parse time, NOT to removing this entry: the
    # alternative failure — readers sent to a table whose rows were deleted — is
    # the worse of the two, and is what the entry prevents.
    "thirteen_f_filings": WritePolicy(insert_only=frozenset({"tier"})),
}

#: Exactly the fields :func:`latest_rank` reads. The projection is built FROM
#: this list rather than hand-written beside it: a hardcoded `select` that had
#: drifted from the code grading it is what made "we never asked for the column"
#: print as "the vendor has no value" in the F3 reconcile.
IS_LATEST_FIELDS = ("accession", "filedAt", "form", "isAmendment", "mappingSource", "isLatest")


def _epoch(value: Any) -> float:
    """A sortable instant. Absent sorts LAST, so a row with no date never wins."""
    if isinstance(value, datetime):
        stamped = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
        return stamped.timestamp()
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=UTC).timestamp()
    return float("-inf")


def latest_rank(document: dict[str, Any]) -> tuple[int, float, int, int, str]:
    """The ordering that decides ``isLatest``. Higher wins. PURE.

    In order:

    1. ``mappingSource`` authority — see :data:`MAPPING_SOURCE_RANK`.
    2. ``filedAt``: the later filing restates the earlier one.
    3. Form: a 10-K/20-F/40-F beats a 10-Q for the same period end, because the
       annual report is audited and the quarter is not.
    4. A non-amendment beats an amendment filed at the same instant. (An
       amendment filed LATER already won at step 2; this only settles the tie.)
    5. ``accession``, lexicographically. Not a business rule — a TIE-BREAKER, so
       the answer cannot depend on the order MongoDB happened to return the rows
       in. ``accession`` is part of the unique key, so it is always distinct
       within a group and the ordering is therefore total.
    """
    form = str(document.get("form") or "")
    return (
        MAPPING_SOURCE_RANK.get(str(document.get("mappingSource") or ""), 0),
        _epoch(document.get("filedAt")),
        2 if form in ANNUAL_REPORT_FORMS else 1,
        0 if document.get("isAmendment") else 1,
        str(document.get("accession") or ""),
    )


def pick_latest(documents: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    """The one row that should carry ``isLatest``. PURE, and order-independent."""
    if not documents:
        return None
    return max(documents, key=latest_rank)


@dataclass(frozen=True, slots=True)
class IsLatestResult:
    """What the recompute found and changed."""

    candidates: int = 0
    winner: str | None = None
    promoted: int = 0
    demoted: int = 0


def recompute_is_latest(
    db: Any,
    cik10: str,
    statement_type: str,
    period_type: str,
    period_end: date | datetime,
) -> IsLatestResult:
    """Make exactly one row in the group carry ``isLatest: true``.

    RE-RUNNABLE and INDEPENDENT OF INSERTION ORDER: it reads the group back out
    of MongoDB and ranks it, so it does not matter which row was written first,
    which run wrote it, or whether a previous recompute crashed halfway. Running
    it twice changes nothing the second time, and ``modified`` reports 0 — that
    is the property the idempotency test asserts.

    It deliberately does NOT touch ``updatedAt``. ``isLatest`` is a derived
    pointer, not filed data; bumping the timestamp would make every no-op re-run
    report a modification and destroy exactly the signal above.
    """
    target = collection(db, "fundamentals")
    query = {
        "cik10": cik10,
        "statementType": statement_type,
        "periodType": period_type,
        "periodEnd": _as_datetime(period_end),
    }
    projection = {field: 1 for field in IS_LATEST_FIELDS}
    documents = list(target.find(query, projection))
    winner = pick_latest(documents)
    if winner is None:
        return IsLatestResult()

    demoted = target.update_many(
        {**query, "_id": {"$ne": winner["_id"]}}, {"$set": {"isLatest": False}}
    )
    promoted = target.update_one({"_id": winner["_id"]}, {"$set": {"isLatest": True}})
    return IsLatestResult(
        candidates=len(documents),
        winner=str(winner.get("accession") or ""),
        promoted=int(getattr(promoted, "modified_count", 0) or 0),
        demoted=int(getattr(demoted, "modified_count", 0) or 0),
    )


def _as_datetime(value: date | datetime) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return datetime(value.year, value.month, value.day, tzinfo=UTC)


# ── The RowWriter adapter (MONEY-979 integration) ────────────────────────────
#
# `app/parsers/dispatch.py` binds to `writers.default_writer()` and drives a
# narrow `RowWriter` protocol: LOGICAL collection names, plain dicts, ints back.
# This module was built the other way round — per-collection functions taking a
# `db` handle and typed Row models — because those are what the bulk jobs need.
#
# Both shapes are right for their callers, so this is an adapter rather than a
# rewrite of either. It matters that it exists at all: without it
# `resolve_writer()` returns None, and an ARMED parse then raises
# `WriterUnavailable` — which is the correct failure (a writer that reports a
# clean zero is how a job runs nightly and stores nothing) but is still a
# service that cannot write. The two contracts were written in parallel by
# different tasks and neither was wrong; nothing had yet made them meet.


class _DocRow:
    """Adapts a plain dict to the ``Row`` protocol ``bulk_upsert`` expects.

    Everything valuable in `bulk_upsert` — key extraction with a named error,
    the `$setOnInsert` split, chunking, partial-failure counting — works on
    `row.to_doc()`. Wrapping is a line; duplicating that logic for dicts would
    be a second writer to keep in step.
    """

    __slots__ = ("_doc",)

    def __init__(self, doc: Mapping[str, Any]) -> None:
        self._doc = doc

    def to_doc(self) -> dict[str, Any]:
        return dict(self._doc)


class MongoRowWriter:
    """`RowWriter` over a live database handle."""

    def __init__(self, db: Any) -> None:
        self._db = db

    def upsert_rows(
        self, collection_name: str, rows: Sequence[Mapping[str, Any]], *, key: Sequence[str]
    ) -> int:
        if not rows:
            return 0
        target = collection(self._db, collection_name)
        policy = write_policy(collection_name)
        result = bulk_upsert(
            target,
            [_DocRow(r) for r in rows],
            tuple(key),
            insert_only=policy.insert_only,
            authority=policy.authority,
        )
        # UPSERTED + MODIFIED, not `matched`. A re-parse that changes nothing
        # matches every row and modifies none, and reporting that as "wrote N"
        # would make an idempotent no-op indistinguishable from real work — the
        # number a zero-write monitor reads.
        #
        # That sentence is a claim about the WRITER, not about this line, and it
        # was false for one release: `_with_storage_timestamps` filled a fresh
        # `utc_now()` into `updatedAt`, `INSERT_ONLY_ALWAYS` did not cover it, so
        # every dict row's `$set` differed on every run and `modified` could
        # never reach zero. Nothing here can detect that — the arithmetic stays
        # correct while the input stops meaning anything. It is held true by the
        # per-row `$setOnInsert` routing in `bulk_upsert` /
        # `_bulk_upsert_guarded` and by the dict-path tests under
        # "MONEY-1317 round 2" that pass NO timestamps.
        return result.upserted + result.modified

    def set_filing_status(
        self,
        accession: str,
        *,
        status: str,
        parsed_at: datetime,
        parser_version: str,
        error: str | None = None,
    ) -> None:
        mark_filing_status(
            self._db,
            accession,
            status,
            parser_version=parser_version,
            parsed_at=parsed_at,
            error=error,
        )

    def recompute_is_latest(
        self,
        *,
        cik10: str,
        statement_type: str,
        period_type: str,
        period_end: datetime,
    ) -> int:
        outcome = recompute_is_latest(self._db, cik10, statement_type, period_type, period_end)
        return outcome.promoted + outcome.demoted

    def delete_rows(self, collection_name: str, where: Mapping[str, Any]) -> int:
        """Used ONLY by a 13F RESTATEMENT supersede, which is why it exists.

        Optional in the protocol: dispatch checks for it and reports
        `supersedeSkippedReason` rather than pretending when it is absent.
        """
        target = collection(self._db, collection_name)
        return int(target.delete_many(dict(where)).deleted_count)


def default_writer() -> MongoRowWriter:
    """The factory `dispatch.resolve_writer()` looks for.

    Resolves the database handle PER CALL. A module-level handle would freeze at
    import — the same failure this repo has hit with kill switches and with the
    dedupe store factory earlier in this very service.
    """
    from app.db import get_database

    return MongoRowWriter(get_database())
