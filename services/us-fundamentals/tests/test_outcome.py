"""Job-outcome reporting — MONEY-979.

The metric names are asserted as LITERAL strings. That is the point: a rename
must go red here, because ``scripts/ops/datadog/monitor-zero-write.json`` and
every dashboard query the deployed series by name, and a monitor on a series
nobody emits sits permanently in NO DATA — indistinguishable from health once
the no-data notification is muted (MONEY-1238).
"""

from __future__ import annotations

import logging
import os

import pytest

from app.store.outcome import (
    DETECT_LATENCY_METRIC,
    JOB_METRIC_FAILED,
    JOB_METRIC_SELECTED,
    JOB_METRIC_TRANSPORT_FAILURES,
    JOB_METRIC_WRITTEN,
    record_latency,
    report_job_outcome,
)

# ── The names, spelled out ──────────────────────────────────────────────────


def test_the_emitted_metric_names_are_exactly_the_workers_names() -> None:
    """Literal strings, on purpose.

    Deriving them from the constants under test would make this assertion
    tautological — it would still pass after a rename, which is the one event it
    exists to catch.
    """
    assert JOB_METRIC_SELECTED == "stockbook.job.selected"
    assert JOB_METRIC_WRITTEN == "stockbook.job.written"
    assert JOB_METRIC_FAILED == "stockbook.job.failed"
    assert JOB_METRIC_TRANSPORT_FAILURES == "stockbook.job.transport_failures"
    assert DETECT_LATENCY_METRIC == "stockbook.edgar.detect_latency_seconds"


def test_all_four_counters_are_emitted_with_the_job_tag(statsd) -> None:
    report_job_outcome("edgar-detect", selected=49, written=49, failed=0)

    assert statsd.names() == [
        "stockbook.job.selected",
        "stockbook.job.written",
        "stockbook.job.failed",
        "stockbook.job.transport_failures",
    ]
    for _, _, _, tags in statsd.calls:
        assert "job:edgar-detect" in tags


def test_the_default_tags_carry_service_env_and_version(statsd) -> None:
    os.environ["DD_ENV"] = "production"
    os.environ["DD_VERSION"] = "abc1234"

    report_job_outcome("edgar-parse-13f", selected=1, written=1)

    tags = statsd.calls[0][3]
    assert "service:us-fundamentals" in tags
    assert "env:production" in tags
    assert "version:abc1234" in tags


def test_prod_maps_to_the_env_tag_production_not_prod(statsd) -> None:
    """`apply-monitors.sh` once substituted `env:prod`, a tag the workers have
    never emitted. Mirrors `toDatadogEnv` exactly."""
    os.environ["DD_ENV"] = "prod"
    report_job_outcome("edgar-evict", selected=0, written=0)
    assert "env:production" in statsd.calls[0][3]


def test_the_counters_carry_the_values_they_were_given(statsd) -> None:
    report_job_outcome("edgar-parse-8k", selected=10, written=7, failed=3, transport_failures=2)

    assert statsd.value_of("stockbook.job.selected") == 10
    assert statsd.value_of("stockbook.job.written") == 7
    assert statsd.value_of("stockbook.job.failed") == 3
    assert statsd.value_of("stockbook.job.transport_failures") == 2


# ── Severity ────────────────────────────────────────────────────────────────


def test_selected_but_wrote_nothing_is_a_WARNING(statsd, caplog) -> None:
    """The whole point of the module.

    Six jobs ran on time, returned 200 and wrote nothing for a week. The signal
    that separates them from a healthy run is not the exit code.
    """
    with caplog.at_level(logging.INFO, logger="us-fundamentals.job-outcome"):
        report_job_outcome("edgar-detect", selected=49, written=0, skipped_reason="cursor_stuck")

    record = caplog.records[-1]
    assert record.levelno == logging.WARNING
    assert "selected 49 and wrote 0" in record.getMessage()
    assert "cursor_stuck" in record.getMessage()


def test_a_transport_block_with_zero_writes_is_a_WARNING(statsd, caplog) -> None:
    """Without this branch a total upstream block emits a clean 0/0/0 —
    byte-identical to a healthy quiet run in both the metrics and the log. That
    is the exact shape that hid Tickertape's 403 for five months."""
    with caplog.at_level(logging.INFO, logger="us-fundamentals.job-outcome"):
        report_job_outcome(
            "edgar-detect", selected=0, written=0, transport_failures=20, skipped_reason="sec_403"
        )

    record = caplog.records[-1]
    assert record.levelno == logging.WARNING
    assert "20 UPSTREAM failure(s)" in record.getMessage()


def test_a_healthy_run_is_INFO(statsd, caplog) -> None:
    with caplog.at_level(logging.INFO, logger="us-fundamentals.job-outcome"):
        report_job_outcome("edgar-detect", selected=5, written=5)
    assert caplog.records[-1].levelno == logging.INFO


def test_a_genuinely_quiet_run_is_not_warned_about(statsd, caplog) -> None:
    """0 selected / 0 written with no transport failure is a poll that found
    nothing new, which happens every minute overnight."""
    with caplog.at_level(logging.INFO, logger="us-fundamentals.job-outcome"):
        report_job_outcome("edgar-detect", selected=0, written=0)
    assert caplog.records[-1].levelno == logging.INFO


# ── Never throws ────────────────────────────────────────────────────────────


def test_reporting_survives_a_dead_statsd_socket(caplog) -> None:
    """A metrics backend that is down must not fail the job reporting to it."""
    from app.store import outcome
    from tests.conftest import RecordingStatsd

    outcome.set_statsd_for_tests(RecordingStatsd(fail=True))
    with caplog.at_level(logging.INFO, logger="us-fundamentals.job-outcome"):
        report_job_outcome("edgar-detect", selected=1, written=1)
    assert any("job-outcome" in r.getMessage() for r in caplog.records)


def test_a_dead_statsd_socket_is_REPORTED_not_swallowed(caplog) -> None:
    """MONEY-1229 — non-fatal is not the same as invisible.

    The HTTP branch was changed to report a dropped batch because a drop and a
    delivery were byte-identical; this branch kept a bare ``except: pass``, and
    it is the one the SERVICE runs (``DD_METRICS_TRANSPORT=statsd``), where
    ``edgar-detect`` reports every minute. A raising ``increment`` is not
    something UDP's fire-and-forget excuses — the send never happened.
    """
    from app.store import outcome
    from tests.conftest import RecordingStatsd

    outcome.set_statsd_for_tests(RecordingStatsd(fail=True))
    with caplog.at_level(logging.ERROR):
        report_job_outcome("edgar-detect", selected=1, written=1)

    assert "series dropped" in caplog.text
    # The TYPE identifies the failure; the OBJECT carries the credentialed
    # request that httpx and google-auth hang off it.
    assert "RuntimeError" in caplog.text
    assert "Traceback" not in caplog.text


def test_no_statsd_client_at_all_is_REPORTED(monkeypatch, caplog) -> None:
    """The other silent half: ``_get_statsd()`` returning ``None``.

    A failed import of ``datadog`` drops all four counters with no exception to
    catch and — until MONEY-1229 — no log line either. The outcome line still
    printed perfectly, so a service with no metrics package looked exactly like
    a service with a healthy sidecar.

    ``_get_statsd`` is patched rather than the import, because the resolution is
    CACHED: ``set_statsd_for_tests(None)`` resets the cache and lets the real
    import run, which succeeds wherever the package is installed and would make
    this case pass or fail depending on the machine.
    """
    from app.store import outcome

    # INFO, not ERROR: the fallback assertion below is about the outcome line,
    # which is logged at INFO on a healthy run and would be filtered out.
    monkeypatch.setattr(outcome, "_get_statsd", lambda: None)
    with caplog.at_level(logging.INFO):
        report_job_outcome("edgar-detect", selected=4, written=4)

    assert "series dropped" in caplog.text
    assert "DogStatsD" in caplog.text
    # Still reported: the log line is the fallback record either way.
    assert any('"written": 4' in r.getMessage() for r in caplog.records)


def test_a_HEALTHY_statsd_emit_logs_no_error(statsd, caplog) -> None:
    """The positive control for the two cases above.

    Without it, "series dropped" would also appear if the branch logged
    unconditionally — which is the shape that trains people to ignore the line.
    """
    with caplog.at_level(logging.ERROR):
        report_job_outcome("edgar-detect", selected=2, written=2)

    assert statsd.names(), "the counters were not emitted at all"
    assert "dropped" not in caplog.text


def test_reporting_still_logs_with_no_statsd_at_all(caplog) -> None:
    """The log line is the fallback signal for an environment with no Datadog."""
    with caplog.at_level(logging.INFO, logger="us-fundamentals.job-outcome"):
        report_job_outcome("edgar-detect", selected=3, written=3)
    assert '"written": 3' in caplog.records[-1].getMessage()


# ── Emitted from a `finally`, even when the body raises ─────────────────────


def test_the_outcome_is_emitted_from_a_finally_when_the_body_raises(statsd) -> None:
    """A job that raises before reporting is a job whose failure is invisible in
    exactly the dimension this module measures. The CONTRACT is that every
    caller reports from a `finally`; this drives that shape end to end."""
    selected = 0
    written = 0

    with pytest.raises(RuntimeError):
        try:
            selected = 12
            raise RuntimeError("sec.gov 403")
        finally:
            report_job_outcome(
                "edgar-parse-financials",
                selected=selected,
                written=written,
                transport_failures=1,
                skipped_reason="sec_identity_rejected",
            )

    assert statsd.value_of("stockbook.job.selected") == 12
    assert statsd.value_of("stockbook.job.written") == 0
    assert statsd.value_of("stockbook.job.transport_failures") == 1


# ── Latency histogram ───────────────────────────────────────────────────────


def test_latency_is_a_histogram_not_a_gauge(statsd) -> None:
    """The acceptance gate is a p95. A gauge reports only the LAST sample of a
    flush window, which on a minutely detect loop is one filing out of dozens,
    chosen at random."""
    record_latency(87.5, {"form": "4"})

    kind, name, value, tags = statsd.calls[-1]
    assert kind == "histogram"
    assert name == "stockbook.edgar.detect_latency_seconds"
    assert value == 87.5
    assert "form:4" in tags


def test_latency_survives_a_dead_socket() -> None:
    from app.store import outcome
    from tests.conftest import RecordingStatsd

    outcome.set_statsd_for_tests(RecordingStatsd(fail=True))
    record_latency(1.0)  # must not raise


# ── The transport seam (MONEY-1278) ─────────────────────────────────────────
#
# The five Cloud Run JOBS have no datadog-agent sidecar, and DogStatsD is
# fire-and-forget UDP: every counter was refused by a closed port and dropped in
# silence while ``[job-outcome] {...}`` kept logging perfectly. A metric that
# never arrives renders as NO DATA, not as an alert, so the job half of EDGAR
# could not be monitored in either direction. These cases pin the HTTP path that
# replaces it, and — just as importantly — that the SERVICE still uses DogStatsD.


@pytest.fixture
def http_sender(monkeypatch):
    """Record what the HTTP transport would POST, and select it."""
    from app.store import outcome

    monkeypatch.setenv("DD_METRICS_TRANSPORT", "http")
    sent: list[list[dict]] = []
    outcome.set_http_sender_for_tests(sent.append)
    yield sent
    outcome.set_http_sender_for_tests(None)


def test_http_transport_posts_the_four_counters_in_one_request(http_sender) -> None:
    report_job_outcome("edgar-bulk-ftd", selected=3, written=0, failed=1)

    assert len(http_sender) == 1, "one request per run, not one per counter"
    series = http_sender[0]
    assert [s["metric"] for s in series] == [
        "stockbook.job.selected",
        "stockbook.job.written",
        "stockbook.job.failed",
        "stockbook.job.transport_failures",
    ]
    # `count`, matching DogStatsD's `increment`, so a job and the service remain
    # summable in ONE query — a monitor must not have to know which emitted.
    assert {s["type"] for s in series} == {"count"}
    assert [s["points"][0][1] for s in series] == [3, 0, 1, 0]
    for s in series:
        assert "job:edgar-bulk-ftd" in s["tags"]
        assert any(t.startswith("env:") for t in s["tags"])
        assert any(t.startswith("service:") for t in s["tags"])


def test_http_transport_still_logs_the_outcome_line(http_sender, caplog) -> None:
    """The log line is the fallback record, and it does not move with the wire."""
    with caplog.at_level(logging.WARNING):
        report_job_outcome("edgar-bulk-submissions", selected=9, written=0)
    assert "[job-outcome]" in caplog.text
    assert "edgar-bulk-submissions" in caplog.text


def test_http_transport_never_raises(monkeypatch, caplog) -> None:
    from app.store import outcome

    monkeypatch.setenv("DD_METRICS_TRANSPORT", "http")

    def boom(_series):
        raise RuntimeError("intake refused the batch")

    outcome.set_http_sender_for_tests(boom)
    try:
        # Must not propagate: a metrics backend having a moment cannot be
        # allowed to fail the job that was reporting to it.
        with caplog.at_level(logging.ERROR):
            report_job_outcome("edgar-bulk-ftd", selected=1, written=1)
    finally:
        outcome.set_http_sender_for_tests(None)
    # ...but non-fatal is not the same as INVISIBLE. This is where a DNS
    # failure, a TLS error and a five-second timeout land, and `pass` made every
    # one of them byte-identical to a delivered batch (MONEY-1229).
    assert "series dropped" in caplog.text
    # The exception TYPE identifies the failure; the exception OBJECT carries
    # the credentialed request that httpx and google-auth hang off it.
    assert "RuntimeError" in caplog.text
    assert "Traceback" not in caplog.text


def test_http_transport_opens_no_socket_without_a_key(monkeypatch) -> None:
    """No key is a NO-OP, matching `datadog-metrics` on the TypeScript side.

    RECORDS the call rather than raising on it, and that is the whole design of
    this case. The first version raised ``AssertionError`` from the patched
    ``urlopen`` — which ``report_job_outcome`` catches, because ``AssertionError``
    is an ``Exception`` and reporting is deliberately allowed to swallow
    anything. It passed with the key guard REMOVED. A test whose failure mode is
    an exception cannot see through a catch-all; asserting on a recorded fact
    can.
    """
    import urllib.request

    from app.store import outcome

    monkeypatch.setenv("DD_METRICS_TRANSPORT", "http")
    monkeypatch.delenv("DD_API_KEY", raising=False)
    outcome.set_http_sender_for_tests(None)  # the REAL sender, not a stub

    opened: list[object] = []
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda *args, **kwargs: opened.append(args) or _NullResponse(),
    )

    report_job_outcome("edgar-bulk-ftd", selected=1, written=1)
    assert opened == [], "the transport reached the network with no API key"


class _NullResponse:
    """Context manager standing in for an ``HTTPResponse``.

    It carries a ``status``, defaulting to the 202 the v1 intake answers on
    success, because the transport now READS one — a stub without it would make
    every positive case look like a refused batch.
    """

    def __init__(self, status: int = 202) -> None:
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def test_http_transport_does_open_a_socket_when_a_key_is_present(monkeypatch) -> None:
    """The positive control for the case above.

    Without it, "no socket" would also pass if the HTTP path were dead for some
    unrelated reason — which is how the no-key assertion would go on reading as
    protection long after it had stopped being any.
    """
    import urllib.request

    from app.store import outcome

    monkeypatch.setenv("DD_METRICS_TRANSPORT", "http")
    monkeypatch.setenv("DD_API_KEY", "not-a-real-key")
    outcome.set_http_sender_for_tests(None)

    opened: list[object] = []
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda *args, **kwargs: opened.append(args[0]) or _NullResponse(),
    )

    report_job_outcome("edgar-bulk-ftd", selected=1, written=1)
    assert len(opened) == 1
    request = opened[0]
    assert request.full_url == "https://api.us5.datadoghq.com/api/v1/series"
    assert request.get_header("Dd-api-key") == "not-a-real-key"


def test_statsd_stays_the_default_when_the_flag_is_absent(monkeypatch, statsd) -> None:
    """Absent means the sidecar path — the state every env was in before this."""
    monkeypatch.delenv("DD_METRICS_TRANSPORT", raising=False)
    report_job_outcome("edgar-detect", selected=2, written=2)
    assert statsd.names() == [
        "stockbook.job.selected",
        "stockbook.job.written",
        "stockbook.job.failed",
        "stockbook.job.transport_failures",
    ]


def test_an_unrecognised_transport_value_falls_back_to_statsd(monkeypatch, statsd) -> None:
    """Compared to the LITERAL string. `bool("statsd")` is True, so a coercion
    would put the SERVICE on the HTTP path and have it bypass a healthy sidecar."""
    monkeypatch.setenv("DD_METRICS_TRANSPORT", "HTTP")  # wrong case, deliberately
    report_job_outcome("edgar-detect", selected=1, written=1)
    assert statsd.names(), "an unrecognised value must not silently disable statsd"


def test_the_two_transports_are_mutually_exclusive(http_sender, statsd) -> None:
    """One wire per run. Emitting both would double every count."""
    report_job_outcome("edgar-bulk-ftd", selected=5, written=5)
    assert len(http_sender) == 1
    assert statsd.calls == []


# ── The status DogStatsD never had — MONEY-1229 ─────────────────────────────
#
# The whole reason to leave fire-and-forget UDP is that HTTP answers. Throwing
# the answer away rebuilds MONEY-1278's defect one layer up: a rotated key, a
# site the key was not minted on and an unmounted secret all produced a printed
# `[job-outcome]` line, exit 0, and a monitor reading NO DATA.


def test_a_non_2xx_is_reported_rather_than_swallowed(monkeypatch, caplog) -> None:
    """The intake answered, and it refused. That has to reach a log."""
    import urllib.request

    from app.store import outcome

    monkeypatch.setenv("DD_METRICS_TRANSPORT", "http")
    monkeypatch.setenv("DD_API_KEY", "rotated-yesterday")
    outcome.set_http_sender_for_tests(None)  # the REAL sender, not a stub
    monkeypatch.setattr(urllib.request, "urlopen", lambda *_a, **_k: _NullResponse(403))

    with caplog.at_level(logging.ERROR):
        report_job_outcome("edgar-bulk-ftd", selected=1, written=1)

    assert "403" in caplog.text, "a refused batch must not read like a delivered one"
    assert "dropped" in caplog.text


def test_an_http_error_status_is_reported(monkeypatch, caplog) -> None:
    """`urlopen` RAISES on 4xx, so the status arrives as an EXCEPTION.

    A branch that only inspects the returned response never sees a 401, a 403 or
    a 400 — which are the three failures the transport exists to make visible.
    """
    import urllib.error
    import urllib.request

    from app.store import outcome

    monkeypatch.setenv("DD_METRICS_TRANSPORT", "http")
    monkeypatch.setenv("DD_API_KEY", "minted-on-the-other-site")
    outcome.set_http_sender_for_tests(None)

    def refuse(*_a, **_k):
        raise urllib.error.HTTPError(
            "https://api.example.invalid/api/v1/series", 403, "Forbidden", {}, None
        )

    monkeypatch.setattr(urllib.request, "urlopen", refuse)

    with caplog.at_level(logging.ERROR):
        report_job_outcome("edgar-bulk-ftd", selected=1, written=1)

    assert "403" in caplog.text


def test_a_missing_api_key_is_reported(monkeypatch, caplog) -> None:
    """A failed secret mount was as silent as a delivered batch.

    Still a NO-OP — the socket is not opened, which
    `test_http_transport_opens_no_socket_without_a_key` pins — but no longer an
    invisible one.
    """
    from app.store import outcome

    monkeypatch.setenv("DD_METRICS_TRANSPORT", "http")
    monkeypatch.delenv("DD_API_KEY", raising=False)
    outcome.set_http_sender_for_tests(None)

    with caplog.at_level(logging.ERROR):
        report_job_outcome("edgar-bulk-ftd", selected=1, written=1)

    assert "DD_API_KEY" in caplog.text
