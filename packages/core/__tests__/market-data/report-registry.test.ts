/**
 * UNIT TEST — Report registry: date tokens + golden URLs (MONEY-1097 / P2).
 *
 * Exercises the REAL exported table and token builders from
 * packages/core/src/market-data/report-registry.ts (no shadow copies):
 *   - date tokens          — every casing/ordering NSE uses, incl. the two
 *                            month-name forms that differ only in case
 *   - golden URLs          — the full URL each family builds for ONE fixed day
 *   - registry invariants  — unique ids, unique feed slugs, evidence-gated
 *                            `enabled`, disabled families that cannot fetch
 *   - `familiesDue`        — cadence + startDate + null-URL filtering
 *
 * ## Why golden URLs and not "does it contain the date"
 *
 * The failure this guards against is silent. A wrong token case or a wrong path
 * segment produces a 404, and a 404 in this system legitimately means "market
 * holiday / not published yet" — so a broken URL and an ordinary non-trading
 * day are indistinguishable in the logs and in the sync log. Nothing downstream
 * would ever raise its hand. Pinning the entire string is the only check that
 * fails loudly at the moment someone edits a pattern.
 *
 * Pure functions throughout: no network, no Prisma, no GCS.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  REPORT_REGISTRY,
  allFamilies,
  enabledFamilies,
  familiesDue,
  familiesForBackfill,
  backfillableFamilies,
  familyById,
  tokDDMM,
  tokDDMMMYYYY,
  tokDDMMYY,
  tokDDMMYYYY,
  tokDashMonTitle,
  tokDashMonUpper,
  tokIsoDay,
  tokMonthUpper,
  tokSlash,
  tokYYYYMMDD,
} from "../../src/market-data/report-registry";

/**
 * One fixed trading day for every golden URL: Saturday 2026-08-08 IST.
 *
 * Anchored at UTC NOON so the +5:30 IST shift cannot cross a day boundary —
 * the same convention `resolveTargetDay`/`parseIsoDay` use, and the reason
 * MONEY-1157's archive-key fix mattered. A midnight-anchored Date would make
 * these assertions pass or fail depending on the runner's clock.
 */
const DAY = new Date(Date.UTC(2026, 7, 8, 12, 0, 0));

/** A single-digit day/month, to catch missing zero-padding. */
const PADDED_DAY = new Date(Date.UTC(2026, 0, 5, 12, 0, 0)); // 2026-01-05

describe("report-registry: date tokens", () => {
  it("builds every numeric ordering NSE uses", () => {
    assert.equal(tokYYYYMMDD(DAY), "20260808");
    assert.equal(tokDDMMYYYY(DAY), "08082026");
    assert.equal(tokDDMMYY(DAY), "080826");
    assert.equal(tokDDMM(DAY), "0808");
    assert.equal(tokSlash(DAY), "08/08/2026");
    assert.equal(tokIsoDay(DAY), "2026-08-08");
  });

  it("zero-pads single-digit days and months", () => {
    assert.equal(tokYYYYMMDD(PADDED_DAY), "20260105");
    assert.equal(tokDDMMYYYY(PADDED_DAY), "05012026");
    assert.equal(tokDDMMYY(PADDED_DAY), "050126");
    assert.equal(tokDDMM(PADDED_DAY), "0501");
  });

  it("distinguishes the two month-name casings, which is a real 404 source", () => {
    // Same site, same day, two different families — `oi_cli_limit` wants
    // UPPERCASE and `fii_stats` wants Title case. Getting either wrong 404s
    // silently, so both are pinned.
    assert.equal(tokDashMonUpper(DAY), "08-AUG-2026");
    assert.equal(tokDashMonTitle(DAY), "08-Aug-2026");
    assert.notEqual(tokDashMonUpper(DAY), tokDashMonTitle(DAY));
  });

  it("builds legacy and path-segment month names", () => {
    assert.equal(tokDDMMMYYYY(DAY), "08AUG2026");
    assert.equal(tokMonthUpper(DAY), "AUG");
    assert.equal(tokMonthUpper(PADDED_DAY), "JAN");
  });

  it("derives tokens from the IST calendar day, not UTC", () => {
    // 2026-08-07T19:00Z is 2026-08-08T00:30 IST — the IST day is the 8th.
    // A UTC-derived token would say the 7th and file the object under the
    // wrong day, which is precisely the MONEY-1157 archive-key bug.
    const lateUtc = new Date(Date.UTC(2026, 7, 7, 19, 0, 0));
    assert.equal(tokIsoDay(lateUtc), "2026-08-08");
    assert.equal(tokYYYYMMDD(lateUtc), "20260808");
  });
});

describe("report-registry: golden URLs", () => {
  /** Assert a family builds exactly this URL for DAY. */
  const golden = (id: string, expected: string): void => {
    const family = familyById(id);
    assert.ok(family, `no registry entry for ${id}`);
    assert.equal(family.buildUrl(DAY), expected, `${id} URL drifted`);
  };

  it("pins the NSE files production already fetches", () => {
    golden(
      "nse-cm-udiff-bhavcopy",
      "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_20260808_F_0000.csv.zip",
    );
    golden(
      "nse-indices-close",
      "https://nsearchives.nseindia.com/content/indices/ind_close_all_08082026.csv",
    );
  });

  it("pins the P1-verified NSE families", () => {
    golden(
      "nse-sec-bhavdata-full",
      "https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_08082026.csv",
    );
    golden(
      "nse-mto-delivery",
      "https://nsearchives.nseindia.com/archives/equities/mto/MTO_08082026.DAT",
    );
    golden(
      "nse-cd-udiff-bhavcopy",
      "https://nsearchives.nseindia.com/archives/cd/bhav/BhavCopy_NSE_CD_0_0_0_20260808_F_0000.csv.zip",
    );
    golden(
      "nse-com-udiff-bhavcopy",
      "https://nsearchives.nseindia.com/content/com/BhavCopy_NSE_CO_0_0_0_20260808_F_0000.csv.zip",
    );
  });

  it("pins the four SLB families to the live daily-reports?key=SLBS payload", () => {
    // MONEY-1200. Every one of these was wrong before 2026-08-14 and every one
    // of them 404'd in a way that reads exactly like a market holiday, which
    // is why the family sat empty for months without anything raising a hand.
    //
    // The strings below are NOT reconstructed from the working URLs — they are
    // `filePath` + `fileActlName` concatenated straight out of NSE's own
    // index, then fetched to confirm (200 + real CSV/DAT bytes for
    // 13-Aug-2026). Four details in them are load-bearing and each was a 404
    // on its own:
    //
    //   open_pos   NOT openpos   — one underscore
    //   bhavcopy   NOT bhav      — and SLBM_BC_ carries a trailing underscore
    //   seclist    NOT /content/slbs/ — different directory entirely
    //   .DAT/.CSV  UPPERCASE     — both lowercase forms 404
    //
    // Foreclosure is also the only SLB family on tokYYYYMMDD, and NSE
    // misspells it "Forclosure". Do not correct that spelling.
    golden(
      "nse-slb-openpos",
      "https://nsearchives.nseindia.com/archives/slbs/open_pos/slb_openpos_08082026.csv",
    );
    golden(
      "nse-slb-bhavcopy",
      "https://nsearchives.nseindia.com/archives/slbs/bhavcopy/SLBM_BC_08082026.DAT",
    );
    golden(
      "nse-slb-eligible",
      "https://nsearchives.nseindia.com/archives/slbs/seclist/SLB_ELG_SEC_08082026.csv",
    );
    golden(
      "nse-slb-foreclosure",
      "https://nsearchives.nseindia.com/content/slbs/Forclosure_SLB_20260808.CSV",
    );
  });

  it("claims the SLBS fileKeys so the drift guard stops calling them unknown", () => {
    // The guard diffs NSE's fileKey namespace against the union of
    // `nseFileKeys`. These four were observed live in the key=SLBS payload on
    // 2026-08-14; the fifth, SLBS-BEGIN-DAY-VAR, is deliberately unclaimed
    // (VaR DAT files are an explicit exclusion in this registry's header), so
    // it stays in the guard's informational `unregistered` list forever and
    // that is the intended outcome, not an oversight.
    const claimed = new Set(
      [
        "nse-slb-openpos",
        "nse-slb-bhavcopy",
        "nse-slb-eligible",
        "nse-slb-foreclosure",
      ].flatMap((id) => [...(familyById(id)?.nseFileKeys ?? [])]),
    );
    assert.deepEqual(
      [...claimed].sort(),
      [
        "SLBS-BHAVCOPY-DAT",
        "SLBS-ELIGIBLE-SECURITIES-LIST",
        "SLBS-FORCLOSURE-REPORT",
        "SLBS-OPEN-POSITION",
      ],
      "SLBS fileKeys drifted from the live index",
    );
    assert.ok(
      !claimed.has("SLBS-BEGIN-DAY-VAR"),
      "VaR files are an explicit registry exclusion — do not claim the key",
    );
  });

  it("pins the WDM families, whose path is a THREE-segment tree", () => {
    // MONEY-1201. `/content/debt/wdmlist_{DDMMYYYY}.csv` 404'd for months
    // because it dropped the `{YYYY}/{MON}/` segments entirely — and NSE's own
    // report index has been observed emitting a HALF-substituted
    // `/content/historical/WDM/20wdmlist_...` for this very file, i.e. its
    // template failing to fill those same two segments. The index is
    // authoritative, not infallible; these strings are the ones that were
    // fetched (200 + 1,243,367 B / 109,340 B for 13-Aug-2026).
    golden(
      "nse-wdm-list",
      "https://nsearchives.nseindia.com/content/historical/WDM/2026/AUG/wdmlist_08082026.csv",
    );
    // The daily bundle moved directory AND changed token width: the old row
    // built `/archives/wdm/dly/dly080826.zip` (DDMMYY), which 404s.
    golden(
      "nse-wdm-daily",
      "https://nsearchives.nseindia.com/content/debt/dly08082026.zip",
    );
  });

  it("keeps the WDM {MON} segment UPPERCASE — title/lower case both 404", () => {
    // Probed 2026-08-14: `/2026/JUL/` returns 200 at 1,240,522 B while
    // `/2026/Jul/` and `/2026/jul/` each return NSE's 3,546-byte 404 page. The
    // segment is case-sensitive, not locale-sensitive, so it reuses
    // `tokMonthUpper` (the nse-cm-legacy helper) rather than a new token.
    const url = familyById("nse-wdm-list")!.buildUrl(DAY)!;
    assert.ok(url.includes("/2026/AUG/"), `expected /2026/AUG/ in ${url}`);
    assert.ok(!url.includes("/Aug/"), "title-case month segment 404s");
    assert.ok(!url.includes("/aug/"), "lower-case month segment 404s");
    assert.equal(tokMonthUpper(DAY), "AUG");
  });

  it("pins the CBM same-day families, incl. the token that was wrong", () => {
    // The bhavcopy lives under /archives/debt/cbm/ (not /content/debt/) and its
    // token is YYYYMMDD with NO separating underscore.
    golden(
      "nse-cbm-trades",
      "https://nsearchives.nseindia.com/archives/debt/cbm/cbm_trd20260808.csv",
    );
    // The security master's PATH was always right; only the token was wrong.
    // DD-Mon-YYYY title case — the third family in this file on that casing.
    golden(
      "nse-corporate-bond-report",
      "https://nsearchives.nseindia.com/content/debt/Corporate_bond_report_08-Aug-2026.csv",
    );
  });

  it("pins the T+1 CBM/CD/CP/SDI families", () => {
    golden(
      "nse-cbm-list-mandatory",
      "https://nsearchives.nseindia.com/content/cbm/cbm_list_man_08082026.csv",
    );
    golden(
      "nse-cbm-list-non-mandatory",
      "https://nsearchives.nseindia.com/content/cbm/cbm_list_non_man_08082026.csv",
    );
    golden(
      "nse-cbm-unlisted-mandatory",
      "https://nsearchives.nseindia.com/content/cbm/cbm_unlist_man_08082026.csv",
    );
    golden(
      "nse-cbm-unlisted-non-mandatory",
      "https://nsearchives.nseindia.com/content/cbm/cbm_unlist_non_man_08082026.csv",
    );
    golden(
      "nse-cbm-failed-trades",
      "https://nsearchives.nseindia.com/content/cbm/cbm_fail_08082026.csv",
    );
    golden(
      "nse-cbm-gsec-settlement",
      "https://nsearchives.nseindia.com/archives/debt/cbm/GSEC_SettlementOrderReport_08082026.csv",
    );
    // CD and CP SHARE the /content/cd/ directory — CP is not under /content/cp/.
    golden(
      "nse-cd-settlement",
      "https://nsearchives.nseindia.com/content/cd/CD_SettlementOrderReport_08082026.csv",
    );
    golden(
      "nse-cp-settlement",
      "https://nsearchives.nseindia.com/content/cd/CP_SettlementOrderReport_08082026.csv",
    );
    // Directory segment is `sdi`, filenames are `sdt_` — both spellings are
    // NSE's and neither is a typo waiting to be tidied.
    golden(
      "nse-sdi-list-mandatory",
      "https://nsearchives.nseindia.com/content/sdi/sdt_list_man_08082026.csv",
    );
    golden(
      "nse-sdi-unlisted-mandatory",
      "https://nsearchives.nseindia.com/content/sdi/sdt_unlist_man_08082026.csv",
    );
    golden(
      "nse-sdi-list-non-mandatory",
      "https://nsearchives.nseindia.com/content/sdi/sdt_list_non_man_08082026.csv",
    );
    golden(
      "nse-sdi-unlisted-non-mandatory",
      "https://nsearchives.nseindia.com/content/sdi/sdt_unlist_non_man_08082026.csv",
    );
    golden(
      "nse-sdi-failed-trades",
      "https://nsearchives.nseindia.com/content/sdi/sdt_fail_08082026.csv",
    );
  });

  it("claims the CBM + WDM fileKeys but NOT the six WDM-SPAN keys", () => {
    // Observed live in the key=CBM (15 keys) and key=WDM (8 keys) payloads on
    // 2026-08-14. The six SPAN zips are an explicit registry exclusion — the
    // same rule that left SLBS-BEGIN-DAY-VAR unclaimed — so they stay in the
    // drift guard's informational `unregistered` list forever, by design.
    const claimed = new Set(
      REPORT_REGISTRY.flatMap((f) => [...(f.nseFileKeys ?? [])]),
    );
    for (const key of [
      "CBM-BHAVCOPY-CSV",
      "CBM-SECURITY-CSV",
      "CBM-NON-MANDATORY-CSV",
      "CBM-MANDATORY-CSV",
      "CBM-LIST-NON-MANDATORY-CSV",
      "CBM-LIST-MANDATORY-CSV",
      "CBM-LIST-TRADES-CSV",
      "CD-SETTLEMENT-DETAILS",
      "CP-SETTLEMENT-DETAILS",
      "CBM-GOV-SEC",
      "SDT-LIST-MAN-CSV",
      "SDT-UNLIST-MAN-CSV",
      "SDT-LIST-NON-MAN-CSV",
      "SDT-UNLIST-NON-MAN-CSV",
      "SDT-LIST-FAILED-TRADES-CSV",
      "WDM-SEC-AVAILABLE-FOR-TRADE",
      "WDM-DAILY-REPORT",
    ]) {
      assert.ok(claimed.has(key), `unclaimed live fileKey: ${key}`);
    }
    for (const key of [
      "WDM-SPAN-BEGIN-DAY",
      "WDM-SPAN-INTRA-DAY-1",
      "WDM-SPAN-INTRA-DAY-2",
      "WDM-SPAN-INTRA-DAY-3",
      "WDM-SPAN-INTRA-DAY-4",
      "WDM-SPAN-END-DAY",
    ]) {
      assert.ok(
        !claimed.has(key),
        `SPAN files are an explicit registry exclusion — do not claim ${key}`,
      );
    }
  });

  it("pins EGR to the pattern captured from the live daily-reports payload", () => {
    // fileActlName `EG_BC06082026.DAT` + filePath `/archives/egr/` — taken
    // verbatim from NSE's own JSON, so this string is evidence, not a guess.
    golden(
      "nse-egr-bhavcopy",
      "https://nsearchives.nseindia.com/archives/egr/EG_BC08082026.DAT",
    );
  });

  it("pins the two month-name families to their distinct casings", () => {
    golden(
      "nse-oi-cli-limit",
      "https://nsearchives.nseindia.com/content/nsccl/oi_cli_limit_08-AUG-2026.lst",
    );
    golden(
      "nse-fii-stats",
      "https://nsearchives.nseindia.com/content/fo/fii_stats_08-Aug-2026.xls",
    );
  });

  it("pins the P/E path that a placeholder URL once faked a PRESENT for", () => {
    golden(
      "nse-pe-ratio",
      "https://nsearchives.nseindia.com/content/equities/peDetail/PE_080826.csv",
    );
  });

  it("pins the gz masters", () => {
    golden(
      "nse-cm-security-master",
      "https://nsearchives.nseindia.com/content/master/NSE_CM_security_08082026.csv.gz",
    );
    golden(
      "nse-fo-contract-master",
      "https://nsearchives.nseindia.com/content/master/NSE_FO_contract_08082026.csv.gz",
    );
  });

  it("pins BSE, including the capital-B / lowercase-b directory split", () => {
    // BSE serves Equity from `/download/BhavCopy/` and Derivative from
    // `/download/Bhavcopy/`. That inconsistency is upstream's, it is real, and
    // P1 verified both — so it is pinned rather than "tidied".
    golden(
      "bse-cm-udiff-bhavcopy",
      "https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_20260808_F_0000.CSV",
    );
    golden(
      "bse-fo-udiff-bhavcopy",
      "https://www.bseindia.com/download/Bhavcopy/Derivative/BhavCopy_BSE_FO_0_0_0_20260808_F_0000.CSV",
    );
  });

  it("pins BSE gross delivery, whose year is in the PATH and day in the NAME", () => {
    golden(
      "bse-gross-delivery",
      "https://www.bseindia.com/BSEDATA/gross/2026/SCBSEALL0808.zip",
    );
  });

  it("pins rolling deal files to their undated upstream URL", () => {
    // No date token: upstream keeps one file and overwrites it. The DATE lives
    // in the archive key instead, and means "when we fetched", not "trade date".
    golden(
      "nse-bulk-deals",
      "https://nsearchives.nseindia.com/content/equities/bulk.csv",
    );
    golden(
      "nse-block-deals",
      "https://nsearchives.nseindia.com/content/equities/block.csv",
    );
  });

  it("pins the /api/reports door shapes captured from the live site", () => {
    // Every one of P1's guesses at these was wrong in a way that returned 404,
    // so the exact captured strings are pinned character-for-character. Debt
    // needs section "debt-segment" (NOT "debt") plus a top-level
    // type=debt-segment; Mutual Fund needs type "monthly-reports" (NOT
    // "archives"), a top-level type=mutual-fund, and NO date at all.
    golden(
      "nse-debt-weekly-reports",
      "https://www.nseindia.com/api/reports?archives=%5B%7B%22name%22%3A%22WDM%20-%20Weekly%20Reports%22%2C%22type%22%3A%22weekly-reports%22%2C%22category%22%3A%22debt%22%2C%22section%22%3A%22debt-segment%22%7D%5D&date=08-Aug-2026&type=debt-segment&mode=single",
    );
    golden(
      "nse-mf-approved-securities",
      "https://www.nseindia.com/api/reports?archives=%5B%7B%22name%22%3A%22Approved%20list%20of%20Securities%20(.zip)%22%2C%22type%22%3A%22monthly-reports%22%2C%22category%22%3A%22capital-market%22%2C%22section%22%3A%22mutual-fund%22%7D%5D&type=mutual-fund&mode=single",
    );
  });

  it("keeps `(.zip)` parentheses UNENCODED, as the site sends them", () => {
    // encodeURIComponent leaves !'()* alone, which is what makes the generated
    // string match the captured one byte-for-byte. If a future refactor swaps
    // in a stricter encoder the URL changes and the family silently 404s.
    const url = familyById("nse-mf-approved-mutual-funds")!.buildUrl(DAY)!;
    assert.ok(
      url.includes("(.zip)"),
      "parentheses must not be percent-encoded",
    );
    assert.ok(!url.includes("%28"), "found an encoded '('");
  });

  it("pins an index-constituent list", () => {
    golden(
      "nse-index-constituents-nifty50",
      "https://nsearchives.nseindia.com/content/indices/ind_nifty50list.csv",
    );
  });
});

describe("report-registry: invariants", () => {
  it("has unique ids", () => {
    const ids = REPORT_REGISTRY.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate family id");
  });

  it("gives every ENABLED family a distinct feed slug", () => {
    // Two enabled families sharing a slug would archive to the same GCS key and
    // silently overwrite each other. Disabled rows are exempt: several
    // deliberately point at an existing production feed.
    const slugs = enabledFamilies().map((f) => `${f.exchange}/${f.feed}`);
    assert.equal(
      new Set(slugs).size,
      slugs.length,
      "duplicate enabled feed slug",
    );
  });

  it("only enables families that have real evidence behind the URL", () => {
    // The core rule of this table. An "unverified" pattern is a guess, and a
    // guessed URL 404s indistinguishably from a market holiday — so it must
    // never be fetched nightly.
    for (const family of enabledFamilies()) {
      assert.notEqual(
        family.provenance,
        "unverified",
        `${family.id} is enabled with unverified provenance — probe it with --registry first`,
      );
    }
  });

  it("makes disabled-unknown-shape families unfetchable, not merely disabled", () => {
    // Belt and braces: `enabled:false` already stops the worker, but a family
    // whose shape is genuinely UNKNOWN also returns null from buildUrl, so
    // flipping `enabled` alone can never resurrect a known-wrong URL.
    //
    // This list used to hold three ids. Two graduated once their real shapes
    // were captured from the live site (MONEY-1097): `nse-debt-weekly-reports`
    // is now enabled, and `nse-cm-mutual-fund` was replaced by the four
    // `nse-mf-*` monthly families it turned out to be. `bse-egr` remains —
    // P1 proved BSE EGR does not ride the CM UDiFF file, but its own endpoint
    // is still undiscovered.
    for (const id of ["bse-egr"]) {
      const family = familyById(id);
      assert.ok(family, `no registry entry for ${id}`);
      assert.equal(family.enabled, false, `${id} must stay disabled`);
      assert.equal(family.buildUrl(DAY), null, `${id} must not build a URL`);
    }
  });

  it("gives every family a startDate that parses as an ISO day", () => {
    for (const family of allFamilies()) {
      assert.match(
        family.startDate,
        /^\d{4}-\d{2}-\d{2}$/,
        `${family.id} startDate`,
      );
    }
  });

  it("gives every family a non-empty note", () => {
    for (const family of allFamilies()) {
      assert.ok(family.notes.trim().length > 0, `${family.id} has no notes`);
    }
  });
});

describe("report-registry: NSE debt publication classes (MONEY-1201)", () => {
  /**
   * The 17 debt families split by WHEN NSE publishes day D's file, and that
   * split — not confidence in the URL — is what decides `enabled`.
   *
   * Probed 2026-08-14 at 18:32 IST, one hour before the 19:30 pass: the four
   * CLASS_A files for 14-Aug already existed; all thirteen CLASS_B files for
   * 14-Aug returned NSE's 3,546-byte 404 page while their 13-Aug counterparts
   * were healthy 200s. NSE's own report index agrees — its `CurrentDay` bucket
   * carries only the Class A keys (plus CBM-GOV-SEC, pointing at YESTERDAY's
   * filename), and lists everything else under `PreviousDay`.
   *
   * Both nightly passes (`report-archive-sync-evening` 19:30 and `-night`
   * 21:45, Mon-Fri) resolve to the CURRENT trading day, so a Class B family
   * enabled here would request `{name}_{D}` on day D and 404 on both passes,
   * every weekday, forever. That 404 is indistinguishable from a market
   * holiday — the exact silent failure this registry exists to prevent.
   *
   * This is the regression most likely to be "helpfully fixed" by a future
   * reader who sees `provenance: "p2-probed"` next to `enabled: false` and
   * reads it as an oversight. It is not: provenance describes the URL PATTERN
   * (proven), `enabled` answers "may the nightly job fetch this?" (no).
   */
  const CLASS_A = [
    "nse-wdm-list",
    "nse-wdm-daily",
    "nse-cbm-trades",
    "nse-corporate-bond-report",
  ] as const;

  const CLASS_B = [
    "nse-cbm-list-mandatory",
    "nse-cbm-list-non-mandatory",
    "nse-cbm-unlisted-mandatory",
    "nse-cbm-unlisted-non-mandatory",
    "nse-cbm-failed-trades",
    "nse-cbm-gsec-settlement",
    "nse-cd-settlement",
    "nse-cp-settlement",
    "nse-sdi-list-mandatory",
    "nse-sdi-unlisted-mandatory",
    "nse-sdi-list-non-mandatory",
    "nse-sdi-unlisted-non-mandatory",
    "nse-sdi-failed-trades",
  ] as const;

  it("enables EXACTLY the four same-day families", () => {
    for (const id of CLASS_A) {
      const f = familyById(id);
      assert.ok(f, `no registry entry for ${id}`);
      assert.equal(
        f.enabled,
        true,
        `${id} publishes same-day — must be nightly`,
      );
      assert.equal(f.provenance, "p2-probed", `${id} provenance`);
    }
  });

  it("keeps every T+1 family OUT of the nightly run", () => {
    for (const id of CLASS_B) {
      const f = familyById(id);
      assert.ok(f, `no registry entry for ${id}`);
      assert.equal(
        f.enabled,
        false,
        `${id} publishes on T+1 — enabling it 404s on BOTH nightly passes ` +
          `every weekday, and that 404 reads exactly like a market holiday. ` +
          `To flip it, re-probe {name}_{D} at >= 21:45 IST on a trading day D.`,
      );
    }
  });

  it("keeps every T+1 family BACKFILLABLE — that is how they get captured", () => {
    // enabled:false is not "we gave up". Each URL is date-addressable: asking
    // for a PAST day returns that day's file, which is exactly what
    // familiesForBackfill walks. Dropping backfillable would leave 13 proven
    // feeds with no capture route at all.
    for (const id of CLASS_B) {
      assert.equal(
        familyById(id)!.backfillable,
        true,
        `${id} must be walkable`,
      );
    }
    const picked = familiesForBackfill("1990-01-01", "2030-01-01").map(
      (x) => x.family.id,
    );
    for (const id of [...CLASS_A, ...CLASS_B]) {
      assert.ok(picked.includes(id), `${id} missing from the backfill set`);
    }
  });

  it("proves the split is real — familiesDue sees A but never B", () => {
    // The end-to-end assertion: whatever the flags say in isolation, the
    // NIGHTLY SELECTOR must return the four and none of the thirteen.
    const due = familiesDue(DAY, "daily").map((f) => f.id);
    for (const id of CLASS_A) assert.ok(due.includes(id), `${id} not due`);
    for (const id of CLASS_B) {
      assert.ok(!due.includes(id), `${id} must never be fetched nightly`);
    }
  });

  it("gives each family its OWN probed floor, not one shared guess", () => {
    // A single startDate for "the debt families" would manufacture years of
    // phantom 404s at one end and skip real history at the other. Every floor
    // below was bisected against live responses on 2026-08-14.
    const floors: Record<string, string> = {
      "nse-wdm-list": "2005-05-09", // 06-May-2005 404, 09-May-2005 200
      "nse-wdm-daily": "2009-11-03", // 02-Nov 404, 03-Nov 200
      "nse-cbm-trades": "2007-05-03", // 02-May 404, 03-May 200
      "nse-corporate-bond-report": "2020-01-02",
      "nse-cbm-gsec-settlement": "2020-02-17", // 03-Feb 404, 17-Feb 200
      "nse-sdi-list-mandatory": "2014-09-15", // ~9y deeper than its siblings
      "nse-sdi-failed-trades": "2014-09-15",
      "nse-sdi-unlisted-mandatory": "2024-07-15", // 15-Jul-2022 404
      "nse-sdi-list-non-mandatory": "2024-07-15",
      "nse-sdi-unlisted-non-mandatory": "2024-07-15",
    };
    for (const [id, floor] of Object.entries(floors)) {
      const f = familyById(id);
      assert.ok(f, id);
      assert.equal(f.startDate, floor, `${id} floor drifted`);
      assert.equal(
        f.startDateProvenance,
        "probed",
        `${id} floor must stay evidence-backed`,
      );
    }
    // The two SDI generations must NOT be collapsed onto one date.
    assert.notEqual(
      familyById("nse-sdi-list-mandatory")!.startDate,
      familyById("nse-sdi-unlisted-mandatory")!.startDate,
    );
  });

  it("never asks a family for a date before it existed", () => {
    // 15-Jul-2022: sdt_unlist_man 404s (did not exist), sdt_list_man 200s.
    const day2022 = new Date(Date.UTC(2022, 6, 15, 12, 0, 0));
    const walked = familiesForBackfill("2022-07-15", "2022-07-15").map(
      (x) => x.family.id,
    );
    assert.ok(!walked.includes("nse-sdi-unlisted-mandatory"));
    assert.ok(walked.includes("nse-sdi-list-mandatory"));
    // ...and the nightly selector applies the same floor.
    assert.ok(
      !familiesDue(day2022, "all")
        .map((f) => f.id)
        .includes("nse-cbm-gsec-settlement"),
    );
  });
});

describe("report-registry: backfillable (MONEY-941 step 0b)", () => {
  it("populates all FOUR enabled x backfillable quadrants", () => {
    // Each combination is real and load-bearing. If any quadrant were empty the
    // flag would be redundant with `enabled` and someone would eventually
    // collapse them — which breaks the backfill in two opposite directions.
    const q = (e: boolean, b: boolean) =>
      REPORT_REGISTRY.filter((f) => f.enabled === e && f.backfillable === b);

    assert.ok(q(true, true).length > 0, "nightly AND walkable (e.g. MTO)");
    assert.ok(q(true, false).length > 0, "nightly, no history (rolling)");
    assert.ok(q(false, true).length > 0, "backfill-only (workhorses, legacy)");
    assert.ok(q(false, false).length > 0, "neither (unknown shape)");
  });

  it("NEVER marks a rolling family backfillable — the corruption guard", () => {
    // A rolling URL carries no date and always serves today. Walking one would
    // archive TODAY's bytes under a past key, and the archive would then assert
    // something false about a date nobody will re-check. This is the single
    // most important invariant in the table.
    for (const f of REPORT_REGISTRY) {
      if (f.rolling) {
        assert.equal(
          f.backfillable,
          false,
          `${f.id} is rolling (undated URL) and MUST NOT be backfillable`,
        );
      }
    }
  });

  it("keeps the 3 inventory workhorses backfillable while NOT nightly", () => {
    // bhavcopy-sync owns their daily fetch, so enabled:false avoids fetching
    // identical bytes 3x/weekday. But only the backfill can walk their history,
    // and it is the most valuable history we have.
    for (const id of [
      "nse-cm-udiff-bhavcopy",
      "nse-indices-close",
      "bse-cm-udiff-bhavcopy",
    ]) {
      const f = familyById(id);
      assert.ok(f, id);
      assert.equal(f.enabled, false, `${id} must stay out of the nightly run`);
      assert.equal(f.backfillable, true, `${id} must be walkable`);
    }
  });

  it("selects for backfill on backfillable, NOT on enabled", () => {
    const picked = familiesForBackfill("1990-01-01", "2030-01-01").map(
      (x) => x.family.id,
    );
    // present despite enabled:false
    assert.ok(picked.includes("nse-cm-udiff-bhavcopy"));
    assert.ok(picked.includes("nse-cm-legacy"));
    // absent despite enabled:true
    assert.ok(!picked.includes("nse-bulk-deals"));
    assert.ok(!picked.includes("nse-index-constituents-nifty50"));
    assert.ok(picked.every((id) => familyById(id)!.backfillable));
  });

  it("clamps each family's window to its own era", () => {
    // Asking for 1990->2030 must not ask the legacy CM family for 2026 (its
    // format was retired) nor for 1990 (before it existed).
    const legacy = familiesForBackfill("1990-01-01", "2030-01-01").find(
      (x) => x.family.id === "nse-cm-legacy",
    );
    assert.ok(legacy);
    assert.equal(legacy.from, "1994-11-03");
    assert.equal(legacy.to, "2024-07-05");
  });

  it("drops a family whose era does not intersect the window", () => {
    const picked = familiesForBackfill("2025-01-01", "2025-12-31").map(
      (x) => x.family.id,
    );
    assert.ok(!picked.includes("nse-cm-legacy"), "era ended 2024-07-05");
    assert.ok(!picked.includes("nse-fo-legacy"));
  });

  it("honours an explicit family-id filter", () => {
    const picked = familiesForBackfill("1990-01-01", "2030-01-01", [
      "nse-cm-legacy",
    ]);
    assert.equal(picked.length, 1);
    assert.equal(picked[0]!.family.id, "nse-cm-legacy");
  });

  it("leaves the nightly selector untouched", () => {
    // familiesDue must keep reading `enabled` only — a backfill-only family
    // must never appear in a nightly run.
    const due = familiesDue(DAY, "all").map((f) => f.id);
    assert.ok(!due.includes("nse-cm-legacy"));
    assert.ok(!due.includes("nse-fo-legacy"));
    assert.ok(!due.includes("nse-cm-udiff-bhavcopy"));
    assert.ok(due.every((id) => familyById(id)!.enabled));
  });

  it("exposes backfillableFamilies() consistently — MINUS the api-gated rows", () => {
    // `requiresApi` describes the FETCH PATH, not the schedule: `getFeedAsset` →
    // `fetchExchangeAsset` carries no cookie jar, so a cookie-gated family gets
    // Akamai's challenge interstitial whether the request came from tonight's
    // run or from a backfill of 2019. The exclusion used to live only in
    // `isNightlyFetchable`, so this function still handed `bse-sensex-daily`
    // (requiresApi + backfillable) to exactly the path the flag exists to keep
    // it away from (MONEY-1236).
    assert.deepEqual(
      backfillableFamilies()
        .map((f) => f.id)
        .sort(),
      REPORT_REGISTRY.filter((f) => f.backfillable && !f.requiresApi)
        .map((f) => f.id)
        .sort(),
    );
  });

  it("the api-gated exclusion is LOAD-BEARING, not a no-op", () => {
    // A falsifiable ceiling. If no shipped row were both `backfillable` and
    // `requiresApi`, the assertion above would pass against either
    // implementation and prove nothing.
    const gatedAndBackfillable = REPORT_REGISTRY.filter(
      (f) => f.backfillable && f.requiresApi,
    ).map((f) => f.id);
    assert.ok(
      gatedAndBackfillable.length > 0,
      "expected at least one backfillable+requiresApi row to exercise the filter",
    );
    for (const id of gatedAndBackfillable) {
      assert.ok(
        !backfillableFamilies().some((f) => f.id === id),
        `${id} is cookie-gated and must not reach the archive fetch path`,
      );
      assert.ok(
        !familiesForBackfill("1990-01-01", "2030-01-01").some(
          (e) => e.family.id === id,
        ),
        `${id} must be excluded from familiesForBackfill for the same reason`,
      );
    }
  });
});

describe("report-registry: legacy era families (step 0c)", () => {
  it("pins the legacy CM golden URL, MMM uppercase", () => {
    // P1 fetched this exact URL for 1994-11-03.
    const d = new Date(Date.UTC(1994, 10, 3, 12, 0, 0));
    assert.equal(
      familyById("nse-cm-legacy")!.buildUrl(d),
      "https://nsearchives.nseindia.com/content/historical/EQUITIES/1994/NOV/cm03NOV1994bhav.csv.zip",
    );
  });

  it("pins the legacy FO golden URL", () => {
    const d = new Date(Date.UTC(2000, 5, 12, 12, 0, 0));
    assert.equal(
      familyById("nse-fo-legacy")!.buildUrl(d),
      "https://nsearchives.nseindia.com/content/historical/DERIVATIVES/2000/JUN/fo12JUN2000bhav.csv.zip",
    );
  });

  it("keeps both eras available across the 2024 overlap", () => {
    // Jan->Jul 2024 has BOTH formats. Archiving both is what makes the parity
    // check in step 4 possible, so neither may be clamped out of the overlap.
    const overlap = familiesForBackfill("2024-01-01", "2024-07-05").map(
      (x) => x.family.id,
    );
    assert.ok(overlap.includes("nse-cm-legacy"));
    assert.ok(overlap.includes("nse-cm-udiff-bhavcopy"));
  });

  it("never lets a legacy family into the nightly run — the era ended", () => {
    for (const id of ["nse-cm-legacy", "nse-fo-legacy"]) {
      assert.equal(familyById(id)!.enabled, false);
      assert.ok(familyById(id)!.endDate);
    }
  });
});

describe("report-registry: BSE legacy era families (MONEY-1101 / P7)", () => {
  // Golden URLs pinned against responses observed on 2026-08-13. A wrong token
  // here does not fail loudly — BSE answers 200 with its SPA page — so the
  // whole string is pinned, exactly as for the NSE legacy rows above.
  it("pins the no-ISIN legacy CM golden URL (DDMMYY, lowercase eq)", () => {
    // eq020107_csv.zip returned a real 219,745-byte CSV inside a zip.
    const d = new Date(Date.UTC(2007, 0, 2, 12, 0, 0));
    assert.equal(
      familyById("bse-cm-legacy")!.buildUrl(d),
      "https://www.bseindia.com/download/BhavCopy/Equity/eq020107_csv.zip",
    );
  });

  it("pins the ISIN-bearing legacy CM golden URL (DDMMYY, EQ_ISINCODE_)", () => {
    // EQ_ISINCODE_150323.zip returned a real 155,493-byte zip, 3,929 rows.
    const d = new Date(Date.UTC(2023, 2, 15, 12, 0, 0));
    assert.equal(
      familyById("bse-cm-isin-legacy")!.buildUrl(d),
      "https://www.bseindia.com/download/BhavCopy/Equity/EQ_ISINCODE_150323.zip",
    );
  });

  it("declares both as ZIPs — that is what rejects BSE's SPA page", () => {
    // BSE never 404s an absent file; it serves a 13,850-byte HTML page with a
    // 200. `validateFeedPayload` only catches that for a zip, via the
    // PK\x03\x04 magic. A row mis-declared as csv would archive the homepage.
    for (const id of ["bse-cm-legacy", "bse-cm-isin-legacy"]) {
      assert.equal(familyById(id)!.format, "zip", id);
    }
  });

  it("never lets a BSE legacy family into the nightly run — the era ended", () => {
    for (const id of ["bse-cm-legacy", "bse-cm-isin-legacy"]) {
      assert.equal(familyById(id)!.enabled, false, id);
      assert.ok(familyById(id)!.endDate, `${id} must declare an endDate`);
      assert.equal(familyById(id)!.backfillable, true, id);
    }
  });

  it("walks the pre-2017 years through the no-ISIN family ONLY", () => {
    // The ISIN file does not exist before 2017, so a walk of 2010 must not
    // include it — otherwise every day of that year is a payload ERROR.
    const ids = familiesForBackfill("2010-01-01", "2010-12-31").map(
      (x) => x.family.id,
    );
    assert.ok(ids.includes("bse-cm-legacy"));
    assert.ok(!ids.includes("bse-cm-isin-legacy"));
  });

  it("keeps both BSE eras available across their overlap", () => {
    // 2017 → mid-2024 has both files. Archiving both is what makes a
    // scrip-code-join vs ISIN-join parity check possible on the same day.
    const ids = familiesForBackfill("2023-01-01", "2023-12-31").map(
      (x) => x.family.id,
    );
    assert.ok(ids.includes("bse-cm-legacy"));
    assert.ok(ids.includes("bse-cm-isin-legacy"));
  });

  it("clamps both eras out of the UDiFF-only period", () => {
    const ids = familiesForBackfill("2025-01-01", "2025-12-31").map(
      (x) => x.family.id,
    );
    assert.ok(!ids.includes("bse-cm-legacy"));
    assert.ok(!ids.includes("bse-cm-isin-legacy"));
  });
});

describe("report-registry: familiesDue", () => {
  it("returns only enabled daily families for a normal day", () => {
    const due = familiesDue(DAY, "daily");
    assert.ok(due.length > 0);
    assert.ok(due.every((f) => f.enabled));
    assert.ok(due.every((f) => f.cadence === "daily"));
  });

  it("excludes a family whose startDate is after the target day", () => {
    // EGR starts 2026-05-01. A 2020 backfill must not manufacture requests for
    // a file that did not exist — those 404s would be indistinguishable from
    // real absences and would waste the exchange's patience.
    const old = new Date(Date.UTC(2020, 5, 15, 12, 0, 0));
    const due = familiesDue(old, "daily").map((f) => f.id);
    assert.ok(!due.includes("nse-egr-bhavcopy"));
    assert.ok(!due.includes("nse-cd-udiff-bhavcopy"));
    // ...but a long-lived family is still due.
    assert.ok(due.includes("nse-52wk-high-low"));
  });

  it("excludes the families bhavcopy-sync already fetches", () => {
    // These three rows build the SAME URLs as bhavcopy.ts and write to the SAME
    // GCS keys, so enabling them would fetch identical bytes a second and third
    // time each weekday (19:30 + 21:45 on top of bhavcopy-sync's 21:00) from
    // hosts that 403 under load — against MONEY-840's scrape-once principle.
    // They stay as inventory rows so the registry is complete.
    const due = familiesDue(DAY, "all").map((f) => f.id);
    for (const id of [
      "nse-cm-udiff-bhavcopy",
      "nse-indices-close",
      "bse-cm-udiff-bhavcopy",
    ]) {
      assert.ok(!due.includes(id), `${id} must not be fetched by this job`);
      assert.equal(familyById(id)?.enabled, false, `${id} must stay disabled`);
    }
  });

  it("never returns a family whose buildUrl is null", () => {
    for (const family of familiesDue(DAY, "all")) {
      assert.notEqual(
        family.buildUrl(DAY),
        null,
        `${family.id} returned a null URL`,
      );
    }
  });

  it("filters by cadence", () => {
    const weekly = familiesDue(DAY, "weekly");
    assert.ok(weekly.every((f) => f.cadence === "weekly"));
  });
});

describe("report-registry: nse-results-xbrl (MONEY-1204 P0.2)", () => {
  /**
   * The first family in this table that is ARCHIVED NIGHTLY while being
   * `enabled:false`, and the first whose fetcher is a different job entirely.
   *
   * That combination reads like a mistake, so each half is asserted with the
   * reason attached — this is the row most likely to be "helpfully fixed" by a
   * future reader who sees `provenance: "existing-code"` next to
   * `enabled: false` and reads it as an oversight, exactly the way MONEY-1201's
   * thirteen T+1 debt families are.
   */
  const XBRL = "nse-results-xbrl";

  it("is registered at the slug the archive key and the worker both use", () => {
    const f = familyById(XBRL);
    assert.ok(f, "no registry entry for nse-results-xbrl");
    assert.equal(f.exchange, "NSE");
    assert.equal(f.feed, "results-xbrl");
    assert.equal(f.format, "xml");
  });

  it("stays OUT of the nightly report-archive pass", () => {
    // The mechanism, not just the flag: report-archive-sync fetches
    // familiesDue() -> enabledFamilies() -> .filter(f => f.enabled).
    const f = familyById(XBRL)!;
    assert.equal(f.enabled, false);
    for (const cadence of ["daily", "weekly", "monthly", "all"] as const) {
      assert.ok(
        !familiesDue(DAY, cadence).some((x) => x.id === XBRL),
        `${XBRL} must not be due for cadence=${cadence}`,
      );
    }
  });

  it("cannot be fetched by flipping `enabled` alone", () => {
    // Belt and braces, the same guarantee `bse-egr` gets. A filing URL is a
    // function of the FILING (INDAS_{co}_{seq}_{DDMMYYYYHHMMSS}.xml), and no
    // function of a date can produce one — so buildUrl returns null for every
    // day, and report-archive-sync's own `if (!url) return absent` catches it
    // even if someone enables the row.
    const f = familyById(XBRL)!;
    for (const d of [
      DAY,
      new Date(Date.UTC(2018, 4, 15)),
      new Date(Date.UTC(2026, 0, 31)),
    ]) {
      assert.equal(f.buildUrl(d), null, `built a URL for ${d.toISOString()}`);
    }
  });

  it("is NOT backfillable — the index is the only route to a filing URL", () => {
    // `familiesForBackfill` walks a family by handing buildUrl a day. Marking
    // this backfillable would enter it into a walk that can only ever produce
    // nulls, and a walk that visits thousands of days for nothing looks exactly
    // like a walk that found nothing.
    assert.equal(familyById(XBRL)!.backfillable, false);
    assert.ok(
      !backfillableFamilies().some((f) => f.id === XBRL),
      "must not be offered to the feed backfiller",
    );
    assert.ok(
      !familiesForBackfill("1990-01-01", "2030-01-01").some(
        (p) => p.family.id === XBRL,
      ),
    );
  });

  it("declares evidence, not a guess — provenance is `existing-code`", () => {
    // The per-filing URLs are fetched in production TODAY by
    // workers/src/processors/xbrl-sync.ts. "unverified" would claim we do not
    // know where these come from; what we cannot do is DERIVE one from a date.
    assert.equal(familyById(XBRL)!.provenance, "existing-code");
  });

  it("declares the MEASURED startDate, not the 2020 helper default", () => {
    // On the `.xml` suffix: 0% Jul-2012 -> Feb-2018, 89% May-2018, 97-98% from
    // 2019. The stub url starts with "http", so a startsWith('http') check
    // reports ~100% coverage back to 2012 — six years of nothing.
    const f = familyById(XBRL)!;
    assert.equal(f.startDate, "2018-05-01");
    assert.equal(f.startDateProvenance, "probed");
  });

  it("needs no buildBasename — filing URLs are per-filing unique", () => {
    assert.equal(familyById(XBRL)!.buildBasename, undefined);
  });

  it("names its fetcher and its key grammar in the notes", () => {
    // The notes are the only place a reader learns that a DISABLED row is
    // archived every night, and by whom. An empty or vague note here is the
    // whole defect.
    const notes = familyById(XBRL)!.notes;
    assert.match(notes, /xbrl-sync/);
    assert.match(notes, /getFeedAsset/);
    assert.match(notes, /feeds\/NSE\/results-xbrl/);
    assert.match(notes, /enabled:false/);
  });

  it("keeps all FOUR enabled x backfillable quadrants populated", () => {
    // Re-asserted here because this row lands in the sparsest quadrant
    // (false/false, previously `bse-egr` alone). If a later cleanup deleted
    // bse-egr believing this row replaced it, the quadrant invariant still
    // holds — which is the point of checking it from the new row's own suite.
    for (const [e, b] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      assert.ok(
        REPORT_REGISTRY.some((f) => f.enabled === e && f.backfillable === b),
        `quadrant enabled=${e} backfillable=${b} is empty`,
      );
    }
    const f = familyById(XBRL)!;
    assert.equal(f.enabled, false);
    assert.equal(f.backfillable, false);
  });

  it("does not collide with any enabled family's slug", () => {
    const slugs = enabledFamilies().map((f) => `${f.exchange}/${f.feed}`);
    assert.ok(!slugs.includes("NSE/results-xbrl"));
    assert.equal(
      allFamilies().filter(
        (f) => `${f.exchange}/${f.feed}` === "NSE/results-xbrl",
      ).length,
      1,
    );
  });
});
