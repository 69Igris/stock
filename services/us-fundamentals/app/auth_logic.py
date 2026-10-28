"""The OIDC skip decision for ``/jobs/*`` — PURE logic. Port of
``workers/src/index-auth-logic.ts``.

This is the single most security-sensitive branch in the service: it decides
whether an unauthenticated POST can trigger any job processor with an arbitrary
payload.

MONEY-288 (security audit, TypeScript side) found verification gated behind
``NODE_ENV === "production"``, so QA Cloud Run accepted unauthenticated POSTs to
every ``/jobs/*`` route. The fix made it always-on for any deployed environment,
with ONE explicit opt-out for genuine local development — where Pub/Sub cannot
reach localhost and jobs arrive via a pull subscriber, so there is no HTTP auth
context to check.

## Why the decision is INVERTED (deny by default)

The original form asked "is this one of production|qa?" and, if not, allowed the
pull-subscriber opt-out. That is an ALLOW-LIST of deployed environments, so any
service whose env is neither — unset, ``"staging"``, a typo, or a Cloud Build
substitution that did not expand — plus ``ENABLE_PULL_SUBSCRIBER=true`` would
skip OIDC on every route. Both conditions here are POSITIVE requirements
instead: the environment must be a KNOWN local one AND the pull subscriber must
be explicitly enabled. Anything else requires a token.

## Why the middleware is a FACTORY

Extracting the decision function alone leaves the CALL SITE untested, and the
call site is where the gate silently degrades. On the TypeScript side two
mutations left the whole suite green:

  1. appending ``or enable_pull_subscriber == "true"`` at the call site —
     :func:`should_skip_http_oidc` is untouched, so its unit tests still pass,
     including the one named "cannot be disabled on a deployed env";
  2. changing ``if not skip`` to ``if False``, which disables OIDC on every
     route while every string a source-scanning test greps for is still present.

A source scan cannot close that. Only EXECUTING the real middleware can, so the
composition lives in :func:`create_jobs_auth_middleware` where the behavioural
tests drive it.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Protocol

#: Environments that are deployed and therefore ALWAYS require a token.
#:
#: Kept for documentation and for the test that pins QA's membership; the
#: DECISION is driven by :data:`LOCAL_ENVS` below, because an allow-list of
#: deployed envs fails OPEN on anything it does not recognise.
DEPLOYED_ENVS: tuple[str, ...] = ("production", "qa")

#: The ONLY environments in which HTTP OIDC may be skipped, and only then with
#: the pull subscriber explicitly enabled.
#:
#: An empty/unset environment is deliberately NOT here: "I do not know what this
#: is" must never authorise skipping auth on a route family that can trigger
#: every job processor with an arbitrary payload.
LOCAL_ENVS: tuple[str, ...] = ("development", "test", "local")


def should_skip_http_oidc(app_env: str | None, enable_pull_subscriber: str | None) -> bool:
    """True only in genuine local development with the pull subscriber active.

    Both conditions are required, and the local check comes FIRST: an operator
    setting ``ENABLE_PULL_SUBSCRIBER=true`` on a QA or prod service must not be
    able to turn HTTP auth off.
    """
    is_known_local = (app_env or "").strip().lower() in LOCAL_ENVS
    if not is_known_local:
        return False
    return enable_pull_subscriber == "true"


# ── The middleware itself ───────────────────────────────────────────────────


class AuthResponder(Protocol):
    """Minimal shape of the response factory the gate needs.

    Declared structurally rather than importing Starlette's ``JSONResponse`` so
    the gate can be driven by a plain callable in a test — no server, no
    sockets, no route table. :mod:`app.auth` supplies the real one.
    """

    def __call__(self, body: dict[str, Any], status: int) -> Any: ...


#: ``verify_id_token(token=..., audience=...)``. Raises on anything invalid.
VerifyIdToken = Callable[..., Any]

#: The downstream handler. Returns the response.
NextHandler = Callable[[], Awaitable[Any]]


def create_jobs_auth_middleware(
    *,
    app_env: str | None,
    enable_pull_subscriber: str | None,
    audience: str | None,
    verify_id_token: VerifyIdToken,
    json_response: AuthResponder,
    log_error: Callable[[str, BaseException | None], None] | None = None,
) -> Callable[[str | None, NextHandler], Awaitable[Any]]:
    """Build the ``/jobs/*`` auth middleware.

    The returned coroutine takes the raw ``Authorization`` header value (or
    ``None``) and the downstream handler.

    Failure modes, all of them deliberate:

    * no token           -> 401 ``Unauthorized: missing token``
    * audience unset     -> 500 ``Server misconfigured``. A missing audience must
      FAIL, not skip verification: verifying against ``None`` would accept ANY
      Google-signed token, including one minted for an unrelated service.
    * verification raises-> 401 ``Unauthorized: invalid token``
    """
    skip = should_skip_http_oidc(app_env, enable_pull_subscriber)
    logger = log_error or (lambda _message, _err=None: None)

    async def jobs_auth(authorization: str | None, call_next: NextHandler) -> Any:
        if not skip:
            token = ""
            if authorization:
                token = authorization.removeprefix("Bearer ").strip()
            if not token:
                return json_response({"error": "Unauthorized: missing token"}, 401)
            if not audience:
                logger("CLOUD_RUN_URL not set - cannot verify OIDC token", None)
                return json_response({"error": "Server misconfigured"}, 500)
            try:
                verify_id_token(token=token, audience=audience)
            except Exception as err:
                # The exception is passed to the injected logger, which redacts
                # it. NEVER format it into the response: a google-auth error
                # carries the token and the request it was made with.
                logger("OIDC token verification failed", err)
                return json_response({"error": "Unauthorized: invalid token"}, 401)
        return await call_next()

    return jobs_auth
