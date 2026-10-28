"""One report per data-writing job run — MONEY-979.

Python side of ``packages/datadog/src/job-outcome.ts``. The metric NAMES are
identical on purpose: a monitor, a dashboard and a notebook must be able to span
the TypeScript workers and this service with one query, and the zero-write
monitor template in ``scripts/ops/datadog/`` already queries these series.

## The class of bug this exists to make visible

In a single week six scheduled jobs ran on time, reported success, and wrote
nothing. Every schedule was ENABLED, every invocation returned 200, every
dashboard was green. The only symptom was a table that had stopped growing —
and nobody watches a table for absence.

The signal that separates a healthy run from all six is not the exit code. It is
``selected > 0 and written == 0``: the job found work and produced nothing.
MONEY-1250 added the second signal, ``transport_failures > 0 and written == 0``:
without it a total upstream block emits a clean ``0/0/0``, byte-identical to a
healthy quiet run.

## Why the transport counter is separate from ``failed``

``failed`` is measured in ROWS. A 403 from sec.gov is not a row that failed to
persist; it is a reason no rows were considered. Folding one into the other
makes the block invisible in both the metrics and the log, which is the exact
shape that hid Tickertape's egress block for five months.

## Counters are incremented AFTER the call they count

Not enforceable here — this module only reports what it is handed — but it is
the contract every caller owes it. ``stock-document-sync`` incremented every
per-source counter BEFORE the call it counted, so a source that 403s on every
request still produced a full-looking number (MONEY-1255).
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import resource
import sys
import time
import urllib.error
import urllib.request
from typing import Any

from app import settings
from app.logging_setup import log_error

_logger = logging.getLogger("us-fundamentals.job-outcome")

#: Multiplier that turns ``resource.getrusage(...).ru_maxrss`` into BYTES.
#:
#: The unit is PLATFORM-DEPENDENT and getting it wrong is a 1024x error that
#: still reads as a plausible number — 1.6 GB of parse on a 2Gi container looks
#: exactly like 1.6 MB if you divide by the wrong constant, and neither is
#: obviously absurd. Linux reports KILOBYTES (`man 2 getrusage`); macOS and the
#: BSDs report BYTES. The service runs on `python:3.12-slim` (Linux), so 1024 is
#: the deployed path and the darwin branch exists for laptop measurement.
RU_MAXRSS_TO_BYTES = 1 if sys.platform == "darwin" else 1024

#: Metric names as EMITTED. Unlike the TypeScript side — where `datadog-metrics`
#: is initialised with a `prefix` and the code passes the bare name — DogStatsD
#: has no prefix configured here, so what is passed IS what arrives. The
#: ``stockbook.`` prefix is therefore written into the constant rather than
#: applied by a client setting that a test cannot see.
JOB_METRIC_SELECTED = settings.METRIC_PREFIX + "job.selected"
JOB_METRIC_WRITTEN = settings.METRIC_PREFIX + "job.written"
JOB_METRIC_FAILED = settings.METRIC_PREFIX + "job.failed"
JOB_METRIC_TRANSPORT_FAILURES = settings.METRIC_PREFIX + "job.transport_failures"

#: Detection freshness: seconds between SEC ``acceptedAt`` and our storing the
#: filing. The acceptance gate for MONEY-979 is p95 < 300 s, and T12 renders a
#: Datadog monitor from this exact name.
DETECT_LATENCY_METRIC = settings.METRIC_PREFIX + "edgar.detect_latency_seconds"

#: DogStatsD host/port. The Datadog sidecar (`serverless-init`) listens on UDP
#: 8125 inside the same Cloud Run task, so localhost is correct and there is no
#: network hop.
STATSD_HOST = "127.0.0.1"
STATSD_PORT = 8125

_statsd: Any = None
_statsd_resolved = False


def _get_statsd() -> Any:
    """The DogStatsD client, or ``None`` when the library is unavailable.

    Resolved once and cached, INCLUDING the failure — but the cache stores the
    determinacy, not a fabricated success: a failed import yields ``None``,
    which every caller treats as "no metrics backend", never as "emitted".

    Silent HERE, reported at the CALL SITE. The failure is cached, so logging it
    inside this function would say it once per process and never again — while
    every subsequent run drops four counters. :func:`report_job_outcome` logs
    once per REPORT, which is the rate the drop actually happens at.
    """
    global _statsd, _statsd_resolved
    if _statsd_resolved:
        return _statsd
    try:
        from datadog.dogstatsd import DogStatsd

        _statsd = DogStatsd(host=STATSD_HOST, port=STATSD_PORT)
    except Exception:
        _statsd = None
    _statsd_resolved = True
    return _statsd


def set_statsd_for_tests(client: Any) -> None:
    """Inject a recording client. Test-only; pass ``None`` to reset."""
    global _statsd, _statsd_resolved
    _statsd = client
    _statsd_resolved = client is not None


#: The HTTP sender, injectable for tests. ``None`` means "use the real one".
_http_sender: Any = None


def set_http_sender_for_tests(sender: Any) -> None:
    """Inject a recording HTTP sender. Test-only; pass ``None`` to reset."""
    global _http_sender
    _http_sender = sender


def _count(metric: str, value: int, tags: list[str]) -> dict[str, Any]:
    """One v1-intake series point. ``type: "count"`` matches the DogStatsD
    ``increment`` the sidecar path uses, so the SAME series has the same
    semantics whichever transport produced it — a job and the service must be
    summable in one query or the monitors would have to know which is which."""
    return {
        "metric": metric,
        "type": "count",
        "points": [[int(time.time()), value]],
        "tags": tags,
    }


def _http_send_series(series: list[dict[str, Any]]) -> None:
    """POST counters to the Datadog v1 intake — MONEY-1278.

    The agentless path, for the five Cloud Run JOBS, which have no sidecar to
    receive DogStatsD. Deliberately the same arrangement ``apps/web`` uses on
    Vercel, where no agent is available either.

    NO-OP without ``DD_API_KEY``, which is the TypeScript side's contract
    (``datadog-metrics`` no-ops when uninitialised) and the reason a local run
    or a test needs no credentials to exercise everything above this line — but
    a NOISY no-op. An unmounted secret and a delivered batch used to produce
    byte-identical output.

    ``urllib`` rather than ``httpx``: this must not depend on a client that
    ddtrace patches, and it must work in a job that has torn down its async
    machinery. The five-second timeout is a ceiling on how long reporting may
    delay a job's exit, not a retry budget — a lost batch is a lost batch, and
    the ``[job-outcome]`` log line is the fallback record either way.

    ## The STATUS is the whole point of having an HTTP transport

    MONEY-1229. DogStatsD cannot report a DELIVERY status — fire-and-forget UDP
    has none — which is the defect this transport was built to escape. That
    excuses nothing else about the statsd branch, and for a release it was read
    as excusing everything: a missing package and a raising ``increment`` were
    swallowed there too, neither of which is a property of UDP. Both are logged
    now, in :func:`report_job_outcome`.

    Throwing away the status HTTP does give us rebuilds the same defect one
    layer up: a rotated key (403), a site the key was not minted on (403) and a
    malformed body (400) all raise ``HTTPError``, the caller catches bare
    ``Exception``, and the run ends with ``[job-outcome]`` printed, exit 0, and
    the monitor reading NO DATA — indistinguishable from an idle healthy job.

    Non-fatal either way; the job must not fail because reporting did. Logged
    through :func:`log_error`, never with the exception object, because
    ``httpx`` and ``google-auth`` hang the credentialed request off it.
    """
    api_key = os.environ.get("DD_API_KEY")
    if not api_key:
        log_error("[job-outcome] DD_API_KEY is not set — metrics series dropped")
        return
    request = urllib.request.Request(
        f"https://api.{settings.DD_SITE}/api/v1/series",
        data=json.dumps({"series": series}).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "DD-API-KEY": api_key},
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:  # noqa: S310 - fixed https host
            # `getattr` rather than `response.status`: a stub or an exotic
            # opener without one reads as 0 and is REPORTED, which is the
            # direction that fails loudly instead of inventing a success.
            status = int(getattr(response, "status", 0) or 0)
    except urllib.error.HTTPError as exc:
        # An `HTTPError` IS the response — 400/401/403 arrive here, not in the
        # `with`, and they are the three failures this branch exists for.
        status = int(exc.code)
    if not 200 <= status < 300:
        log_error(
            f"[job-outcome] Datadog intake at api.{settings.DD_SITE} answered "
            f"{status} — {len(series)} metric series dropped"
        )


def _tags(extra: dict[str, str] | None = None) -> list[str]:
    tags = settings.default_metric_tags()
    if extra:
        tags.extend(f"{key}:{value}" for key, value in extra.items())
    return tags


def peak_rss_bytes() -> int | None:
    """This PROCESS's high-water resident set size, in bytes, or ``None``.

    ``None`` is a distinct answer meaning "could not determine", never ``0``. A
    zero here would read as "this job used no memory", which is the shape of a
    cached fail-open default — and the one number nobody would question.

    ## It is a PROCESS high-water mark, not a per-job measurement

    ``ru_maxrss`` is monotonic for the life of the process: it never comes back
    down when a parse releases its DataFrames, and on a warm Cloud Run instance
    it reports the largest thing that instance has EVER held, not the largest
    thing this run held. That is deliberately the more useful number for the
    question this field exists to answer — "how close is this container to its
    2Gi limit" — because an OOM kill is caused by the peak, whoever caused it.
    It is NOT usable as "how much did this filing cost"; ``scripts/
    bench_parse_memory.py`` answers that by running one parse per fresh process.

    Cloud Run kills a container that exceeds its memory limit with SIGKILL, and
    the surviving evidence is a 137 exit that reads as a crash rather than as
    "the limit is too small". This field is what turns the second reading into
    something an operator can see BEFORE the kill.
    """
    try:
        return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * RU_MAXRSS_TO_BYTES
    except Exception:
        # Not reachable on Linux or macOS; `resource` is absent on Windows and
        # a sandbox can refuse the syscall. Reporting nothing beats reporting a
        # number that is not a measurement.
        return None


def report_job_outcome(
    job: str,
    selected: int,
    written: int,
    failed: int = 0,
    transport_failures: int = 0,
    skipped_reason: str | None = None,
) -> None:
    """Emit the four counters and one structured line. NEVER raises.

    A metrics backend that is down must not fail the job that was reporting to
    it, and the log line is the fallback signal for an environment with no
    Datadog at all (it is greppable as ``"written": 0``).

    Call it from a ``finally``. A job that raises before reporting is a job
    whose failure is invisible in exactly the dimension this module measures.
    """
    tags = _tags({"job": job})

    # MONEY-1278 — which wire this process uses is a property of WHERE it runs,
    # not of what it is reporting. A Cloud Run JOB has no sidecar, so DogStatsD
    # packets were refused by a closed port and dropped in silence; the service
    # has one and keeps using it. Both produce the same four series with the
    # same tags, so a monitor never has to know which side emitted.
    if settings.metrics_transport() == "http":
        try:
            send = _http_sender or _http_send_series
            send(
                [
                    _count(JOB_METRIC_SELECTED, selected, tags),
                    _count(JOB_METRIC_WRITTEN, written, tags),
                    _count(JOB_METRIC_FAILED, failed, tags),
                    _count(JOB_METRIC_TRANSPORT_FAILURES, transport_failures, tags),
                ]
            )
        except Exception as exc:
            # Same contract as the statsd branch — a metrics backend having a
            # moment must never fail the job that was reporting to it — but NOT
            # the same silence. This is where a DNS failure, a TLS error or a
            # five-second timeout landed, and `pass` made every one of them
            # byte-identical to a delivered batch (MONEY-1229). `log_error`
            # keeps the exception TYPE and drops the traceback and the
            # exception's `request` attribute.
            log_error("[job-outcome] metrics transport failed — series dropped", exc)
    else:
        statsd = _get_statsd()
        if statsd is None:
            # MONEY-1229 — the HALF THAT WAS LEFT SILENT. The reason the HTTP
            # branch below was made to report is that a dropped batch and a
            # delivered one were byte-identical; an absent client is the same
            # defect on the same line, and this is the branch the SERVICE runs
            # (DD_METRICS_TRANSPORT=statsd), where `edgar-detect` reports every
            # minute. "Fire-and-forget UDP has no status" is true of the SEND —
            # it says nothing about a client that was never constructed.
            log_error(
                "[job-outcome] no DogStatsD client (the `datadog` package did "
                "not import) — four metric series dropped"
            )
        else:
            try:
                statsd.increment(JOB_METRIC_SELECTED, selected, tags=tags)
                statsd.increment(JOB_METRIC_WRITTEN, written, tags=tags)
                statsd.increment(JOB_METRIC_FAILED, failed, tags=tags)
                statsd.increment(JOB_METRIC_TRANSPORT_FAILURES, transport_failures, tags=tags)
            except Exception as exc:
                # Same contract as the HTTP branch — reporting must never fail
                # the job — and now the same visibility. `increment` itself
                # raises on a closed socket, a client whose transport was torn
                # down, or a tag the library refuses; `pass` made all three read
                # as a healthy emit. Through `log_error`, never with the
                # exception object: the type and message survive, the traceback
                # and any `request` attribute do not.
                log_error("[job-outcome] statsd increment failed — series dropped", exc)

    payload: dict[str, Any] = {
        "msg": "job-outcome",
        "job": job,
        "selected": selected,
        "written": written,
        "failed": failed,
    }
    # MONEY-979 T20. The service ships 2Gi with `containerConcurrency: 4` and
    # the heaviest thing it does is edgartools+pandas on a 10-K, so the distance
    # between "works" and "SIGKILL 137" is a number nobody was recording. Put in
    # the LOG payload rather than emitted as a fifth DogStatsD series on purpose:
    # `tests/test_outcome.py` asserts the emitted metric name list EXACTLY, and
    # a log-based metric off this JSON field is a Datadog configuration change
    # rather than a code change. Omitted entirely when it cannot be measured —
    # an absent key is honest, a 0 is a lie.
    peak = peak_rss_bytes()
    if peak is not None:
        payload["peakRssBytes"] = peak
    if transport_failures:
        payload["transportFailures"] = transport_failures
    if skipped_reason:
        payload["skippedReason"] = skipped_reason
    line = json.dumps(payload)

    # An upstream that would not answer is a warning on its own. Without this
    # branch a total block emits a clean 0/0/0, indistinguishable from a healthy
    # quiet run in both the metrics and the log.
    if transport_failures > 0 and written == 0:
        _logger.warning(
            "[job-outcome] %s wrote 0 after %d UPSTREAM failure(s) — %s %s",
            job,
            transport_failures,
            skipped_reason or "no reason reported",
            line,
        )
        return
    # A job that found work and wrote none is a WARNING even when it "succeeded".
    # This is the whole point of the module, so it is the one branch that changes
    # SEVERITY rather than just wording.
    if selected > 0 and written == 0:
        _logger.warning(
            "[job-outcome] %s selected %d and wrote 0 — %s %s",
            job,
            selected,
            skipped_reason or "no reason reported",
            line,
        )
        return
    _logger.info("[job-outcome] %s", line)


def record_latency(seconds: float, tags: dict[str, str] | None = None) -> None:
    """Record one detection latency sample. NEVER raises.

    A HISTOGRAM, not a gauge: the acceptance gate is a p95 and a gauge would
    report only the last sample of each flush window — which on a minutely
    detect loop is one filing out of dozens, chosen at random.

    Computed from ``acceptedAt``, never ``filedAt``: ``filedAt`` is a DATE on
    many forms, so a latency derived from it is measured in hours and is not a
    measurement of anything this service controls.
    """
    statsd = _get_statsd()
    if statsd is None:
        return
    # Suppressed, not logged: this is called once PER FILING inside the detect
    # loop, so a broken socket would otherwise emit a log line per filing and
    # bury the outcome report it sits next to. `report_job_outcome` is the
    # signal that a run went wrong; a lost latency sample is not.
    with contextlib.suppress(Exception):
        statsd.histogram(DETECT_LATENCY_METRIC, seconds, tags=_tags(tags))
