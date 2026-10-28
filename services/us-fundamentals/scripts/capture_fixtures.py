#!/usr/bin/env python3
"""Capture the SEC fixture corpus used by `tests/test_edgar_adapter.py`.

RUN BY HAND, RARELY. Every byte this writes came out of a real request to
sec.gov under our declared identity, and the whole point of the corpus is that
the adapter tests never need to make another one. Re-running it is not free:
SEC's fair-access policy is a shared 10 req/s budget for the entire company, so
this script pauses `PACE_SECONDS` between requests and refuses to exceed
`REQUEST_BUDGET` even if a caller asks it to.

    python scripts/capture_fixtures.py --plan     # print the plan, fetch nothing
    python scripts/capture_fixtures.py            # fetch what is missing
    python scripts/capture_fixtures.py --force    # re-fetch everything

IDEMPOTENT BY DESIGN. A fixture already on disk is skipped and costs zero
requests, so an interrupted run resumes instead of restarting. That is not a
convenience — it is the only thing that makes a 12-request budget survivable
when a single accession turns out to be the wrong one.

WHAT THIS ACTUALLY COST, recorded rather than rounded: **13 requests for 15
fixtures**, against a 12-request intent. Eleven went out in the first run,
which then aborted inside `pick_legacy_13g` on a date pattern written for
`YYYY-MM-DD` when a daily index publishes `YYYYMMDD`. The recovery run spent
two more: the legacy `SC 13G` the abort had skipped, and one unplanned request
after the first Form 4 turned out to have no derivative table at all (1
transaction, 12 holdings), leaving six schema columns untestable. The
idempotence above is what made that recoverable — the eleven already on disk
cost nothing to re-run past.

WHY THE BUDGET IS SPENT ON DISCOVERY. Six of the fixtures are addressed by
accession number, and an accession cannot be guessed. Rather than one lookup
per fixture, three requests act as MULTIPLEXERS:

  * `data.sec.gov/submissions/CIK0001067983.json` (Berkshire) is both the
    `parse_submissions_json` fixture and the source of three 13F accessions —
    one filed after the 2023-01-03 whole-dollars cutover, one before it, and one
    amendment.
  * `daily-index/.../form.20220214.idx` is both the `parse_daily_index` fixture
    and the source of a legacy `SC 13G` accession. 2022-02-14 is chosen because
    it is simultaneously the Q4-2021 13F deadline and the annual 13G deadline,
    so one day's index carries both populations.
  * `api/xbrl/companyfacts/CIK0000320193.json` (Apple) is both the companyfacts
    fixture and the source of Apple's 10-K accession, which rides along in the
    `accn` field of every fact.

Two more fixtures cost NOTHING because an earlier probe already captured them
with the same User-Agent: the `getcurrent` Atom page and an EFTS response. The
Atom page also supplies the Form 4 and `SCHEDULE 13D` accessions, and the EFTS
response supplies an 8-K whose `items` array literally contains "2.02" — which
is why no request is spent hunting for an earnings 8-K.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# SEC's fair-access policy REQUIRES a User-Agent that identifies the requester;
# an undeclared one is answered with 403 and the body "Undeclared Automated
# Tool". This is the same string `packages/core/src/market-data/instruments/
# edgar-cik.ts` already sends, so SEC sees one identity for the whole company.
USER_AGENT = "UseMoney/1.0 (deepshaswat@gmail.com)"

# Hard ceiling. SEC publishes 10 req/s; one request per second is two orders of
# magnitude under it and a capture run is a dozen requests, so there is nothing
# to gain by going faster and a block to lose by going wrong.
PACE_SECONDS = 1.0
REQUEST_BUDGET = 12

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
MANIFEST_PATH = FIXTURES_DIR / "manifest.json"

ARCHIVES = "https://www.sec.gov/Archives/edgar"
DATA = "https://data.sec.gov"

# ── Accessions that cost nothing ────────────────────────────────────────────
# From the `getcurrent` Atom page captured 2026-08-29T06:00:04Z (see
# `atom_getcurrent.xml.gz`). Picked by the `Size:` hint in each entry's summary:
# HANDLER is 13 KB against 8 KB for the sibling Jefferies filings, and the extra
# bytes are a derivative table.
FORM4_ACCESSION = "0001214659-26-011109"
FORM4_CIK = "0001211677"  # HANDLER RICHARD B (reporting owner)
# ...and it turned out to have NO derivative table: 1 non-derivative
# transaction and 12 non-derivative holdings. Good for `is_holding` and for
# `natureOfOwnership`, useless for the six derivative columns. The largest Form
# 4 on the same Atom page (23 KB against 13 KB) is a biotech 4/A, which buys
# both the amendment path and a derivative table for one request.
FORM4_DERIVATIVE_ACCESSION = "0001437749-26-029235"
FORM4_DERIVATIVE_CIK = "0001645469"  # Monopar Therapeutics (issuer)
# The only post-2024-12-18-mandate `SCHEDULE 13D` on that page, so it carries
# the structured XML the legacy `SC 13D`/`SC 13G` filings cannot.
SCHEDULE13D_ACCESSION = "0001903596-26-000330"
SCHEDULE13D_CIK = "0001927401"  # Five Narrow Lane LP (filer)
# From the EFTS response captured the same minute (`efts_8k_search.json.gz`):
# the only two hits whose `items` array contains "2.02" are iBio and GlobalTech.
# iBio is the smaller filing and a real operating company.
EIGHTK_ACCESSION = "0001420720-26-000019"
EIGHTK_CIK = "0001420720"  # iBio, Inc.

APPLE_CIK = "0000320193"
BERKSHIRE_CIK = "0001067983"
# CoreWeave IPO'd in March 2025. Its companyfacts therefore carries FEWER THAN
# FIVE fiscal years, which is the entire point of the fixture: decision 5 of the
# plan says a short-history filer must yield whatever exists and never fail, and
# an assertion about that is worthless against a filer that has 30 years.
SHORT_HISTORY_CIK = "0001769628"


@dataclass(frozen=True)
class Capture:
    """One fixture: where it came from, where it lands, and why it exists."""

    name: str
    filename: str
    url: str
    why: str


def _accession_nodash(accession: str) -> str:
    return accession.replace("-", "")


def bundle_url(cik: str, accession: str) -> str:
    """The full-submission SGML bundle — every document of a filing in one file.

    This is the archive-first unit: one fetch yields the primary document, every
    exhibit and the XBRL instance, so a reparse after a mapping change never
    goes back to SEC.
    """
    return f"{ARCHIVES}/data/{int(cik)}/{_accession_nodash(accession)}/{accession}.txt"


def _request(url: str) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept-Encoding": "gzip, deflate",
            "Accept": "*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return raw


class BudgetExhausted(RuntimeError):
    """Raised instead of fetching once the request ceiling is reached.

    A DEFERRAL, not a failure. Everything already captured stays on disk and in
    the manifest, so raising the ceiling and re-running picks up exactly the
    fixtures that are missing and re-fetches nothing.
    """


class Budget:
    """A request counter that is incremented AFTER the call it counts.

    Bumping it first would report a full number for a run in which every request
    403'd, which is exactly the reading that hid an upstream block for five
    months elsewhere in this repo (MONEY-1255).
    """

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.used = 0
        self._last_at = 0.0

    def exhausted(self) -> bool:
        return self.used >= self.limit

    def fetch(self, url: str) -> bytes:
        if self.exhausted():
            raise BudgetExhausted(f"budget {self.limit} spent; refusing to fetch {url}")
        elapsed = time.monotonic() - self._last_at
        if self._last_at and elapsed < PACE_SECONDS:
            time.sleep(PACE_SECONDS - elapsed)
        body = _request(url)
        self.used += 1
        self._last_at = time.monotonic()
        print(f"  [{self.used}/{self.limit}] {len(body):>10,} B  {url}", file=sys.stderr)
        return body


def write_fixture(cap: Capture, body: bytes, manifest: dict[str, Any]) -> None:
    """Store the bytes gzipped and record their provenance.

    The sha256 is of the RAW bytes, not the gzip, because gzip output varies
    with the compressor while the thing under test is what SEC served.
    """
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    path = FIXTURES_DIR / cap.filename
    path.write_bytes(gzip.compress(body, compresslevel=9))
    manifest[cap.name] = {
        "file": cap.filename,
        "url": cap.url,
        "sha256": hashlib.sha256(body).hexdigest(),
        "bytes": len(body),
        "gzipBytes": path.stat().st_size,
        "fetchedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "why": cap.why,
    }


def load_manifest() -> dict[str, Any]:
    if MANIFEST_PATH.exists():
        return json.loads(MANIFEST_PATH.read_text())
    return {}


def save_manifest(manifest: dict[str, Any]) -> None:
    ordered = {k: manifest[k] for k in sorted(manifest)}
    MANIFEST_PATH.write_text(json.dumps(ordered, indent=2, sort_keys=False) + "\n")


# ── Discovery ───────────────────────────────────────────────────────────────


def pick_apple_10k(companyfacts: dict[str, Any]) -> str:
    """Newest 10-K accession Apple has tagged, straight off the facts.

    Every companyfacts value carries the `accn` that reported it and the `form`
    it was reported on, so the accession comes free with a fixture we were
    fetching anyway. No separate lookup is spent on it.
    """
    best: tuple[str, str] | None = None
    for units in companyfacts_units(companyfacts):
        for entry in units:
            if entry.get("form") != "10-K":
                continue
            filed, accn = entry.get("filed"), entry.get("accn")
            if filed and accn and (best is None or filed > best[0]):
                best = (filed, accn)
    if best is None:
        raise RuntimeError("no 10-K accession found in companyfacts")
    return best[1]


def companyfacts_units(payload: dict[str, Any]):
    for taxonomy in payload.get("facts", {}).values():
        for concept in taxonomy.values():
            yield from concept.get("units", {}).values()


def pick_13f_accessions(submissions: dict[str, Any]) -> dict[str, tuple[str, str]]:
    """Three 13F accessions from one filer's submissions: post-cutover, pre-cutover, amendment.

    The 2023-01-03 boundary is a FILING date, not a period — Release 34-95148
    applies to reports FILED on or after that day — so the split is made on
    `filingDate` and never on `reportDate`. Getting that backwards puts a 2022
    quarter amended in 2023 on the wrong side and misreports the portfolio by
    1000x.
    """
    recent = submissions["filings"]["recent"]
    rows = list(
        zip(
            recent["accessionNumber"],
            recent["form"],
            recent["filingDate"],
            recent["reportDate"],
            strict=True,
        )
    )
    out: dict[str, tuple[str, str]] = {}
    for accession, form, filed, report in rows:
        if form == "13F-HR" and filed >= "2023-01-03" and "13f_post" not in out:
            out["13f_post"] = (accession, f"filed {filed}, period {report}")
        if form == "13F-HR" and filed < "2023-01-03" and "13f_pre" not in out:
            out["13f_pre"] = (accession, f"filed {filed}, period {report}")
        if form == "13F-HR/A" and "13f_amend" not in out:
            out["13f_amend"] = (accession, f"filed {filed}, period {report}")
    return out


# MEASURED against form.20220214.idx, not taken from the documentation: the
# date column is `YYYYMMDD` with NO separators. A pattern written for
# `YYYY-MM-DD` matches zero rows on every daily index ever published, and it
# fails SILENTLY — the caller sees "no such form today", which is
# indistinguishable from a market holiday.
IDX_ROW = re.compile(
    r"^(?P<form>.+?)\s{2,}(?P<name>.+?)\s{2,}(?P<cik>\d+)\s+(?P<date>\d{8})\s+(?P<path>edgar/\S+?)\s*$"
)


def pick_legacy_13g(idx_text: str) -> tuple[str, str]:
    """A pre-mandate `SC 13G` from the daily index.

    Before 2024-12-18 these filings are HTML only, so the adapter can recover
    identities and nothing else. A fixture from AFTER the mandate would make
    `has_structured_data=False` untestable, and that flag is the only thing
    separating "not machine-readable" from "zero percent".
    """
    for line in idx_text.splitlines():
        m = IDX_ROW.match(line.rstrip())
        if not m or m.group("form").strip() != "SC 13G":
            continue
        path = m.group("path")
        accession = Path(path).stem
        return accession, m.group("cik")
    raise RuntimeError("no SC 13G row in the daily index")


# ── Plan ────────────────────────────────────────────────────────────────────

STATIC_CAPTURES = [
    Capture(
        name="submissions_berkshire",
        filename="submissions_brk.json.gz",
        url=f"{DATA}/submissions/CIK{BERKSHIRE_CIK}.json",
        why=(
            "parse_submissions_json fixture. Berkshire is chosen over a pure "
            "operating company because one filer's history has to supply the "
            "13F trio (post-2023, pre-2023, amendment) as well as the paging "
            "`filings.files[]` references, and Berkshire files all four."
        ),
    ),
    Capture(
        name="daily_index_20220214",
        filename="form_20220214.idx.gz",
        url=f"{ARCHIVES}/daily-index/2022/QTR1/form.20220214.idx",
        why=(
            "parse_daily_index fixture AND the source of a legacy `SC 13G` "
            "accession. 2022-02-14 is simultaneously the Q4-2021 13F deadline "
            "and the annual 13G deadline, so a single day's index carries both "
            "populations and no second request is needed."
        ),
    ),
    Capture(
        name="companyfacts_aapl",
        filename="companyfacts_aapl.json.gz",
        url=f"{DATA}/api/xbrl/companyfacts/CIK{APPLE_CIK}.json",
        why=(
            "facts_from_companyfacts_json fixture, and the source of Apple's "
            "10-K accession via the `accn` on its own facts. Also the fixture "
            "that proves `frame` survives our parser — edgartools' own parser "
            "drops it."
        ),
    ),
    Capture(
        name="companyfacts_short_history",
        filename="companyfacts_coreweave.json.gz",
        url=f"{DATA}/api/xbrl/companyfacts/CIK{SHORT_HISTORY_CIK}.json",
        why=(
            "A 2025 IPO, so FEWER THAN FIVE fiscal years. Decision 5 says a "
            "short-history filer must yield everything it has and raise "
            "nothing; that is only falsifiable against a filer that actually "
            "has a short history."
        ),
    ),
    Capture(
        name="form4_bundle",
        filename="form4_jefferies.txt.gz",
        url=bundle_url(FORM4_CIK, FORM4_ACCESSION),
        why=(
            "Insider parsing: derivative rows, footnotes and the "
            "`equitySwapInvolved` element. Accession came free from the Atom "
            "page; picked by its 13 KB size against 8 KB for its siblings, "
            "which is a derivative table."
        ),
    ),
    Capture(
        name="form4_derivative_bundle",
        filename="form4_monopar_amendment.txt.gz",
        url=bundle_url(FORM4_DERIVATIVE_CIK, FORM4_DERIVATIVE_ACCESSION),
        why=(
            "The derivative half of insider parsing — underlyingSecurity, "
            "underlyingShares, exercisePrice, exerciseDate, expirationDate — "
            "six schema columns the Jefferies Form 4 leaves entirely untested, "
            "plus the `4/A` amendment path. Chosen as the largest ownership "
            "filing on the Atom page (23 KB against 13 KB), which is a "
            "derivative table."
        ),
    ),
    Capture(
        name="schedule13d_bundle",
        filename="schedule13d_expion.txt.gz",
        url=bundle_url(SCHEDULE13D_CIK, SCHEDULE13D_ACCESSION),
        why=(
            "A post-2024-12-18 `SCHEDULE 13D` — structured XML, so "
            "has_structured_data is True and percent/voting/dispositive fields "
            "exist. Accession came free from the Atom page."
        ),
    ),
    Capture(
        name="eightk_bundle",
        filename="eightk_ibio.txt.gz",
        url=bundle_url(EIGHTK_CIK, EIGHTK_ACCESSION),
        why=(
            "8-K carrying Item 2.02 (results of operations) and 9.01, with an "
            "EX-99.1 press release. Accession came free from the already "
            "captured EFTS response, whose `items` array names 2.02 outright — "
            "so no request was spent hunting for an earnings 8-K."
        ),
    ),
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--plan", action="store_true", help="print the plan and exit")
    ap.add_argument("--force", action="store_true", help="re-fetch fixtures already on disk")
    args = ap.parse_args()

    manifest = load_manifest()
    budget = Budget(REQUEST_BUDGET)

    def needed(cap: Capture) -> bool:
        return args.force or not (FIXTURES_DIR / cap.filename).exists()

    if args.plan:
        for cap in STATIC_CAPTURES:
            mark = "FETCH" if needed(cap) else "have "
            print(f"{mark} {cap.name:28} {cap.url}")
        print("+ 3 derived captures (apple 10-K, 13F x3, legacy SC 13G)")
        return 0

    fetched: dict[str, bytes] = {}
    deferred: list[str] = []

    def capture(cap: Capture) -> None:
        """Fetch one fixture, or record it as deferred when the budget is spent.

        Deferral is reported by name at the end rather than swallowed. A
        fixture that silently never arrives is a test that silently never runs.
        """
        if not needed(cap):
            print(f"  [cached] {cap.name}", file=sys.stderr)
            return
        try:
            body = budget.fetch(cap.url)
        except BudgetExhausted:
            deferred.append(cap.name)
            return
        write_fixture(cap, body, manifest)
        fetched[cap.name] = body
        save_manifest(manifest)

    for cap in STATIC_CAPTURES:
        capture(cap)

    def load(name: str, filename: str) -> bytes:
        if name in fetched:
            return fetched[name]
        return gzip.decompress((FIXTURES_DIR / filename).read_bytes())

    # ── derived: Apple 10-K ────────────────────────────────────────────────
    aapl_10k = Capture(
        name="tenk_bundle_aapl",
        filename="tenk_aapl.txt.gz",
        url=bundle_url(
            APPLE_CIK,
            pick_apple_10k(json.loads(load("companyfacts_aapl", "companyfacts_aapl.json.gz"))),
        ),
        why=(
            "statements_from_bundle fixture — the standardization path, with "
            "hand-verified revenue and net income. Apple because its numbers "
            "are the ones anyone can check against the filing."
        ),
    )
    capture(aapl_10k)

    # ── derived: three 13F filings ─────────────────────────────────────────
    subs = json.loads(load("submissions_berkshire", "submissions_brk.json.gz"))
    picks = pick_13f_accessions(subs)
    thirteenf_specs = [
        (
            "13f_post",
            "thirteenf_post2023.txt.gz",
            "13F-HR FILED on or after 2023-01-03, so its values are whole "
            "dollars under Release 34-95148. Paired with the pre-cutover "
            "fixture, this is what makes the unit rule falsifiable.",
        ),
        (
            "13f_pre",
            "thirteenf_pre2023.txt.gz",
            "13F-HR filed BEFORE 2023-01-03, so its values are thousands. "
            "Without this half the unit rule is an untested constant.",
        ),
        (
            "13f_amend",
            "thirteenf_amendment.txt.gz",
            "13F-HR/A. `amendmentType` decides whether the amendment REPLACES "
            "the original's holdings or ADDS to them; getting it wrong either "
            "doubles a portfolio or erases most of it.",
        ),
    ]
    for key, filename, why in thirteenf_specs:
        if key not in picks:
            print(f"  !! no {key} in this filer's submissions; skipped", file=sys.stderr)
            continue
        accession, detail = picks[key]
        cap = Capture(
            name=key,
            filename=filename,
            url=bundle_url(BERKSHIRE_CIK, accession),
            why=f"{why} ({detail})",
        )
        capture(cap)

    # ── derived: legacy SC 13G ─────────────────────────────────────────────
    idx = load("daily_index_20220214", "form_20220214.idx.gz").decode("latin-1")
    legacy_acc, legacy_cik = pick_legacy_13g(idx)
    legacy = Capture(
        name="schedule13g_legacy",
        filename="schedule13g_legacy.txt.gz",
        url=bundle_url(legacy_cik, legacy_acc),
        why=(
            "A pre-mandate `SC 13G` — HTML only. Proves has_structured_data is "
            "False and that the adapter still recovers identities rather than "
            "raising, so a 2019 filing's null percentOfClass reads as 'not "
            "machine-readable' and never as 'zero'."
        ),
    )
    capture(legacy)

    save_manifest(manifest)
    print(f"\nrequests used: {budget.used}/{budget.limit}", file=sys.stderr)
    if deferred:
        print(
            "DEFERRED (budget spent, nothing lost — raise REQUEST_BUDGET and "
            f"re-run to pick up only these): {', '.join(deferred)}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except urllib.error.HTTPError as exc:  # pragma: no cover - operator feedback
        # Never print the exception object raw: it carries the request, headers
        # included. Status and URL are enough to act on.
        print(f"HTTP {exc.code} for {exc.url}", file=sys.stderr)
        sys.exit(1)
