"""Every process that can fetch from SEC installs the shared limiter — MONEY-979.

## The defect this exists for

`install_shared_limiter()` was written, unit-tested from nine angles, and called
from NOWHERE in ``app/``. Every call site was in ``tests/``. A deployed process
therefore held ``_installed is None``, and the first ``try_acquire`` raised
``LimiterUnavailable``.

The reason that survived review is the shape worth naming: it does not crash
loudly. ``LimiterUnavailable`` is a ``SecError``, and the fetch paths classify
non-transport ``SecError``s as deterministic upstream refusals — so the run ACKs
its message, counts one ``transportFailure``, and reports a skip reason that
reads like a quiet SEC. ``edgar-detect`` would have done that every minute,
forever, while ``/health`` reported ``"mode": "redis-shared"`` — because that
field was derived from ``REDIS_URL`` being SET rather than from the limiter
being INSTALLED, which is true in exactly the broken state.

A unit test cannot see this. Each one installs the limiter itself, in-process,
before exercising it. What was missing was a test of the WIRING, which is what
this file is: it reads the source of every entry point and asserts the call is
there.

## What counts as an entry point

Any module under ``app/`` that constructs a ``SecClient`` — that is the precise
definition of "can reach sec.gov", and it is derived by scanning rather than
listed, so a sixth job cannot be added without being covered.
"""

from __future__ import annotations

import ast
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"

#: The two spellings that install the limiter: the direct call, and the shared
#: helper the bulk jobs use.
INSTALL_NAMES = ("install_shared_limiter", "install_sec_limiter")


def _python_sources() -> list[Path]:
    return sorted(p for p in APP.rglob("*.py") if "__pycache__" not in p.parts)


def _calls_in(tree: ast.AST) -> set[str]:
    """Names CALLED anywhere in the module — an import alone does not count.

    Importing a function and never calling it is precisely the state that
    shipped, so the assertion has to be about the call.
    """
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            fn = node.func
            if isinstance(fn, ast.Name):
                out.add(fn.id)
            elif isinstance(fn, ast.Attribute):
                out.add(fn.attr)
    return out


def _is_process_entry_point(path: Path) -> bool:
    """True for a module the container starts directly (`python -m app.bulk.x`)."""
    return '__name__ == "__main__"' in path.read_text()


def _constructs_sec_client(tree: ast.AST) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            fn = node.func
            # `SecClient(...)` or `SecClient.from_settings()`
            if isinstance(fn, ast.Name) and fn.id == "SecClient":
                return True
            if isinstance(fn, ast.Attribute) and fn.attr == "from_settings":
                return True
    return False


def test_the_scan_reads_the_app_tree() -> None:
    """Guards every assertion below.

    A scan that silently walks nothing passes each `for` loop vacuously — which
    is the same failure class as the defect this file exists for.
    """
    sources = _python_sources()
    assert len(sources) > 20, f"expected to walk app/, found {len(sources)} files"


def test_the_scan_finds_the_fetching_modules() -> None:
    """And a floor on the population, so an emptied scan cannot pass."""
    fetchers = [p for p in _python_sources() if _constructs_sec_client(ast.parse(p.read_text()))]
    assert len(fetchers) >= 5, (
        f"expected at least the five bulk jobs to construct a SecClient, found "
        f"{len(fetchers)}: {[p.name for p in fetchers]}"
    )


def test_every_module_that_can_reach_sec_installs_the_limiter() -> None:
    """The wiring assertion.

    A module that builds a `SecClient` is a module that can reach sec.gov, so it
    must either install the shared budget itself or be a library whose caller
    does. The service's push handlers are covered by the app's own startup hook
    (`app/main.py`), and each Cloud Run JOB is a separate process that installs
    its own.
    """
    offenders: list[str] = []
    checked: list[str] = []
    for path in _python_sources():
        tree = ast.parse(path.read_text())
        if not _constructs_sec_client(tree):
            continue
        # The rule is PROCESS vs LIBRARY, not directory.
        #
        # A module with an `if __name__ == "__main__"` block is something the
        # container actually starts, so it owns its own install. Everything else
        # — `app/jobs/*` push handlers, and `app/parsers/dispatch.py`, which
        # builds a client inside `run_parse_job` — is reached only through the
        # running FastAPI process and inherits that process's install, which
        # `test_the_service_installs_it_at_startup` below holds down.
        #
        # A directory-based exemption got this wrong: it cleared `app/jobs/*`
        # and then flagged `dispatch.py`, which is in `app/parsers/`.
        if not _is_process_entry_point(path):
            continue
        checked.append(str(path.relative_to(APP.parent)))
        if not (_calls_in(tree) & set(INSTALL_NAMES)):
            offenders.append(str(path.relative_to(APP.parent)))

    # The EXEMPTION cannot be allowed to swallow the population.
    #
    # Mutation-found: degrading `_is_process_entry_point` to `if True: continue`
    # left this test GREEN with a bulk job that installs nothing, because the
    # only floor was on modules that CONSTRUCT a client — not on modules
    # actually CHECKED. An exemption that grows until it covers everything is
    # the classic way a guard becomes decoration.
    assert len(checked) >= 5, (
        f"only {len(checked)} module(s) were actually checked: {checked}. The "
        f"process-vs-library exemption has widened until it covers the "
        f"population this test exists to protect."
    )

    assert offenders == [], (
        "these modules construct a SecClient but never install the shared SEC "
        "limiter, so their first fetch raises LimiterUnavailable — which the "
        "fetch paths classify as a deterministic upstream refusal and ACK, "
        "producing a clean-looking run that fetched nothing:\n  "
        + "\n  ".join(offenders)
        + "\n\nCall `install_sec_limiter()` (app/bulk/common.py) before "
        "constructing the client."
    )


def test_the_service_installs_it_at_startup() -> None:
    """The push handlers' half.

    `app/jobs/*` are exempted above because they run inside the FastAPI process
    rather than as their own — which is only true while that process installs
    the limiter. Without this, the exemption becomes the hole.
    """
    main = (APP / "main.py").read_text()
    calls = _calls_in(ast.parse(main))
    assert set(INSTALL_NAMES) & calls, (
        "app/main.py never installs the shared SEC limiter, so every push "
        "handler in the service — detect and all five parsers — would raise "
        "LimiterUnavailable on its first fetch and ACK the message. Install it "
        "in a FastAPI lifespan hook."
    )


def test_health_reports_the_limiter_it_HAS_not_the_one_it_was_configured_for() -> None:
    """`/health` must not derive the limiter's state from an env var.

    It reported `"redis-shared" if settings.redis_url() else "unconfigured"` —
    true in precisely the broken state, and the reason a preflight check built
    on `/health` would have passed on a service that could not fetch.
    `limiter.py` exports `installed_limiter()` and `edgartools_injected()` to be
    reported instead.
    """
    main = (APP / "main.py").read_text()
    calls = _calls_in(ast.parse(main))
    assert "installed_limiter" in calls or "edgartools_injected" in calls, (
        "/health does not ask the limiter module what is actually installed. "
        "Reporting a mode derived from REDIS_URL being set is true even when "
        "no limiter exists in the process."
    )
