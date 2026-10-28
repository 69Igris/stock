"""Row models and the schema snapshot — MONEY-979.

This module is also the PRODUCER of ``tests/_schema_snapshot.json``, the file
T11's ``packages/core/__tests__/us-fundamentals/schema-parity.test.ts`` reads. It
is written on every run so it cannot go stale in a commit, and it is compared
against ``schema.prisma`` here as well — the TypeScript test is the build gate,
this one is the fast local one, and neither is derived from the other.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from app.store import models
from app.store.models import (
    MODELS,
    UsCompanyFactRow,
    UsCusipMapRow,
    UsFilerRow,
    UsFilingRow,
    UsFundamentalsRow,
    parse_class,
    schema_snapshot,
)

SERVICE_ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT_PATH = SERVICE_ROOT / "tests" / "_schema_snapshot.json"
SCHEMA_PATH = SERVICE_ROOT.parents[1] / "packages" / "database" / "prisma" / "schema.prisma"

#: The Prisma field these models deliberately do NOT carry: it is declared
#: ``@map("_id")``, so its physical key is ``_id`` and MongoDB owns it.
PRISMA_OWNED_FIELDS = {"id"}


def _prisma_models() -> dict[str, set[str]]:
    source = SCHEMA_PATH.read_text()
    block = source[source.index("US FUNDAMENTALS — SEC EDGAR (MONEY-979)") :]
    parsed: dict[str, set[str]] = {}
    for match in re.finditer(r"^model (\w+) \{$(.*?)^\}$", block, re.M | re.S):
        fields: set[str] = set()
        for line in match.group(2).splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("//") or stripped.startswith("@@"):
                continue
            field = re.match(r"^(\w+)\s+\S+", stripped)
            if field and field.group(1) not in PRISMA_OWNED_FIELDS:
                fields.add(field.group(1))
        parsed[match.group(1)] = fields
    return parsed


# ── The snapshot ────────────────────────────────────────────────────────────


def test_snapshot_is_written_for_the_typescript_parity_test() -> None:
    snapshot = schema_snapshot()
    SNAPSHOT_PATH.write_text(json.dumps(snapshot, indent=2, sort_keys=True) + "\n")
    reloaded = json.loads(SNAPSHOT_PATH.read_text())
    assert reloaded == snapshot
    assert len(reloaded) == 11
    assert all(
        isinstance(fields, list) and fields == sorted(fields) for fields in reloaded.values()
    )


def test_every_model_matches_its_prisma_declaration_field_for_field() -> None:
    prisma = _prisma_models()
    assert len(prisma) == 11, f"expected 11 models in the MONEY-979 block, parsed {len(prisma)}"
    python = {name: set(fields) for name, fields in schema_snapshot().items()}
    assert set(prisma) == set(python)
    for name in sorted(prisma):
        assert python[name] == prisma[name], (
            f"{name}: prisma-only={sorted(prisma[name] - python[name])} "
            f"python-only={sorted(python[name] - prisma[name])}"
        )


def test_every_model_carries_the_provenance_quartet() -> None:
    for name, model in MODELS.items():
        fields = set(model.model_fields)
        if name == "UsEdgarCursor":
            # A cursor is a WATERMARK, not a filed fact: no accession, no filing
            # date, no parser behind it. Prisma spells its insert stamp
            # `createdAt` for the same reason. Excluding it here is more honest
            # than four columns that would always be null.
            assert "createdAt" in fields
            continue
        assert "ingestedAt" in fields, name
        assert "source" in fields, name
        assert "updatedAt" in fields, name


def test_every_row_that_a_parser_produces_records_which_parser() -> None:
    # Provenance is not optional: a bad parse has to be identifiable and
    # re-runnable rather than indistinguishable from the truth.
    for name in (
        "UsInsiderTransaction",
        "UsThirteenFFiling",
        "UsThirteenFHolding",
        "UsBeneficialOwnership",
        "UsFilingDocument",
        "UsFundamentals",
    ):
        assert "parserVersion" in MODELS[name].model_fields, name
        assert "accession" in MODELS[name].model_fields, name


# ── to_doc ──────────────────────────────────────────────────────────────────


def test_to_doc_omits_none_and_keeps_empty_collections() -> None:
    row = UsFilerRow(cik10="0000320193", name="Apple Inc.")
    document = row.to_doc()
    assert "sic" not in document
    assert "firstFilingAt" not in document
    assert document["formerNames"] == []
    assert document["tickersAsFiled"] == []
    assert document["inUniverse"] is False
    assert document["source"] == "SEC_EDGAR"


def test_to_doc_widens_dates_to_utc_midnight_and_never_truncates_a_timestamp() -> None:
    accepted = datetime(2026, 1, 5, 21, 53, 12, tzinfo=UTC)
    row = UsFilingRow(
        accession="0000320193-26-000106",
        cik10="0000320193",
        form="10-K",
        filedAt=date(2026, 1, 6),
        acceptedAt=accepted,
    )
    document = row.to_doc()
    assert document["filedAt"] == datetime(2026, 1, 6, 0, 0, tzinfo=UTC)
    assert document["acceptedAt"] == accepted, "a datetime must not be truncated to its date"


def test_to_doc_stamps_utc_on_a_naive_timestamp() -> None:
    row = UsFilingRow(
        accession="0000320193-26-000106",
        cik10="0000320193",
        form="10-K",
        filedAt=date(2026, 1, 6),
        acceptedAt=datetime(2026, 1, 5, 21, 53, 12),
    )
    stored = row.to_doc()["acceptedAt"]
    assert stored.tzinfo is not None
    assert stored == datetime(2026, 1, 5, 21, 53, 12, tzinfo=UTC)


def test_to_doc_coerces_dates_nested_in_json_columns() -> None:
    row = UsCompanyFactRow(
        cik10="0000320193",
        taxonomy="us-gaap",
        concept="Assets",
        unit="USD",
        values=[{"end": date(2024, 9, 28), "val": 1.0, "frame": None}],
    )
    entry = row.to_doc()["values"][0]
    assert entry["end"] == datetime(2024, 9, 28, tzinfo=UTC)
    assert entry["frame"] is None, (
        "a None INSIDE a Json column is the caller's business, not to_doc's"
    )


def test_rows_are_frozen_and_reject_unknown_fields() -> None:
    from pydantic import ValidationError

    row = UsFilerRow(cik10="0000320193", name="Apple")
    with pytest.raises(ValidationError):
        row.name = "changed"  # type: ignore[misc]
    # A snake_case typo would otherwise become a field silently missing from
    # every document, which the read side reports as missing DATA.
    with pytest.raises(ValidationError):
        UsFilerRow(cik10="0000320193", name="Apple", fiscal_year_end="0930")  # type: ignore[call-arg]


def test_cusip_map_source_has_no_default_because_it_names_a_resolution_tier() -> None:
    assert (
        "source" not in UsCusipMapRow.model_fields
        or UsCusipMapRow.model_fields["source"].is_required()
    )
    row = UsCusipMapRow(cusip="037833100", source="OPENFIGI", symbol="AAPL")
    assert row.to_doc()["source"] == "OPENFIGI"


def test_fundamentals_defaults_are_the_prisma_defaults() -> None:
    row = UsFundamentalsRow(
        cik10="0000320193",
        statementType="INCOME",
        periodType="ANNUAL",
        periodEnd=date(2024, 9, 28),
        fiscalYear=2024,
        fiscalPeriod="FY",
        accession="0000320193-24-000123",
        form="10-K",
        filedAt=date(2024, 11, 1),
        mappingVersion="v1",
        parserVersion="v1",
    )
    document = row.to_doc()
    assert document["currency"] == "USD"
    assert document["isLatest"] is False
    assert document["mappingSource"] == "FILING_XBRL"
    assert document["source"] == "SEC_EDGAR"


# ── parse_class ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("form", "expected"),
    [
        ("4", "OWNERSHIP"),
        ("4/A", "OWNERSHIP"),
        ("3", "OWNERSHIP"),
        ("5", "OWNERSHIP"),
        ("13F-HR", "THIRTEENF"),
        ("13F-HR/A", "THIRTEENF"),
        ("13F-NT", "THIRTEENF"),
        # BOTH spellings. Legacy filings say `SC 13D`; the 2024-12-18 XML mandate
        # changed the string to `SCHEDULE 13D`, and a classifier that knows one
        # silently drops half the history.
        ("SC 13D", "SCHEDULE13"),
        ("SC 13G/A", "SCHEDULE13"),
        ("SCHEDULE 13D", "SCHEDULE13"),
        ("SCHEDULE 13G/A", "SCHEDULE13"),
        ("8-K", "EIGHTK"),
        ("8-K/A", "EIGHTK"),
        ("10-K", "FINANCIALS"),
        ("10-Q/A", "FINANCIALS"),
        ("20-F", "FINANCIALS"),
        ("40-F", "FINANCIALS"),
        # A late-filing NOTICE contains no statements. A substring test would
        # hand it to the financials parser, which would record FAILED for a
        # filing that was never going to have XBRL.
        ("NT 10-K", "OTHER"),
        ("NT 10-Q", "OTHER"),
        ("10-K405", "OTHER"),
        ("DEF 14A", "OTHER"),
        ("S-3ASR", "OTHER"),
        ("424B2", "OTHER"),
        ("", "OTHER"),
        (None, "OTHER"),
    ],
)
def test_parse_class_table(form: str | None, expected: str) -> None:
    assert parse_class(form) == expected


def test_parse_class_normalises_case_and_inner_whitespace() -> None:
    assert parse_class("  schedule   13d/a  ") == "SCHEDULE13"
    assert parse_class("13f-hr") == "THIRTEENF"


def test_annual_report_forms_cover_foreign_private_issuers() -> None:
    # A 20-F/40-F filer never files a 10-K. Counting only 10-Ks would report
    # every one of them as having zero years of history.
    assert {"20-F", "40-F"} <= models.ANNUAL_REPORT_FORMS
