"""Form -> parse class -> Pub/Sub topic — MONEY-979.

PURE. No I/O, no clock, no environment.

## There is exactly ONE form table in this tree, and it is not here

``app.store.models.PARSE_CLASS_BY_FORM`` owns it. This module DELEGATES to
``models.parse_class`` rather than restating the table, because the same string
is written by three different paths — detection (here), the nightly
``submissions.zip`` ledger and the parsers' status stamps — and they all write
the SAME column, ``us_filings.parseClass``. Two tables would not disagree
loudly; ``upsert_filings`` routes ``parseClass`` through ``$set``, so whichever
path ran last would silently relabel the filing, and the symptom would be a
``{parseClass: "EIGHTK"}`` query that returns a different number every morning.

What this module owns is the half models.py has no opinion about: **which topic
a class is fanned out to**, and the fact that OTHER is fanned out to nothing.

## The 13D/13G double spelling, and 13F-NT

Both live in the shared table and both matter enough to restate here, because
this is the module a reader lands on when asking "how is a filing routed":

* SEC's 2024-12-18 XML mandate changed the form string from ``SC 13D`` to
  ``SCHEDULE 13D``. Both spellings are classified. A classifier that knew only
  the modern one would drop the entire pre-2025 backfill to OTHER — no error,
  no failed job, just a table that starts in 2025.
* ``13F-NT`` is THIRTEENF, not OTHER. A notice filing carries no information
  table by design, and routing it to the 13F parser is what lets
  ``app/parsers/dispatch.py`` mark the filing ``UNSUPPORTED`` — "we looked,
  there is nothing to extract" — instead of leaving it unparsed and
  indistinguishable from a form nobody has taught us about.

## ``6-K`` — the open decision, recorded rather than fudged

A 6-K is the foreign private issuer's current report: material events, press
releases and earnings releases filed as exhibits. That is exactly the shape
``parse_8k`` handles (item list + exhibit text into ``us_filing_documents``), so
**the right answer is EIGHTK**. FINANCIALS would be wrong — a 6-K is not an
audited statement set and has no XBRL statements, so ``parse_financials`` would
fail on every one of them — and OTHER drops every foreign issuer's earnings
release out of the document queue.

It is NOT routed today, because the table it has to be added to lives in
``app/store/models.py``, which another task owns. ``test_classify.py`` pins the
current answer so that adding it is a deliberate change with a failing test
pointing at the place to update, rather than a silent reclassification of
several hundred filings a week.
"""

from __future__ import annotations

from app.store.models import (
    PARSE_CLASS_EIGHTK,
    PARSE_CLASS_FINANCIALS,
    PARSE_CLASS_OTHER,
    PARSE_CLASS_OWNERSHIP,
    PARSE_CLASS_SCHEDULE13,
    PARSE_CLASS_THIRTEENF,
)
from app.store.models import parse_class as _parse_class

# ── Parse classes ───────────────────────────────────────────────────────────
#
# ALIASES, not second definitions. These strings are STORED in
# `us_filings.parseClass` and are read back by the parsers, by the
# `[status, parseClass]` index and by the coverage reports; renaming one is a
# data migration, not a refactor, so there is exactly one place they are spelled.

OWNERSHIP = PARSE_CLASS_OWNERSHIP
THIRTEENF = PARSE_CLASS_THIRTEENF
SCHEDULE13 = PARSE_CLASS_SCHEDULE13
EIGHTK = PARSE_CLASS_EIGHTK
FINANCIALS = PARSE_CLASS_FINANCIALS
OTHER = PARSE_CLASS_OTHER

#: Every value :func:`classify_form` can return.
PARSE_CLASSES: tuple[str, ...] = (
    OWNERSHIP,
    THIRTEENF,
    SCHEDULE13,
    EIGHTK,
    FINANCIALS,
    OTHER,
)

#: Parse class -> Pub/Sub BASE topic (the env suffix is applied by
#: :func:`app.publish.topic_name`). These names must equal the ones in
#: ``workers/scripts/setup-pubsub.sh``'s ``EDGAR_TOPICS`` and the routes in
#: ``app/main.py``'s ``JOB_ROUTES``: the push subscription's endpoint is built as
#: ``${SERVICE_URL}/jobs/${BASE_TOPIC}``, so a mismatch answers 404 on every
#: delivery — five retries and a dead letter, which reads as a broken
#: subscription rather than as a typo here.
TOPIC_BY_PARSE_CLASS: dict[str, str] = {
    OWNERSHIP: "edgar-parse-ownership",
    THIRTEENF: "edgar-parse-13f",
    SCHEDULE13: "edgar-parse-13dg",
    EIGHTK: "edgar-parse-8k",
    FINANCIALS: "edgar-parse-financials",
}


def classify_form(form: str) -> str:
    """Which parser owns a filing with this form string.

    Case- and whitespace-tolerant (the same form arrives from an Atom
    ``<category term=>``, an EFTS ``form`` field and a fixed-width daily-index
    column, and the last of those can carry ``SC  13G`` with two spaces).

    An unknown form is :data:`OTHER` — NEVER an exception. EDGAR publishes
    hundreds of form types and adds new ones without warning; a detector that
    raised on an unrecognised one would stop the whole minutely walk for every
    OTHER filing on the same page, converting one unknown form into a total
    detection outage.
    """
    return _parse_class(form)


def topic_for(parse_class: str) -> str | None:
    """Base topic a filing of this class is fanned out to.

    ``None`` for :data:`OTHER`, and that is a real answer rather than a gap: the
    filing is recorded in ``us_filings`` as a ledger row and no parser is asked
    to handle it. ``{parseClass: "OTHER"}`` lists every form we have chosen not
    to parse.

    A ``None`` here therefore obliges the CALLER to store the row TERMINAL —
    ``app.store.models.STATUS_NO_PARSER``, which ``app/jobs/detect.py`` resolves
    before it claims the row. Storing it ``DETECTED`` is what MONEY-1303 fixed:
    nothing ever advances a filing with no parser, so the in-flight status came
    to mean both "awaiting a parser" and "will never be parsed", and 933
    permanent rows on prod were indistinguishable from a stalled parse queue.

    An UNRECOGNISED class raises, and the asymmetry with :func:`classify_form`
    is deliberate. An unknown FORM comes from SEC and must be survivable; an
    unknown parse CLASS can only come from our own code, and answering ``None``
    for it would drop a whole class of filings out of the fan-out with nothing
    anywhere reporting it — the same reason ``collection_name`` refuses to
    invent a collection.
    """
    if parse_class == OTHER:
        return None
    try:
        return TOPIC_BY_PARSE_CLASS[parse_class]
    except KeyError as err:
        raise KeyError(
            f"unknown parse class {parse_class!r}; known: {sorted(PARSE_CLASSES)}"
        ) from err
