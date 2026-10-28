"""The I/O shell around the OIDC gate — MONEY-979.

Everything branchy lives in :mod:`app.auth_logic`. This module supplies the two
things that touch the outside world: Google's real token verifier, and the
Starlette ``JSONResponse`` factory.
"""

from __future__ import annotations

import os
from typing import Any

from fastapi.responses import JSONResponse

from app import settings
from app.auth_logic import create_jobs_auth_middleware
from app.logging_setup import log_error


def verify_google_id_token(*, token: str, audience: str) -> Any:
    """Verify a Pub/Sub push OIDC token against ``audience``.

    Imported lazily so a unit test never needs ``google-auth`` and the import
    cost is not paid on a ``/health`` request.

    ``verify_oauth2_token`` RAISES on an invalid signature, a wrong audience, an
    expired token and a malformed one alike — every failure is a 401, and the
    caller deliberately does not distinguish them in the response body.
    """
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token as google_id_token

    return google_id_token.verify_oauth2_token(
        token,
        google_requests.Request(),
        audience=audience,
    )


def _json_response(body: dict[str, Any], status: int) -> JSONResponse:
    return JSONResponse(body, status_code=status)


def build_jobs_auth():
    """Compose the real gate from the environment as it stands AT THIS CALL.

    The values are then FROZEN for the life of the returned gate, and that is
    deliberate rather than incidental — the docstring here used to claim the
    opposite ("read per call, not at import"), which was false about its own
    module in two places at once:

    * ``app.main`` calls this exactly ONCE, at module scope, so every value
      below is in fact resolved at container start.
    * ``create_jobs_auth_middleware`` freezes ``should_skip_http_oidc`` into
      ``skip`` in the factory body and captures ``audience`` in the closure, so
      even a second call per request would not re-decide anything.
      ``tests/test_auth_logic.py::test_the_decision_is_frozen_at_construction``
      PINS that freeze; it is the behaviour, not a leftover.

    The freeze is safe because a Cloud Run process cannot outlive its own
    environment: the env block is fixed before the container starts, and
    correcting it with ``--update-env-vars`` creates a NEW revision and
    therefore a new process. There is no window in which a running instance
    holds a stale answer that a re-read could repair.

    It is also the safer default in the direction that matters. Re-reading per
    request would let a mid-process env change silently REOPEN the gate, and
    ``should_skip_http_oidc`` is deny-by-default precisely so that an
    unrecognised environment cannot do that. ``/health`` reports the resolved
    state so an operator can see what was frozen.

    A test — not this text — is what keeps the two in agreement:
    ``tests/test_auth_build.py`` asserts both halves (a fresh call observes a
    changed environment; an already-built gate does not).
    """
    return create_jobs_auth_middleware(
        app_env=settings.app_env(),
        enable_pull_subscriber=os.environ.get("ENABLE_PULL_SUBSCRIBER"),
        audience=settings.cloud_run_url(),
        verify_id_token=verify_google_id_token,
        json_response=_json_response,
        log_error=log_error,
    )
