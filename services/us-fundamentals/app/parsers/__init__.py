"""Filing parsers: typed adapter rows -> stored, provenance-stamped documents.

No re-exports — for the same reason as :mod:`app.sec`. A convenience barrel here
would drag :mod:`app.parsers.dispatch` (and through it pymongo,
google-cloud-storage and httpx) into a caller that only wanted a pure predicate
out of :mod:`app.parsers.thirteenf_logic`. Import the module you need.

What DOES live here is the handful of zero-dependency primitives every
``*_logic`` module needs, because they have no other honest home: putting
:func:`as_datetime` in one logic module and importing it from the other four
would make that module's import graph a lie.

Layout, and the split is the point:

* ``*_logic.py``  PURE. No I/O, no clock, no environment, no database. Every
  decision a parser makes lives here so a test can drive the REAL
  implementation rather than a re-declared copy of it.
* :mod:`app.parsers.dispatch`  the ONE seam. ``parse_and_store(accession,
  bundle, parse_class=...)`` takes BYTES somebody else fetched and returns an
  outcome. It is pure of TRANSPORT: nothing in it fetches and nothing in it
  knows about Pub/Sub. Today ``app/jobs/parse_*.py`` call it after a
  ``SecClient.fetch_bundle``; MONEY-1271's always-on poller and MONEY-1272's
  SFTP receiver will call the same function with the same arguments, which is
  what makes the latency roadmap a change of SOURCE rather than a rewrite of
  five parsers.
* :mod:`app.parsers.cusip_map`  the four-tier CUSIP resolver's I/O half;
  :mod:`app.parsers.cusip_map_logic` decides.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

#: Stamped on every row this service writes. Prisma defaults it too; it is
#: written explicitly because a `$setOnInsert` default is invisible to a reader
#: comparing a stored document against the code that produced it.
SOURCE = "SEC_EDGAR"


def as_datetime(value: date | datetime | None) -> datetime | None:
    """A ``date`` as a timezone-aware UTC ``datetime``. ``None`` passes through.

    NOT cosmetic. BSON has no date type: pymongo raises ``InvalidDocument`` on a
    bare :class:`datetime.date`, so every date the adapter returns has to be
    widened before it can be stored — and a NAIVE datetime is worse than the
    error, because it is accepted and then silently reinterpreted as local time
    by whatever reads it next.

    Midnight UTC, deliberately: ``filedAt`` and ``transactionDate`` are calendar
    days at SEC, not instants, and inventing an Eastern-time hour would make a
    date-only fact look like a timestamp somebody measured.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return datetime(value.year, value.month, value.day, tzinfo=UTC)
