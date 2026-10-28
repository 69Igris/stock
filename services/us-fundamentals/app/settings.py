"""Environment access for the us-fundamentals service — MONEY-979.

## Every accessor is a FUNCTION, and that is not a style choice

A module-level ``SEC_EGRESS = os.getenv("SEC_EGRESS")`` is read ONCE, at import.
Import happens before anything a test does, so a test that sets the variable and
then calls the code silently exercises the DEFAULT — the assertion passes for the
wrong reason and the guard it claims to cover is never executed. The same freeze
bit `bse-client.ts`'s retry config in this repo, where a module-scope read
captured a value the operator later changed and nothing reported the difference.

So: read ``os.environ`` inside the call, every call.

## Flags are compared to a LITERAL string, never coerced

``bool("false")`` is ``True``. A flag that arms a writer must therefore never be
passed through ``bool()``, and the three write-arming flags here
(``EDGAR_DETECT``, ``EDGAR_PARSE_APPLY``, ``EDGAR_EVICT_APPLY``) compare against
the exact strings ``"on"`` / ``"true"``.

## Absent and explicitly-off are DIFFERENT states

Both are OFF, but they are reported differently by :func:`flag_state`, and both
Cloud Build specs ship all three flags PRESENT and off. ``MF_METADATA_PROVIDER``
disabled its job for months by being absent, which no dashboard could show,
because "absent" and "deliberately off" looked identical from outside
(MONEY-1214).
"""

from __future__ import annotations

import os

# ── Constants that are NOT environment-derived ──────────────────────────────

#: Metric namespace. Mirrors ``METRIC_PREFIX`` in ``packages/datadog/src/constants.ts``.
#: The series that reaches Datadog is ``stockbook.job.written``, never ``job.written``.
METRIC_PREFIX = "stockbook."

#: Datadog service tag for this Cloud Run service.
DD_SERVICE_DEFAULT = "us-fundamentals"

#: Datadog SITE. Mirrors ``DD_SITE`` in ``packages/datadog/src/constants.ts``
#: (us5 since the September-2026 org replacement, MONEY-1229).
#:
#: Read by ONE thing: the HTTP metrics transport in ``app.store.outcome``, which
#: exists because a Cloud Run JOB has no sidecar. Everything else in this
#: service — ddtrace, DogStatsD — talks to the sidecar on localhost and never
#: needs to know which org it forwards to. A site mismatch does not error: a key
#: minted on one site is answered 403 by another, and the transport swallows it,
#: so the only symptom is a series that never arrives.
DD_SITE = "us5.datadoghq.com"

#: SEC's documented fair-access ceiling is 10 req/s. We pace at 9 deliberately:
#: the limiter is proactive and the penalty for overrunning is a 10-minute block
#: with no ``Retry-After`` to steer by, so one request per second of headroom is
#: cheap insurance. Matches edgartools' own ``EDGAR_RATE_LIMIT_PER_SEC`` default.
DEFAULT_SEC_RATE_LIMIT_PER_SEC = 9


def _env(name: str) -> str | None:
    """Read one variable, trimmed. Empty string reads as absent.

    An empty value in a Cloud Run spec is what an unexpanded substitution looks
    like, and treating it as "set" is how a service ends up verifying OIDC
    tokens against an audience of ``""``.
    """
    raw = os.environ.get(name)
    if raw is None:
        return None
    trimmed = raw.strip()
    return trimmed or None


def _literal(name: str) -> str:
    """Lower-cased literal value for a flag comparison. ``""`` when absent."""
    return (os.environ.get(name) or "").strip().lower()


# ── Identity of this deployment ─────────────────────────────────────────────


def app_env() -> str | None:
    """The environment this process believes it is.

    ``APP_ENV`` first, then ``NODE_ENV`` — both are set by the Cloud Build specs
    so the Python service and the TypeScript workers report the same word, and
    the OIDC gate's local-environment allow-list is written against these values.
    """
    return _env("APP_ENV") or _env("NODE_ENV")


def pubsub_env() -> str | None:
    """Topic suffix (``qa`` / ``prod`` / ``local``). Names the topics we publish to."""
    return _env("PUBSUB_ENV")


def cloud_run_url() -> str | None:
    """The OIDC audience every Pub/Sub push token must carry.

    Absent is a MISCONFIGURATION and never a reason to skip verification:
    verifying against ``None`` accepts any Google-signed token, including one
    minted for an unrelated service. :mod:`app.auth` answers 500, not 200.
    """
    return _env("CLOUD_RUN_URL")


def gcp_project_id() -> str | None:
    return _env("GCP_PROJECT_ID")


def gcp_storage_bucket() -> str | None:
    """Bucket holding the SEC archive (``edgar/...``). Absent disables archiving."""
    return _env("GCP_STORAGE_BUCKET")


def database_url() -> str | None:
    return _env("DATABASE_URL")


def redis_url() -> str | None:
    """Redis backing the SHARED SEC rate limiter.

    Not optional in a deployed environment: edgartools' own limiter is a
    per-process ``InMemoryBucket``, so N Cloud Run instances would each pace to
    9 req/s independently and the aggregate would breach SEC's ceiling. T3
    fails CLOSED when this is unreachable rather than falling back in-process.
    """
    return _env("REDIS_URL")


def dd_version() -> str:
    return _env("DD_VERSION") or "unknown"


# ── SEC access ──────────────────────────────────────────────────────────────


def edgar_identity() -> str | None:
    """Sent VERBATIM as the ``User-Agent`` on every sec.gov request.

    SEC's own template is ``Name email``; an undeclared or generic agent gets a
    403 whose body reads "Undeclared Automated Tool". edgartools does not
    validate this string, so a typo here is a whole-service outage that looks
    like a permissions problem.
    """
    return _env("EDGAR_IDENTITY")


def sec_rate_limit_per_sec() -> int:
    """Requests per second the shared limiter allows across ALL instances.

    Falls back to :data:`DEFAULT_SEC_RATE_LIMIT_PER_SEC` on absent, non-numeric
    or non-positive input. Guessing HIGH here walks the fleet into a 10-minute
    block; guessing low only runs slower, so an unparseable value resolves to
    the safe number instead of raising and taking the service down.
    """
    raw = _env("SEC_RATE_LIMIT_PER_SEC")
    if raw is None:
        return DEFAULT_SEC_RATE_LIMIT_PER_SEC
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_SEC_RATE_LIMIT_PER_SEC
    return value if value > 0 else DEFAULT_SEC_RATE_LIMIT_PER_SEC


def sec_egress() -> str:
    """``"archive"`` (prod: may fetch sec.gov) or ``"off"`` (QA: archive reads only).

    Defaults to ``"off"``. An environment that has not said it may reach the SEC
    does not reach the SEC — a service that fetches by default is one
    misconfigured deploy away from two environments scraping the same host.
    """
    value = _literal("SEC_EGRESS")
    return "archive" if value == "archive" else "off"


def openfigi_api_key() -> str | None:
    """OpenFIGI key for CUSIP resolution. Keyed = 25 req / 6 s, 100 jobs / req.

    Absent is legal — unkeyed access exists at 25/min and 10 jobs — so T7 must
    degrade rather than fail. NEVER log this value; it is redacted by
    :mod:`app.logging_setup` under the ``X-OPENFIGI-APIKEY`` header name.
    """
    return _env("OPENFIGI_API_KEY")


# ── Kill switches / write arms ──────────────────────────────────────────────
#
# Three flags, three questions, and they are deliberately NOT one flag:
#   EDGAR_DETECT       does this environment poll the SEC at all?
#   EDGAR_PARSE_APPLY  may a parser WRITE the rows it produced?
#   EDGAR_EVICT_APPLY  may the 13F evictor DELETE hot rows it has archived?
#
# All three ship PRESENT and OFF in both Cloud Build specs.


def detect_enabled() -> bool:
    """True only when ``EDGAR_DETECT`` is literally ``"on"``."""
    return _literal("EDGAR_DETECT") == "on"


def parse_apply() -> bool:
    """True only when ``EDGAR_PARSE_APPLY`` is literally ``"true"``."""
    return _literal("EDGAR_PARSE_APPLY") == "true"


def evict_apply() -> bool:
    """True only when ``EDGAR_EVICT_APPLY`` is literally ``"true"``.

    The evictor is the only code path in this service that DELETES stored rows.
    """
    return _literal("EDGAR_EVICT_APPLY") == "true"


def flag_state(name: str) -> str:
    """Report a flag as ``"absent"``, ``"empty"`` or its literal lower-cased value.

    ``/health`` prints this rather than a boolean so an operator can tell a
    deliberate ``"off"`` from a variable nobody set. That distinction is the
    whole reason the specs ship the flags present-and-off.
    """
    raw = os.environ.get(name)
    if raw is None:
        return "absent"
    trimmed = raw.strip()
    return trimmed.lower() if trimmed else "empty"


def datadog_env() -> str:
    """Map this deployment onto the Datadog ``env:`` tag.

    Mirrors ``toDatadogEnv`` in ``packages/datadog/src/constants.ts`` EXACTLY,
    including that ``prod`` maps to ``production``. ``apply-monitors.sh`` once
    substituted ``env:prod``, a tag the workers have never emitted, and the
    monitor sat permanently in NO DATA — which is indistinguishable from health.
    """
    raw = _env("DD_ENV") or app_env()
    if raw in ("production", "prod"):
        return "production"
    if raw == "qa":
        return "qa"
    return "development"


def metrics_transport() -> str:
    """``"http"`` or ``"statsd"`` — how this process ships its counters.

    MONEY-1278. The SERVICE runs beside a ``serverless-init`` sidecar, so its
    counters go out over DogStatsD to ``127.0.0.1:8125``. The five Cloud Run
    JOBS have NO sidecar, and DogStatsD is fire-and-forget UDP: the packets were
    refused by a closed port and dropped, silently, while
    ``[job-outcome] {...}`` kept logging perfectly. A metric that never arrives
    renders as NO DATA, not as an alert, so the job half of EDGAR could not be
    monitored in either direction.

    Compared to the LITERAL string, like every flag here: ``bool("statsd")`` is
    ``True``, so a coercion would put every process on the HTTP path — including
    the service, which would then bypass a healthy sidecar and spend a request
    per emit. Absent means statsd, which is the shipped default and the state
    every environment was in before this flag existed.
    """
    return "http" if _env("DD_METRICS_TRANSPORT") == "http" else "statsd"


def default_metric_tags() -> list[str]:
    """``service:`` / ``env:`` / ``version:`` — mirrors ``getDefaultTags()``."""
    return [
        f"service:{_env('DD_SERVICE') or DD_SERVICE_DEFAULT}",
        f"env:{datadog_env()}",
        f"version:{dd_version()}",
    ]
