"""The evictor's PURE rules — MONEY-979 (T9).

Every test here drives a function in :mod:`app.evict_logic` that the shipped
handler also calls, so deleting the real rule turns these red. Nothing is
re-declared inline.

The three properties worth stating up front, because they are the ones a future
change is most likely to break without noticing:

* the hot window is TWO periods plus whatever quarter is still inside 13F's
  45-day deadline — narrowing it to one archives a quarter the product reads on
  every QoQ comparison;
* the selection query says ``tier != "COLD"``, never ``tier == "HOT"``, because
  in Mongo an absent field matches neither ``{"f": None}`` nor ``{"f": {"$ne":
  None}}`` and would be skipped forever;
* a delete plan is an INTERSECTION of what was archived with what the re-read
  gave back, and it is short exactly when the shard is short.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta, timezone

import pytest

from app.evict_logic import (
    CHAIN_AFTER_ACCESSION_KEY,
    CHAIN_AFTER_PERIOD_KEY,
    CHAIN_DEPTH_KEY,
    FILING_FIELDS,
    HOT_PERIOD_COUNT,
    IN_FLIGHT_DAYS,
    MAX_CHAIN_DEPTH,
    RUN_TIME_BUDGET_MS,
    STOP_BUDGET_SPENT,
    STOP_CHAIN_DEPTH_REACHED,
    STOP_DRAINED,
    STOP_STORAGE_UNAVAILABLE,
    Cursor,
    EvictRowError,
    as_day,
    as_utc_midnight,
    budget_exhausted,
    chain_depth,
    chunk,
    cursor_for,
    cursor_from_payload,
    evictable_query,
    filing_projection,
    holding_to_shard_row,
    hot_window,
    in_flight_cutoff,
    next_chain_payload,
    plan_deletions,
    proven_row_keys,
    readable_by_reader,
    shard_row_key,
    should_chain,
    storage_failing,
)
from app.sec.archive_logic import decode_shard, encode_shard, thirteenf_shard_key

#: The EXACT string the already-merged TypeScript reader expects, copied from
#: `packages/core/__tests__/us-fundamentals/repository.test.ts:684`, where a
#: cold read asserts `assert.equal(key, "edgar/13f/0001067983/2024-03-31")`.
#: A mismatch does not fail anywhere: it 404s every archived quarter, silently
#: and forever, and the reader reports COLD_SHARD_ABSENT.
TS_EXPECTED_KEY = "edgar/13f/0001067983/2024-03-31"
BERKSHIRE = "0001067983"
Q1_2024 = date(2024, 3, 31)


def holding(**overrides) -> dict:
    """A ``us_13f_holdings`` document as pymongo hands it back.

    NAIVE datetimes, because the client is not ``tz_aware`` — which is exactly
    the shape that would render without a ``Z`` if anything here used
    ``isoformat()`` directly.
    """
    document = {
        "_id": "68b0c0ffee00000000000001",
        "accession": "0000950123-24-005678",
        "rowIndex": 0,
        "managerCik10": BERKSHIRE,
        "periodOfReport": datetime(2024, 3, 31),
        "filedAt": datetime(2024, 5, 15),
        "cusip": "037833100",
        "figi": None,
        "issuerName": "APPLE INC",
        "titleOfClass": "COM",
        "valueUsd": 135_360_000_000.0,
        "shares": 789_368_450.0,
        "sharesType": "SH",
        "putCall": None,
        "investmentDiscretion": "SOLE",
        "otherManagers": [],
        "votingSole": 789_368_450.0,
        "votingShared": 0.0,
        "votingNone": 0.0,
        "symbol": "AAPL",
        "source": "SEC_EDGAR",
        "parserVersion": "1.0.0",
    }
    document.update(overrides)
    return document


# ── The hot window ──────────────────────────────────────────────────────────


def test_the_hot_window_keeps_exactly_two_periods():
    """TWO, and the two NEWEST. A one-period window would push the second half
    of every QoQ comparison into GCS on every request."""
    window = hot_window(
        [
            date(2023, 6, 30),
            date(2023, 9, 30),
            date(2023, 12, 31),
            date(2024, 3, 31),
            date(2024, 6, 30),
        ]
    )

    assert HOT_PERIOD_COUNT == 2
    assert window.newest == (date(2024, 6, 30), date(2024, 3, 31))
    assert window.in_flight == ()
    assert window.periods == (date(2024, 6, 30), date(2024, 3, 31))
    assert len(window.periods) == 2


def test_the_in_flight_quarter_is_kept_ON_TOP_of_the_two():
    """The union is three wide for the 45 days after a quarter ends.

    MUTATION this catches: dropping the ``in_flight`` leg, or intersecting
    instead of unioning. A 13F is due 45 days after the quarter end, so for those
    45 days the newest period is still ARRIVING — a few hundred managers have
    filed and a few thousand have not, and its ``periodOfReport`` is not yet
    among the two most-populated values in the table.
    """
    window = hot_window(
        [date(2024, 3, 31), date(2024, 6, 30), date(2024, 9, 30)],
        [date(2024, 12, 31)],
    )

    assert window.newest == (date(2024, 9, 30), date(2024, 6, 30))
    assert window.in_flight == (date(2024, 12, 31),)
    assert window.periods == (date(2024, 12, 31), date(2024, 9, 30), date(2024, 6, 30))
    assert date(2024, 3, 31) not in window, "the third-newest quarter is evictable"


def test_an_in_flight_period_already_in_the_window_does_not_widen_it():
    window = hot_window(
        [date(2024, 6, 30), date(2024, 9, 30)],
        [date(2024, 9, 30)],
    )
    assert window.periods == (date(2024, 9, 30), date(2024, 6, 30))


def test_the_window_reads_pymongos_naive_datetimes_as_days():
    window = hot_window([datetime(2024, 6, 30), datetime(2024, 9, 30, 0, 0)])
    assert window.periods == (date(2024, 9, 30), date(2024, 6, 30))


def test_an_unparseable_period_is_dropped_and_never_raises():
    """A guard that throws on one bad row stops protecting the good ones."""
    window = hot_window([date(2024, 6, 30), None, "not-a-date", 17, date(2024, 9, 30)])
    assert window.periods == (date(2024, 9, 30), date(2024, 6, 30))


def test_a_table_with_fewer_than_two_periods_keeps_what_there_is():
    assert hot_window([date(2024, 6, 30)]).periods == (date(2024, 6, 30),)
    assert hot_window([]).periods == ()


def test_the_in_flight_cutoff_is_45_days():
    now = datetime(2026, 8, 29, 12, 0, tzinfo=UTC)
    assert IN_FLIGHT_DAYS == 45
    assert in_flight_cutoff(now) == now - timedelta(days=45)


def test_the_cutoff_stamps_a_naive_clock_as_utc():
    """A naive ``now`` must not be read as local time — the whole service stores
    UTC, and a 5.5-hour skew moves the deadline across a day boundary."""
    assert in_flight_cutoff(datetime(2026, 8, 29, 12, 0)) == datetime(
        2026, 7, 15, 12, 0, tzinfo=UTC
    )


# ── The selection query ─────────────────────────────────────────────────────


def test_the_query_selects_NOT_COLD_rather_than_EQUALS_HOT():
    """``$ne`` matches an ABSENT field; ``$eq: "HOT"`` does not.

    A field added by a later ``db push`` is absent on every pre-existing row, and
    both ``{"f": None}`` and ``{"f": {"$ne": None}}`` return ZERO — the class
    behind MONEY-1050, -1234, -1235 and -1236. Selecting on the negative means an
    untiered filing is treated as hot, which is the safe direction: it gets
    archived, proven and deleted rather than accumulating unseen forever.
    """
    query = evictable_query(hot_window([date(2024, 6, 30)]))
    assert query["tier"] == {"$ne": "COLD"}
    assert "HOT" not in json.dumps(query, default=str)


def test_the_window_reaches_the_query_as_UTC_MIDNIGHT_DATETIMES():
    """BSON has no date-without-time type.

    ``{"periodOfReport": {"$nin": [date(2024, 6, 30)]}}`` compares a Python
    ``date`` against a stored ``datetime`` and matches NOTHING, so the hot window
    would exclude nothing and the newest quarter would be archived the day it
    arrived.
    """
    query = evictable_query(hot_window([date(2024, 3, 31), date(2024, 6, 30)]))
    excluded = query["periodOfReport"]["$nin"]

    assert excluded == [
        datetime(2024, 6, 30, tzinfo=UTC),
        datetime(2024, 3, 31, tzinfo=UTC),
    ]
    assert all(isinstance(value, datetime) for value in excluded)


def test_an_empty_window_puts_no_period_clause_in_the_query():
    """An empty ``$nin`` excludes nothing, so omitting the clause is equivalent —
    but writing ``{"$nin": []}`` would read as "the window was computed and is
    empty", which is a different claim from "there is nothing to compare"."""
    assert "periodOfReport" not in evictable_query(hot_window([]))


def test_the_cursor_is_a_compound_ASC_boundary():
    """A chained run must not be handed the same first page.

    Ordering by a column that is CONSTANT across the population wrote the same
    100 rows nightly and never reached the other 681 (MONEY-1211); ``desc`` on a
    growing population is the same defect pointing the other way (MONEY-1255).
    Successful evictions leave the population, but FAILURES do not — so without
    the cursor one unarchivable filing sits at the head of every page and starves
    the drain.
    """
    query = evictable_query(
        hot_window([date(2024, 6, 30)]),
        Cursor(period=date(2024, 3, 31), accession="0000950123-24-005678"),
    )

    boundary = datetime(2024, 3, 31, tzinfo=UTC)
    assert query["$or"] == [
        {"periodOfReport": {"$gt": boundary}},
        {"periodOfReport": boundary, "accession": {"$gt": "0000950123-24-005678"}},
    ]


def test_the_projection_is_built_from_the_field_list():
    """A hardcoded ``select`` that had drifted from the code consuming it is what
    made "we never asked for the column" print as "the vendor has no value"."""
    assert filing_projection() == dict.fromkeys(FILING_FIELDS, 1)
    assert "managerCik10" in FILING_FIELDS and "periodOfReport" in FILING_FIELDS


def test_cursor_for_refuses_a_half_built_boundary():
    assert cursor_for({"periodOfReport": datetime(2024, 3, 31), "accession": "a"}) == Cursor(
        date(2024, 3, 31), "a"
    )
    assert cursor_for({"periodOfReport": datetime(2024, 3, 31)}) is None
    assert cursor_for({"accession": "a"}) is None


# ── Days ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (datetime(2024, 3, 31), date(2024, 3, 31)),
        (datetime(2024, 3, 31, tzinfo=UTC), date(2024, 3, 31)),
        (date(2024, 3, 31), date(2024, 3, 31)),
        ("2024-03-31", date(2024, 3, 31)),
        ("2024-03-31T00:00:00.000Z", date(2024, 3, 31)),
        ("", None),
        ("not-a-date", None),
        (None, None),
        (17, None),
    ],
)
def test_as_day_normalises_every_shape_a_period_arrives_in(value, expected):
    assert as_day(value) == expected


def test_as_day_converts_a_zoned_instant_to_its_UTC_day():
    """An instant late on the 31st in a +05:30 zone is still the 31st in UTC only
    if it is converted, not truncated."""
    ist = timezone(timedelta(hours=5, minutes=30))
    assert as_day(datetime(2024, 4, 1, 2, 0, tzinfo=ist)) == date(2024, 3, 31)


def test_as_utc_midnight_is_what_mongo_stores():
    assert as_utc_midnight(date(2024, 3, 31)) == datetime(2024, 3, 31, 0, 0, tzinfo=UTC)


# ── The cross-language key ──────────────────────────────────────────────────


def test_the_shard_key_matches_the_TYPESCRIPT_READERS_LITERAL():
    """``edgar/13f/0001067983/2024-03-31``.

    Read out of `packages/core/__tests__/us-fundamentals/repository.test.ts`,
    where the cold read asserts the key it `get`s. The key is the ONLY handle the
    archived object has: there is no index, no listing and no foreign key that
    would notice a wrong one. A mismatch stores the object successfully, reports
    success, and is then unreachable by every reader forever.
    """
    assert thirteenf_shard_key(BERKSHIRE, Q1_2024) == TS_EXPECTED_KEY


def test_the_key_is_identical_whatever_shape_the_period_arrives_in():
    """pymongo hands back a naive datetime; a chained payload carries a string.
    Both must land on ONE object, or a quarter is written to two keys each
    holding half the manager."""
    assert thirteenf_shard_key(BERKSHIRE, as_day(datetime(2024, 3, 31))) == TS_EXPECTED_KEY
    assert thirteenf_shard_key(BERKSHIRE, as_day("2024-03-31")) == TS_EXPECTED_KEY
    ist = timezone(timedelta(hours=5, minutes=30))
    assert (
        thirteenf_shard_key(BERKSHIRE, as_day(datetime(2024, 4, 1, 2, 0, tzinfo=ist)))
        == TS_EXPECTED_KEY
    )


# ── Shard rows ──────────────────────────────────────────────────────────────


def test_a_shard_row_is_LOSSLESS_except_for_the_mongo_id():
    """The shard becomes the only copy the moment the hot rows are deleted.

    A writer that projected down to the fifteen fields today's reader consumes
    would destroy ``investmentDiscretion``, ``votingSole``, ``otherManagers``,
    ``resolvedBy`` and every future column — quietly, and discoverably only years
    later when something needs them.
    """
    row = holding_to_shard_row(holding())

    assert "_id" not in row
    for field in holding():
        if field != "_id":
            assert field in row, f"{field} was dropped from the archive"
    assert row["investmentDiscretion"] == "SOLE"
    assert row["votingSole"] == 789_368_450.0
    assert row["parserVersion"] == "1.0.0"


def test_dates_are_rendered_with_an_EXPLICIT_Z():
    """``2024-03-31T00:00:00.000Z``, never a bare local-looking timestamp.

    ECMA-262 reads a date-TIME string with no offset as LOCAL time. A bare
    ``2024-03-31T00:00:00`` becomes 2024-03-30T18:30:00Z for a reader running in
    IST, whose `toISOString().slice(0, 10)` then builds the key for the WRONG
    DAY. One character; one quarter 404ing forever.
    """
    row = holding_to_shard_row(holding())
    assert row["periodOfReport"] == "2024-03-31T00:00:00.000Z"
    assert row["filedAt"] == "2024-05-15T00:00:00.000Z"

    line = json.dumps(row, separators=(",", ":"))
    assert '"periodOfReport":"2024-03-31T00:00:00.000Z"' in line


def test_a_shard_row_survives_the_real_codec_round_trip():
    """Encoded with the SHIPPED codec, not a re-implementation."""
    rows = [holding_to_shard_row(holding(rowIndex=index)) for index in range(3)]
    parsed = decode_shard(encode_shard(rows, sort_key=shard_row_key))

    assert parsed.dropped == 0
    assert [row["rowIndex"] for row in parsed.rows] == [0, 1, 2]
    assert parsed.rows[0]["cusip"] == "037833100"


@pytest.mark.parametrize("bad", [{"accession": ""}, {"accession": None}])
def test_a_holding_with_no_accession_is_REFUSED_not_archived(bad):
    """``(accession, rowIndex)`` is the merge identity AND the delete key. A row
    that cannot be keyed cannot be proven, and must never be
    archived-then-deleted."""
    with pytest.raises(EvictRowError):
        holding_to_shard_row(holding(**bad))


@pytest.mark.parametrize("bad", [None, "seven", 1.5, True])
def test_a_holding_with_a_non_integer_rowIndex_is_REFUSED(bad):
    with pytest.raises(EvictRowError):
        holding_to_shard_row(holding(rowIndex=bad))


# ── The merge identity ──────────────────────────────────────────────────────


def test_the_merge_key_is_the_prisma_unique_key_zero_padded():
    """Zero-padded because ``serialize_shard`` SORTS on this string: unpadded,
    row 10 sorts before row 2 and the same SET of rows produces different bytes
    depending on how many there are."""
    assert shard_row_key({"accession": "A", "rowIndex": 7}) == "A|00000007"
    assert shard_row_key({"accession": "A", "rowIndex": 2}) < shard_row_key(
        {"accession": "A", "rowIndex": 10}
    )


def test_two_unkeyable_rows_do_not_COLLAPSE_into_one():
    """They can only arrive from a corrupt existing shard — this writer refuses to
    build one. A shared fallback key would silently drop one of them during the
    merge: a repair that DESTROYS a row is worse than one that preserves an odd
    row."""
    first = shard_row_key({"issuerName": "A"})
    second = shard_row_key({"issuerName": "B"})
    assert first != second
    assert first == shard_row_key({"issuerName": "A"}), "the fallback must be stable"


# ── What the reader would drop ──────────────────────────────────────────────


def test_a_healthy_row_is_readable():
    assert readable_by_reader(holding_to_shard_row(holding())) is True


@pytest.mark.parametrize(
    "broken",
    [
        {"cusip": ""},
        {"valueUsd": None},
        {"shares": "not-a-number"},
        {"filedAt": None},
    ],
)
def test_a_row_the_TYPESCRIPT_READER_would_drop_is_detected(broken):
    """Mirrors ``parseThirteenFShard``'s per-line drop rule, which is written
    against JS coercion and not Python's: ``Number(null)`` is 0 over there, so a
    line that omitted ``valueUsd`` would otherwise become a holding worth zero
    dollars rather than a line that is dropped.

    Reported as a COUNT, never enforced as a gate — the row is archived either
    way, because the shard is lossless. What must not happen is the gap being
    invisible.
    """
    document = holding()
    document.update(broken)
    assert readable_by_reader(holding_to_shard_row(document)) is False


def test_a_numeric_string_still_counts_as_a_number():
    """``finite()`` on the reader side accepts a non-empty numeric string."""
    assert readable_by_reader(holding_to_shard_row(holding(valueUsd="12345"))) is True


# ── The delete plan ─────────────────────────────────────────────────────────


def test_a_full_proof_deletes_every_row_and_is_COMPLETE():
    rows = [holding_to_shard_row(holding(rowIndex=index)) for index in range(4)]
    plan = plan_deletions(rows, proven_row_keys(rows))

    assert plan.row_indexes == (0, 1, 2, 3)
    assert plan.missing == ()
    assert plan.complete is True


def test_a_SHORT_shard_deletes_only_what_came_back():
    """The intersection, never the intended set.

    A shard that came back short is not a reason to delete the rest and hope.
    Those rows stay hot, the filing stays HOT, and the next run merges them in
    again and re-proves them — the drain converges instead of losing them.
    """
    rows = [holding_to_shard_row(holding(rowIndex=index)) for index in range(4)]
    plan = plan_deletions(rows, proven_row_keys(rows[:2]))

    assert plan.row_indexes == (0, 1)
    assert plan.missing == (
        "0000950123-24-005678|00000002",
        "0000950123-24-005678|00000003",
    )
    assert plan.complete is False


def test_an_EMPTY_proof_deletes_NOTHING():
    plan = plan_deletions([holding_to_shard_row(holding())], set())
    assert plan.row_indexes == ()
    assert plan.complete is False


def test_rows_that_belong_to_ANOTHER_filing_do_not_prove_ours():
    """Proof is per ``(accession, rowIndex)``. A shard holds every filing for the
    manager-quarter, so an amendment's rows sitting in the same object must never
    stand in for the original's."""
    ours = [holding_to_shard_row(holding(rowIndex=index)) for index in range(2)]
    theirs = [
        holding_to_shard_row(holding(accession="0000950123-24-009999", rowIndex=index))
        for index in range(2)
    ]

    plan = plan_deletions(ours, proven_row_keys(theirs))
    assert plan.row_indexes == ()
    assert plan.complete is False


def test_an_empty_filing_is_trivially_complete():
    """A manager-quarter with no rows: nothing to delete, nothing unproven. The
    filing may go COLD against an empty shard, which is an honest archive of
    zero holdings rather than a hole."""
    plan = plan_deletions([], set())
    assert plan.row_indexes == ()
    assert plan.complete is True


def test_chunk_slices_and_never_spins_on_a_zero_size():
    assert [list(part) for part in chunk([1, 2, 3, 4, 5], 2)] == [[1, 2], [3, 4], [5]]
    assert [list(part) for part in chunk([1, 2], 0)] == [[1], [2]]
    assert list(chunk([], 10)) == []


# ── Budget and chaining ─────────────────────────────────────────────────────


def test_the_budget_is_420_seconds_and_is_a_GREATER_OR_EQUAL_test():
    """Checked BETWEEN filings, so the real wall is ``budget + one filing``.
    Pub/Sub's push ack deadline is 600 s and is always the binding constraint;
    overrunning it makes Pub/Sub REDELIVER while the first copy is still running,
    and a second copy of this job is two writers racing on one shard."""
    assert RUN_TIME_BUDGET_MS == 420_000
    assert budget_exhausted(419_999.0) is False
    assert budget_exhausted(420_000.0) is True
    assert budget_exhausted(1.0, budget_ms=1.0) is True


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        (None, 0),
        ({}, 0),
        ({CHAIN_DEPTH_KEY: 3}, 3),
        ({CHAIN_DEPTH_KEY: "4"}, 4),
        ({CHAIN_DEPTH_KEY: -1}, 0),
        ({CHAIN_DEPTH_KEY: "junk"}, 0),
        ({CHAIN_DEPTH_KEY: True}, 0),
    ],
)
def test_the_chain_depth_is_coerced_never_trusted(payload, expected):
    """A value that failed to parse must read as "first run" — bounded from zero
    — and never as a number that skips the bound."""
    assert chain_depth(payload) == expected


def test_the_chain_is_BOUNDED_at_twenty():
    """MUTATION this catches: removing the depth check. Without it a run whose
    budget is spent every time republishes forever."""
    assert MAX_CHAIN_DEPTH == 20
    assert should_chain(work_remains=True, depth=19).chain is True
    assert should_chain(work_remains=True, depth=20) == (False, STOP_CHAIN_DEPTH_REACHED)
    assert should_chain(work_remains=True, depth=21) == (False, STOP_CHAIN_DEPTH_REACHED)


def test_a_drained_run_does_not_chain_and_says_so():
    assert should_chain(work_remains=False, depth=0) == (False, STOP_DRAINED)


def test_a_failing_bucket_stops_the_chain_BEFORE_anything_else():
    """Order is load-bearing. Chaining into a dead bucket manufactures 20
    identical failures and 20 dead-letter candidates out of one."""
    assert should_chain(work_remains=True, depth=0, storage_failing=True) == (
        False,
        STOP_STORAGE_UNAVAILABLE,
    )


def test_a_budget_stop_with_work_left_chains():
    assert should_chain(work_remains=True, depth=0) == (True, STOP_BUDGET_SPENT)


def test_three_consecutive_storage_failures_is_the_bucket_not_the_data():
    assert storage_failing(2) is False
    assert storage_failing(3) is True
    assert storage_failing(1, limit=0) is True, "a floored limit must not disable the guard"


def test_the_follow_up_carries_the_incremented_depth_and_the_cursor():
    payload = next_chain_payload(
        {"note": "manual"},
        depth=4,
        after=Cursor(period=date(2024, 3, 31), accession="0000950123-24-005678"),
    )

    assert payload[CHAIN_DEPTH_KEY] == 5
    assert payload[CHAIN_AFTER_PERIOD_KEY] == "2024-03-31"
    assert payload[CHAIN_AFTER_ACCESSION_KEY] == "0000950123-24-005678"
    assert payload["note"] == "manual", "an operator's override survives the chain boundary"


def test_a_follow_up_with_no_cursor_carries_NO_stale_boundary():
    payload = next_chain_payload(
        {CHAIN_AFTER_PERIOD_KEY: "2024-03-31", CHAIN_AFTER_ACCESSION_KEY: "old"},
        depth=0,
        after=None,
    )
    assert CHAIN_AFTER_PERIOD_KEY not in payload
    assert CHAIN_AFTER_ACCESSION_KEY not in payload


def test_the_follow_up_round_trips_through_the_cursor_reader():
    cursor = Cursor(period=date(2024, 3, 31), accession="0000950123-24-005678")
    assert cursor_from_payload(next_chain_payload({}, depth=0, after=cursor)) == cursor


@pytest.mark.parametrize(
    "payload",
    [
        None,
        {},
        {CHAIN_AFTER_PERIOD_KEY: "2024-03-31"},
        {CHAIN_AFTER_ACCESSION_KEY: "0000950123-24-005678"},
        {CHAIN_AFTER_PERIOD_KEY: "junk", CHAIN_AFTER_ACCESSION_KEY: "a"},
    ],
)
def test_a_half_specified_cursor_is_NO_cursor(payload):
    """Resuming from an unbounded boundary would silently re-walk or skip a page
    depending on which half survived."""
    assert cursor_from_payload(payload) is None
