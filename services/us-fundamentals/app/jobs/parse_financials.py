"""``/jobs/edgar-parse-financials`` — 10-K/10-Q/20-F/40-F -> ``us_fundamentals``.

Thin ON PURPOSE; see ``parse_ownership.py``. A filing with no XBRL instance is
UNSUPPORTED, not FAILED: most of EDGAR has none, and a queue of them marked
FAILED is a permanently red parser with nothing wrong with it.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from app.parsers.dispatch import run_parse_job

JOB = "edgar-parse-financials"
PARSE_CLASS = "FINANCIALS"


def handle(payload: Mapping[str, Any]) -> dict[str, Any]:
    return run_parse_job(payload, parse_class=PARSE_CLASS, job=JOB)
