"""The shipped dependency closure is PINNED, and the build actually uses it.

`pyproject.toml` states FLOORS, so two builds of one commit could install
different code — including a different `google-auth`, the library that decides
whether a Pub/Sub push token is valid. The container holds `DATABASE_URL`,
`REDIS_URL`, `OPENFIGI_API_KEY` and `DD_API_KEY` for its environment, so that is
a supply-chain exposure rather than an inconvenience. The TypeScript half of the
repo is locked by `yarn.lock`; `constraints.txt` is that for this half.

Both halves are asserted, because either alone is a false comfort: a
constraints file the Dockerfile does not pass to pip is decoration, and a
`-c` flag pointing at a file missing the dependency that matters pins nothing.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parent.parent
CONSTRAINTS = SERVICE_ROOT / "constraints.txt"
PYPROJECT = SERVICE_ROOT / "pyproject.toml"
DOCKERFILE = SERVICE_ROOT / "Dockerfile"

#: `name==version` lines, ignoring comments and blanks.
_PIN = re.compile(r"^([A-Za-z0-9._-]+)==([^\s;]+)", re.MULTILINE)
#: The distribution name at the head of a PEP 508 requirement.
_REQ_NAME = re.compile(r"^([A-Za-z0-9._-]+)")


def _normalise(name: str) -> str:
    """PEP 503: `-`, `_` and `.` are equivalent, and case is not significant."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _pins() -> dict[str, str]:
    text = CONSTRAINTS.read_text()
    return {_normalise(n): v for n, v in _PIN.findall(text)}


def _runtime_dependencies() -> list[str]:
    payload = tomllib.loads(PYPROJECT.read_text())
    return list(payload["project"]["dependencies"])


def test_constraints_file_exists_and_is_a_full_closure() -> None:
    """PREMISE. A short file would make every assertion below vacuous."""
    assert CONSTRAINTS.exists(), "constraints.txt is missing — the build pins nothing"
    pins = _pins()
    assert len(pins) > 50, (
        f"only {len(pins)} pins — this must be the whole transitive closure, not the "
        "direct dependencies. An indirect dependency ships new code just as easily "
        "and is the half nobody reads."
    )


def test_every_runtime_dependency_is_pinned() -> None:
    pins = _pins()
    missing = [
        req
        for req in _runtime_dependencies()
        if (m := _REQ_NAME.match(req)) and _normalise(m.group(1)) not in pins
    ]
    assert missing == [], (
        f"these runtime dependencies have no pin in constraints.txt: {missing}. "
        "Regenerate with `.venv/bin/pip freeze --exclude-editable | sort`."
    )


def test_the_security_critical_dependencies_are_pinned_exactly() -> None:
    """Named, so the assertion says WHY rather than restating the rule.

    `google-auth` verifies every Pub/Sub push token; `httpx` and `edgartools`
    reach sec.gov; `pymongo` and `redis` hold the credentials.
    """
    pins = _pins()
    for name in ["google-auth", "httpx", "edgartools", "pymongo", "redis", "pyrate-limiter"]:
        assert _normalise(name) in pins, f"{name} is not pinned"


def test_no_floor_or_range_leaked_into_the_constraints_file() -> None:
    """A `>=` here would pin nothing while looking like a lockfile."""
    offenders = [
        line
        for line in CONSTRAINTS.read_text().splitlines()
        if line.strip()
        and not line.lstrip().startswith("#")
        and ("==" not in line or ">=" in line or "<" in line)
    ]
    assert offenders == [], f"non-exact entries in constraints.txt: {offenders[:5]}"


def test_the_dockerfile_actually_passes_the_constraints_to_pip() -> None:
    """A constraints file the build ignores is decoration.

    The dependency layer is the one that RESOLVES; the later
    `pip install --no-deps .` only re-registers package metadata and needs no
    constraints, so this asserts the resolving install specifically.
    """
    text = DOCKERFILE.read_text()
    assert "COPY pyproject.toml constraints.txt" in text, (
        "constraints.txt is never COPYed into the build context"
    )
    resolving = [
        line
        for line in text.splitlines()
        if "pip install" in line and "--no-deps" not in line
    ]
    assert resolving, "premise: no resolving pip install found in the Dockerfile"
    for line in resolving:
        assert "-c constraints.txt" in line, (
            f"this install resolves without constraints: {line.strip()}"
        )
