"""CUSIP -> ticker: the I/O. Every DECISION lives in :mod:`app.parsers.cusip_map_logic`.

Four tiers, three of them primary-source, run strongest-first and each one only
over the CUSIPs the tiers above it could not answer. The precedence guard —
"a lower tier may never overwrite a higher one" — is applied once, in
``cusip_map_logic.plan_writes``, so a tier added later cannot forget it.

THE HIT-RATE IS REPORTED, NOT ASSUMED. ``TIINGO_FIGI`` was planned as a cheap
early tier and then MEASURED nearly empty: the 13F ``figi`` column has been
optional since EDGAR Release 22.4.1 and Berkshire omits it on all 89 rows of its
2026 filing. A tier that resolves nothing looks exactly like a tier that was
never reached, so every run emits ``byTier`` counts and per-tier hit rates.

``SEC_FTD`` takes an INJECTED lookup and, with none, reports ``"unavailable"`` —
a third value, distinct from "tried and found nothing". Collapsing the two would
let a permanently un-provisioned tier read as a tier with poor coverage forever.
The real lookup is built by ``app.bulk.ftd.make_ftd_lookup`` off the archive
``edgar-bulk-ftd`` writes; nothing here constructs it, because the decision to
spend a GCS read or an OpenFIGI quota belongs to the job.

:func:`sweep_unresolved` is the entry point the sentence about "everything the
sweep learned" refers to. Until it existed there was no sweep: an UNRESOLVED row
was written once by whichever 13F parse first met the CUSIP and never revisited,
so ``attempts`` counted to one forever and every holding of that issuer stayed
symbol-less. ``edgar-cusip-sweep-daily`` drives it through
``/jobs/edgar-detect`` with ``{"mode": "cusip-sweep"}``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, Protocol

from app.parsers import cusip_map_logic as logic
from app.parsers.cusip_map_logic import UNRESOLVED, normalise_ticker
from app.parsers.dispatch import US_INSTRUMENTS_COLLECTION, RowWriter
from app.store.collections import collection_name

#: Unique key of ``us_cusip_map``.
CUSIP_KEY: tuple[str, ...] = ("cusip",)

#: Logical collection name. Physical resolution happens in the writer.
CUSIP_COLLECTION = "cusip_map"

#: How :func:`select_unresolved` rotates. **ASCENDING, and that is the whole
#: point.** ``desc`` on a growing population never reaches the oldest rows: it
#: is not "newest first, oldest later", it is "oldest never" — every 13F parsed
#: tonight adds UNRESOLVED rows that push the existing ones further down, and
#: the sweep re-visits the same head forever (MONEY-1255, 36,001 documents and
#: ~2 years to drain at the observed rate).
#:
#: ``lastTriedAt`` is ABSENT on a row no sweep has visited, and MongoDB sorts a
#: missing field FIRST in ascending order — so never-tried rows are served
#: before once-tried ones, which is exactly the order wanted. ``cusip`` breaks
#: the tie so a page boundary is deterministic rather than dependent on the
#: storage order of rows sharing a timestamp.
UNRESOLVED_SORT: tuple[tuple[str, int], ...] = (("lastTriedAt", 1), ("cusip", 1))


class FtdLookup(Protocol):
    """CUSIP -> SYMBOL from SEC's Fails-to-Deliver files. T8 provides the real one."""

    def __call__(self, cusips: Sequence[str]) -> Mapping[str, str]: ...


class CusipSources:
    """The database reads the tiers need. One class so the tiers stay declarative."""

    def __init__(self, database: Any) -> None:
        self._db = database

    def subject_ciks(self, cusips: Sequence[str]) -> dict[str, dict[str, Any]]:
        """Tier (a): our own 13D/G cover pages, CUSIP -> subject CIK + name.

        Filtered POSITIVELY on ``cusip``. ``{"cusip": {"$ne": None}}`` would
        match zero rows on this collection the day a `db push` adds a field,
        because an absent attribute is not a null one.
        """
        cursor = self._db[collection_name("beneficial_ownership")].find(
            {"cusip": {"$in": list(cusips)}},
            {"_id": 0, "cusip": 1, "subjectCik10": 1, "subjectName": 1, "filedAt": 1},
        )
        newest: dict[str, dict[str, Any]] = {}
        for row in cursor:
            cusip = row.get("cusip")
            if not cusip or not row.get("subjectCik10"):
                continue
            seen = newest.get(cusip)
            # Newest cover page wins: a subject company can change its CUSIP
            # after a reorganisation, and the recent filing is the current pair.
            if seen is None or (row.get("filedAt") or datetime.min) >= (
                seen.get("filedAt") or datetime.min
            ):
                newest[cusip] = row
        return newest

    def figis(self, cusips: Sequence[str]) -> dict[str, str]:
        """Tier (b): CUSIP -> ``figi`` as filed on a 13F information table."""
        cursor = self._db[collection_name("thirteen_f_holdings")].find(
            {"cusip": {"$in": list(cusips)}, "figi": {"$type": "string"}},
            {"_id": 0, "cusip": 1, "figi": 1},
        )
        return {row["cusip"]: row["figi"] for row in cursor if row.get("cusip") and row.get("figi")}

    def instruments_by_cik(self, ciks: Sequence[str]) -> dict[str, list[Mapping[str, Any]]]:
        by_cik: dict[str, list[Mapping[str, Any]]] = {}
        if not ciks:
            return by_cik
        cursor = self._db[US_INSTRUMENTS_COLLECTION].find(
            {"cik": {"$in": list(ciks)}, "listingStatus": "ACTIVE"},
            {"_id": 0, "cik": 1, "symbol": 1, "openFIGIComposite": 1},
        )
        for row in cursor:
            by_cik.setdefault(row["cik"], []).append(row)
        return by_cik

    def instruments_by_figi(self, figis: Sequence[str]) -> dict[str, Mapping[str, Any]]:
        if not figis:
            return {}
        cursor = self._db[US_INSTRUMENTS_COLLECTION].find(
            {"openFIGIComposite": {"$in": list(figis)}, "listingStatus": "ACTIVE"},
            {"_id": 0, "cik": 1, "symbol": 1, "openFIGIComposite": 1},
        )
        return {row["openFIGIComposite"]: row for row in cursor if row.get("openFIGIComposite")}

    def instruments_by_symbol(self, symbols: Sequence[str]) -> dict[str, Mapping[str, Any]]:
        if not symbols:
            return {}
        cursor = self._db[US_INSTRUMENTS_COLLECTION].find(
            {"symbol": {"$in": list(symbols)}, "listingStatus": "ACTIVE"},
            {"_id": 0, "cik": 1, "symbol": 1, "openFIGIComposite": 1},
        )
        return {row["symbol"]: row for row in cursor if row.get("symbol")}

    def existing(self, cusips: Sequence[str]) -> dict[str, Mapping[str, Any]]:
        cursor = self._db[collection_name(CUSIP_COLLECTION)].find(
            {"cusip": {"$in": list(cusips)}},
            {"_id": 0, "cusip": 1, "source": 1, "symbol": 1, "cik10": 1, "attempts": 1},
        )
        return {row["cusip"]: row for row in cursor if row.get("cusip")}

    def unresolved(self, limit: int) -> list[str]:
        """The ``limit`` least-recently-tried UNRESOLVED CUSIPs. The sweep's population.

        Filtered POSITIVELY on ``source``. ``{"symbol": None}`` would be the
        obvious way to ask "which rows have no ticker" and it returns ZERO on
        this collection: ``to_doc()`` omits null fields, so an unresolved row has
        no ``symbol`` ATTRIBUTE at all and neither ``{"symbol": None}`` nor
        ``{"symbol": {"$ne": None}}`` matches it (MONEY-1050 / 1234 / 1235).
        ``source`` is always written, so it is the one field that can be asked
        about safely.
        """
        if limit < 1:
            return []
        cursor = (
            self._db[collection_name(CUSIP_COLLECTION)]
            .find({"source": UNRESOLVED}, {"_id": 0, "cusip": 1})
            .sort(list(UNRESOLVED_SORT))
            .limit(limit)
        )
        return [row["cusip"] for row in cursor if row.get("cusip")]


class NullCusipSources:
    """No database. Every tier that needs one reports zero and says why."""

    def subject_ciks(self, cusips: Sequence[str]) -> dict[str, dict[str, Any]]:
        return {}

    def figis(self, cusips: Sequence[str]) -> dict[str, str]:
        return {}

    def instruments_by_cik(self, ciks: Sequence[str]) -> dict[str, list[Mapping[str, Any]]]:
        return {}

    def instruments_by_figi(self, figis: Sequence[str]) -> dict[str, Mapping[str, Any]]:
        return {}

    def instruments_by_symbol(self, symbols: Sequence[str]) -> dict[str, Mapping[str, Any]]:
        return {}

    def existing(self, cusips: Sequence[str]) -> dict[str, Mapping[str, Any]]:
        return {}

    def unresolved(self, limit: int) -> list[str]:
        return []


def resolve_sources() -> Any:
    """Mongo-backed sources, or :class:`NullCusipSources` when unconfigured."""
    from app import settings

    if not settings.database_url():
        return NullCusipSources()
    from app.db import get_database

    database = get_database()
    return NullCusipSources() if database is None else CusipSources(database)


def _one_symbol(rows: Sequence[Mapping[str, Any]]) -> str | None:
    """The single ACTIVE symbol for a CIK, or ``None`` when there is a choice.

    Same refusal as the ownership resolver, for the same reason: BAC's CIK
    carries 16 tickers and picking one of them for a 13F holding would attach a
    position in the common stock to a preferred series.
    """
    symbols = {row["symbol"] for row in rows if row.get("symbol")}
    return next(iter(symbols)) if len(symbols) == 1 else None


def resolve_cusips(
    cusips: Sequence[str],
    *,
    sources: Any | None = None,
    openfigi: Any | None = None,
    writer: RowWriter | None = None,
    apply: bool = False,
    ftd_lookup: FtdLookup | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Run the four tiers over ``cusips`` and, when armed, store the result.

    Returns the tier report plus the resolutions, so a caller that is not
    writing (a dry run, or ``parse_13f`` reporting coverage) still learns
    everything the sweep learned.
    """
    stamped = now or datetime.now(UTC)
    src = sources if sources is not None else resolve_sources()
    wanted = logic.distinct_cusips(cusips)
    if not wanted:
        return {
            **logic.tier_report({}, 0),
            "resolutions": {},
            "written": 0,
            "ftd": "unavailable" if ftd_lookup is None else "idle",
        }

    pending = list(wanted)
    resolved: dict[str, dict[str, Any]] = {}
    counts: dict[str, int] = {}

    def take(cusip: str, row: dict[str, Any], tier: str) -> None:
        resolved[cusip] = row
        counts[tier] = counts.get(tier, 0) + 1

    # ── tier (a) SEC_13DG — our own cover pages ─────────────────────────────
    subjects = src.subject_ciks(pending)
    by_cik = src.instruments_by_cik(
        sorted({row["subjectCik10"] for row in subjects.values() if row.get("subjectCik10")})
    )
    for cusip in list(pending):
        subject = subjects.get(cusip)
        if not subject:
            continue
        cik = subject["subjectCik10"]
        take(
            cusip,
            logic.resolution_row(
                cusip,
                source="SEC_13DG",
                symbol=_one_symbol(by_cik.get(cik, [])),
                cik10=cik,
                issuer_name=subject.get("subjectName"),
                resolved_at=stamped,
                last_tried_at=stamped,
            ),
            "SEC_13DG",
        )
    pending = [c for c in pending if c not in resolved]

    # ── tier (b) TIINGO_FIGI — the 13F figi column. Measured nearly empty. ──
    figi_by_cusip = src.figis(pending)
    instruments_by_figi = src.instruments_by_figi(sorted(set(figi_by_cusip.values())))
    for cusip in list(pending):
        figi = figi_by_cusip.get(cusip)
        instrument = instruments_by_figi.get(figi) if figi else None
        if not instrument:
            continue
        take(
            cusip,
            logic.resolution_row(
                cusip,
                source="TIINGO_FIGI",
                symbol=instrument.get("symbol"),
                cik10=instrument.get("cik"),
                composite_figi=figi,
                resolved_at=stamped,
                last_tried_at=stamped,
            ),
            "TIINGO_FIGI",
        )
    pending = [c for c in pending if c not in resolved]

    # ── tier (c) SEC_FTD — partial and rolling, and not provisioned yet ─────
    ftd_state = "unavailable"
    if ftd_lookup is not None:
        ftd_state = "queried"
        hits = ftd_lookup(pending) or {}
        instruments = src.instruments_by_symbol(
            sorted({s for s in (normalise_ticker(v) for v in hits.values()) if s})
        )
        for cusip in list(pending):
            symbol = normalise_ticker(hits.get(cusip))
            if not symbol:
                continue
            instrument = instruments.get(symbol) or {}
            take(
                cusip,
                logic.resolution_row(
                    cusip,
                    source="SEC_FTD",
                    symbol=symbol,
                    cik10=instrument.get("cik"),
                    composite_figi=instrument.get("openFIGIComposite"),
                    resolved_at=stamped,
                    last_tried_at=stamped,
                ),
                "SEC_FTD",
            )
        pending = [c for c in pending if c not in resolved]

    # ── tier (d) OPENFIGI — its own host, its own pacer, its own budget ─────
    openfigi_state = "unavailable"
    if openfigi is not None and pending:
        openfigi_state = "queried"
        matches = openfigi.map_cusips(pending)
        instruments = src.instruments_by_symbol(
            sorted({m["symbol"] for m in matches.values() if m.get("symbol")})
        )
        for cusip in list(pending):
            match = matches.get(cusip)
            if not match:
                continue
            symbol = match.get("symbol")
            instrument = instruments.get(symbol) if symbol else None
            take(
                cusip,
                logic.resolution_row(
                    cusip,
                    source="OPENFIGI",
                    # Only a symbol our own master actually carries is stored.
                    # OpenFIGI knows tickers we do not list, and a symbol no
                    # instrument row backs joins to nothing while looking
                    # resolved.
                    symbol=symbol if instrument else None,
                    cik10=(instrument or {}).get("cik"),
                    composite_figi=match.get("compositeFigi"),
                    issuer_name=match.get("issuerName"),
                    resolved_at=stamped,
                    last_tried_at=stamped,
                ),
                "OPENFIGI",
            )
        pending = [c for c in pending if c not in resolved]

    # ── whatever is left is a ROW, not a silence ────────────────────────────
    for cusip in pending:
        resolved[cusip] = logic.resolution_row(
            cusip, source=UNRESOLVED, attempts=1, last_tried_at=stamped
        )

    existing = src.existing(wanted)
    writes = logic.plan_writes(resolved, existing)

    written = 0
    if apply and writes:
        if writer is None:
            from app.parsers.dispatch import _require_writer

            writer = _require_writer(None)
        written = int(writer.upsert_rows(CUSIP_COLLECTION, writes, key=CUSIP_KEY) or 0)

    report = logic.tier_report(counts, len(wanted))
    report.update(
        {
            "resolutions": resolved,
            "planned": len(writes),
            "written": written,
            "applied": bool(apply),
            "ftd": ftd_state,
            "openfigi": openfigi_state,
        }
    )
    return report


def sweep_unresolved(
    *,
    sources: Any | None = None,
    limit: int = 500,
    openfigi: Any | None = None,
    ftd_lookup: FtdLookup | None = None,
    writer: RowWriter | None = None,
    apply: bool = False,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Re-run the four tiers over the least-recently-tried UNRESOLVED rows.

    THE ENTRY POINT THE MODULE DOCSTRING ALREADY PROMISED. ``resolve_cusips``
    says it returns "everything the sweep learned" and no sweep existed: an
    UNRESOLVED row was written once, by whichever 13F parse first met the CUSIP,
    and never looked at again. ``us_cusip_map.attempts`` counted to one forever
    and every holding of that issuer stayed symbol-less.

    ## Every VISITED row is stamped, not every resolved one

    That property is not implemented here — it is inherited, and stating where
    from matters more than restating it. ``resolve_cusips`` writes a row for
    each CUSIP it was handed: a resolution for the ones a tier answered, and an
    ``UNRESOLVED`` row with ``attempts=1`` and ``lastTriedAt`` for the ones none
    did. ``plan_writes`` then adds that 1 to whatever was stored. So a CUSIP the
    sweep failed on moves to the BACK of :data:`UNRESOLVED_SORT` exactly like
    one it succeeded on.

    Stamping only the winners is the failure this shape avoids: the losers keep
    the oldest ``lastTriedAt`` in the table, are therefore selected again next
    run, and are selected again every run after that — a sweep that visits the
    same 500 permanent failures nightly while the rest of the table is never
    reached. It looks identical to a healthy sweep from every metric except
    coverage.

    ## Nothing external is constructed here

    ``openfigi`` and ``ftd_lookup`` are parameters, not defaults. Both spend
    something — an API quota and a GCS read — and the decision to spend belongs
    to the JOB (``app/jobs/detect.py``), which is also where the arming flag is
    read. Passing ``None`` for either is the documented "tier unavailable"
    state, which ``resolve_cusips`` reports as a third value distinct from
    "tried and found nothing".
    """
    src = sources if sources is not None else resolve_sources()
    cusips = src.unresolved(limit)
    if not cusips:
        return {
            **logic.tier_report({}, 0),
            "selected": 0,
            "resolutions": {},
            "planned": 0,
            "written": 0,
            "applied": bool(apply),
            "ftd": "unavailable" if ftd_lookup is None else "idle",
            "openfigi": "unavailable" if openfigi is None else "idle",
        }

    report = resolve_cusips(
        cusips,
        sources=src,
        openfigi=openfigi,
        writer=writer,
        apply=apply,
        ftd_lookup=ftd_lookup,
        now=now,
    )
    report["selected"] = len(cusips)
    return report
