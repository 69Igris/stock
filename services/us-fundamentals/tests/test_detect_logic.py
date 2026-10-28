"""The detection loop's decisions, driven against the REAL captured feed — MONEY-979 (T6).

Every function here is pure, so these tests drive the shipping implementation
with no HTTP, no clock and no database. The two fixtures are bytes SEC actually
served (``tests/fixtures/manifest.json`` records the URL, sha256 and capture
time), which is what makes "100 entries are 49 filings" a measurement rather
than a restatement of the code.
"""

from __future__ import annotations

import gzip
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from app import classify
from app.detect_logic import (
    EFTS_FORMS_BY_PARSE_CLASS,
    STOP_BUDGET_SPENT,
    STOP_CURSOR_REACHED,
    STOP_NOTHING_NEW,
    STOP_PAGE_CAP,
    DetectCursor,
    FanOutResult,
    detect_latency_seconds,
    eastern_offset,
    efts_primary_cik10,
    efts_window,
    is_cursor_boundary,
    next_cursor,
    plan_efts_reconcile,
    plan_page_walk,
    should_chain,
    to_eastern,
)
from app.sec.adapter_types import CurrentFilingEntry
from app.sec.edgar_adapter import json_loads, parse_current_filings_atom, parse_efts_response

FIXTURES = Path(__file__).parent / "fixtures"


def _atom_bytes() -> bytes:
    return gzip.decompress((FIXTURES / "atom_getcurrent.xml.gz").read_bytes())


def _atom_entries() -> list[CurrentFilingEntry]:
    return parse_current_filings_atom(_atom_bytes())


def _efts_hits() -> list:
    payload = json_loads(gzip.decompress((FIXTURES / "efts_8k_search.json.gz").read_bytes()))
    return parse_efts_response(payload)


def _entry(accession: str, seconds_ago: int, base: datetime | None = None) -> CurrentFilingEntry:
    moment = (base or datetime(2026, 8, 29, 2, 0, tzinfo=UTC)) - timedelta(seconds=seconds_ago)
    return CurrentFilingEntry(
        accession=accession,
        form="4",
        cik10="0000000001",
        company="TEST CO",
        accepted_at=moment,
        filed_at=moment.date(),
    )


# ── Entries are not filings ─────────────────────────────────────────────────


def test_one_hundred_entries_collapse_to_forty_nine_filings() -> None:
    """The headline fact the whole walk is built on, asserted from bytes.

    SEC emits one Atom entry per filer ROLE — Reporting / Issuer / Subject /
    Filed by — so a detector that treats entries as filings publishes the same
    Form 4 twice and the same 13D three times. The strict inequality is asserted
    as well as the count: if a future fixture happened to have no multi-filer
    filings, ``49 == 49`` would still pass while proving nothing.
    """
    raw = _atom_bytes()
    entry_elements = raw.count(b"<entry>")
    entries = parse_current_filings_atom(raw)

    assert entry_elements == 100
    assert len(entries) == 49
    assert len(entries) < entry_elements

    plan = plan_page_walk([entries], None)
    assert len(plan.new_entries) == 49
    assert len({e.accession for e in plan.new_entries}) == 49


def test_walk_dedupes_across_pages() -> None:
    """The rolling window shifts between two HTTP requests, so pages overlap.

    ``parse_current_filings_atom`` dedupes WITHIN a page; only the walk can
    dedupe across them. Feeding the same page twice is the extreme form of the
    overlap that happens in production every time page 2 is fetched a second
    after page 1.
    """
    entries = _atom_entries()
    plan = plan_page_walk([entries, entries], None)

    assert len(plan.new_entries) == 49
    assert plan.new_per_page == (49, 0)
    assert plan.repeats_collapsed == 49
    assert plan.entries_seen == 98
    assert plan.pages_consumed == 2


def test_walk_stops_at_the_cursor_accession_mid_page() -> None:
    entries = _atom_entries()
    cursor = DetectCursor(last_accession=entries[10].accession, last_accepted_at=None)

    plan = plan_page_walk([entries], cursor)

    assert plan.cursor_reached is True
    assert [e.accession for e in plan.new_entries] == [e.accession for e in entries[:10]]
    # The boundary entry is COUNTED as examined but not collected.
    assert plan.entries_seen == 11
    assert plan.new_per_page == (10,)


def test_walk_falls_back_to_accepted_at_when_the_accession_has_rolled_out() -> None:
    """After an outage longer than the window the cursor's accession is simply gone.

    Without the timestamp fallback the walk would run to the page cap every
    minute forever and never report anything but ``page-cap``.

    The boundary is STRICTLY older, so the entry sharing the cursor's acceptance
    second is still collected: several filings share a second, and re-offering
    one costs an insert that fails on the unique index while skipping one loses
    it.
    """
    entries = _atom_entries()
    cursor = DetectCursor(
        last_accession="9999999999-99-999999",
        last_accepted_at=entries[10].accepted_at,
    )

    plan = plan_page_walk([entries], cursor)

    assert plan.cursor_reached is True
    assert len(plan.new_entries) == 11
    assert plan.new_entries[-1].accession == entries[10].accession
    assert entries[10].accepted_at == cursor.last_accepted_at


def test_no_cursor_collects_everything() -> None:
    entries = _atom_entries()
    plan = plan_page_walk([entries], None)
    assert plan.cursor_reached is False
    assert len(plan.new_entries) == len(entries)


def test_page_cap_limits_pages_consumed() -> None:
    entries = _atom_entries()
    plan = plan_page_walk([entries, entries, entries], None, max_pages=2)
    assert plan.pages_consumed == 2
    assert len(plan.new_per_page) == 2


def test_is_cursor_boundary_without_a_cursor_is_false() -> None:
    assert is_cursor_boundary(_entry("0000000000-00-000001", 0), None) is False


# ── Named stop reasons ──────────────────────────────────────────────────────


def _decide(**overrides: object):
    kwargs: dict = {
        "pages_fetched": 1,
        "max_pages": 20,
        "cursor_reached": False,
        "new_on_last_page": 49,
        "elapsed_seconds": 1.0,
        "budget_seconds": 420.0,
    }
    kwargs.update(overrides)
    return should_chain(**kwargs)  # type: ignore[arg-type]


def test_walk_continues_when_nothing_says_stop() -> None:
    decision = _decide()
    assert decision.should_fetch_more is True
    assert decision.stop_reason is None


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"cursor_reached": True}, STOP_CURSOR_REACHED),
        ({"new_on_last_page": 0}, STOP_NOTHING_NEW),
        ({"elapsed_seconds": 420.0}, STOP_BUDGET_SPENT),
        ({"elapsed_seconds": 999.0}, STOP_BUDGET_SPENT),
        ({"pages_fetched": 20}, STOP_PAGE_CAP),
        ({"pages_fetched": 21}, STOP_PAGE_CAP),
    ],
)
def test_every_stop_path_is_named(overrides: dict, expected: str) -> None:
    """ "Why did it stop" must never be inferable-only.

    ``cursor-reached`` and ``nothing-new`` are healthy; ``budget-spent`` and
    ``page-cap`` mean the loop is behind and someone should look. Collapsing
    them into "the walk ended" makes a job that has silently stopped keeping up
    identical to one that has nothing to do.
    """
    decision = _decide(**overrides)
    assert decision.should_fetch_more is False
    assert decision.stop_reason == expected


def test_stop_reason_is_none_only_while_continuing() -> None:
    for overrides in ({}, {"cursor_reached": True}, {"new_on_last_page": 0}, {"pages_fetched": 20}):
        decision = _decide(**overrides)
        assert (decision.stop_reason is None) is decision.should_fetch_more


def test_healthy_exits_win_over_unhealthy_ones() -> None:
    """A run that is caught up must not be reported as out of budget.

    The two situations lead to different operator actions, so the precedence is
    asserted rather than left to the order of the ``if`` statements.
    """
    decision = _decide(cursor_reached=True, elapsed_seconds=9999.0, pages_fetched=99)
    assert decision.stop_reason == STOP_CURSOR_REACHED

    decision = _decide(new_on_last_page=0, elapsed_seconds=9999.0, pages_fetched=99)
    assert decision.stop_reason == STOP_NOTHING_NEW


# ── The cursor ──────────────────────────────────────────────────────────────


def _result(accession: str, seconds_ago: int, published: bool) -> FanOutResult:
    entry = _entry(accession, seconds_ago)
    return FanOutResult(entry.accession, entry.accepted_at, published)


def test_cursor_advances_to_the_newest_when_everything_published() -> None:
    results = [
        _result("A", 0, True),
        _result("B", 10, True),
        _result("C", 20, True),
    ]
    advanced = next_cursor(results, None)
    assert advanced is not None
    assert advanced.last_accession == "A"


def test_cursor_stops_short_of_a_failure() -> None:
    """THE property. The cursor must land STRICTLY OLDER than every failure.

    The next walk stops at the cursor, so anything older than it is never looked
    at again. Advancing past a filing this run did not hand off does not lose a
    retry — it loses the filing, permanently, with nothing reporting a gap.
    """
    results = [
        _result("A", 0, True),
        _result("B", 10, False),  # publish failed
        _result("C", 20, True),
        _result("D", 30, True),
    ]
    advanced = next_cursor(results, None)
    assert advanced is not None
    assert advanced.last_accession == "C"


def test_cursor_does_not_move_when_the_oldest_result_failed() -> None:
    results = [_result("A", 0, True), _result("B", 10, False)]
    previous = DetectCursor("PREV", datetime(2026, 8, 29, 1, 0, tzinfo=UTC))
    assert next_cursor(results, previous) is previous


def test_cursor_does_not_move_when_everything_failed() -> None:
    results = [_result("A", 0, False), _result("B", 10, False)]
    assert next_cursor(results, None) is None


def test_cursor_does_not_move_on_an_empty_run() -> None:
    previous = DetectCursor("PREV", datetime(2026, 8, 29, 1, 0, tzinfo=UTC))
    assert next_cursor([], previous) is previous


def test_a_duplicate_counts_as_handed_off() -> None:
    """A filing another run already claimed has nothing outstanding.

    It must not pin the cursor: an overlapping run would otherwise leave the
    cursor stuck behind work that IS being done, and the walk would re-read the
    same window every minute forever.
    """
    results = [_result("A", 0, True), _result("B", 10, True)]
    advanced = next_cursor(results, None)
    assert advanced is not None and advanced.last_accession == "A"


def test_cursor_never_moves_backwards() -> None:
    """Nothing in the current walk should produce this — and "impossible" is not a guard.

    A cursor that goes backwards re-walks the same window on every run forever,
    and the symptom (duplicates, no progress) looks like a healthy busy loop.
    """
    previous = DetectCursor("NEWER", datetime(2026, 8, 29, 3, 0, tzinfo=UTC))
    results = [_result("OLDER", 0, True)]  # accepted 02:00, older than the cursor
    assert next_cursor(results, previous) is previous


def test_cursor_carries_both_accession_and_accepted_at() -> None:
    results = [_result("A", 0, True)]
    advanced = next_cursor(results, None)
    assert advanced is not None
    assert advanced.last_accession == "A"
    assert advanced.last_accepted_at == datetime(2026, 8, 29, 2, 0, tzinfo=UTC)


# ── Latency ─────────────────────────────────────────────────────────────────


def test_latency_is_measured_from_accepted_at() -> None:
    """From the real feed: a filing accepted 01:53:58Z, observed 30 s later.

    The same entry's ``filedAt`` is 2026-08-28 — a whole calendar day earlier —
    so a latency taken from that column reports ~25.9 HOURS for a filing this
    loop caught in half a minute.
    """
    entry = _atom_entries()[0]
    assert entry.accepted_at == datetime(2026, 8, 29, 1, 53, 58, tzinfo=UTC)
    assert entry.filed_at == date(2026, 8, 28)

    now = entry.accepted_at + timedelta(seconds=30)
    assert detect_latency_seconds(entry.accepted_at, now) == 30.0

    filed_at_midnight = datetime.combine(entry.filed_at, datetime.min.time(), tzinfo=UTC)
    assert detect_latency_seconds(filed_at_midnight, now) > 90_000


def test_latency_is_none_when_accepted_at_is_absent() -> None:
    """EFTS carries ``file_date`` and no acceptance timestamp at all.

    Every filing recovered by the hourly reconcile has nothing to measure.
    Substituting ``filedAt`` there would emit hours-long latencies for filings
    the loop never actually saw late, poisoning the p95 the 5-minute acceptance
    gate is read from.
    """
    assert detect_latency_seconds(None, datetime(2026, 8, 29, 2, 0, tzinfo=UTC)) is None


def test_latency_is_negative_when_filed_at_is_used_after_the_evening_cutoff() -> None:
    """The concrete reason ``filedAt`` cannot be the source column.

    A filing accepted at 21:53 ET is DATED the next business day once it lands
    after EDGAR's cutoff, so ``now - filedAt`` is NEGATIVE — a latency histogram
    fed from it would be full of impossible values most evenings.
    """
    accepted = datetime(2026, 8, 29, 1, 53, 58, tzinfo=UTC)  # 21:53 ET on the 28th
    next_business_day = datetime(2026, 8, 31, 0, 0, tzinfo=UTC)
    now = accepted + timedelta(seconds=30)

    assert detect_latency_seconds(accepted, now) == 30.0
    assert detect_latency_seconds(next_business_day, now) < 0


def test_latency_negatives_are_not_clamped() -> None:
    """Clamping would hide the clock skew (or wrong column) it is evidence of."""
    now = datetime(2026, 8, 29, 2, 0, tzinfo=UTC)
    assert detect_latency_seconds(now + timedelta(seconds=5), now) == -5.0


def test_latency_treats_a_naive_timestamp_as_utc() -> None:
    """pymongo hands back naive datetimes; local-time reinterpretation would shift every sample."""
    now = datetime(2026, 8, 29, 2, 0, tzinfo=UTC)
    naive = datetime(2026, 8, 29, 1, 59, 30)
    assert detect_latency_seconds(naive, now) == 30.0


# ── US Eastern, EDGAR's calendar ────────────────────────────────────────────


@pytest.mark.parametrize(
    ("instant", "expected_offset_hours"),
    [
        # 2026 transitions: DST starts 2026-03-08 07:00 UTC (02:00 EST),
        # ends 2026-11-01 06:00 UTC (02:00 EDT).
        ("2026-03-08T06:59:00", -5),
        ("2026-03-08T07:00:00", -4),
        ("2026-11-01T05:59:00", -4),
        ("2026-11-01T06:00:00", -5),
        ("2026-01-15T12:00:00", -5),
        ("2026-08-29T01:53:58", -4),
        # Different years, to prove the rule is computed and not a constant.
        ("2025-03-09T07:00:00", -4),
        ("2025-11-02T06:00:00", -5),
        ("2027-03-14T07:00:00", -4),
        ("2027-11-07T06:00:00", -5),
    ],
)
def test_eastern_offset_at_the_dst_boundaries(instant: str, expected_offset_hours: int) -> None:
    moment = datetime.fromisoformat(instant).replace(tzinfo=UTC)
    assert eastern_offset(moment).utcoffset(None) == timedelta(hours=expected_offset_hours)


def test_eastern_offset_agrees_with_the_system_tz_database() -> None:
    """Cross-check the hand-rolled rule against the real tzdb where one exists.

    The rule is hand-rolled because ``python:3.12-slim`` is not guaranteed to
    ship a tz database and the failure would surface at the first hourly
    reconcile rather than at deploy time. That is a reason to avoid DEPENDING on
    zoneinfo, not a reason to avoid checking against it.
    """
    zoneinfo = pytest.importorskip("zoneinfo")
    try:
        eastern = zoneinfo.ZoneInfo("America/New_York")
    except zoneinfo.ZoneInfoNotFoundError:  # pragma: no cover - depends on the host
        pytest.skip("no tz database on this host")

    moment = datetime(2026, 1, 1, tzinfo=UTC)
    checked = 0
    while moment < datetime(2028, 1, 1, tzinfo=UTC):
        assert eastern_offset(moment).utcoffset(None) == moment.astimezone(eastern).utcoffset()
        moment += timedelta(hours=7)
        checked += 1
    assert checked > 2000


def test_to_eastern_rolls_back_the_date_after_utc_midnight() -> None:
    moment = datetime(2026, 8, 29, 1, 53, 58, tzinfo=UTC)
    assert to_eastern(moment).date() == date(2026, 8, 28)


# ── EFTS window ─────────────────────────────────────────────────────────────


def test_efts_window_uses_the_eastern_day_not_the_utc_one() -> None:
    """A UTC-derived window asks for a day EDGAR has not reached — every night.

    At 01:00 UTC the Eastern date is still the previous day. A window of
    ``(today_utc, today_utc)`` returns zero hits and reports a perfectly
    successful reconcile that examined nothing.
    """
    now = datetime(2026, 8, 29, 1, 0, tzinfo=UTC)  # 21:00 ET on the 28th
    start, end = efts_window(now, lookback_minutes=120)

    assert end == date(2026, 8, 28)
    assert start == date(2026, 8, 28)
    assert end != now.date()


def test_efts_window_spans_two_eastern_days_when_the_lookback_crosses_midnight() -> None:
    now = datetime(2026, 8, 29, 4, 30, tzinfo=UTC)  # 00:30 ET on the 29th
    start, end = efts_window(now, lookback_minutes=120)
    assert (start, end) == (date(2026, 8, 28), date(2026, 8, 29))


def test_efts_window_of_zero_minutes_is_a_single_day() -> None:
    now = datetime(2026, 8, 29, 18, 0, tzinfo=UTC)
    assert efts_window(now, lookback_minutes=0) == (date(2026, 8, 29), date(2026, 8, 29))


def test_efts_window_rejects_a_negative_lookback() -> None:
    """A negative lookback inverts the range into a query that silently matches nothing."""
    with pytest.raises(ValueError):
        efts_window(datetime(2026, 8, 29, tzinfo=UTC), lookback_minutes=-1)


# ── EFTS reconcile ──────────────────────────────────────────────────────────


def test_efts_plan_against_the_captured_response() -> None:
    hits = _efts_hits()
    assert len(hits) == 100

    plan = plan_efts_reconcile(hits, known_accessions=())
    assert len(plan.missing) == 100
    assert plan.hits_seen == 100
    assert plan.already_known == 0
    assert plan.repeats_collapsed == 0


def test_efts_plan_skips_what_detection_already_stored() -> None:
    hits = _efts_hits()
    known = {hit.accession for hit in hits[:97]}

    plan = plan_efts_reconcile(hits, known)

    assert len(plan.missing) == 3
    assert plan.already_known == 97
    assert [hit.accession for hit in plan.missing] == [hit.accession for hit in hits[97:]]


def test_efts_plan_collapses_a_paging_overlap() -> None:
    hits = _efts_hits()
    plan = plan_efts_reconcile(list(hits) + list(hits), known_accessions=())
    assert len(plan.missing) == 100
    assert plan.hits_seen == 200
    assert plan.repeats_collapsed == 100


def test_efts_primary_cik_is_the_first_of_the_array() -> None:
    """``ciks`` is an ARRAY and ``us_filings`` has one ``cik10`` column.

    Taking the first matches the primary chosen from the first Atom entry for
    the same accession, so a filing seen live and the same filing recovered by
    the reconcile agree instead of overwriting each other.
    """
    hit = _efts_hits()[0]
    assert hit.ciks
    assert efts_primary_cik10(hit) == hit.ciks[0]


def test_efts_forms_cover_every_routed_parse_class() -> None:
    """A class with no ``forms=`` row is never swept, and nothing would say so."""
    assert set(EFTS_FORMS_BY_PARSE_CLASS) == set(classify.TOPIC_BY_PARSE_CLASS)
    for forms in EFTS_FORMS_BY_PARSE_CLASS.values():
        assert forms


def test_efts_form_lists_use_root_forms_not_amendment_spellings() -> None:
    """``forms=8-K`` returns ``8-K/A`` too — measured on the captured page.

    95 ``8-K`` and 5 ``8-K/A`` came back for a single ``forms=8-K`` query, which
    is why the amendment spellings are deliberately absent from the query rather
    than forgotten. The 13D/13G rows keep the LEGACY spelling for the same
    reason: ``root_forms`` was never re-spelled by the XML mandate.
    """
    forms_returned = {hit.form for hit in _efts_hits()}
    assert forms_returned == {"8-K", "8-K/A"}

    assert EFTS_FORMS_BY_PARSE_CLASS[classify.EIGHTK] == ("8-K", "6-K")
    assert EFTS_FORMS_BY_PARSE_CLASS[classify.SCHEDULE13] == ("SC 13D", "SC 13G")
    for forms in EFTS_FORMS_BY_PARSE_CLASS.values():
        assert not any(form.endswith("/A") for form in forms)
