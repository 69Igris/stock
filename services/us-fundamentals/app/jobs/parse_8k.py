"""``/jobs/edgar-parse-8k`` — 8-K exhibits -> ``us_filing_documents`` + GCS text.

Thin ON PURPOSE; see ``parse_ownership.py``. Note that a reparse of an unchanged
filing writes NOTHING — same ``textHash``, no GCS put, no row — so this job is
safe to re-run over the whole queue after a mapping bump.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from app.parsers.dispatch import run_parse_job

JOB = "edgar-parse-8k"
PARSE_CLASS = "EIGHTK"


def handle(payload: Mapping[str, Any]) -> dict[str, Any]:
    return run_parse_job(payload, parse_class=PARSE_CLASS, job=JOB)
