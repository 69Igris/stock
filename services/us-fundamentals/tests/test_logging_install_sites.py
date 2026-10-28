"""Every entry point installs redaction BEFORE its imports — MONEY-979.

``app/logging_setup.py`` states the rule ("MUST be the first statement... a log
line emitted during import is emitted before any later call could have installed
the filter") and ``app/main.py`` was the only module honouring it. The five bulk
jobs called ``install_logging()`` inside ``main()``, which is AFTER the module
body has already imported ``edgar``, ``pymongo`` and ``ddtrace`` — so any record
those emit at import time reached Python's lastResort stderr handler with no
filter attached. Boot-time failures are exactly the ones that still have
credentials on them.

The rule is enforced by PARSING each module rather than by importing it. An
import-time assertion would prove nothing: the call has by then already run, and
"it ran" is not the property — "it ran FIRST" is.

The entry-point set is DISCOVERED, not listed. A hard-coded list is a list
someone adds a sixth job without touching, and the whole reason this test exists
is that five of six sites had already drifted from the documented rule with
nothing failing anywhere.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

APP_DIR = Path(__file__).resolve().parent.parent / "app"

#: Imports allowed to precede the install: the ones the install itself needs.
ALLOWED_BEFORE = frozenset({"__future__", "app.logging_setup"})


def _entry_points() -> list[Path]:
    """Every module that starts a process.

    Two shapes, both discovered from source: a CLI job (``if __name__ ==
    "__main__"``) and the ASGI app (``app/main.py``, which uvicorn imports and
    which therefore has no ``__main__`` guard).
    """
    found = {
        path
        for path in sorted(APP_DIR.rglob("*.py"))
        if '__name__ == "__main__"' in path.read_text() or "__name__ == '__main__'" in path.read_text()
    }
    found.add(APP_DIR / "main.py")
    return sorted(found)


def _module_scope_install_line(tree: ast.Module) -> int | None:
    """Line of the top-level ``install_logging()`` call, or ``None``.

    Only a DIRECT child of the module body counts. A call nested in a
    ``FunctionDef`` — which is what all five jobs had — is not reached until the
    function runs, long after the imports.
    """
    for node in tree.body:
        if (
            isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name)
            and node.value.func.id == "install_logging"
        ):
            return node.lineno
    return None


def _import_names(node: ast.Import | ast.ImportFrom) -> list[str]:
    if isinstance(node, ast.Import):
        return [alias.name for alias in node.names]
    # A relative import (`from .common import ...`) has module=None or a bare
    # name and level >= 1; it is never one of ALLOWED_BEFORE.
    return [node.module or ""]


def test_the_entry_point_set_is_not_empty_and_is_the_one_we_think() -> None:
    """Guard the DISCOVERY, not just the rule.

    A glob that matched nothing would make every assertion below vacuously true
    — the shape that let 45 test files stop running unnoticed in this repo
    (MONEY-1093). The six known sites are spelled out so a rename that hides one
    from the discovery goes red here rather than silently shrinking coverage.
    """
    names = {path.relative_to(APP_DIR).as_posix() for path in _entry_points()}

    assert names == {
        "main.py",
        "bulk/submissions.py",
        "bulk/companyfacts.py",
        "bulk/xbrl_backfill.py",
        "bulk/ownership_backfill.py",
        "bulk/ftd.py",
    }


@pytest.mark.parametrize("path", _entry_points(), ids=lambda p: p.name)
def test_install_logging_is_called_at_module_scope(path: Path) -> None:
    tree = ast.parse(path.read_text())

    assert _module_scope_install_line(tree) is not None, (
        f"{path.name}: install_logging() is not called at module scope. "
        "A call inside main() runs AFTER this module's imports, so anything "
        "edgar/pymongo/ddtrace log while importing is emitted unredacted."
    )


@pytest.mark.parametrize("path", _entry_points(), ids=lambda p: p.name)
def test_install_logging_precedes_every_other_import(path: Path) -> None:
    """Module scope alone is not enough — it must come FIRST.

    ``install_logging()`` sitting at the BOTTOM of the import block would
    satisfy the previous test and still miss every record emitted while those
    imports ran, which is the entire harm.
    """
    tree = ast.parse(path.read_text())
    install_line = _module_scope_install_line(tree)
    assert install_line is not None, f"{path.name}: no module-scope install_logging()"

    late = [
        (node.lineno, name)
        for node in tree.body
        if isinstance(node, ast.Import | ast.ImportFrom)
        for name in _import_names(node)
        if name not in ALLOWED_BEFORE and node.lineno < install_line
    ]

    assert late == [], (
        f"{path.name}: {len(late)} import(s) run BEFORE install_logging() "
        f"(line {install_line}): {late}. Only {sorted(ALLOWED_BEFORE)} may precede it."
    )


@pytest.mark.parametrize("path", _entry_points(), ids=lambda p: p.name)
def test_install_logging_is_not_left_behind_inside_main(path: Path) -> None:
    """No second call inside a function.

    Harmless at runtime (``install_logging`` is idempotent) but it is the
    artefact of the defect, and leaving it there makes the next reader believe
    the call site inside ``main()`` is what provides the guarantee.
    """
    tree = ast.parse(path.read_text())

    nested = [
        node.lineno
        for func in ast.walk(tree)
        if isinstance(func, ast.FunctionDef | ast.AsyncFunctionDef)
        for node in ast.walk(func)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "install_logging"
    ]

    assert nested == [], f"{path.name}: install_logging() still called inside a function at {nested}"
