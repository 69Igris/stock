"""``/jobs/edgar-parse-13f`` — 13F-HR -> ``us_13f_filings`` + ``us_13f_holdings``.

Thinner than it looks, plus ONE extra leg: the CUSIP map.

A 13F reports positions by CUSIP and nothing else, so a holding whose CUSIP is
not in ``us_cusip_map`` cannot be shown next to a price. The parse stamps
whatever the map already knows; this job then hands the REMAINDER to
:func:`app.parsers.cusip_map.resolve_cusips`, which runs the four tiers and
records the ones that stay unresolved as ROWS with an ``attempts`` count — so
the nightly sweep has a population to retry weekly instead of rediscovering the
same misses forever.

The leg runs AFTER the parse and never blocks it. A holdings row with a null
symbol is complete, correct and useful; the map filling in later changes nothing
that was already written. It is skipped entirely when the run is not armed,
because seeding UNRESOLVED rows is a write.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from app import settings
from app.logging_setup import log_error
from app.parsers import cusip_map
from app.parsers.dispatch import run_parse_job

JOB = "edgar-parse-13f"
PARSE_CLASS = "THIRTEENF"

#: A single 13F can carry thousands of distinct CUSIPs (Berkshire's 2026 filing
#: is 89 rows; a large index manager files far more). The resolver is capped per
#: message so one enormous filing cannot spend the whole OpenFIGI budget or push
#: the handler past Pub/Sub's 600 s ack deadline — the leftovers are simply
#: still unresolved on the next filing that mentions them, and the nightly sweep
#: takes them either way.
MAX_CUSIPS_PER_MESSAGE = 500


def handle(payload: Mapping[str, Any]) -> dict[str, Any]:
    result = run_parse_job(payload, parse_class=PARSE_CLASS, job=JOB)

    detail = result.get("detail") or {}
    # POPPED, not read: a 4,000-element list in the HTTP response body is a
    # 4,000-element list in Pub/Sub's delivery log.
    unresolved = list(detail.pop("unresolvedCusips", []) or [])
    if not unresolved:
        return result

    detail["cusipResolution"] = {"pending": len(unresolved), "ran": False}
    if not settings.parse_apply():
        detail["cusipResolution"]["reason"] = "EDGAR_PARSE_APPLY is not armed"
        return result

    try:
        report = cusip_map.resolve_cusips(unresolved[:MAX_CUSIPS_PER_MESSAGE], apply=True)
    except Exception as err:
        # The HOLDINGS ARE ALREADY WRITTEN AND CORRECT. A holding row with a
        # null symbol is complete and useful; the map filling in later changes
        # nothing about it. Letting an OpenFIGI outage take the route to 500
        # would have Pub/Sub redeliver a filing that is fully parsed, five
        # times, and dead-letter it. Recorded as a named failure instead — the
        # nightly sweep takes the same CUSIPs either way.
        log_error(f"{JOB}: CUSIP resolution leg failed after a successful parse", err)
        detail["cusipResolution"] = {
            "pending": len(unresolved),
            "ran": False,
            "reason": f"resolver failed: {type(err).__name__}",
        }
        return result

    # Same reason as the pop above: the per-CUSIP resolutions are the sweep's
    # working set, not a response body.
    report.pop("resolutions", None)
    # NOTE the counts here are NOT in the job's `written` metric: that counter
    # is reported from `run_parse_job`'s finally, before this leg runs, and it
    # measures the FILING. The map is its own population with its own sweep.
    detail["cusipResolution"] = {"pending": len(unresolved), "ran": True, **report}
    return result
