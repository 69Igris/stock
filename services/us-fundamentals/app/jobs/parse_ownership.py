"""``/jobs/edgar-parse-ownership`` — Forms 3/4/5 -> ``us_insider_transactions``.

Thin ON PURPOSE. The route decodes the envelope, this module names the parse
class and the metric tag, and everything else is
:func:`app.parsers.dispatch.run_parse_job` -> ``parse_and_store``. When
MONEY-1271's always-on poller lands it will call the same seam with the same
arguments and this file will not change.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from app.parsers.dispatch import run_parse_job

#: MUST equal the route path in ``app/main.py`` and the topic base name in
#: ``setup-pubsub.sh``: the push endpoint is built as
#: ``${SERVICE_URL}/jobs/${BASE_TOPIC}``, and the metric is tagged ``job:``.
JOB = "edgar-parse-ownership"
PARSE_CLASS = "OWNERSHIP"


def handle(payload: Mapping[str, Any]) -> dict[str, Any]:
    return run_parse_job(payload, parse_class=PARSE_CLASS, job=JOB)
