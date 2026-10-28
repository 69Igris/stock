"""The seam: ``parse_and_store`` and the job wrapper around it — MONEY-979 T7.

Every parse here runs against a REAL SEC filing out of ``tests/fixtures/``. A
hand-written bundle would agree with whatever the parser happened to do, which
is the definition of a shadow test.

The two properties this file exists for, and neither is provable from the source
by reading it:

1. ``parse_and_store`` performs NO NETWORK I/O. It is the seam three different
   detection sources will call (push today, MONEY-1271's poller, MONEY-1272's
   SFTP receiver), and a fetch inside it would be reimplemented three times —
   the third one bypassing the shared 9 req/s SEC budget.
2. An unarmed run PARSES FULLY AND WRITES NOTHING. Asserted with a writer whose
   every method raises, so "wrote nothing" cannot pass by the writer merely
   having been handed no rows.
"""

from __future__ import annotations

import gzip
import json
import socket
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from app.parsers import dispatch
from app.parsers.dispatch import WriterUnavailable, parse_and_store, run_parse_job
from app.sec.errors import SecEgressDisabled, SecTransportError

FIXTURES = Path(__file__).parent / "fixtures"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text())


def fixture_text(name: str) -> str:
    return gzip.decompress((FIXTURES / MANIFEST[name]["file"]).read_bytes()).decode(
        "utf-8", "replace"
    )


#: (fixture, parseClass, accession, cik10, form) for every parser, taken from
#: the SGML headers of the fixtures themselves.
CASES: tuple[tuple[str, str, str, str, str], ...] = (
    ("form4_bundle", "OWNERSHIP", "0001214659-26-011109", "0000096223", "4"),
    ("13f_post", "THIRTEENF", "0001193125-26-352200", "0001067983", "13F-HR"),
    ("schedule13d_bundle", "SCHEDULE13", "0001903596-26-000330", "0001894954", "SCHEDULE 13D"),
    ("eightk_bundle", "EIGHTK", "0001420720-26-000019", "0001420720", "8-K"),
    ("tenk_bundle_aapl", "FINANCIALS", "0000320193-25-000079", "0000320193", "10-K"),
)


class RecordingWriter:
    """A writer that records instead of storing. Counts rows like the real one."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.upserts: list[tuple[str, list[dict[str, Any]], tuple[str, ...]]] = []
        self.statuses: list[dict[str, Any]] = []
        self.recomputes: list[dict[str, Any]] = []
        self.deletes: list[tuple[str, dict[str, Any]]] = []

    def upsert_rows(self, collection, rows, *, key) -> int:
        self.calls.append("upsert_rows")
        self.upserts.append((collection, [dict(row) for row in rows], tuple(key)))
        return len(rows)

    def set_filing_status(self, accession, *, status, parsed_at, parser_version, error=None):
        self.calls.append("set_filing_status")
        self.statuses.append(
            {
                "accession": accession,
                "status": status,
                "parsedAt": parsed_at,
                "parserVersion": parser_version,
                "error": error,
            }
        )

    def recompute_is_latest(self, *, cik10, statement_type, period_type, period_end) -> int:
        self.calls.append("recompute_is_latest")
        self.recomputes.append(
            {
                "cik10": cik10,
                "statementType": statement_type,
                "periodType": period_type,
                "periodEnd": period_end,
            }
        )
        return 1

    def delete_rows(self, collection, where) -> int:
        self.calls.append("delete_rows")
        self.deletes.append((collection, dict(where)))
        return 0

    def rows_for(self, collection: str) -> list[dict[str, Any]]:
        return [row for name, rows, _ in self.upserts if name == collection for row in rows]


class ExplodingWriter:
    """Every method is a tripwire. Handed to every unarmed run in this suite."""

    def upsert_rows(self, *args: Any, **kwargs: Any) -> int:
        raise AssertionError("a dry run wrote rows")

    def set_filing_status(self, *args: Any, **kwargs: Any) -> None:
        raise AssertionError("a dry run stamped us_filings.status")

    def recompute_is_latest(self, *args: Any, **kwargs: Any) -> int:
        raise AssertionError("a dry run recomputed isLatest")

    def delete_rows(self, *args: Any, **kwargs: Any) -> int:
        raise AssertionError("a dry run deleted rows")


class StubLookups:
    """Injected joins. ``name`` is echoed into the outcome, like the real ones."""

    name = "stub"

    def __init__(
        self,
        instruments: dict[str, list[dict[str, Any]]] | None = None,
        cusips: dict[str, dict[str, Any]] | None = None,
        hashes: dict[int, str] | None = None,
    ) -> None:
        self.instruments = instruments or {}
        self.cusips = cusips or {}
        self.hashes = hashes or {}

    def instruments_for_cik(self, cik10: str) -> list[dict[str, Any]]:
        return self.instruments.get(cik10, [])

    def cusip_map(self, cusips):
        return {c: self.cusips[c] for c in cusips if c in self.cusips}

    def document_hashes(self, accession: str) -> dict[int, str]:
        return dict(self.hashes)


# ── property 1: no transport ────────────────────────────────────────────────


def test_parse_and_store_opens_no_socket(monkeypatch: pytest.MonkeyPatch) -> None:
    """All five parsers, every fixture, with connections blocked.

    Not belt-and-braces: three edgartools entry points that LOOK pure reach
    sec.gov, and the ones this service uses were confirmed clean by exactly this
    check rather than by reading signatures. It also proves the DEFAULT lookups
    open nothing when no ``DATABASE_URL`` is set, which is the state a QA
    container starts in.
    """

    class BlockedSocket(socket.socket):
        def connect(self, *args: Any, **kwargs: Any) -> None:
            raise AssertionError(f"parse_and_store attempted a connection: {args!r}")

        def connect_ex(self, *args: Any, **kwargs: Any) -> None:
            raise AssertionError(f"parse_and_store attempted a connection: {args!r}")

    monkeypatch.setattr(socket, "socket", BlockedSocket)

    for fixture, parse_class, accession, cik10, form in CASES:
        outcome = parse_and_store(
            accession,
            fixture_text(fixture),
            parse_class=parse_class,
            cik10=cik10,
            form=form,
            writer=ExplodingWriter(),
        )
        assert outcome["status"] == "PARSED", fixture
        assert outcome["rowsParsed"] > 0, fixture
        # No DATABASE_URL in the test environment (conftest clears it), so the
        # resolver must degrade to NullLookups rather than construct a client.
        assert outcome["lookups"] == "none", fixture


# ── property 2: the apply flag ──────────────────────────────────────────────


def test_unarmed_run_parses_fully_and_writes_nothing() -> None:
    """The counts are real; the writer is never touched.

    A "dry run" that SKIPPED the parse would report a clean zero for a filing
    that cannot be parsed at all, which is the opposite of what a dry run is
    for.
    """
    for fixture, parse_class, accession, cik10, form in CASES:
        outcome = parse_and_store(
            accession,
            fixture_text(fixture),
            parse_class=parse_class,
            cik10=cik10,
            form=form,
            writer=ExplodingWriter(),
        )
        assert outcome["applied"] is False
        assert outcome["written"] == 0
        assert outcome["rowsParsed"] > 0
        assert sum(outcome["rows"].values()) > 0


def test_unarmed_run_calls_the_writer_zero_times() -> None:
    """Stated as a CALL COUNT as well, because ``ExplodingWriter`` proves the
    negative only for the methods it happens to define."""
    writer = RecordingWriter()
    parse_and_store(
        "0001214659-26-011109",
        fixture_text("form4_bundle"),
        parse_class="OWNERSHIP",
        cik10="0000096223",
        writer=writer,
    )
    assert writer.calls == []


@pytest.mark.parametrize(
    ("value", "armed"),
    [
        ("true", True),
        ("TRUE", True),
        ("  true  ", True),
        ("false", False),
        ("0", False),
        ("1", False),
        ("yes", False),
        ("on", False),
        ("", False),
    ],
)
def test_apply_is_the_literal_string_true(
    monkeypatch: pytest.MonkeyPatch, value: str, armed: bool
) -> None:
    """``bool("false")`` is ``True``. The flag is compared, never coerced.

    ``"1"``, ``"yes"`` and ``"on"`` are all deliberately NOT armed: this is a
    write arm, and a value nobody documented must not turn one on. ``"on"`` in
    particular is the spelling ``EDGAR_DETECT`` uses, so a copy-paste between
    the two flags has to fail closed.
    """
    monkeypatch.setenv("EDGAR_PARSE_APPLY", value)
    writer = RecordingWriter() if armed else ExplodingWriter()
    outcome = parse_and_store(
        "0001214659-26-011109",
        fixture_text("form4_bundle"),
        parse_class="OWNERSHIP",
        cik10="0000096223",
        writer=writer,
    )
    assert outcome["applied"] is armed
    assert (outcome["written"] > 0) is armed


def test_armed_without_a_writer_raises_rather_than_reporting_a_clean_zero(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An armed environment that silently stops writing is the failure this
    repo has shipped six times: on schedule, 200, table stops growing."""
    monkeypatch.setenv("EDGAR_PARSE_APPLY", "true")
    monkeypatch.setattr(dispatch, "resolve_writer", lambda: None)
    with pytest.raises(WriterUnavailable):
        parse_and_store(
            "0001214659-26-011109",
            fixture_text("form4_bundle"),
            parse_class="OWNERSHIP",
            cik10="0000096223",
        )


# ── status stamping ─────────────────────────────────────────────────────────


def test_armed_run_stamps_parsed_with_version_and_timestamp() -> None:
    writer = RecordingWriter()
    stamped = datetime(2026, 8, 29, 12, 0, tzinfo=UTC)
    outcome = parse_and_store(
        "0001214659-26-011109",
        fixture_text("form4_bundle"),
        parse_class="OWNERSHIP",
        cik10="0000096223",
        writer=writer,
        apply=True,
        now=stamped,
    )
    assert outcome["written"] == 13
    assert writer.statuses == [
        {
            "accession": "0001214659-26-011109",
            "status": "PARSED",
            "parsedAt": stamped,
            "parserVersion": outcome["parserVersion"],
            "error": None,
        }
    ]
    # Rows are written BEFORE the status is stamped: a PARSED stamp on a filing
    # whose rows failed to land is a lie that nothing later can detect.
    assert writer.calls.index("upsert_rows") < writer.calls.index("set_filing_status")


def test_an_unreadable_filing_is_FAILED_and_never_raises() -> None:
    """A filing this build cannot read is DATA. Raising would take the route to
    500 and have Pub/Sub redeliver the same broken bytes five times."""
    outcome = parse_and_store(
        "0000000000-00-000000",
        "not an SGML submission at all",
        parse_class="OWNERSHIP",
        cik10="0000096223",
        writer=ExplodingWriter(),
    )
    assert outcome["status"] == "FAILED"
    assert outcome["failed"] == 1
    assert outcome["written"] == 0
    assert "ValueError" in outcome["error"]


def test_a_failed_parse_stamps_FAILED_when_armed() -> None:
    writer = RecordingWriter()
    parse_and_store(
        "0000000000-00-000000",
        "not an SGML submission at all",
        parse_class="OWNERSHIP",
        cik10="0000096223",
        writer=writer,
        apply=True,
    )
    assert writer.statuses[0]["status"] == "FAILED"
    assert writer.statuses[0]["error"].startswith("ValueError")
    assert "upsert_rows" not in writer.calls


def test_error_text_is_truncated_before_it_reaches_the_column() -> None:
    outcome = parse_and_store(
        "0000000000-00-000000",
        "x" * 50_000,
        parse_class="THIRTEENF",
        cik10="0001067983",
        form="13F-HR",
        writer=ExplodingWriter(),
    )
    assert outcome["status"] == "FAILED"
    assert len(outcome["error"]) <= dispatch.ERROR_MAX_CHARS


def test_unknown_parse_class_is_a_programming_error_and_raises() -> None:
    with pytest.raises(ValueError, match="unknown parse class"):
        parse_and_store("0000000000-00-000000", "", parse_class="NOT_A_CLASS")


def test_every_parse_class_has_a_parser() -> None:
    """The tuple and the dispatch table are two spellings of one fact."""
    assert set(dispatch.PARSE_CLASSES) == set(dispatch._PARSERS)


# ── the job wrapper ─────────────────────────────────────────────────────────


def test_run_parse_job_reports_the_outcome_from_a_finally(statsd) -> None:
    """A job that raises before reporting is invisible in exactly the dimension
    this metric measures."""

    def explode(cik10: str, accession: str) -> bytes:
        raise SecTransportError("connection reset")

    with pytest.raises(SecTransportError):
        run_parse_job(
            {"accession": "0001214659-26-011109", "cik10": "0000096223"},
            parse_class="OWNERSHIP",
            job="edgar-parse-ownership",
            fetch_bundle=explode,
        )
    assert "stockbook.job.selected" in statsd.names()
    assert statsd.value_of("stockbook.job.selected") == 1
    assert statsd.value_of("stockbook.job.written") == 0


def test_run_parse_job_acks_a_deterministic_sec_refusal(statsd) -> None:
    """Egress off, a rate block or an identity rejection ACK with a named skip.

    Retrying makes a block LONGER — it is measured at SEC's edge across every
    process we run — so five redeliveries would be five more requests into a
    host that has already said no.
    """

    def blocked(cik10: str, accession: str) -> bytes:
        raise SecEgressDisabled("SEC_EGRESS=off")

    result = run_parse_job(
        {"accession": "0001214659-26-011109", "cik10": "0000096223"},
        parse_class="OWNERSHIP",
        job="edgar-parse-ownership",
        fetch_bundle=blocked,
    )
    assert result["success"] is False
    assert result["skippedReason"] == "SecEgressDisabled"
    assert statsd.value_of("stockbook.job.transport_failures") == 1


def test_run_parse_job_acks_an_unaddressable_message(statsd) -> None:
    """No accession or no CIK will not become addressable on redelivery."""
    result = run_parse_job({"form": "4"}, parse_class="OWNERSHIP", job="edgar-parse-ownership")
    assert result["success"] is False
    assert "no accession" in result["skippedReason"]
    assert statsd.value_of("stockbook.job.selected") == 0


def test_run_parse_job_parses_and_counts(statsd) -> None:
    writer = RecordingWriter()
    result = run_parse_job(
        {"accession": "0001214659-26-011109", "cik10": "0000096223", "form": "4"},
        parse_class="OWNERSHIP",
        job="edgar-parse-ownership",
        fetch_bundle=lambda cik, acc: fixture_text("form4_bundle").encode(),
        writer=writer,
        apply=True,
    )
    assert result["success"] is True
    assert result["written"] == 13
    assert statsd.value_of("stockbook.job.written") == 13


def test_run_parse_job_reports_unsupported_as_a_named_skip(statsd) -> None:
    result = run_parse_job(
        {"accession": "0001193125-26-352200", "cik10": "0001067983", "form": "13F-NT"},
        parse_class="THIRTEENF",
        job="edgar-parse-13f",
        fetch_bundle=lambda cik, acc: fixture_text("13f_post").encode(),
        writer=ExplodingWriter(),
    )
    assert result["status"] == "UNSUPPORTED"
    assert result["success"] is True
    assert "13F-NT" in result["skippedReason"]


def test_bytes_and_text_bundles_parse_identically() -> None:
    """The seam takes ``bytes | str``: an archive read hands bytes, a poller may
    hand a decoded string, and the two must not diverge."""
    text = fixture_text("form4_bundle")
    as_text = parse_and_store(
        "0001214659-26-011109", text, parse_class="OWNERSHIP", cik10="0000096223"
    )
    as_bytes = parse_and_store(
        "0001214659-26-011109", text.encode(), parse_class="OWNERSHIP", cik10="0000096223"
    )
    assert as_text["rows"] == as_bytes["rows"]
    assert as_text["detail"] == as_bytes["detail"]


def test_injected_lookups_resolve_the_symbol_and_are_named_in_the_outcome() -> None:
    outcome = parse_and_store(
        "0001214659-26-011109",
        fixture_text("form4_bundle"),
        parse_class="OWNERSHIP",
        cik10="0000096223",
        lookups=StubLookups(instruments={"0000096223": [{"symbol": "JEF"}]}),
    )
    assert outcome["lookups"] == "stub"
    assert outcome["detail"]["symbol"] == "JEF"


def test_resolve_writer_returns_none_while_t5_has_not_landed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``app/store/writers.py`` is T5's file. Until it exists the resolver must
    answer ``None`` — and an armed run must then RAISE, not degrade."""
    import builtins

    real_import = builtins.__import__

    def missing(name: str, *args: Any, **kwargs: Any):
        if name == "app.store.writers" or (name == "app.store" and "writers" in (args[2] or ())):
            raise ModuleNotFoundError("no module named app.store.writers", name="app.store.writers")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", missing)
    assert dispatch.resolve_writer() is None


# ── the detector's message ──────────────────────────────────────────────────


def test_acceptedAt_from_the_message_is_a_fallback_never_an_override() -> None:
    """``<ACCEPTANCE-DATETIME>`` in the bundle is the primary source and is
    present on a BACKFILL, which has no message at all. The message's value
    fills in only when the bundle carries none, so the two can never disagree
    on a filing that states its own acceptance time."""
    from_message = datetime(2000, 1, 1, tzinfo=UTC)
    writer = RecordingWriter()
    parse_and_store(
        "0001214659-26-011109",
        fixture_text("form4_bundle"),
        parse_class="OWNERSHIP",
        cik10="0000096223",
        writer=writer,
        accepted_at=from_message,
        apply=True,
    )
    stored = {row["acceptedAt"] for row in writer.rows_for("insider_transactions")}
    # The bundle's own `<ACCEPTANCE-DATETIME>20260828215358`, normalised from
    # Eastern (SEC stamps it in ET and does not say so) — not the message's.
    assert stored == {datetime(2026, 8, 29, 1, 53, 58, tzinfo=UTC)}


def test_acceptedAt_fills_in_when_the_bundle_carries_none() -> None:
    # Deliberately NOT the value the header would have produced, so the
    # assertion can only pass if the fallback actually fired.
    from_message = datetime(2026, 8, 28, 22, 0, 0, tzinfo=UTC)
    writer = RecordingWriter()
    stripped = fixture_text("form4_bundle").replace("<ACCEPTANCE-DATETIME>", "<REMOVED>")
    parse_and_store(
        "0001214659-26-011109",
        stripped,
        parse_class="OWNERSHIP",
        cik10="0000096223",
        writer=writer,
        accepted_at=from_message,
        apply=True,
    )
    assert {row["acceptedAt"] for row in writer.rows_for("insider_transactions")} == {from_message}


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("2026-08-29T01:53:58.000Z", datetime(2026, 8, 29, 1, 53, 58, tzinfo=UTC)),
        ("2026-08-29T01:53:58+00:00", datetime(2026, 8, 29, 1, 53, 58, tzinfo=UTC)),
        # Naive input is read as UTC rather than as local time.
        ("2026-08-29T01:53:58", datetime(2026, 8, 29, 1, 53, 58, tzinfo=UTC)),
        ("not a timestamp", None),
        ("", None),
        (None, None),
        (17, None),
    ],
)
def test_the_message_timestamp_is_parsed_or_left_null_never_guessed(
    raw: Any, expected: datetime | None
) -> None:
    """T6 renders it the way ``JSON.stringify(new Date())`` does, with a literal
    ``Z``. An unparseable value must not become "now": a fabricated acceptance
    time silently becomes a latency measurement."""
    assert dispatch._message_accepted_at(raw) == expected


def test_a_misrouted_message_is_recorded_and_the_subscription_still_wins(statsd) -> None:
    """One topic per parse class, so the ROUTE is the authority. A message
    claiming a different class means the detector and the topic disagree about
    a filing, which is otherwise completely silent."""
    result = run_parse_job(
        {
            "accession": "0001214659-26-011109",
            "cik10": "0000096223",
            "form": "4",
            "parseClass": "THIRTEENF",
        },
        parse_class="OWNERSHIP",
        job="edgar-parse-ownership",
        fetch_bundle=lambda cik, acc: fixture_text("form4_bundle").encode(),
        writer=ExplodingWriter(),
    )
    assert result["parseClassMismatch"] == "THIRTEENF"
    assert result["parseClass"] == "OWNERSHIP"
    assert result["status"] == "PARSED"


def test_a_correctly_routed_message_records_no_mismatch(statsd) -> None:
    result = run_parse_job(
        {
            "accession": "0001214659-26-011109",
            "cik10": "0000096223",
            "form": "4",
            "parseClass": "OWNERSHIP",
        },
        parse_class="OWNERSHIP",
        job="edgar-parse-ownership",
        fetch_bundle=lambda cik, acc: fixture_text("form4_bundle").encode(),
        writer=ExplodingWriter(),
    )
    assert "parseClassMismatch" not in result


@pytest.mark.parametrize(
    ("fixture", "parse_class", "accession", "cik10", "form", "substitute"),
    [
        # `reportingPeriod` is the TRANSACTION period. Substituting it would put
        # an insider trade on the timeline days before the market could have
        # known about it.
        ("form4_bundle", "OWNERSHIP", "0001214659-26-011109", "0000096223", "4", "reporting"),
        # The period end is by definition EARLIER than the filing, and `filedAt`
        # is what `isLatest` ranks on and what the point-in-time read filters
        # by — so a substitution makes a restatement look like it was known
        # months before it was filed.
        ("tenk_bundle_aapl", "FINANCIALS", "0000320193-25-000079", "0000320193", "10-K", "period"),
    ],
)
def test_a_bundle_with_no_FILED_AS_OF_DATE_fails_rather_than_substituting(
    fixture: str, parse_class: str, accession: str, cik10: str, form: str, substitute: str
) -> None:
    """Every disseminated bundle carries the header. Its absence is a malformed
    submission and belongs in FAILED, where a reparse can find it — not stored
    with a plausible date taken from a different fact."""
    stripped = fixture_text(fixture).replace("FILED AS OF DATE:", "REMOVED HEADER:")
    outcome = parse_and_store(
        accession,
        stripped,
        parse_class=parse_class,
        cik10=cik10,
        form=form,
        writer=ExplodingWriter(),
    )
    assert outcome["status"] == "FAILED"
    assert "FILED AS OF DATE" in outcome["error"]
    assert outcome["written"] == 0


# ── property 9: an unencodable row costs ONE filing, not the walk ───────────


class OverflowingWriter(RecordingWriter):
    """`upsert_rows` raises what pymongo really raised in production.

    Not a stand-in shape: `edgar-bulk-companyfacts-prod` failed on 2026-08-30
    and again on 2026-08-31 with exactly this, and `us_company_facts` sat frozen
    at 134,938 rows across both. Measured against bson 4.17: the class is
    `builtins.OverflowError` — NOT `bson.errors.BSONError` and NOT
    `InvalidDocument`, so a handler written against the bson hierarchy catches
    nothing at all.
    """

    def upsert_rows(self, collection, rows, *, key) -> int:
        self.calls.append("upsert_rows")
        raise OverflowError("MongoDB can only handle up to 8-byte ints")


def test_an_unencodable_row_is_FAILED_and_never_raises() -> None:
    """The write leg owes the same containment the parse leg has had since it
    shipped.

    `parse_and_store` promises to raise only for errors that are "about us".  A
    value SEC filed that Mongo cannot represent is about the FILING, and it
    arrives at encode time — i.e. inside `upsert_rows`, AFTER the parse's own
    `except Exception` has closed. So it escaped the function entirely, and one
    filer ended a walk that costs 23h of a shared per-IP SEC budget.
    """
    writer = OverflowingWriter()
    outcome = parse_and_store(
        "0001214659-26-011109",
        fixture_text("form4_bundle"),
        parse_class="OWNERSHIP",
        cik10="0000096223",
        writer=writer,
        apply=True,
    )
    assert outcome["status"] == "FAILED"
    assert outcome["failed"] == 1
    assert outcome["written"] == 0
    assert "OverflowError" in outcome["error"]


def test_an_unencodable_row_stamps_FAILED_so_the_filing_is_RETRIED() -> None:
    """ERROR, never PARSED. A filing stamped PARSED having written nothing is
    skipped by every later run, so a sanitiser shipped tomorrow would never
    revisit it — the create-suppressed-but-stamped shape from MONEY-1235."""
    writer = OverflowingWriter()
    parse_and_store(
        "0001214659-26-011109",
        fixture_text("form4_bundle"),
        parse_class="OWNERSHIP",
        cik10="0000096223",
        writer=writer,
        apply=True,
    )
    assert writer.statuses[-1]["status"] == "FAILED"
    assert writer.statuses[-1]["error"].startswith("OverflowError")


def test_an_infrastructure_error_still_RAISES() -> None:
    """The other half of the contract, and the reason this is not a bare
    `except Exception`. A database that is unreachable is about US: swallowing
    it would report a clean run over a walk that stored nothing."""

    class UnreachableWriter(RecordingWriter):
        def upsert_rows(self, collection, rows, *, key) -> int:
            raise ConnectionError("connection refused")

    with pytest.raises(ConnectionError):
        parse_and_store(
            "0001214659-26-011109",
            fixture_text("form4_bundle"),
            parse_class="OWNERSHIP",
            cik10="0000096223",
            writer=UnreachableWriter(),
            apply=True,
        )
