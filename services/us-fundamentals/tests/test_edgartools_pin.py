"""TRIPWIRE. Not a version-hygiene test — a correctness test.

edgartools is a PARSER WHOSE OUTPUT WE STORE AS NUMBERS. `us_fundamentals`
rows are written from `standard_concept`, which is produced by a JSON mapping
file inside the wheel. An upgrade that adds one company concept to the
`Revenue` bucket changes the revenue we report for some filer, silently, with
every other test in this suite still green — because every other test asserts
that our code does what it says, and our code would still be doing what it
says.

So two things are pinned, and the second is the one that matters:

  1. the version, which catches a deliberate bump that forgot to re-verify;
  2. the sha256 of `gaap_mappings.json`, which catches the case the version
     cannot — a rebuilt wheel, a patched install, a `pip install --upgrade`
     that resolved to the same version string from a different artifact.

THE SECOND HASH USED TO NAME THE WRONG FILE, and it cost a CRITICAL. It pinned
`concept_mappings.json` — 12 KB of human-readable names — while the values we
actually store in `standard_concept` come from `standard_tags` inside the 3.7 MB
`gaap_mappings.json`. The reader's translation table was built from the pinned
file, the writer's keys from the unpinned one, and the two vocabularies overlap
in exactly ONE string (`Revenue`), so every US statement rendered as revenue and
nothing else. A tripwire across the wrong wire is worse than none: it reports
that the thing it does not watch has not changed.

Both are pinned now. `gaap_mappings.json` is the one that decides stored keys.

WHEN THIS TEST GOES RED, THE FIX IS NOT TO UPDATE THE CONSTANT. It is to
re-run the statement assertions in `test_edgar_adapter.py` against the new
library, confirm Apple's revenue and net income are still the numbers in the
filing, and only then record the new hash with the diff in the commit message.
Updating the constant first turns a tripwire into a rubber stamp.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

import edgar
from edgar.xbrl import standardization

PINNED_VERSION = "5.53.0"

#: sha256 of `edgar/xbrl/standardization/concept_mappings.json` as shipped by
#: edgartools 5.53.0, measured 2026-08-29. 100 top-level keys (95 real, 5
#: `_comment_*`), each mapping one standard concept name to the list of
#: company concepts that collapse into it. NOT the file that decides what we
#: store — see PINNED_GAAP_MAPPINGS_SHA256.
PINNED_CONCEPT_MAPPINGS_SHA256 = "9c140917f204c334d5b823953e7cc1643737b0bbbc4cbba1fe900a1f0bf72bdb"

#: sha256 of `edgar/xbrl/standardization/gaap_mappings.json` as shipped by
#: edgartools 5.53.0, measured 2026-08-29. 2,924 us-gaap tags -> `standard_tags`
#: (235 distinct) + `display_name`. THE `standard_tags` VALUES ARE THE KEYS OF
#: EVERY STORED `standardized` BLOB, so a change here changes stored data.
#: Upstream regenerates this file every release — it carries per-tag
#: `company_count` / `first_year` statistics — so expect this to fire on any
#: upgrade, and treat it as a real re-verification, not a rubber stamp.
PINNED_GAAP_MAPPINGS_SHA256 = "6355648d056e171cdb2d280e042181f1c3486a10c2d21eb0ad818b8ec387ff70"

REPO_SERVICE_ROOT = Path(__file__).resolve().parent.parent


def test_edgartools_version_is_pinned() -> None:
    assert edgar.__version__ == PINNED_VERSION


def test_concept_mappings_file_is_unchanged() -> None:
    """The mapping file drives every standardized number we store."""
    path = Path(standardization.__file__).parent / "concept_mappings.json"
    assert path.exists(), f"concept_mappings.json missing at {path}"
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    assert digest == PINNED_CONCEPT_MAPPINGS_SHA256, (
        "edgartools' standardization map changed. Re-verify the hand-checked "
        "statement values in test_edgar_adapter.py BEFORE updating this hash."
    )


def test_gaap_mappings_file_is_unchanged() -> None:
    """The file that decides the KEYS of every stored `standardized` blob.

    Red here means the stored vocabulary may have moved under
    `US_CONCEPT_TO_STATEMENT_FIELD`. Re-run
    `scripts/gen_standard_tags.py`, diff the regenerated fixture, and re-check
    the reader table against it before recording a new hash.
    """
    path = Path(standardization.__file__).parent / "gaap_mappings.json"
    assert path.exists(), f"gaap_mappings.json missing at {path}"
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    assert digest == PINNED_GAAP_MAPPINGS_SHA256, (
        "edgartools' gaap->standard_tag map changed. This decides the keys of "
        "every stored `standardized` blob. Regenerate the TS vocabulary fixture "
        "and re-verify US_CONCEPT_TO_STATEMENT_FIELD BEFORE updating this hash."
    )


#: Directories a source scan must never descend into. `.venv` matters most:
#: edgartools' own ~700 modules import `edgar` on every other line, so a scan
#: that reaches site-packages reports hundreds of offenders and gets "fixed" by
#: loosening the assertion until it means nothing.
_PRUNED_DIRS = frozenset(
    {
        ".git",
        ".venv",
        "venv",
        "node_modules",
        "__pycache__",
        "build",
        "dist",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        "site-packages",
    }
)

# The WHOLE statement is captured, not just the prefix, because the sibling
# test below inspects which submodule the limiter reaches for. `\b` after
# `edgar` is what keeps `from app.sec.edgar_adapter import ...` out of the
# results: `_` is a word character, so `edgar\b` cannot match inside
# `edgar_adapter`.
_IMPORT_EDGAR = re.compile(r"^[ \t]*(?:import[ \t]+edgar\b|from[ \t]+edgar\b).*$", re.MULTILINE)

#: Every file allowed to touch the library, with the reason. Reasons are stored
#: rather than implied so that widening this set is a deliberate act with an
#: argument attached — an allow-list of bare filenames grows one entry at a
#: time until it describes the codebase instead of constraining it.
_ALLOWED_IMPORTERS: dict[str, str] = {
    "app/sec/standardize.py": (
        "THE VOCABULARY MAP, and deliberately NOT a parser. It reads one data "
        "file from the pinned wheel — gaap_mappings.json — and answers a dict "
        "lookup, so the companyfacts fallback stores the SAME vocabulary the "
        "per-filing parse stores. Without it the two writers filled one column "
        "with two vocabularies and half of every companyfacts statement was "
        "unreadable. It never touches a filing, so an upgrade reaches it only "
        "through that file, which this module already pins."
    ),
    "scripts/gen_standard_tags.py": (
        "THE VOCABULARY EXPORTER, and it is not a parser. The TypeScript read "
        "seam has to know which strings `standard_concept` can take, and only "
        "the installed wheel knows: `standard_tags` lives inside a 3.7 MB JSON "
        "the TS tree cannot see. This reads that one file and writes a "
        "generated .ts fixture. It touches no filing and produces no value we "
        "store, so an upgrade cannot change a reported number through it — it "
        "can only change the fixture, which is precisely the signal we want."
    ),
    "tests/test_companyfacts_vocabulary.py": (
        "THE CROSS-SEAM CHECK, and it imports the library ON PURPOSE. It "
        "asserts that every key the companyfacts writer produces exists in "
        "edgartools' standard_tags universe. Deriving that universe from "
        "app.sec.standardize — the module under test — would make the "
        "assertion tautological: the mapper would be graded against itself. "
        "An independent read of the same pinned file is the whole point."
    ),
    "tests/test_standard_tags_fixture.py": (
        "THE DRIFT TEST for the exporter above. It imports edgar only to read "
        "`__version__` and to re-extract the vocabulary for comparison."
    ),
    "app/sec/edgar_adapter.py": (
        "THE PARSER. The only module that uses edgartools to turn filings into "
        "values, and therefore the only one whose output the version pin has "
        "to protect."
    ),
    "app/sec/limiter.py": (
        "THE LIMITER INJECTION, and deliberately NOT parsing. edgartools ships "
        "a per-process InMemoryBucket rate limiter, which is exactly wrong for "
        "N Cloud Run instances sharing one 9 req/s budget with SEC. Replacing "
        "it means assigning `edgar.httpclient.HTTP_MGR.rate_limiter`, so this "
        "file reaches into `edgar.httpclient` and nothing else — asserted "
        "below, so it cannot quietly start parsing."
    ),
    "tests/test_edgartools_pin.py": "This file, which asserts the pin.",
    "tests/test_edgar_adapter.py": (
        "Imports `edgar.ownership.models.TransactionCode` for ONE assertion: "
        "that the library's transaction-code table is missing J, L and W and "
        "ours is not. Comparing against the real table is the whole point — a "
        "hardcoded copy of its contents would keep passing after the library "
        "fixed the gap, and we would never learn."
    ),
}


def _python_sources() -> list[Path]:
    found: list[Path] = []
    for path in REPO_SERVICE_ROOT.rglob("*.py"):
        if _PRUNED_DIRS.isdisjoint(path.parts):
            found.append(path)
    return found


def test_only_the_adapter_imports_edgar() -> None:
    """One file may `import edgar`. Everything else consumes our own types.

    The version pin above is worthless if a writer, a job or a test helper
    imports the library directly: the blast radius of an upgrade would be the
    whole service rather than one reviewed module.

    THE POSITIVE CONTROL IS THE POINT OF THE FIRST ASSERTION. The obvious way
    to write this check is `git grep`, and that is what it did until the check
    was run: `git grep` reads TRACKED files only, the adapter was still
    untracked, so the search returned NOTHING and the test passed while
    enforcing nothing at all. A zero that the configuration explains is not
    evidence. So the scan is a filesystem walk, and it must FIND the adapter
    before it is allowed to conclude anything about what else it did not find.
    """
    sources = _python_sources()
    importers = {
        str(path.relative_to(REPO_SERVICE_ROOT)).replace("\\", "/")
        for path in sources
        if _IMPORT_EDGAR.search(path.read_text(encoding="utf-8", errors="replace"))
    }

    # Ceiling first: if the scan cannot see the one file that certainly does
    # import edgar, it cannot see anything, and every conclusion below is void.
    assert "app/sec/edgar_adapter.py" in importers, (
        f"scan is broken — it did not find the adapter itself among {len(sources)} files"
    )

    offenders = importers - set(_ALLOWED_IMPORTERS)
    assert offenders == set(), (
        "these files import edgartools without a recorded reason: "
        f"{sorted(offenders)}. Consume app.sec.adapter_types instead, or add an "
        "entry to _ALLOWED_IMPORTERS explaining why this one cannot."
    )


def test_the_limiter_touches_only_edgars_http_client() -> None:
    """The second importer must stay a limiter, not become a second parser.

    `app/sec/limiter.py` is allowed to import edgartools because replacing its
    per-process rate limiter requires assigning
    `edgar.httpclient.HTTP_MGR.rate_limiter`. That is a narrow, deliberate
    reach into one module. If it ever imported `edgar.Filing` or
    `edgar.thirteenf`, parsing would have escaped the adapter and the version
    pin would be guarding half the surface it claims to.
    """
    source = (REPO_SERVICE_ROOT / "app" / "sec" / "limiter.py").read_text()
    edgar_imports = {match.group(0).strip() for match in _IMPORT_EDGAR.finditer(source)}

    assert edgar_imports, "expected the limiter to import edgartools; did the injection move?"
    for statement in edgar_imports:
        assert "httpclient" in statement, (
            f"limiter.py may only reach edgar.httpclient, found: {statement!r}"
        )
