"""``/jobs/edgar-parse-13dg`` — Schedules 13D/13G -> ``us_beneficial_ownership``.

Thin ON PURPOSE; see ``parse_ownership.py``. The one thing worth knowing at this
layer is that BOTH form spellings arrive here — ``SC 13D`` before the
2024-12-18 XML mandate and ``SCHEDULE 13D`` after it — and the parser handles
the pre-mandate HTML by storing identities with ``hasStructuredData: False``
rather than by failing.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from app.parsers.dispatch import run_parse_job

JOB = "edgar-parse-13dg"
PARSE_CLASS = "SCHEDULE13"


def handle(payload: Mapping[str, Any]) -> dict[str, Any]:
    return run_parse_job(payload, parse_class=PARSE_CLASS, job=JOB)
