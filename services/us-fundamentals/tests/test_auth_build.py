"""``build_jobs_auth`` — what it actually freezes, and when — MONEY-979.

The docstring on this function used to claim the environment is read "per call,
not at import: a module-scope read would freeze the environment at container
start". Both halves were false about its own module. ``app/main.py`` calls it
ONCE at module scope, and ``app/auth_logic.py`` freezes ``should_skip_http_oidc``
into ``skip`` in the factory body and captures ``audience`` in the closure — so
the values ARE frozen at container start, deliberately, and
``test_auth_logic.py::test_the_decision_is_frozen_at_construction`` already pins
the inner half.

The docstring is now corrected. A comment cannot fail, so these tests pin the
BEHAVIOUR it describes — both directions, because "frozen" and "read per call"
are each half of the truth and stating only one of them is how the old text went
wrong:

* a FRESH call observes the environment as it stands at that moment, and
* an already-built gate does NOT change when the environment changes under it.

The second is the one that carries the security argument. Re-reading per request
would let a mid-process env change silently REOPEN the gate, which is exactly
what ``should_skip_http_oidc``'s deny-by-default shape exists to prevent.
"""

from __future__ import annotations

import os
from typing import Any

import pytest

from app.auth import build_jobs_auth


async def _call_next(_: Any = None) -> str:
    return "reached the handler"


def _status(result: Any) -> int:
    """Status code out of whatever the gate returned.

    ``build_jobs_auth`` wires the REAL ``JSONResponse`` factory, so a rejection
    is a Starlette response and a pass-through is the handler's return value.
    """
    return getattr(result, "status_code", 200)


@pytest.mark.asyncio
async def test_a_deployed_env_requires_a_token() -> None:
    """Baseline: the composed gate is live, not a stub."""
    os.environ["APP_ENV"] = "production"
    os.environ["CLOUD_RUN_URL"] = "https://us-fundamentals.example.run.app"

    gate = build_jobs_auth()

    assert _status(await gate(None, _call_next)) == 401


@pytest.mark.asyncio
async def test_each_call_reads_the_environment_as_it_stands_then() -> None:
    """The "read per call" half — of ``build_jobs_auth`` itself.

    Two calls, two environments, two different gates. This is what the old
    docstring got RIGHT about the function, and it is only meaningful because
    the next test shows what it got wrong about the module.
    """
    os.environ["APP_ENV"] = "production"
    os.environ["ENABLE_PULL_SUBSCRIBER"] = "true"
    os.environ["CLOUD_RUN_URL"] = "https://us-fundamentals.example.run.app"

    deployed_gate = build_jobs_auth()
    assert _status(await deployed_gate(None, _call_next)) == 401

    os.environ["APP_ENV"] = "development"
    local_gate = build_jobs_auth()

    assert await local_gate(None, _call_next) == "reached the handler"


@pytest.mark.asyncio
async def test_an_already_built_gate_does_not_re_read_the_environment() -> None:
    """The freeze — the half the docstring denied.

    ``app/main.py:142`` builds the gate once, at module scope, so this is the
    live behaviour of the deployed service and not a corner case. Making the
    gate re-read per request is the mutation this test exists to catch: it would
    let a mid-process env change open ``/jobs/*`` on a production instance.

    Safe because a Cloud Run process cannot outlive its own environment — the
    env block is fixed before the container starts and ``--update-env-vars``
    creates a NEW revision, so there is no window in which a running instance
    holds a stale answer that a re-read could repair.
    """
    os.environ["APP_ENV"] = "production"
    os.environ["CLOUD_RUN_URL"] = "https://us-fundamentals.example.run.app"

    gate = build_jobs_auth()

    os.environ["APP_ENV"] = "development"
    os.environ["ENABLE_PULL_SUBSCRIBER"] = "true"

    assert _status(await gate(None, _call_next)) == 401


@pytest.mark.asyncio
async def test_a_missing_audience_frozen_at_build_time_fails_closed() -> None:
    """``audience`` is captured once too, and an absent one is a 500, not a skip.

    Verifying against ``None`` would accept ANY Google-signed token, including
    one minted for an unrelated service — so the frozen-empty case must fail,
    and it must fail differently from "no token" (500 vs 401) or an operator
    cannot tell a misconfiguration from an unauthenticated caller.
    """
    os.environ["APP_ENV"] = "production"
    os.environ.pop("CLOUD_RUN_URL", None)

    gate = build_jobs_auth()

    os.environ["CLOUD_RUN_URL"] = "https://us-fundamentals.example.run.app"

    assert _status(await gate("Bearer some-token", _call_next)) == 500

