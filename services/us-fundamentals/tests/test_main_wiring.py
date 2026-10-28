"""App wiring — MONEY-979.

Two properties that only an executed request can establish:

1. **The OIDC gate runs BEFORE the dedupe.** Asserted BEHAVIOURALLY — an
   unauthorised request must never reach the dedupe store — rather than by
   reading the registration list, because a comment about ordering cannot fail.
   Getting this backwards is a denial-of-job with no credentials required:
   anyone could burn the dedupe key for a legitimate message and have every real
   redelivery answered ``200 duplicate: true``.

2. **A route whose handler module does not exist yet answers 501, not 500.**
   The seven routes are provisioned by ``setup-pubsub.sh`` in this task; the
   handlers land with T6/T7/T9. A 500 in that window is indistinguishable from a
   crash, and a 404 makes Pub/Sub retry five times and dead-letter.
"""

from __future__ import annotations

import base64
import importlib
import json
import os
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def _load_app(**env: str):
    """Import ``app.main`` fresh under a given environment.

    Reimported rather than reused because the auth gate is composed AT IMPORT
    (deliberately — see `test_the_decision_is_frozen_at_construction`), so a
    scenario that changes APP_ENV must re-enter the module.
    """
    for key, value in env.items():
        os.environ[key] = value
    for name in ("app.main", "app.auth", "app.dedupe"):
        sys.modules.pop(name, None)
    return importlib.import_module("app.main")


@pytest.fixture
def prod_app() -> Iterator:
    module = _load_app(APP_ENV="production", CLOUD_RUN_URL="https://us-fundamentals-prod.run.app")
    yield module
    sys.modules.pop("app.main", None)


@pytest.fixture
def local_app() -> Iterator:
    module = _load_app(APP_ENV="development", ENABLE_PULL_SUBSCRIBER="true")
    yield module
    sys.modules.pop("app.main", None)


class _SpyStore:
    """Records every claim so "did the dedupe run?" is observable."""

    def __init__(self) -> None:
        self.claims: list[tuple[str, str]] = []
        self.releases: list[tuple[str, str]] = []

    def claim(self, message_id: str, route: str):
        from app.dedupe_logic import ClaimDecision

        self.claims.append((message_id, route))
        return ClaimDecision("RUN", "claimed", 1)

    def release(self, message_id: str, outcome: str) -> None:
        self.releases.append((message_id, outcome))


def envelope(payload: dict | None = None, message_id: str = "msg-1") -> dict:
    data = base64.b64encode(json.dumps(payload or {}).encode()).decode()
    return {"message": {"data": data, "messageId": message_id}, "subscription": "s"}


# ── 1. Middleware ORDER ─────────────────────────────────────────────────────


def test_an_unauthenticated_job_request_NEVER_reaches_the_dedupe_store(prod_app, monkeypatch):
    """The ordering assertion, made behaviourally.

    MUTATION this catches: swapping the two `@app.middleware("http")`
    registrations in main.py. Starlette runs them in REVERSE registration order,
    so a swap puts the dedupe FIRST — every assertion about 401s still passes
    (the gate still rejects), but `spy.claims` becomes non-empty and the dedupe
    key is burned by an anonymous caller.
    """
    spy = _SpyStore()
    monkeypatch.setattr(prod_app, "_build_store", lambda: spy)

    with TestClient(prod_app.app) as client:
        response = client.post("/jobs/edgar-detect", json=envelope())

    assert response.status_code == 401
    assert response.json() == {"error": "Unauthorized: missing token"}
    assert spy.claims == [], "the dedupe must not claim for an unauthenticated request"


def test_a_bad_token_is_401_and_still_never_claims(prod_app, monkeypatch):
    spy = _SpyStore()
    monkeypatch.setattr(prod_app, "_build_store", lambda: spy)

    with TestClient(prod_app.app) as client:
        response = client.post(
            "/jobs/edgar-parse-13f",
            json=envelope(),
            headers={"Authorization": "Bearer not-a-real-token"},
        )

    assert response.status_code == 401
    assert spy.claims == []


#: A module path that is guaranteed not to exist, used to drive the 501 branch.
ABSENT_HANDLER_MODULE = "app.jobs.__not_built_yet__"


def test_an_authenticated_request_DOES_reach_the_dedupe_store(local_app, monkeypatch):
    """The complement. Without it, a gate that rejected EVERYTHING would satisfy
    the two assertions above — a test that passes because nothing works.

    It needs a NON-2xx STATUS specifically, because the property under test is
    `dedupe.py`'s "a non-2xx response releases the claim as FAILED" — a different
    line, and a different code path, from the release on a raised exception. This
    used to get one for free by targeting `edgar-evict`, the last route whose
    handler module did not exist. T9 landed that handler, so the non-2xx is now
    produced by pointing ONE route's entry in `JOB_HANDLERS` at a module that
    genuinely is not on disk: the real `_load_handler`, the real 501 branch, the
    real auth gate and the real dedupe middleware all still run, and only the
    module NAME is injected. The assertion is unchanged.
    """
    spy = _SpyStore()
    monkeypatch.setattr(local_app, "_build_store", lambda: spy)
    monkeypatch.setitem(local_app.JOB_HANDLERS, "edgar-evict", ABSENT_HANDLER_MODULE)

    with TestClient(local_app.app) as client:
        response = client.post("/jobs/edgar-evict", json=envelope(message_id="msg-42"))

    assert response.status_code == 501, (
        "this test needs a NON-2xx response so the dedupe claim is released "
        "FAILED. It gets one by pointing edgar-evict's handler at a module that "
        "does not exist — do not relax the assertion; force a non-2xx instead."
    )
    assert spy.claims == [("msg-42", "/jobs/edgar-evict")]
    # 501 is NOT 2xx, so the claim is released FAILED and the message stays
    # retryable.
    assert spy.releases == [("msg-42", "FAILED")]


def test_health_is_not_behind_the_gate(prod_app):
    with TestClient(prod_app.app) as client:
        response = client.get("/health")
    assert response.status_code == 200


# ── 2. Missing handler -> 501 ───────────────────────────────────────────────


ALL_ROUTES = (
    "edgar-detect",
    "edgar-parse-ownership",
    "edgar-parse-13f",
    "edgar-parse-13dg",
    "edgar-parse-8k",
    "edgar-parse-financials",
    "edgar-evict",
)


@pytest.mark.parametrize("route", ALL_ROUTES)
def test_every_topic_has_a_registered_route(local_app, route: str):
    """The route path MUST equal the topic base name.

    `setup-pubsub.sh` builds the endpoint as `${SERVICE_URL}/jobs/${BASE_TOPIC}`,
    so a route named anything else answers 404 to every delivery — which Pub/Sub
    retries five times and then dead-letters, silently.
    """
    paths = {r.path for r in local_app.app.routes}
    assert f"/jobs/{route}" in paths


# Routes whose handler module does not exist YET.
#
# This list started as "all of them" and shrank as handlers landed — six entries
# once T6 landed `detect` and T7 landed the five parsers, then the last one when
# T9 landed `evict`. **It is now EMPTY, and that is the finished state**: every
# topic in `setup-pubsub.sh` has a handler on disk.
#
# It is kept rather than deleted because it is checked from BOTH sides: an entry
# here that HAS a handler fails, and a route absent from here that has NO handler
# fails too (`test_the_two_route_lists_agree_with_what_is_on_disk`). A new topic
# added to `setup-pubsub.sh` and `JOB_ROUTES` before its handler exists goes in
# here, and the 501 assertion below comes back with it.
UNIMPLEMENTED_ROUTES: tuple[str, ...] = ()

IMPLEMENTED_ROUTES = tuple(r for r in ALL_ROUTES if r not in UNIMPLEMENTED_ROUTES)


def test_a_missing_handler_answers_501_with_the_module_name(local_app, monkeypatch):
    """The 501 branch itself, which outlives the list above.

    With `UNIMPLEMENTED_ROUTES` empty there is no route on disk that can produce
    this response, so the missing module is injected by NAME. Everything else is
    real — `_load_handler` does the import, fails to find it, and `_run_job`
    builds the body. Deleting the 501 branch turns this red.

    501 and not 500 (indistinguishable from a crash) and not 404 (which Pub/Sub
    retries five times and then dead-letters, silently).
    """
    monkeypatch.setitem(local_app.JOB_HANDLERS, "edgar-evict", ABSENT_HANDLER_MODULE)

    with TestClient(local_app.app) as client:
        response = client.post("/jobs/edgar-evict", json={"mode": "direct"})

    assert response.status_code == 501, "must not be 500 (reads as a crash) or 404 (dead-letters)"
    body = response.json()
    assert body["error"] == "Not implemented"
    assert body["job"] == "edgar-evict"
    assert body["handler"] == ABSENT_HANDLER_MODULE


@pytest.mark.parametrize("route", IMPLEMENTED_ROUTES)
def test_an_implemented_handler_is_REACHED_and_never_answers_501(local_app, route: str):
    """The other side of the list, and the reason it cannot rot.

    Without this, deleting `app/jobs/parse_13f.py` would turn its route into a
    501 — "not implemented yet" — and the only failing test would be one
    asserting 501 for a route that now legitimately answers it. The suite would
    go GREEN on a deleted parser.

    The assertion is deliberately about REACHABILITY, not about the outcome: a
    handler invoked with a nonsense payload and no database may answer 200 (the
    apply flags ship off, so a disarmed skip is a normal result) or 500. What it
    must never do is 501 (the module did not resolve) or 404 (no route, which
    Pub/Sub retries five times and then dead-letters, silently).
    """
    with TestClient(local_app.app) as client:
        response = client.post(f"/jobs/{route}", json={"mode": "direct"})

    from app.main import JOB_HANDLERS

    assert response.status_code != 501, (
        f"/jobs/{route} answered 501 — its handler module is missing. Either "
        f"restore {JOB_HANDLERS[route]}, or add the route to "
        f"UNIMPLEMENTED_ROUTES if it is genuinely not built yet."
    )
    assert response.status_code != 404, (
        "no route registered — Pub/Sub would dead-letter every delivery"
    )


def test_the_two_route_lists_agree_with_what_is_on_disk():
    """UNIMPLEMENTED_ROUTES must name exactly the modules that do not exist.

    Checked against the filesystem rather than against imports: a handler whose
    own `import edgar` is broken still EXISTS, and must not be silently
    reclassified as unimplemented (there is a separate test for exactly that
    confusion below).
    """
    # The route -> module mapping is READ from main.py's own table, not
    # restated. Restating it is how this check first went wrong: `edgar-detect`
    # maps to `app.jobs.detect`, not `app.jobs.edgar_detect`, so a naive
    # `route.replace("-", "_")` reported every handler as missing.
    from app.main import JOB_HANDLERS

    jobs_dir = Path(__file__).resolve().parent.parent / "app" / "jobs"
    on_disk = {p.stem for p in jobs_dir.glob("*.py") if p.stem != "__init__"}

    missing = [
        route for route in ALL_ROUTES if JOB_HANDLERS[route].rsplit(".", 1)[-1] not in on_disk
    ]
    assert sorted(missing) == sorted(UNIMPLEMENTED_ROUTES), (
        f"UNIMPLEMENTED_ROUTES says {sorted(UNIMPLEMENTED_ROUTES)} but the "
        f"modules actually absent from app/jobs/ are {sorted(missing)}. "
        f"Update the list in the same change that adds or removes a handler."
    )


def test_a_handler_that_EXISTS_but_fails_to_import_is_not_reported_as_unimplemented(
    local_app, monkeypatch
):
    """The narrow-catch guard.

    `_load_handler` catches ModuleNotFoundError only when it names the module we
    asked for. A broad catch would turn a deploy-time regression — a handler
    whose own `import edgar` is broken — into a 501 that reads like planned work.
    """
    import importlib as _importlib

    def explode(name: str):
        raise ModuleNotFoundError("No module named 'edgar'", name="edgar")

    monkeypatch.setattr(_importlib, "import_module", explode)

    with pytest.raises(ModuleNotFoundError):
        local_app._load_handler("edgar-detect")


def test_a_present_handler_is_invoked(local_app, monkeypatch):
    """Proves the 501 branch is a real branch and not the only path.

    Without this, deleting the handler-dispatch code entirely would leave every
    501 assertion above green.
    """
    import types

    module = types.ModuleType("app.jobs.detect")
    seen: list[dict] = []

    def handle(payload: dict) -> dict:
        seen.append(payload)
        return {"success": True, "selected": 3}

    module.handle = handle  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "app.jobs.detect", module)

    with TestClient(local_app.app) as client:
        response = client.post("/jobs/edgar-detect", json=envelope({"mode": "efts"}))

    assert response.status_code == 200
    assert response.json() == {"success": True, "selected": 3}
    assert seen == [{"mode": "efts"}], "the DECODED payload, not the envelope"


# ── /health ─────────────────────────────────────────────────────────────────


def test_health_distinguishes_an_absent_flag_from_an_explicit_off(local_app):
    """ "Nobody set EDGAR_DETECT" and "EDGAR_DETECT is deliberately off" are
    different incidents. A boolean makes them the same one, which is how
    MF_METADATA_PROVIDER disabled a job for months (MONEY-1214)."""
    with TestClient(local_app.app) as client:
        absent = client.get("/health").json()
        os.environ["EDGAR_DETECT"] = "off"
        explicit = client.get("/health").json()

    assert absent["flags"]["EDGAR_DETECT"] == "absent"
    assert explicit["flags"]["EDGAR_DETECT"] == "off"
    # Both resolve to the same BEHAVIOUR, and that is the point: the states are
    # equally safe and differently diagnosable.
    assert absent["resolvedFlags"]["detectEnabled"] is False
    assert explicit["resolvedFlags"]["detectEnabled"] is False


def test_health_reports_mongo_redis_and_the_pinned_parser(local_app):
    with TestClient(local_app.app) as client:
        body = client.get("/health").json()

    assert body["mongo"]["detail"] == "not_configured"
    assert body["redis"] == {"configured": False, "ok": False, "detail": "not_configured"}
    assert body["edgartools"] == "5.53.0"
    assert body["secEgress"] == "off", "an env that has not said it may reach the SEC does not"


def test_health_reports_the_INSTALLED_limiter_not_the_configured_intent(local_app):
    """`mode` must be derived from `installed_limiter()`, never from REDIS_URL.

    This field used to answer `"redis-shared" if settings.redis_url() else
    "unconfigured"`, which is a statement about a variable being SET. Nothing in
    `app/` called `install_shared_limiter()`, so the one service that could not
    make a single SEC request reported a healthy limiter — and T16's preflight
    assertion ("limiter is redis, not in-memory, not unavailable") could not
    fail on it.

    With no REDIS_URL the honest answer is `unconfigured` AND `installed:
    False`, with the reason attached. `unconfigured` and `unavailable` stay
    distinct because "nobody set the variable" and "Redis refused us" have
    different fixes.
    """
    with TestClient(local_app.app) as client:
        limiter = client.get("/health").json()["limiter"]

    assert limiter["installed"] is False
    assert limiter["configured"] is False
    assert limiter["mode"] == "unconfigured"
    assert limiter["edgartoolsInjected"] is False
    assert limiter["perSec"] == 9
    # The reason travels with the verdict; a bare False is a fact an operator
    # then has to go and explain from the logs of a container that may be gone.
    assert "REDIS_URL" in limiter["detail"]


def test_startup_installs_the_shared_limiter_from_live_settings(local_app, monkeypatch):
    """The LIFESPAN must call the real installer with the real settings values.

    Asserted at the CALL SITE, because the call site is where this silently
    degrades: `install_shared_limiter` was fully built, fully tested and had
    ZERO callers under `app/`, so every unit test of the limiter stayed green
    while the deployed service could not issue a single SEC request. A test of
    the function alone could never have found that.

    What makes the failure so quiet is downstream: `LimiterUnavailable` is a
    `SecError`, and `run_parse_job` classifies a non-transport `SecError` as a
    deterministic upstream refusal — ACK, count a transport failure, drop the
    message. `edgar-detect` would report a tidy `selected 1, written 0` every
    minute and read as a quiet SEC.
    """
    calls: list[tuple[str | None, int]] = []

    def _record(redis_url, per_sec, *args, **kwargs):
        calls.append((redis_url, per_sec))
        return object()

    monkeypatch.setattr("app.sec.limiter.install_shared_limiter", _record)
    monkeypatch.setenv("REDIS_URL", "rediss://example.invalid:6379")
    monkeypatch.setenv("SEC_RATE_LIMIT_PER_SEC", "7")

    with TestClient(local_app.app):
        pass

    assert calls == [("rediss://example.invalid:6379", 7)], (
        "the lifespan did not install the limiter from settings.redis_url() / "
        "settings.sec_rate_limit_per_sec()"
    )


def test_a_failed_install_does_not_abort_the_boot(local_app, monkeypatch):
    """A container that starts and says what is wrong beats one that never starts.

    The limiter fails CLOSED at acquire, so a Redis outage means zero SEC
    traffic whether or not the container boots — refusing to start buys no
    safety and costs the diagnosis, because the logs belong to a container that
    no longer exists. `/health` must still answer, and must say `unavailable`
    rather than `unconfigured`: REDIS_URL WAS set, so "nobody configured it" is
    the wrong incident.
    """
    monkeypatch.setenv("REDIS_URL", "rediss://example.invalid:6379")

    def _boom(*_args, **_kwargs):
        raise RuntimeError("BOOM")

    monkeypatch.setattr("app.sec.limiter.install_shared_limiter", _boom)

    with TestClient(local_app.app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    limiter = response.json()["limiter"]
    assert limiter["mode"] == "unavailable"
    assert limiter["installed"] is False
    assert limiter["configured"] is True
    assert "RuntimeError" in limiter["detail"]


def test_health_reports_redis_shared_only_when_a_limiter_is_actually_installed(
    local_app, monkeypatch
):
    """The positive mapping, driven through the real `_limiter_state()`.

    The install path itself needs a REAL Redis (`RedisBucket` runs a Lua script
    server-side, which is why `tests/test_limiter_load.py` is marked `redis`).
    What is ours to check here is the REPORT: given an installed limiter, the
    field must say so — and must stop saying so when there is none.
    """
    monkeypatch.setenv("REDIS_URL", "rediss://example.invalid:6379")
    monkeypatch.setattr("app.sec.limiter.installed_limiter", lambda: object())
    monkeypatch.setattr("app.sec.limiter.edgartools_injected", lambda: True)

    state = local_app._limiter_state()

    assert state["mode"] == "redis-shared"
    assert state["installed"] is True
    assert state["edgartoolsInjected"] is True


# ── The events transport, on /health (MONEY-1520) ───────────────────────────


def test_health_reports_the_events_TOPIC_not_just_that_events_exist(prod_app, monkeypatch):
    """MONEY-1520 — the wiring that failed for hours with nothing watching it.

    `/health` reported the three arming flags and `SEC_EGRESS` while the one
    piece of cross-service wiring the detector depends on was invisible from
    outside. It answered 404 on every emission — the workers are
    `ingress: internal` and this service has no VPC egress — and nothing on this
    endpoint would have shown an operator where the events were going.

    The RESOLVED topic, not the base name — and resolved through the SAME
    function the publisher uses. The base is a constant and cannot drift; the
    `-{env}` suffix is decided by `app.publish.resolve_pubsub_env`, which reads
    PUBSUB_ENV and falls back on NODE_ENV and **ignores APP_ENV entirely**
    (deliberately: it mirrors the TypeScript `getPubSubEnv()` that created the
    topics). So a spec setting APP_ENV=production and forgetting PUBSUB_ENV
    publishes into the QA topic — a real message on a real topic in the wrong
    environment, which reads downstream as a quiet market. That asymmetry is
    exactly why this field is worth reporting, and it is asserted below in both
    directions rather than assumed away.
    """
    monkeypatch.setenv("PUBSUB_ENV", "prod")
    with TestClient(prod_app.app) as client:
        body = client.get("/health").json()

    events = body["events"]
    assert events["transport"] == "pubsub"
    assert events["topic"] == "us-filing-events-prod", (
        "the health report must name the topic this process would actually "
        f"publish to; got {events['topic']!r}"
    )
    assert events["projectConfigured"] in (True, False)

    # The trap, made visible. APP_ENV is still "production" (the fixture set
    # it) and the resolved topic is the QA one.
    monkeypatch.delenv("PUBSUB_ENV", raising=False)
    monkeypatch.delenv("NODE_ENV", raising=False)
    with TestClient(prod_app.app) as client:
        body = client.get("/health").json()
    assert body["env"] == "production"
    assert body["events"]["topic"] == "us-filing-events-qa", (
        "the topic suffix must follow the PUBLISHER's resolver, not APP_ENV — "
        "reporting the app env here would hide the one misconfiguration this "
        "field exists to reveal"
    )


def test_health_reports_a_MISSING_project_as_a_distinct_state(prod_app, monkeypatch):
    """`Publisher` resolves GCP_PROJECT_ID LAZILY, on the first publish, so an
    unset one is not a boot failure — it is a `PublishError` per run inside a
    fail-soft caller. A boolean on `/health` is the only place that state is
    legible before the first filing is claimed.
    """
    monkeypatch.delenv("GCP_PROJECT_ID", raising=False)
    with TestClient(prod_app.app) as client:
        assert client.get("/health").json()["events"]["projectConfigured"] is False

    monkeypatch.setenv("GCP_PROJECT_ID", "stock-book-483718")
    with TestClient(prod_app.app) as client:
        assert client.get("/health").json()["events"]["projectConfigured"] is True
