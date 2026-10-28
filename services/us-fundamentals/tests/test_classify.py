"""The form -> parse class table — MONEY-979 (T6).

The expected table is written out LITERALLY here rather than imported from
``app.classify``. Importing the sets under test and asserting the code agrees
with itself is the shadow-test shape: it stays green after the whole table is
deleted. Every row below is an independent statement of what EDGAR emits.

The one place real bytes are used is :func:`test_atom_fixture_form_distribution`,
which classifies the 49 filings on the captured ``getcurrent`` page and asserts
the resulting histogram. That row is what would notice if SEC changed a form
spelling under us.
"""

from __future__ import annotations

import gzip
from pathlib import Path

import pytest

from app.classify import (
    EIGHTK,
    FINANCIALS,
    OTHER,
    OWNERSHIP,
    PARSE_CLASSES,
    SCHEDULE13,
    THIRTEENF,
    TOPIC_BY_PARSE_CLASS,
    classify_form,
    topic_for,
)
from app.sec.edgar_adapter import parse_current_filings_atom

FIXTURES = Path(__file__).parent / "fixtures"


# ── The table, stated independently of the implementation ───────────────────

FORM_TABLE: tuple[tuple[str, str], ...] = (
    # Ownership: Forms 3, 4, 5 and their amendments.
    ("3", OWNERSHIP),
    ("4", OWNERSHIP),
    ("5", OWNERSHIP),
    ("3/A", OWNERSHIP),
    ("4/A", OWNERSHIP),
    ("5/A", OWNERSHIP),
    # 13F. 13F-NT is deliberately THIRTEENF and not OTHER: it carries no
    # information table, and routing it to the 13F parser is what lets the
    # filing be marked UNSUPPORTED ("we looked, there is nothing") rather than
    # FAILED or silently unparsed.
    ("13F-HR", THIRTEENF),
    ("13F-HR/A", THIRTEENF),
    ("13F-NT", THIRTEENF),
    ("13F-NT/A", THIRTEENF),
    # Beneficial ownership, BOTH spellings. The 2024-12-18 XML mandate switched
    # EDGAR from `SC 13D` to `SCHEDULE 13D`; a classifier that knows one drops
    # half of history or all of the present.
    ("SCHEDULE 13D", SCHEDULE13),
    ("SCHEDULE 13G", SCHEDULE13),
    ("SCHEDULE 13D/A", SCHEDULE13),
    ("SCHEDULE 13G/A", SCHEDULE13),
    ("SC 13D", SCHEDULE13),
    ("SC 13G", SCHEDULE13),
    ("SC 13D/A", SCHEDULE13),
    ("SC 13G/A", SCHEDULE13),
    # Current reports. (6-K, the foreign private issuer's equivalent, is the
    # one open row — see test_six_k_is_not_routed_yet.)
    ("8-K", EIGHTK),
    ("8-K/A", EIGHTK),
    # Statements.
    ("10-K", FINANCIALS),
    ("10-Q", FINANCIALS),
    ("20-F", FINANCIALS),
    ("40-F", FINANCIALS),
    ("10-K/A", FINANCIALS),
    ("10-Q/A", FINANCIALS),
    ("20-F/A", FINANCIALS),
    ("40-F/A", FINANCIALS),
)

#: Forms that must NOT be routed. Each one is a near-miss chosen because a
#: substring or prefix rule would capture it: `NT 10-K` says a 10-K will be
#: LATE, `10-K405` is a legacy variant with a different body, `SC 13E3` and
#: `SC 14D9` are tender-offer schedules rather than beneficial ownership, and
#: `13F-CTR` is a confidential-treatment request that carries no holdings.
UNROUTED_FORMS: tuple[str, ...] = (
    "144",
    "S-1",
    "425",
    "NT 10-K",
    "NT 10-Q",
    "10-K405",
    "SC 13E3",
    "SC 14D9",
    "SC TO-T",
    "13F-CTR",
    "N-PORT",
    "D",
    "ABS-EE",
)


@pytest.mark.parametrize(("form", "expected"), FORM_TABLE)
def test_form_table(form: str, expected: str) -> None:
    assert classify_form(form) == expected


@pytest.mark.parametrize("form", UNROUTED_FORMS)
def test_unknown_forms_are_other_never_an_exception(form: str) -> None:
    """An unrecognised form is data, not a fault.

    EDGAR adds form types without warning. A classifier that raised on one would
    take down the walk for every OTHER filing on the same page, converting one
    unknown form into a total detection outage.
    """
    assert classify_form(form) == OTHER


@pytest.mark.parametrize("value", ["", "   ", "\t\n", None])
def test_unusable_input_is_other(value: object) -> None:
    assert classify_form(value) == OTHER  # type: ignore[arg-type]


def test_six_k_routes_to_EIGHTK_like_its_domestic_twin() -> None:
    """A 6-K is the foreign private issuer's current report.

    Material events and earnings releases filed as exhibits — exactly what
    ``parse_8k`` extracts. FINANCIALS would be wrong (no audited statement set,
    no XBRL statements, so ``parse_financials`` fails on every one) and OTHER
    drops every foreign issuer's earnings release out of the document queue.

    This test previously pinned the OPPOSITE answer, deliberately: the form
    table lives in ``app.store.models.PARSE_CLASS_BY_FORM``, which detection
    does not own, so the pin existed to make adding 6-K a change with a failing
    test pointing at the right file rather than a silent reclassification of
    several hundred filings a week. The two lines have now landed there.

    A 6-K carries no NUMBERED items, so ``items`` comes back empty — the honest
    result, and the exhibits are stored regardless.
    """
    assert classify_form("6-K") == EIGHTK
    assert classify_form("6-K/A") == EIGHTK


@pytest.mark.parametrize(
    ("form", "expected"),
    [
        ("  sc 13d/a  ", SCHEDULE13),
        ("sc  13g", SCHEDULE13),
        ("SCHEDULE\t13D", SCHEDULE13),
        ("8-k", EIGHTK),
        ("13f-hr", THIRTEENF),
        ("10-q/a", FINANCIALS),
        (" 4 ", OWNERSHIP),
    ],
)
def test_case_and_whitespace_tolerance(form: str, expected: str) -> None:
    """The same form reaches us from three feeds with three renderings.

    An Atom ``<category term=>``, an EFTS ``form`` field and a fixed-width
    daily-index column disagree on case and on internal spacing — the index one
    can carry ``SC  13G`` with two spaces.
    """
    assert classify_form(form) == expected


def test_a_malformed_amendment_suffix_is_not_normalised_into_a_valid_form() -> None:
    """``4/A/A`` is not a form EDGAR emits, and must not be accepted as Form 4."""
    assert classify_form("4/A/A") == OTHER


def test_there_is_exactly_one_form_table_in_the_tree() -> None:
    """``classify_form`` DELEGATES; it does not restate the table.

    ``us_filings.parseClass`` is written by three paths — this detector, the
    nightly ``submissions.zip`` ledger and the parsers' status stamps — and
    ``upsert_filings`` routes ``parseClass`` through ``$set``. Two tables would
    therefore not disagree loudly: whichever path ran last would silently
    relabel the filing, and the symptom would be a ``{parseClass: "EIGHTK"}``
    query returning a different number every morning.

    Driven over the shared table's OWN keys, so a row added there is checked
    here without this test being edited.
    """
    from app.store.models import PARSE_CLASS_BY_FORM, parse_class

    assert PARSE_CLASS_BY_FORM, "the shared table is empty"
    for form, expected in PARSE_CLASS_BY_FORM.items():
        assert classify_form(form) == expected == parse_class(form)
    assert classify_form("NOT-A-FORM") == parse_class("NOT-A-FORM") == OTHER


# ── Topic routing ───────────────────────────────────────────────────────────


def test_topic_for_every_routed_class() -> None:
    assert topic_for(OWNERSHIP) == "edgar-parse-ownership"
    assert topic_for(THIRTEENF) == "edgar-parse-13f"
    assert topic_for(SCHEDULE13) == "edgar-parse-13dg"
    assert topic_for(EIGHTK) == "edgar-parse-8k"
    assert topic_for(FINANCIALS) == "edgar-parse-financials"


def test_topic_for_other_is_none_not_an_error() -> None:
    """OTHER is routed nowhere ON PURPOSE, and that is a real answer.

    The filing is still recorded in ``us_filings`` as a ledger row; it simply
    has no parser. ``{parseClass: "OTHER"}`` is the query that lists every form
    we have chosen not to handle.
    """
    assert topic_for(OTHER) is None


def test_topic_for_unknown_class_raises() -> None:
    """An unknown CLASS can only come from our own code, unlike an unknown FORM.

    Returning ``None`` for it would silently drop a whole class of filings out
    of the fan-out with nothing anywhere reporting it.
    """
    with pytest.raises(KeyError):
        topic_for("INSIDER")


def test_every_parse_class_is_either_routed_or_other() -> None:
    routed = set(TOPIC_BY_PARSE_CLASS)
    assert routed | {OTHER} == set(PARSE_CLASSES)
    assert len(set(TOPIC_BY_PARSE_CLASS.values())) == len(routed), "two classes share a topic"


def test_topics_match_the_service_routes() -> None:
    """Every fan-out topic must have a ``/jobs/<topic>`` route in this service.

    ``setup-pubsub.sh`` builds each push endpoint as ``${URL}/jobs/${TOPIC}``,
    so a topic named here that main.py does not serve answers 404 on every
    delivery — five retries and a dead letter, which reads as a broken
    subscription rather than as a typo in a routing table.
    """
    from app.main import JOB_ROUTES

    missing = set(TOPIC_BY_PARSE_CLASS.values()) - set(JOB_ROUTES)
    assert missing == set(), f"topics with no route: {sorted(missing)}"


# ── Against the captured feed ───────────────────────────────────────────────


def test_atom_fixture_form_distribution() -> None:
    """Classify the 49 real filings on the captured ``getcurrent`` page.

    Hand-counted from the fixture: 31 Form 4, 1 Form 4/A and 1 Form 3 are
    OWNERSHIP (33); 1 `SCHEDULE 13D`, 3 `SCHEDULE 13D/A` and 1 `SCHEDULE 13G/A`
    are SCHEDULE13 (5); the 11 Form 144s are OTHER. Nothing on the page is
    THIRTEENF, EIGHTK or FINANCIALS, which is why those classes are covered by
    the table above instead.
    """
    raw = gzip.decompress((FIXTURES / "atom_getcurrent.xml.gz").read_bytes())
    entries = parse_current_filings_atom(raw)

    histogram: dict[str, int] = {}
    for entry in entries:
        parse_class = classify_form(entry.form)
        histogram[parse_class] = histogram.get(parse_class, 0) + 1

    assert histogram == {OWNERSHIP: 33, SCHEDULE13: 5, OTHER: 11}
    assert sum(histogram.values()) == len(entries) == 49


def test_atom_fixture_carries_the_modern_13d_spelling() -> None:
    """The live feed's spelling, proven from bytes rather than from a docstring.

    If this ever fails because SEC has moved on again, the legacy row in
    ``FORM_TABLE`` is what keeps the backfill working while the new spelling is
    added.
    """
    raw = gzip.decompress((FIXTURES / "atom_getcurrent.xml.gz").read_bytes())
    forms = {entry.form for entry in parse_current_filings_atom(raw)}
    assert "SCHEDULE 13D" in forms
    assert "SCHEDULE 13D/A" in forms
    assert not any(form.startswith("SC 13") for form in forms)
