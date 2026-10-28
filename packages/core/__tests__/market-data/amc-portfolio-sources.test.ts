/**
 * The AMC resolver table, and its join to AMFI's authoritative registry.
 *
 * MONEY-1105 (Data Engine P8a).
 *
 * The property under test is not "do these URLs look right" — a URL cannot be
 * proven by a unit test. It is that the table's OWN discipline holds: that
 * `provenance` actually gates fetching, that the AMFI join key is real, and
 * that the coverage number a scheduled run reports is derived rather than
 * asserted.
 *
 * That matters because the failure this whole file exists to prevent is silent:
 * a guessed URL 404s identically to "not published yet", so an over-eager
 * `fetchableSources()` would report zero rows forever while every log line read
 * as success.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AMC_SOURCES,
  fetchableSources,
  amcSource,
  resolverCoverage,
  buildHdfcUrl,
  monthEnd,
  monthStart,
  ordinal,
  type AmcId,
} from "../../src/market-data/amc-portfolio-sources";
import { AMC_PAGE_SCRAPERS } from "../../src/market-data/amc-page-scrape";
import { parseAmfiAmcRegistry } from "../../src/market-data/amfi-amc-registry";

const AMFI_FIXTURE = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "amfi",
  "portfolio-disclosure.trimmed.html",
);

/** July 2026 — the month every committed AMC workbook fixture describes. */
const JULY_2026 = new Date(Date.UTC(2026, 6, 15));

describe("provenance is what gates fetching (MONEY-1105)", () => {
  it("never exposes an unverified source to a scheduled run", () => {
    // The load-bearing rule. If this ever passes something non-`verified`, a
    // guessed URL reaches the network and its 404 is indistinguishable from a
    // publication delay.
    for (const s of fetchableSources()) {
      assert.equal(
        s.provenance,
        "verified",
        `${s.id} is fetchable but only '${s.provenance}'`,
      );
    }
  });

  it("never exposes a source it cannot arrive at a URL for", () => {
    // MONEY-1407 widened this from "has a `buildUrl`" to "has a `buildUrl` OR
    // a `discoverUrl`". UTI's file is a CloudFront object whose key carries a
    // `?VersionId=`, so there is nothing to build and the only way in is its
    // own JSON index — a second REQUEST, not a second spelling. The invariant
    // the rule protects is unchanged: a scheduled run must never be handed a
    // source it has to guess at.
    for (const s of fetchableSources()) {
      assert.ok(
        s.buildUrl !== null || s.discoverUrl !== undefined,
        `${s.id} is fetchable with no way to reach a URL`,
      );
    }
  });

  it("UTI is fetchable BY DISCOVERY, never by a guessed template (MONEY-1407)", () => {
    // This test used to pin ABSL and Kotak, then UTI, as the house that must
    // stay OUT. All three are in now, and each was promoted the same way: a
    // real fetch of the current month, opened, counted. UTI's measurement
    // (2026-09-14) was 85 scheme sheets, 5,435 holdings, as-on 2026-08-31 on
    // every one, 85 of 85 passing `judgeSheetWrite`.
    //
    // What the row must NOT have acquired is a `buildUrl`. The lesson the
    // earlier version carried — a 200 is not an ingest — survives as its
    // sibling: a CONSTRUCTED url is not a discovered one, and a guessed one
    // 404s identically to "not published yet".
    const ids = fetchableSources().map((s) => s.id);
    assert.ok(ids.includes("UTI"));
    assert.equal(amcSource("UTI")?.provenance, "verified");
    assert.equal(
      amcSource("UTI")?.buildUrl,
      null,
      "there is nothing to build — the VersionId is not derivable",
    );
    assert.ok(amcSource("UTI")?.discoverUrl, "it is asked for");
    // ...and the row must SAY what the sheet looks like, so the next reader
    // does not re-derive the API or the split.
    assert.match(amcSource("UTI")!.notes, /EXPOSURE/);
  });

  it("Kotak and ICICI are fetchable, and their URLs are the ones measured", () => {
    // MONEY-1405 D3. Both were fetched for August-2026 before this was written;
    // the exact strings are pinned because each carries a spelling that reads
    // like a typo and is not: Kotak's literal comma in the DIRECTORY beside a
    // separator-less FILENAME, and ICICI's abbreviated month FOLDER beside a
    // spelled-out month in the file.
    const august = new Date(Date.UTC(2026, 7, 15));
    assert.equal(
      amcSource("KOTAK")!.buildUrl!(august),
      "https://vatseelabs-s3.kotakmf.com/FormsDownloads/Portfolios/" +
        "Consolidated-SEBI-Portfolio-as-on-August-31,-2026/" +
        "ConsolidatedSEBIPortfolioAugust2026.xlsx",
    );
    // NEVER `www.kotakmf.com` — MONEY-1197 measured a Radware bot wall there.
    assert.ok(!amcSource("KOTAK")!.buildUrl!(august).includes("www."));
    // MONEY-1408 — the PRIMARY url for August is the ABBREVIATED folder. It
    // used to be the full name, which 404s; see the next test.
    assert.equal(
      amcSource("ICICI")!.buildUrl!(august),
      "https://www.icicipruamc.com/blob/downloads/Files/" +
        "Monthly%20Portfolio%20Disclosures/2026/Aug/" +
        "Monthly-Portfolio-Disclosure-August-2026.zip",
    );
    assert.deepEqual(amcSource("ICICI")!.altUrls!(august), [
      "https://www.icicipruamc.com/blob/downloads/Files/" +
        "Monthly%20Portfolio%20Disclosures/2026/August/" +
        "Monthly-Portfolio-Disclosure-August-2026.zip",
    ]);
    // May needs no fallback — its name is already three letters, so a second
    // candidate would be a duplicate request every month of May, forever.
    assert.deepEqual(
      amcSource("ICICI")!.altUrls!(new Date(Date.UTC(2026, 4, 15))),
      [],
    );
  });

  it("ICICI's PRIMARY url is the spelling that answers 200 (MONEY-1408)", () => {
    // ## The measurement, 2026-09-14, every published month of 2026
    //
    // Both spellings, three HEAD probes each — a single status is not evidence
    // on this host, which answered 404 once and 200 on four consecutive retries
    // minutes later:
    //
    //   January   `January`  404 · `Jan`  200      May    `May`  200 (only one)
    //   February  `February` 404 · `Feb`  200      June   `June` 200 · `Jun` 404
    //   March     `March`    404 · `Mar`  200      July   `July` 200 · `Jul` 404
    //   April     `April`    404 · `Apr`  200      August `August` 404 · `Aug` 200
    //
    // 8 of 8 fit one rule — abbreviate unless the name is four letters or fewer
    // — and the registry's own note called the same five observations ruleless
    // and ordered the FULL name first. That made `buildUrl` a 404 in five of
    // the eight months while the row read `provenance: "verified"`, invisible
    // only because the one consumer that exists also tries `altUrls`.
    //
    // MUTATION: restore `return full === abbr ? [full] : [full, abbr]` -> RED
    // on every month below except May, June and July.
    const folderOf = (url: string) => url.split("/2026/")[1]!.split("/")[0]!;
    const EXPECTED: ReadonlyArray<readonly [number, string, string | null]> = [
      [0, "Jan", "January"],
      [1, "Feb", "February"],
      [2, "Mar", "March"],
      [3, "Apr", "April"],
      [4, "May", null], // its name IS its abbreviation — no second request
      [5, "June", "Jun"],
      [6, "July", "Jul"],
      [7, "Aug", "August"],
    ];
    for (const [m, primary, fallback] of EXPECTED) {
      const month = new Date(Date.UTC(2026, m, 15));
      assert.equal(
        folderOf(amcSource("ICICI")!.buildUrl!(month)),
        primary,
        `month ${m + 1}: primary folder`,
      );
      assert.deepEqual(
        amcSource("ICICI")!.altUrls!(month).map(folderOf),
        fallback === null ? [] : [fallback],
        `month ${m + 1}: fallback folder`,
      );
      // The FILENAME is the full month in every one of the eight, whichever
      // way the folder went. Getting this backwards is the other 404.
      for (const url of [
        amcSource("ICICI")!.buildUrl!(month),
        ...amcSource("ICICI")!.altUrls!(month),
      ]) {
        assert.match(
          url,
          /Monthly-Portfolio-Disclosure-(January|February|March|April|May|June|July|August)-2026\.zip$/,
          `month ${m + 1}: filename must be the FULL month`,
        );
      }
    }
  });

  it("REGRESSION: HDFC has no month-alone builder — it is per-scheme", () => {
    // HDFC publishes ONE FILE PER SCHEME, so a month alone cannot build a URL:
    // `buildUrl` is null on purpose and `buildHdfcUrl(month, scheme)` is the
    // builder. `fetchableSources()` means "resolvable from a month ALONE", so
    // HDFC is correctly absent from it — the worker fetches it on a separate
    // per-scheme path using the NAVAll scheme list.
    //
    // Pinned because the tempting "fix" is to invent a whole-AMC URL for HDFC,
    // which does not exist and would 404 forever.
    const hdfc = amcSource("HDFC");
    assert.equal(hdfc?.provenance, "verified");
    assert.equal(hdfc?.perScheme, true);
    assert.equal(hdfc?.buildUrl, null);
    assert.ok(!fetchableSources().some((s) => s.id === "HDFC"));
  });

  it("Nippon is flagged UNBACKFILLABLE — the schedule carries its risk", () => {
    // Its June file 404s while July serves, so a missed month may be gone for
    // good. This is why the job runs on the 12th AND the 20th.
    assert.equal(amcSource("NIPPON")?.backfillable, false);
    // Everyone else keeps history.
    for (const s of AMC_SOURCES) {
      if (s.id !== "NIPPON") {
        assert.equal(s.backfillable, true, `${s.id} backfillable`);
      }
    }
  });
});

describe("the AMFI join key is real (MONEY-1105)", () => {
  const registry = parseAmfiAmcRegistry(readFileSync(AMFI_FIXTURE, "utf8"));

  it("the fixture parsed — a null here would make every assertion vacuous", () => {
    assert.notEqual(registry, null);
    assert.ok(
      (registry?.amcs.length ?? 0) >= 8,
      `only ${registry?.amcs.length} AMCs parsed from the fixture`,
    );
  });

  it("every source carries a non-empty numeric AMFI id", () => {
    for (const s of AMC_SOURCES) {
      assert.match(s.amfiMfId, /^\d+$/, `${s.id} amfiMfId`);
    }
  });

  it("no two sources claim the same AMFI id", () => {
    const seen = new Map<string, AmcId>();
    for (const s of AMC_SOURCES) {
      const prior = seen.get(s.amfiMfId);
      assert.equal(
        prior,
        undefined,
        `${s.id} and ${prior} both claim mfId ${s.amfiMfId}`,
      );
      seen.set(s.amfiMfId, s.id);
    }
  });

  it("every AMFI id is PINNED BY VALUE, against the live registry", () => {
    // MONEY-1407. The test below can only check the ids the TRIMMED fixture
    // happens to carry, and it `continue`s past the rest — so a NONEXISTENT id
    // looks exactly like a trimmed-away one. ICICI carried `2` for two
    // releases; AMFI's registry has 57 AMCs and no `2` at all, so
    // `resolverCoverage` counted ICICI in neither bucket and named it nightly
    // as an AMC with no resolver while it was writing ~9,857 holdings a month.
    //
    // Each value here was read from AMFI's own feed on 2026-09-14. Pinning them
    // does not prove an id is right — nothing offline can — but it makes
    // changing one a deliberate edit that fails a test first.
    // MUTATION: put `2` back on ICICI -> RED here.
    const pinned: Record<string, string> = {
      SBI: "22", // SBI Mutual Fund
      NIPPON: "21", // Nippon India Mutual Fund
      HDFC: "9", // HDFC Mutual Fund
      KOTAK: "17", // Kotak Mahindra Mutual Fund
      ICICI: "20", // ICICI Prudential Mutual Fund
      UTI: "28", // UTI Mutual Fund
    };
    assert.deepEqual(
      Object.fromEntries(AMC_SOURCES.map((s) => [s.id, s.amfiMfId])),
      pinned,
      "a row was added, removed or re-keyed — check it against AMFI's registry",
    );
  });

  it("the ids we hard-code match AMFI's own registry, by NAME", () => {
    // Guards a transposed digit. An id that exists but points at the wrong AMC
    // would silently attribute one house's schemes to another, and nothing
    // downstream could notice.
    const expected: Partial<Record<AmcId, string>> = {
      SBI: "SBI Mutual Fund",
      NIPPON: "Nippon India Mutual Fund",
      HDFC: "HDFC Mutual Fund",
      ABSL: "Aditya Birla Sun Life Mutual Fund",
      KOTAK: "Kotak Mahindra Mutual Fund",
    };
    let checked = 0;
    for (const s of AMC_SOURCES) {
      const amfi = registry?.amcs.find((a) => a.mfId === s.amfiMfId);
      // The fixture is TRIMMED, so not every AMC is present — only assert on
      // the ones it actually carries.
      if (!amfi) continue;
      assert.equal(amfi.fundName, expected[s.id], `mfId ${s.amfiMfId}`);
      checked++;
    }
    assert.ok(checked > 0, "the trimmed fixture carried none of our AMCs");
  });
});

describe("the two tables share one AMFI id-space (MONEY-1105)", () => {
  // `AmcId` is what lands in `MfPortfolioHolding.amc` and `amfiMfId` is the join
  // to AMFI. Both must be unique ACROSS the tables, not within them: the whole
  // reason there are two resolvers is a mechanism difference, and an AMC that
  // acquired a row in each would be written twice under two names.

  const ALL = [
    ...AMC_SOURCES.map((s) => ({ id: s.id, amfiMfId: s.amfiMfId })),
    ...AMC_PAGE_SCRAPERS.map((s) => ({ id: s.id, amfiMfId: s.amfiMfId })),
  ];

  it("no AmcId appears in both tables", () => {
    const ids = ALL.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate id in ${ids}`);
  });

  it("no AMFI id is claimed twice, across both tables", () => {
    const seen = new Map<string, string>();
    for (const s of ALL) {
      const prior = seen.get(s.amfiMfId);
      assert.equal(
        prior,
        undefined,
        `${s.id} and ${prior} both claim mfId ${s.amfiMfId}`,
      );
      seen.set(s.amfiMfId, s.id);
    }
  });

  it("every page-scrape house carries a numeric AMFI id too", () => {
    for (const s of AMC_PAGE_SCRAPERS) {
      assert.match(s.amfiMfId, /^\d+$/, `${s.id} amfiMfId`);
    }
  });

  it("every page-scrape AMFI id is PINNED BY VALUE, against the live registry", () => {
    // MONEY-1401 review F5. The `AMC_SOURCES` pin above covered SIX of the
    // nineteen registered houses; the other thirteen were checked only by the
    // NAME join below, which runs over a TRIMMED fixture carrying just 10 AMCs
    // and `continue`s past the rest — so for 11 of these 13 a NONEXISTENT id
    // looks exactly like a trimmed-away one. That is precisely the hole ICICI's
    // `"2"` survived in, and the symptom is silent and expensive:
    // `resolverCoverage` joins AMFI's registry on `amfiMfId`, so an unmatched
    // house is bucketed `missing` and NAMED nightly as having no resolver while
    // it writes holdings every month.
    //
    // Every value here was read from AMFI's own registry payload on
    // 2026-09-14 (57 AMCs) and re-verified against it for this test. Pinning
    // does not prove an id is right — nothing offline can — but it makes
    // changing one a deliberate edit that fails a test first, and it does not
    // decay when the fixture is re-trimmed.
    // MUTATION: change any value, or add/remove a row -> RED here.
    const pinned: Record<string, string> = {
      ABSL: "3", // Aditya Birla Sun Life Mutual Fund
      DSP: "6", // DSP Mutual Fund
      PPFAS: "64", // PPFAS Mutual Fund
      TATA: "25", // Tata Mutual Fund
      ZERODHA: "77", // Zerodha Mutual Fund
      GROWW: "63", // Groww Mutual Fund
      OLD_BRIDGE: "78", // Old Bridge Mutual Fund
      CAPITALMIND: "81", // Capitalmind Mutual Fund
      MIRAE: "45", // Mirae Asset Mutual Fund
      BARODA_BNP: "4", // Baroda BNP Paribas Mutual Fund
      SHRIRAM: "67", // Shriram Mutual Fund
      HELIOS: "76", // Helios Mutual Fund
      THREE_SIXTY_ONE: "62", // 360 ONE Mutual Fund
    };
    assert.deepEqual(
      Object.fromEntries(AMC_PAGE_SCRAPERS.map((s) => [s.id, s.amfiMfId])),
      pinned,
      "a row was added, removed or re-keyed — check it against AMFI's registry",
    );
  });

  it("all NINETEEN registered houses are covered by a value pin", () => {
    // The pins above are two literals in two `it`s, and a new house added to
    // either registry without a pin would simply not be checked by the other.
    // This is the counter that makes "6 of 19" impossible to reach again.
    // MUTATION: delete a row from either `pinned` literal -> RED (the deepEqual
    // fires first, but this is what fails if somebody "fixes" that by dropping
    // the registry row's id from the comparison instead).
    assert.equal(AMC_SOURCES.length + AMC_PAGE_SCRAPERS.length, 19);
  });

  it("the page-scrape ids match AMFI's registry by NAME where the fixture has them", () => {
    // Same guard as the AMC_SOURCES version above: an id that exists but points
    // at the wrong AMC attributes one house's schemes to another, silently.
    // Every value here was read off AMFI's live registry on 2026-08-14; the
    // trimmed fixture happens to carry 360 ONE, so at least one is enforced
    // against AMFI's own bytes rather than against this list.
    const expected: Record<string, string> = {
      // MONEY-1405 D3 — moved here from AMC_SOURCES: its filename is ad-hoc
      // (seven conventions in twenty months), so only a listing can resolve it.
      ABSL: "Aditya Birla Sun Life Mutual Fund",
      DSP: "DSP Mutual Fund",
      PPFAS: "PPFAS Mutual Fund",
      TATA: "Tata Mutual Fund",
      ZERODHA: "Zerodha Mutual Fund",
      GROWW: "Groww Mutual Fund",
      OLD_BRIDGE: "Old Bridge Mutual Fund",
      CAPITALMIND: "Capitalmind Mutual Fund",
      MIRAE: "Mirae Asset Mutual Fund",
      BARODA_BNP: "Baroda BNP Paribas Mutual Fund",
      SHRIRAM: "Shriram Mutual Fund",
      HELIOS: "Helios Mutual Fund",
      THREE_SIXTY_ONE: "360 ONE Mutual Fund",
    };
    const registry = parseAmfiAmcRegistry(readFileSync(AMFI_FIXTURE, "utf8"));

    let checked = 0;
    for (const s of AMC_PAGE_SCRAPERS) {
      // Every house must at least be NAMED here, so a new row cannot be added
      // without stating which AMFI AMC it claims to be.
      assert.equal(expected[s.id], s.name, `${s.id} name`);
      const amfi = registry?.amcs.find((a) => a.mfId === s.amfiMfId);
      if (!amfi) continue; // trimmed fixture
      assert.equal(amfi.fundName, expected[s.id], `mfId ${s.amfiMfId}`);
      checked++;
    }
    assert.ok(checked > 0, "the trimmed fixture carried none of these AMCs");
  });
});

describe("resolverCoverage is derived, not asserted (MONEY-1105)", () => {
  it("partitions the registry exactly — every AMC lands in one bucket", () => {
    const reg = [
      { mfId: "22", fundName: "SBI Mutual Fund" }, // fetchable
      { mfId: "9", fundName: "HDFC Mutual Fund" }, // known, per-scheme
      { mfId: "28", fundName: "UTI Mutual Fund" }, // fetchable BY DISCOVERY
      { mfId: "999", fundName: "Nobody Mutual Fund" }, // missing
    ];
    const c = resolverCoverage(reg);
    assert.equal(c.total, 4);
    // MONEY-1407 — UTI moved from `knownButNotFetchable` to `resolved`, which
    // is the whole point of that ticket and is the one number this function
    // exists to report.
    assert.deepEqual(c.resolved, ["SBI Mutual Fund", "UTI Mutual Fund"]);
    assert.deepEqual(c.knownButNotFetchable, ["HDFC Mutual Fund"]);
    assert.deepEqual(c.missing, ["Nobody Mutual Fund"]);
    // No AMC may be double-counted or dropped.
    assert.equal(
      c.resolved.length + c.knownButNotFetchable.length + c.missing.length,
      c.total,
    );
  });

  it("distinguishes KNOWN-but-blocked from NEVER-considered", () => {
    // The distinction that makes the number actionable: an AMC we investigated
    // and could not prove needs different work from one nobody has looked at.
    const c = resolverCoverage([
      // HDFC: a row here, verified, and STILL not fetchable — it publishes one
      // file per scheme and a month alone does not name them. The bucket must
      // survive the last `observed` row leaving it.
      { mfId: "9", fundName: "HDFC Mutual Fund" },
      { mfId: "999", fundName: "Nobody Mutual Fund" },
    ]);
    assert.equal(c.knownButNotFetchable.length, 1);
    assert.equal(c.missing.length, 1);
    assert.notDeepEqual(c.knownButNotFetchable, c.missing);
  });

  it("an empty registry is zero coverage, not a crash", () => {
    const c = resolverCoverage([]);
    assert.deepEqual(c, {
      total: 0,
      resolved: [],
      knownButNotFetchable: [],
      missing: [],
    });
  });
});

describe("URL builders — the date spellings (MONEY-1105)", () => {
  it("SBI uses an ENGLISH ORDINAL and a lowercase month", () => {
    const url = amcSource("SBI")!.buildUrl!(JULY_2026);
    assert.match(url, /as-on-31st-july-2026\.xlsx$/);
    // The plain spelling is a DIFFERENT url and 404s.
    assert.ok(!url.includes("as-on-31-july"));
  });

  it("Nippon uses a TITLE-case month and a TWO-DIGIT year", () => {
    const url = amcSource("NIPPON")!.buildUrl!(JULY_2026);
    assert.match(url, /NIMF-MONTHLY-PORTFOLIO-31-July-26\.xls$/);
  });

  it("REGRESSION: HDFC's url carries TWO different months", () => {
    // The path segment is the PUBLICATION month (August) and the filename is
    // the DATA month (July). Using one for both is a 404 — and the kind that
    // looks like "not published yet".
    const url = buildHdfcUrl(JULY_2026, "HDFC Value Fund");
    assert.ok(url.includes("/2026-08/"), "path must be the publication month");
    assert.ok(
      decodeURIComponent(url).includes("31 July 2026"),
      "filename must be the data month",
    );
    assert.ok(!url.includes("/2026-07/"), "path must NOT be the data month");
  });

  it("ordinal handles the 11th/12th/13th exception", () => {
    // 11/12/13 take "th" despite ending in 1/2/3. A version that only handled
    // month-ends (28-31) would look correct and be wrong everywhere else.
    assert.equal(ordinal(1), "1st");
    assert.equal(ordinal(2), "2nd");
    assert.equal(ordinal(3), "3rd");
    assert.equal(ordinal(11), "11th");
    assert.equal(ordinal(12), "12th");
    assert.equal(ordinal(13), "13th");
    assert.equal(ordinal(21), "21st");
    assert.equal(ordinal(22), "22nd");
    assert.equal(ordinal(23), "23rd");
    assert.equal(ordinal(31), "31st");
  });

  it("monthEnd/monthStart are correct across February and a leap year", () => {
    assert.equal(
      monthEnd(new Date(Date.UTC(2026, 1, 10)))
        .toISOString()
        .slice(0, 10),
      "2026-02-28",
    );
    assert.equal(
      monthEnd(new Date(Date.UTC(2028, 1, 10)))
        .toISOString()
        .slice(0, 10),
      "2028-02-29",
    );
    assert.equal(
      monthStart(JULY_2026).toISOString().slice(0, 10),
      "2026-07-01",
    );
  });

  it("EVERY builder carries the month's REAL last day (MONEY-1408)", () => {
    // This whole `describe` pinned its day against 31-day months only — July
    // for SBI, Nippon and HDFC, August for Kotak. Four builders read
    // `end.getUTCDate()`, and replacing ANY of them with the literal `31` left
    // every one of those assertions green while producing
    //
    //     …Consolidated-SEBI-Portfolio-as-on-February-31,-2027/…
    //     …all-schemes-monthly-portfolio---as-on-31st-april-2027.xlsx
    //
    // which is a permanent 404 indistinguishable from "not published yet" — the
    // exact failure mode this file's own header names.
    //
    // `monthEnd` IS tested across February and a leap year below; what was
    // untested is that the builders COMPOSE it. So this walks every source that
    // has a template, across a 30-day month, a 28-day February and a leap
    // February, and asserts the day it emits is the real month end.
    //
    // MUTATION: `end.getUTCDate()` -> `31` in ANY of the four builders
    // (SBI / Nippon / Kotak in `AMC_SOURCES`, or `buildHdfcUrl`) -> RED.
    const MONTHS = [
      { label: "April 2027 (30 days)", d: Date.UTC(2027, 3, 15), day: 30 },
      { label: "February 2027 (28)", d: Date.UTC(2027, 1, 15), day: 28 },
      { label: "February 2028 (leap)", d: Date.UTC(2028, 1, 15), day: 29 },
    ];
    for (const { label, d, day } of MONTHS) {
      const month = new Date(d);
      assert.equal(monthEnd(month).getUTCDate(), day, `${label}: monthEnd`);

      // SBI spells it as an ENGLISH ORDINAL, so `30th` / `28th` / `29th`.
      assert.match(
        amcSource("SBI")!.buildUrl!(month),
        new RegExp(`as-on-${ordinal(day)}-`),
        `SBI ${label}`,
      );
      // Nippon and Kotak spell it as a bare number, in different places.
      assert.match(
        amcSource("NIPPON")!.buildUrl!(month),
        new RegExp(`PORTFOLIO-${day}-`),
        `Nippon ${label}`,
      );
      assert.match(
        amcSource("KOTAK")!.buildUrl!(month),
        new RegExp(`as-on-[A-Za-z]+-${day},-`),
        `Kotak ${label}`,
      );
      // HDFC's day sits inside the percent-encoded filename.
      assert.match(
        decodeURIComponent(buildHdfcUrl(month, "HDFC Value Fund")),
        new RegExp(`- ${day} [A-Za-z]+ \\d{4}\\.xlsx$`),
        `HDFC ${label}`,
      );

      // And the day that is NOT this month's must never appear as the day.
      assert.ok(
        !amcSource("KOTAK")!.buildUrl!(month).includes("-31,-"),
        `Kotak ${label} emitted a 31st`,
      );
    }
  });

  it("a builder is a pure function of its month", () => {
    const a = amcSource("SBI")!.buildUrl!(JULY_2026);
    const b = amcSource("SBI")!.buildUrl!(new Date(JULY_2026));
    assert.equal(a, b);
    // And it does not mutate the date it was handed.
    const d = new Date(JULY_2026);
    amcSource("SBI")!.buildUrl!(d);
    assert.equal(d.getTime(), JULY_2026.getTime());
  });
});
