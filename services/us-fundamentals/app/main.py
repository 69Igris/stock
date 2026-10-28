"""FastAPI entry point for the us-fundamentals service — MONEY-979.

Redaction is installed as the FIRST statement, before any other import can log.

APM is NOT started here. The Dockerfile CMD is ``ddtrace-run uvicorn …``, whose
bootstrap patches every library BEFORE the interpreter imports this module — so
``install_logging()`` keeps its place as the first statement of application
code, and no import in this file has to sit in a particular order relative to a
tracer. An ``import ddtrace.auto`` here would have had to land AFTER
``install_logging()`` (or ddtrace's own startup warnings log unredacted) and
BEFORE the first framework import (or ``app = FastAPI(...)`` below is built from
an unpatched class and the app is silently untraced) — a two-sided constraint
enforced only by a comment, silent in both directions.
"""

from __future__ import annotations

from app.logging_setup import install_logging

install_logging()

import logging  # noqa: E402
from collections.abc import AsyncIterator  # noqa: E402
from contextlib import asynccontextmanager  # noqa: E402
from typing import Any  # noqa: E402

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

from app import settings  # noqa: E402
from app.auth import build_jobs_auth  # noqa: E402
from app.dedupe import (  # noqa: E402
    DedupeStore,
    create_dedupe_middleware,
    get_dedupe_collection,
)
from app.envelope import parse_pubsub_message  # noqa: E402
from app.events import EVENTS_TOPIC  # noqa: E402
from app.logging_setup import log_error, redact  # noqa: E402
from app import publish  # noqa: E402

_logger = logging.getLogger("us-fundamentals")

#: Why the last :func:`install_shared_limiter` did not take, or ``None``.
#: Reported by ``/health`` so "nobody set REDIS_URL" and "Redis refused the TLS
#: handshake" are two different answers rather than one silence.
_limiter_install_error: str | None = None


def _install_sec_limiter() -> None:
    """Install the fleet-wide SEC rate limiter into THIS process.

    ## Nothing called this before, and the symptom was a quiet upstream

    edgartools' own limiter is a per-PROCESS ``InMemoryBucket``, so the service
    replaces it with a Redis-backed one that every instance and every job
    shares. Until this call existed, ``_installed`` was ``None`` in every
    deployed process and the FIRST ``try_acquire`` raised ``LimiterUnavailable``.

    That is worse than a crash. ``LimiterUnavailable`` is a ``SecError``, and
    ``run_parse_job`` classifies a non-transport ``SecError`` as a DETERMINISTIC
    upstream refusal — ACK the message, count a transport failure, drop it.
    Right for a real refusal; exactly wrong for a broken process. ``edgar-detect``
    would die on its first ``getcurrent`` every minute, and every parse whose
    bundle was not already archived would ACK having written nothing, reporting
    a tidy ``selected 1, written 0`` that reads as a quiet SEC.

    ## A failure here does NOT abort the boot, deliberately

    The limiter fails CLOSED at acquire, so a Redis outage means zero SEC
    traffic whether the container starts or not — refusing to boot buys no
    safety. What it costs is legibility: a revision that never starts leaves its
    diagnosis in the logs of a container that no longer exists, while a started
    container answers ``/health`` with the reason. T16's preflight reads exactly
    that field.

    A failed install is NOT retried. It does not need to be: an instance whose
    install failed behaves identically to one whose Redis died afterwards —
    ``try_acquire`` raises ``LimiterUnavailable`` either way — so no new failure
    mode is introduced, and Cloud Run replaces instances on its own. Retrying
    per request would instead pay a 5s connect timeout on every message for the
    duration of an outage.
    """
    global _limiter_install_error

    from app.sec.limiter import install_shared_limiter

    try:
        install_shared_limiter(settings.redis_url(), settings.sec_rate_limit_per_sec())
        _limiter_install_error = None
        _logger.info("shared SEC limiter installed at startup")
    except Exception as err:  # every failure means the same thing: no SEC traffic
        # `redact()` rather than the raw text. `LimiterUnavailable` messages are
        # built from a fixed safe vocabulary today (see `limiter.describe`), and
        # running them through the transport's own rule keeps that true if a
        # future driver message ever reaches here.
        _limiter_install_error = redact(f"{type(err).__name__}: {err}")
        log_error("shared SEC limiter NOT installed; this process cannot call SEC", err)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Process-wide startup. Covers EVERY push handler — they share this process.

    The four Cloud Run JOBS are separate processes with their own entry points
    and install the limiter themselves; a lifespan here reaches none of them.
    """
    _install_sec_limiter()
    yield


app = FastAPI(title="us-fundamentals", docs_url=None, redoc_url=None, lifespan=lifespan)

#: The seven Pub/Sub topics whose push subscriptions POST here.
#:
#: The route path MUST equal the topic base name: ``setup-pubsub.sh`` builds the
#: endpoint as ``${SERVICE_URL}/jobs/${BASE_TOPIC}``, so a route named anything
#: else answers 404 to every delivery — which Pub/Sub retries five times and then
#: dead-letters, silently.
JOB_ROUTES: tuple[str, ...] = (
    "edgar-detect",
    "edgar-parse-ownership",
    "edgar-parse-13f",
    "edgar-parse-13dg",
    "edgar-parse-8k",
    "edgar-parse-financials",
    "edgar-evict",
)

#: ``/jobs/<name>`` -> the module that implements it. The modules are OTHER
#: tasks' work (T6 detect, T7 parsers, T9 evict); each is imported LAZILY inside
#: the request so this service boots, answers ``/health`` and passes its wiring
#: tests before any of them exists.
JOB_HANDLERS: dict[str, str] = {
    "edgar-detect": "app.jobs.detect",
    "edgar-parse-ownership": "app.jobs.parse_ownership",
    "edgar-parse-13f": "app.jobs.parse_13f",
    "edgar-parse-13dg": "app.jobs.parse_13dg",
    "edgar-parse-8k": "app.jobs.parse_8k",
    "edgar-parse-financials": "app.jobs.parse_financials",
    "edgar-evict": "app.jobs.evict",
}

_jobs_auth = build_jobs_auth()


def _build_store() -> DedupeStore | None:
    collection = get_dedupe_collection()
    return None if collection is None else DedupeStore(collection)


# Resolved through the module globals ON EVERY REQUEST rather than captured
# here. Two reasons, and the first is behavioural: `get_dedupe_collection()`
# returns None while Mongo is unreachable, and a captured factory would pin that
# "no store" answer for the life of the process — the service would keep running
# untracked long after the cluster came back, with nothing saying so. The second
# is that a captured reference is not a seam, so nothing could drive the real
# composition against an observable store.
_dedupe = create_dedupe_middleware(lambda: _build_store(), log=_logger.info)


# ── Middleware ──────────────────────────────────────────────────────────────
#
# ORDER IS LOAD-BEARING and it is the reverse of how it reads.
#
# Starlette runs `@app.middleware("http")` handlers in REVERSE registration
# order — the LAST registered runs FIRST. The dedupe is registered first and the
# auth gate second, so the AUTH GATE RUNS FIRST.
#
# That direction is the requirement, not an accident of framework mechanics:
# claiming a messageId for an UNAUTHENTICATED request would let anyone burn the
# dedupe key for a legitimate message and have every real redelivery answered
# 200 `duplicate: true`. A denial-of-job with no credentials required.
#
# `tests/test_main_wiring.py` asserts the ORDER BEHAVIOURALLY — an unauthorised
# request must never reach the dedupe store — rather than by reading this list,
# because a comment about ordering cannot fail.


@app.middleware("http")
async def dedupe_middleware(request: Request, call_next):
    if not request.url.path.startswith("/jobs/"):
        return await call_next(request)

    try:
        body = await request.json()
    except Exception:
        return await call_next(request)

    async def run() -> tuple[Any, int]:
        response = await call_next(request)
        # The dedupe only needs the STATUS to decide COMPLETED vs FAILED; the
        # body is passed straight back untouched so no response is buffered.
        return response, response.status_code

    result, status = await _dedupe(request.url.path, body, run)
    if isinstance(result, dict):
        return JSONResponse(result, status_code=status)
    return result


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if not request.url.path.startswith("/jobs/"):
        return await call_next(request)

    async def run():
        return await call_next(request)

    return await _jobs_auth(request.headers.get("Authorization"), run)


# ── Routes ──────────────────────────────────────────────────────────────────


def _edgartools_version() -> str:
    """Version of the pinned parser, or why it could not be determined.

    Imported lazily and tolerantly: T4 owns ``import edgar`` (the tree has
    exactly one, pinned by a grep test), and ``/health`` must answer even in a
    container where the optional import failed — an unhealthy service that
    cannot say why is worse than one that reports the reason.
    """
    try:
        import importlib.metadata

        return importlib.metadata.version("edgartools")
    except Exception as err:
        return f"unavailable:{type(err).__name__}"


def _redis_ping() -> dict[str, Any]:
    """Redis reachability. ``configured`` and ``ok`` are SEPARATE facts.

    A service with no ``REDIS_URL`` and a service whose Redis is down are two
    different incidents and must not report the same word.
    """
    url = settings.redis_url()
    if not url:
        return {"configured": False, "ok": False, "detail": "not_configured"}
    try:
        import redis as redis_lib

        client = redis_lib.Redis.from_url(url, socket_connect_timeout=2, socket_timeout=2)
        client.ping()
        return {"configured": True, "ok": True, "detail": "ok"}
    except Exception as err:
        return {"configured": True, "ok": False, "detail": type(err).__name__}


def _limiter_state() -> dict[str, Any]:
    """What this process's limiter ACTUALLY is, not what the environment intends.

    The previous version answered ``"redis-shared" if settings.redis_url() else
    "unconfigured"`` — derived from a variable being SET. That is true in
    precisely the state where nothing ever installed a limiter, so the field
    read healthy on the one service that could not make a single SEC request,
    and T16's preflight assertion ("limiter is redis, not in-memory, not
    unavailable") could not fail on it. A field that cannot be wrong when the
    system is broken is worse than no field.

    Three modes, because three different things go wrong and they have three
    different fixes:

    ``redis-shared``  installed, and the limiter adopted a real ``RedisBucket``
    ``unconfigured``  ``REDIS_URL`` is absent — nothing could have been installed
    ``unavailable``   ``REDIS_URL`` is set and the install did not take

    ``redis.ok`` in the same payload stays the separate WIRE fact. "We can reach
    Redis" and "this process will actually pace itself" are different claims,
    and only the second one is what SEC's 10 req/s ceiling depends on.
    """
    from app.sec.limiter import edgartools_injected, installed_limiter

    limiter = installed_limiter()
    configured = settings.redis_url() is not None
    if limiter is not None:
        mode = "redis-shared"
    elif configured:
        mode = "unavailable"
    else:
        mode = "unconfigured"

    state: dict[str, Any] = {
        "mode": mode,
        "installed": limiter is not None,
        "configured": configured,
        # False in a deployed process means edgartools is STILL pacing itself on
        # its own in-process bucket — the fleet would then issue 9 req/s per
        # instance instead of 9 in total, which SEC answers with a 10-minute
        # block and no Retry-After to steer by.
        "edgartoolsInjected": edgartools_injected(),
        "perSec": settings.sec_rate_limit_per_sec(),
    }
    if _limiter_install_error:
        state["detail"] = _limiter_install_error
    return state


@app.get("/health")
async def health() -> JSONResponse:
    """Liveness + the resolved configuration an operator needs to debug a silence.

    Deliberately reports FLAG STATE as ``absent`` / ``empty`` / the literal
    value rather than as booleans. "Nobody set EDGAR_DETECT" and "EDGAR_DETECT
    is deliberately off" are different incidents; a boolean makes them the same
    one, which is how ``MF_METADATA_PROVIDER`` disabled a job for months.

    Always 200. A Cloud Run startup probe that fails because Mongo is briefly
    unreachable would take the whole revision down; the FIELDS carry the
    diagnosis and a monitor reads them.
    """
    from app.db import ping as mongo_ping

    mongo_ok, mongo_detail = mongo_ping()
    return JSONResponse(
        {
            "status": "ok",
            "service": "us-fundamentals",
            "env": settings.app_env(),
            "pubsubEnv": settings.pubsub_env(),
            "version": settings.dd_version(),
            "mongo": {"ok": mongo_ok, "detail": mongo_detail},
            "redis": _redis_ping(),
            "edgartools": _edgartools_version(),
            "limiter": _limiter_state(),
            "secEgress": settings.sec_egress(),
            "identityConfigured": settings.edgar_identity() is not None,
            "flags": {
                "EDGAR_DETECT": settings.flag_state("EDGAR_DETECT"),
                "EDGAR_PARSE_APPLY": settings.flag_state("EDGAR_PARSE_APPLY"),
                "EDGAR_EVICT_APPLY": settings.flag_state("EDGAR_EVICT_APPLY"),
                "SEC_EGRESS": settings.flag_state("SEC_EGRESS"),
            },
            "resolvedFlags": {
                "detectEnabled": settings.detect_enabled(),
                "parseApply": settings.parse_apply(),
                "evictApply": settings.evict_apply(),
            },
            # MONEY-1520 — THE EVENTS WIRING, REPORTED.
            #
            # The previous transport (an OIDC-signed POST to the workers)
            # answered 404 on every call for as long as it existed, and this
            # endpoint said nothing about it: it reported the three arming flags
            # and `SEC_EGRESS` while the one piece of cross-service wiring the
            # detector depends on was invisible from outside.
            #
            # `topic` is RESOLVED, not the base name. The base is a constant,
            # but the suffix comes from `PUBSUB_ENV` / `NODE_ENV` through the
            # same resolver the publisher uses — so a spec that ships the wrong
            # env publishes into a topic that exists in the OTHER environment,
            # or into one that does not exist at all, and `/health` is where
            # that is legible.
            #
            # `projectConfigured` because `Publisher` resolves GCP_PROJECT_ID
            # LAZILY, on first publish: without it every publish raises
            # PublishError inside a fail-soft caller, which is a silence.
            "events": {
                "transport": "pubsub",
                "topic": publish.topic_name(EVENTS_TOPIC),
                "projectConfigured": bool(settings.gcp_project_id()),
            },
        },
        status_code=200,
    )


def _load_handler(name: str):
    """Import the job module for ``name``, or ``None`` if it does not exist yet.

    ``ImportError`` is caught NARROWLY, and only when it names the module we
    asked for. A handler that exists but whose own import is broken must NOT be
    reported as "not implemented" — that would turn a deploy-time regression
    into a 501 that reads like planned work.
    """
    module_path = JOB_HANDLERS[name]
    try:
        import importlib

        return importlib.import_module(module_path)
    except ModuleNotFoundError as err:
        if err.name == module_path or (err.name and module_path.startswith(f"{err.name}.")):
            return None
        raise


async def _run_job(name: str, request: Request) -> JSONResponse:
    module = _load_handler(name)
    if module is None:
        # 501, NOT 500 and NOT 404.
        #   404 makes Pub/Sub retry five times and dead-letter, which reads as a
        #       broken subscription rather than as unbuilt work.
        #   500 is indistinguishable from a crash.
        # 501 with the module name says exactly what is missing and to whom.
        return JSONResponse(
            {
                "error": "Not implemented",
                "job": name,
                "handler": JOB_HANDLERS[name],
                "detail": (
                    f"{JOB_HANDLERS[name]} does not exist yet. The route, the topic and the "
                    "push subscription are provisioned; the handler lands with its own task."
                ),
            },
            status_code=501,
        )

    try:
        raw = await request.json()
    except Exception:
        raw = {}
    payload = parse_pubsub_message(raw)

    result = module.handle(payload)
    if hasattr(result, "__await__"):
        result = await result
    return JSONResponse(result if isinstance(result, dict) else {"success": True}, status_code=200)


def _register_job_routes() -> None:
    """One POST route per topic, registered from :data:`JOB_ROUTES`.

    Generated from the list rather than written seven times so a topic added to
    ``setup-pubsub.sh`` and not here fails ONE test instead of answering 404 to
    a live subscription.
    """
    for name in JOB_ROUTES:

        def make(job_name: str):
            async def endpoint(request: Request) -> JSONResponse:
                return await _run_job(job_name, request)

            return endpoint

        app.post(f"/jobs/{name}", name=f"jobs_{name.replace('-', '_')}")(make(name))


_register_job_routes()
