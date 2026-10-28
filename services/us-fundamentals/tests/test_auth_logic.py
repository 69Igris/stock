"""The OIDC gate — decision table AND the call site — MONEY-979.

Two layers, and the second is the one that matters. On the TypeScript side the
decision function was already extracted and unit-tested and the gate was STILL
trivially defeatable, because nothing executed the composition. Both mutation
classes below have to be made where these tests run.
"""

from __future__ import annotations

import pytest

from app.auth_logic import (
    DEPLOYED_ENVS,
    LOCAL_ENVS,
    create_jobs_auth_middleware,
    should_skip_http_oidc,
)

# ── Layer 1: the decision ───────────────────────────────────────────────────


@pytest.mark.parametrize("env", LOCAL_ENVS)
def test_skips_only_in_a_known_local_env_with_the_subscriber_on(env: str) -> None:
    assert should_skip_http_oidc(env, "true") is True


@pytest.mark.parametrize("env", LOCAL_ENVS)
def test_local_env_without_the_subscriber_still_requires_a_token(env: str) -> None:
    assert should_skip_http_oidc(env, None) is False
    assert should_skip_http_oidc(env, "false") is False
    # "TRUE" is not "true". The flag is compared to the LITERAL string, so a
    # case variant does not arm the opt-out.
    assert should_skip_http_oidc(env, "TRUE") is False


@pytest.mark.parametrize("env", DEPLOYED_ENVS)
def test_enable_pull_subscriber_cannot_disable_auth_on_a_deployed_env(env: str) -> None:
    """The exact MONEY-288 shape: an env var must not turn OIDC off in prod/QA."""
    assert should_skip_http_oidc(env, "true") is False


@pytest.mark.parametrize("env", [None, "", "   ", "staging", "prodution", "${_ENV}", "PRODUCTION"])
def test_an_unrecognised_env_requires_a_token(env: str | None) -> None:
    """Deny by default.

    This is the case the INVERSION exists for. An allow-list of deployed envs
    ("is it production or qa?") would answer False here and then hand the
    decision to ENABLE_PULL_SUBSCRIBER — so an unexpanded Cloud Build
    substitution, a typo or an unset variable plus one env var would open every
    job route. `"PRODUCTION"` is included on purpose: it is not in LOCAL_ENVS
    either way, so it is denied, but it documents that case-folding happens
    before the LOCAL check and not after a DEPLOYED one.
    """
    assert should_skip_http_oidc(env, "true") is False


def test_case_and_whitespace_are_normalised_for_the_local_check() -> None:
    assert should_skip_http_oidc("  Development  ", "true") is True
    assert should_skip_http_oidc("LOCAL", "true") is True


# ── Layer 2: the CALL SITE ──────────────────────────────────────────────────


class _Recorder:
    def __init__(self) -> None:
        self.responses: list[tuple[dict, int]] = []
        self.verified: list[tuple[str, str]] = []
        self.next_called = 0
        self.errors: list[str] = []

    def json_response(self, body: dict, status: int):
        self.responses.append((body, status))
        return ("response", body, status)

    def verify_ok(self, *, token: str, audience: str):
        self.verified.append((token, audience))
        return {"aud": audience}

    def verify_raises(self, *, token: str, audience: str):
        self.verified.append((token, audience))
        raise ValueError("Token has wrong audience")

    async def call_next(self):
        self.next_called += 1
        return ("handler", None, 200)

    def log_error(self, message: str, err: BaseException | None = None) -> None:
        self.errors.append(message)


def _gate(rec: _Recorder, *, app_env="production", pull=None, audience="https://svc", verify=None):
    return create_jobs_auth_middleware(
        app_env=app_env,
        enable_pull_subscriber=pull,
        audience=audience,
        verify_id_token=verify or rec.verify_ok,
        json_response=rec.json_response,
        log_error=rec.log_error,
    )


async def test_call_site_rejects_a_request_with_no_authorization_header() -> None:
    """Drives the REAL factory.

    MUTATION that this test exists to catch: changing `if not skip:` to
    `if False:` in auth_logic.py. Every `should_skip_http_oidc` test above stays
    green under that mutation — the decision function is untouched — while OIDC
    is off on every route.
    """
    rec = _Recorder()
    gate = _gate(rec)

    result = await gate(None, rec.call_next)

    assert rec.responses == [({"error": "Unauthorized: missing token"}, 401)]
    assert rec.next_called == 0, "the handler must not run for an unauthenticated request"
    assert result == ("response", {"error": "Unauthorized: missing token"}, 401)


async def test_call_site_rejects_a_bare_bearer_prefix_with_no_token() -> None:
    rec = _Recorder()
    result = await _gate(rec)("Bearer ", rec.call_next)
    assert result[2] == 401
    assert rec.next_called == 0


async def test_call_site_answers_500_when_the_audience_is_unset() -> None:
    """A missing audience must FAIL, never skip verification.

    Verifying against `None` would accept ANY Google-signed token, including one
    minted for an unrelated service — so "we cannot check" is a 500, not a pass.
    """
    rec = _Recorder()
    result = await _gate(rec, audience=None)("Bearer abc", rec.call_next)

    assert result == ("response", {"error": "Server misconfigured"}, 500)
    assert rec.verified == [], "verification must not be attempted without an audience"
    assert rec.next_called == 0


async def test_call_site_answers_401_when_verification_raises() -> None:
    rec = _Recorder()
    gate = _gate(rec, verify=rec.verify_raises)

    result = await gate("Bearer bad-token", rec.call_next)

    assert result == ("response", {"error": "Unauthorized: invalid token"}, 401)
    assert rec.next_called == 0
    # The message must not carry the exception: google-auth errors embed the
    # token and the request they were made with.
    assert rec.errors == ["OIDC token verification failed"]


async def test_call_site_runs_the_handler_on_a_valid_token() -> None:
    rec = _Recorder()
    gate = _gate(rec)

    result = await gate("Bearer good-token", rec.call_next)

    assert rec.verified == [("good-token", "https://svc")]
    assert rec.next_called == 1
    assert result == ("handler", None, 200)


async def test_call_site_skips_verification_only_in_local_dev() -> None:
    rec = _Recorder()
    gate = _gate(rec, app_env="development", pull="true", audience=None)

    result = await gate(None, rec.call_next)

    assert rec.next_called == 1, "local dev with the pull subscriber runs without a token"
    assert rec.responses == []
    assert result == ("handler", None, 200)


async def test_call_site_does_not_skip_on_qa_even_with_the_subscriber_on() -> None:
    """The composed gate, not just the decision function.

    MUTATION this catches: appending `or enable_pull_subscriber == "true"` to
    the skip expression at the call site. `should_skip_http_oidc` is untouched
    by that edit, so its unit tests — including
    `test_enable_pull_subscriber_cannot_disable_auth_on_a_deployed_env` — all
    stay green.
    """
    rec = _Recorder()
    gate = _gate(rec, app_env="qa", pull="true")

    result = await gate(None, rec.call_next)

    assert result[2] == 401
    assert rec.next_called == 0


async def test_the_decision_is_frozen_at_construction() -> None:
    """The gate reads its inputs ONCE, when built.

    Documented rather than incidental: the middleware is constructed at import
    and a per-request re-read would let an env change mid-process silently
    reopen the gate. `/health` reports the resolved state so an operator can see
    what was frozen.
    """
    rec = _Recorder()
    gate = _gate(rec, app_env="production")

    import os

    os.environ["ENABLE_PULL_SUBSCRIBER"] = "true"
    os.environ["APP_ENV"] = "development"
    try:
        result = await gate(None, rec.call_next)
    finally:
        os.environ.pop("ENABLE_PULL_SUBSCRIBER", None)
        os.environ.pop("APP_ENV", None)

    assert result[2] == 401
