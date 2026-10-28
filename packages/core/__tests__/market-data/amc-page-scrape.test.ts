/**
 * Tests for the AMC page-scrape resolver (MONEY-1105, P8a second resolver).
 *
 * Every house runs against a TRIMMED BUT VERBATIM capture of its real page under
 * `__tests__/fixtures/amc-pages/`. That is not a stylistic preference. The whole
 * difficulty of this module is that seven fund houses spell "the July 2026
 * month-end portfolio" seven different ways, in three different embedding
 * schemes (anchors, a JSON island, an ESCAPED JSON blob), with hashes glued into
 * the filenames. A synthetic fixture would have been written by whoever wrote
 * the parser — it would agree with the parser by construction and prove nothing.
 * Only whole records were dropped from these captures; the bytes that remain are
 * exactly what the sites served on 2026-08-14.
 *
 * The assertions are organised around the SILENT wrong answers, because every
 * failure mode of a link resolver is quiet:
 *
 *   - a fortnightly file ingested as a month-end holding set parses cleanly,
 *     stores cleanly, and is invisible downstream;
 *   - a mis-read year files a July workbook under August with no error;
 *   - a page whose markup changed returns zero links, which reads exactly like
 *     "the AMC has not published yet";
 *   - picking the newest link when the month cannot be identified is the same
 *     shape of bug as a guessed URL, one layer up.
 *
 * The `PROVEN` table below is the evidence `provenance: "verified"` rests on:
 * each URL was fetched once on 2026-08-14 and returned a real workbook or zip.
 * The tests assert the resolver still SELECTS those exact URLs, so a regression
 * in parsing shows up as a mismatch against a thing that was actually downloaded
 * rather than against a hand-typed expectation.
 *
 * Everything is synchronous — seven file reads, no timers, no promises, nothing
 * to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AMC_PAGE_SCRAPERS,
  amcPageScraper,
  findMonthlyPortfolioLinks,
  linksForMonth,
  parsePeriodFromFilename,
  pickLinkForMonth,
  schemesForMonth,
  scrapableAmcs,
  type AmcPageScrapeId,
  type AmcPageScraper,
  type ScrapedLink,
} from "../../src/market-data/amc-page-scrape";

const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures", "amc-pages");

const FIXTURE: Record<AmcPageScrapeId, string> = {
  // Not HTML either: ABSL's listing is the JSON its own `resourceAccordianAjax`
  // (global.js) asks for. Trimmed to ten rows of the live 211-row August-2026
  // response, VERBATIM — including the dead `abcscprod.azureedge.net` host,
  // which is the point of half the assertions about it.
  ABSL: "absl-monthly-portfolio-accordion.trimmed.json",
  DSP: "dsp-portfolio-disclosures.trimmed.html",
  PPFAS: "ppfas-portfolio-disclosure.trimmed.html",
  TATA: "tata-schemes-related-portfolio.trimmed.html",
  ZERODHA: "zerodha-disclosures.trimmed.html",
  GROWW: "groww-statutory-portfolio.trimmed.html",
  OLD_BRIDGE: "old-bridge-statutory-disclosures.trimmed.html",
  CAPITALMIND: "capitalmind-statutory-disclosures.trimmed.html",
  // Not HTML: Mirae's listing is the JSON its own DownloadPortfolio.js asks for,
  // captured from a real POST. Committed as `.json` so nothing can quietly start
  // treating it as markup.
  MIRAE: "mirae-downloads-portfolio.trimmed.json",
  BARODA_BNP: "baroda-bnp-monthly-portfolio.trimmed.html",
  SHRIRAM: "shriram-statutory-disclosures.trimmed.html",
  HELIOS: "helios-portfolio-disclosure.trimmed.html",
  THREE_SIXTY_ONE: "360one-downloads.trimmed.html",
};

/** The 584-byte error envelope a GET to Mirae's POST-only endpoint returns. */
const MIRAE_ERROR_FIXTURE = "mirae-downloads-error.json";

/**
 * The exact URL each house's July-2026 pick must produce, and the scheme
 * argument needed to reach it.
 *
 * `undefined` = the house publishes one combined workbook, so no scheme is
 * needed. `null` = the house publishes BOTH a combined workbook and per-scheme
 * files, and this asks for the combined one (PPFAS). A string = a per-scheme
 * house. All three meanings are exercised here on purpose.
 *
 * Fetched 2026-08-14; bytes and content-type recorded per row.
 */
const PROVEN: Record<
  AmcPageScrapeId,
  { scheme: string | null | undefined; url: string; evidence: string }
> = {
  ABSL: {
    scheme: undefined,
    // REBASED. The listing publishes this on `abcscprod.azureedge.net`, which
    // has no DNS record at all — see `rebaseHosts`.
    url:
      "https://mutualfund.adityabirlacapital.com/-/media/bsl/files/resources/" +
      "monthly-portfolio/2026/absl_monthly_portfolio_report_july--2026.zip",
    evidence:
      "August-2026 equivalent fetched 2026-09-13: 200 " +
      "application/x-zip-compressed 1,755,538 B (1 OLE2 .xls member)",
  },
  DSP: {
    scheme: undefined,
    url:
      "https://www.dspim.com/media/pages/mandatory-disclosures/portfolio-disclosures/" +
      "081d3fbd38-1786372968/monthend-portfolios_31_july_2026.zip",
    evidence: "200 application/zip 1,167,224 B (2 xlsx members)",
  },
  PPFAS: {
    scheme: null,
    // The query is part of the published link and is deliberately preserved. It
    // was fetched WITH the query and returned bytes identical to the fetch
    // without it, so keeping it costs nothing and dropping it would be the
    // resolver editing a URL it was given.
    url:
      "https://amc.ppfas.com/downloads/portfolio-disclosure/2026/" +
      "PPFAS_Monthly_Portfolio_Report_July_31_2026.xls?07082026_2",
    evidence: "200 application/vnd.ms-excel 407,676 B (PK magic — OOXML)",
  },
  TATA: {
    scheme: undefined,
    url:
      "https://betacms.tatamutualfund.com/system/files/2026-08/" +
      "Monthly%20Portfolio%20as%20on%2031st%20July%202026.xlsx",
    evidence: "200 spreadsheetml 1,760,778 B (140 parts)",
  },
  ZERODHA: {
    scheme: "zslvr",
    url:
      "https://assets.zerodhafundhouse.com/statutory-reports/portfolio-disclosures/" +
      "ZSLVR%20-%20Monthly%20Portfolio%20July%202026.xlsx",
    evidence: "200 spreadsheetml 133,897 B",
  },
  GROWW: {
    scheme: undefined,
    url:
      "https://assets-netstorage.growwmf.in/compliance_docs/Statutory%20Disclosure/" +
      "Portfolio/2026%20-2027/Monthly%20Portfolio-%20July%2031%202026.xlsx",
    evidence: "200 spreadsheetml 3,553,362 B (127 parts)",
  },
  OLD_BRIDGE: {
    scheme: "focused fund",
    url:
      "https://oldbridgemf.com/uploads/" +
      "Old_Bridge_Focused_Fund_Portfolio_July_26_1729091a89.xlsx",
    evidence: "200 spreadsheetml 128,903 B",
  },
  CAPITALMIND: {
    scheme: "cmflexi",
    url:
      "https://capitalmindmf.com/uploads/" +
      "CMFLEXI_Monthly_Portfolio_Disclosure_July_31_2026_2dad58d22b.xlsx",
    evidence: "200 spreadsheetml 155,519 B",
  },
  MIRAE: {
    scheme: "mascf",
    url:
      "https://www.miraeassetmf.co.in/docs/default-source/portfolios/" +
      "mascf-july2026.xlsx",
    evidence: "200 spreadsheetml 355,800 B",
  },
  BARODA_BNP: {
    scheme: undefined,
    url:
      "https://www.barodabnpparibasmf.in/assets/download_documents/" +
      "BOBBNPMF_Monthly_Portfolio_31-07-2026_19490.xls",
    evidence: "200 application/vnd.ms-excel 14,743,317 B (PK magic — OOXML)",
  },
  SHRIRAM: {
    scheme: undefined,
    // The unencoded parentheses in `Scheme(s)` survive URL resolution — they are
    // legal in a path — so the published link is used exactly as published.
    url:
      "https://cdn.shriramamc.in/uploads/Statutory-disclosure/" +
      "Monthly--Fortnightly--Weekly-Portfolio-of-Scheme(s)/" +
      "Monthly-Portfolio-for-the-Financial-Year/2026-2027/" +
      "Monthly-Portfolio-Shriram-Mutual-Fund-July-2026.xls",
    evidence: "200 application/vnd.ms-excel 539,136 B (D0CF magic — real OLE2)",
  },
  HELIOS: {
    scheme: "flexi cap fund",
    url:
      "https://www.heliosmf.in/wp-content/uploads/2026/08/" +
      "helios-flexi-cap-fund-monthly-portfolio-as-on-31st-july-2026.xlsx",
    evidence: "200 spreadsheetml 173,500 B",
  },
  THREE_SIXTY_ONE: {
    scheme: undefined,
    url:
      "https://s3.ap-south-1.amazonaws.com/x-web-s3.360.one/" +
      "IN_MF_MONTHLY_PORTFOLIO_July2026_94296a0535.xls",
    evidence: "200 application/vnd.ms-excel 283,432 B (PK magic — OOXML)",
  },
};

/** Any day inside the month is accepted; the resolver normalises to the 1st. */
const JULY_2026 = new Date(Date.UTC(2026, 6, 15));

const ym = (d: Date | null): string | null =>
  d === null ? null : d.toISOString().slice(0, 7);

function config(id: AmcPageScrapeId): AmcPageScraper {
  const cfg = amcPageScraper(id);
  assert.ok(cfg, `${id} must be in AMC_PAGE_SCRAPERS`);
  return cfg;
}

/** Read + parse each fixture ONCE; every assertion reads the same result. */
const SCRAPED: Record<AmcPageScrapeId, ScrapedLink[]> = (() => {
  const out = {} as Record<AmcPageScrapeId, ScrapedLink[]>;
  for (const cfg of AMC_PAGE_SCRAPERS) {
    const html = readFileSync(join(FIXTURE_DIR, FIXTURE[cfg.id]), "utf8");
    const links = findMonthlyPortfolioLinks(html, cfg.pageUrl, cfg);
    assert.ok(links, `${cfg.id}: the committed fixture must parse as HTML`);
    out[cfg.id] = links;
  }
  return out;
})();

const byName = (id: AmcPageScrapeId, filename: string): ScrapedLink => {
  const found = SCRAPED[id].find((l) => l.filename === filename);
  assert.ok(found, `${id} fixture must contain ${filename}`);
  return found;
};

/* ────────────────────────────────────────────────────────────────────────────
 * The claim `provenance: "verified"` makes
 * ──────────────────────────────────────────────────────────────────────────── */

describe("every verified house resolves the file that was actually fetched", () => {
  for (const cfg of AMC_PAGE_SCRAPERS) {
    const proven = PROVEN[cfg.id];

    it(`${cfg.id}: July-2026 picks the proven URL — ${proven.evidence}`, () => {
      const picked = pickLinkForMonth(
        SCRAPED[cfg.id],
        JULY_2026,
        proven.scheme,
      );
      assert.ok(picked, `${cfg.id} must resolve a July-2026 link`);
      // The URL, not just the filename: relative resolution, the preserved
      // query and the published host are all part of what was proven fetchable.
      assert.equal(picked.url, proven.url);
      assert.equal(ym(picked.period), "2026-07");
    });
  }

  it("finds links on every fixture — a page that parses to zero is the outage shape", () => {
    for (const cfg of AMC_PAGE_SCRAPERS) {
      assert.ok(
        SCRAPED[cfg.id].length > 0,
        `${cfg.id} yielded no links; a real page always has some`,
      );
    }
  });

  it("only `verified` houses are offered to a scheduled run", () => {
    // Same discipline as `fetchableSources()` next door: an unproven row exists
    // so the evidence is written down, never so a job can pick it up.
    for (const s of scrapableAmcs()) assert.equal(s.provenance, "verified");
    const verified = AMC_PAGE_SCRAPERS.filter(
      (s) => s.provenance === "verified",
    );
    assert.equal(scrapableAmcs().length, verified.length);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The silent wrong answer this module exists to prevent
 * ──────────────────────────────────────────────────────────────────────────── */

describe("fortnightly and half-yearly files never enter the monthly set", () => {
  it("no scraped link on any fixture is a non-month-end disclosure", () => {
    // A fortnightly snapshot ingested as month-end holdings parses cleanly and
    // is invisible downstream. This is the assertion that keeps it out.
    for (const cfg of AMC_PAGE_SCRAPERS) {
      for (const link of SCRAPED[cfg.id]) {
        assert.doesNotMatch(
          link.filename,
          /fortnight|half[\s_-]?year|quarter|annual|proxy|aaum/i,
          `${cfg.id}: ${link.filename} is not a month-end disclosure`,
        );
      }
    }
  });

  it("DSP's fortnightly and half-yearly neighbours are in the fixture but excluded", () => {
    // Proves the exclusion is doing work rather than the fixture being clean.
    const html = readFileSync(join(FIXTURE_DIR, FIXTURE.DSP), "utf8");
    assert.match(html, /dsp-isin-debt-fortnightly-portfolio-as-on-15-jul-2026/);
    assert.match(html, /half-yearly-portfolio_march-2019/);
    for (const link of SCRAPED.DSP) {
      assert.doesNotMatch(link.filename, /fortnightly|half-yearly/);
    }
  });

  it("Old Bridge abbreviates half-yearly as mid-name `HY`, which `\\b` does not catch", () => {
    // `_` is a word character, so `\bhy` never fires inside `OBMF_HY_Portfolio_`.
    // The first draft of the table used `\b` and let this file through, dated
    // and scheme-tagged, looking exactly like a September month-end.
    const html = readFileSync(join(FIXTURE_DIR, FIXTURE.OLD_BRIDGE), "utf8");
    assert.match(html, /OBMF_HY_Portfolio_Sep_2024/);
    assert.equal(
      SCRAPED.OLD_BRIDGE.some((l) => /OBMF_HY_Portfolio/.test(l.filename)),
      false,
    );
  });

  it("Capitalmind's mid-month file says neither 'fortnightly' nor 'monthly' — only the day gives it away", () => {
    // `CMLIQ_Portfolio_Disclosure_June_15_2026` is a fortnightly snapshot with
    // no word in its name to say so. Before the stated-day rule it collided with
    // the genuine June month-end file and cost CMLIQ that month entirely.
    const html = readFileSync(join(FIXTURE_DIR, FIXTURE.CAPITALMIND), "utf8");
    assert.match(html, /CMLIQ_Portfolio_Disclosure_June_15_2026/);
    assert.equal(
      SCRAPED.CAPITALMIND.some((l) => /June_15_2026/.test(l.filename)),
      false,
    );

    // ...and the genuine June month-end for that scheme is therefore reachable.
    const june = pickLinkForMonth(
      SCRAPED.CAPITALMIND,
      new Date(Date.UTC(2026, 5, 1)),
      "cmliq",
    );
    assert.ok(june);
    assert.equal(
      june.filename,
      "CMLIQ_Monthly_Portfolio_Disclosure_June_30_2026_b659b0dc74.xlsx",
    );
  });

  it("a day of 28-31, or no day at all, is kept", () => {
    const cfg = config("GROWW");
    // Groww's month-end file states day 31; Zerodha's states none. Both stay.
    assert.equal(
      ym(parsePeriodFromFilename("Monthly Portfolio- July 31 2026.xlsx", cfg)),
      "2026-07",
    );
    assert.equal(
      ym(
        parsePeriodFromFilename(
          "ZSLVR - Monthly Portfolio July 2026.xlsx",
          config("ZERODHA"),
        ),
      ),
      "2026-07",
    );
    // February's month-end is the 28th, which must not be read as mid-month.
    assert.ok(
      SCRAPED.PPFAS.some(
        (l) =>
          l.filename ===
          "PPFCF_PPFAS_Monthly_Portfolio_Report_February_28_2026.xls",
      ),
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * `null` and `[]` are different answers
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a page with no links and input that is not a page are distinguishable", () => {
  const cfg = config("DSP");

  it("HTML with no portfolio links yields [] — a real, successful, zero-row answer", () => {
    const page =
      "<!doctype html><html><body><h1>Portfolio disclosures</h1>" +
      "<p>Nothing published yet.</p><a href='/about'>About</a></body></html>";
    const links = findMonthlyPortfolioLinks(page, cfg.pageUrl, cfg);
    assert.deepEqual(links, []);
    // The distinction is the point: [] is not null.
    assert.notEqual(links, null);
  });

  it("input that is not a page yields null — never []", () => {
    for (const notAPage of [
      "",
      "   ",
      '{"error":"forbidden"}',
      "PK\u0000\u0000binary workbook bytes",
      "just a sentence with no markup at all",
    ]) {
      assert.equal(
        findMonthlyPortfolioLinks(notAPage, cfg.pageUrl, cfg),
        null,
        `${JSON.stringify(notAPage.slice(0, 24))} must be null, not []`,
      );
    }
  });

  it("a workbook that reaches us as text is not mistaken for a page", () => {
    // A zip's central directory is dense with `<` bytes, so the tag check alone
    // would occasionally call one a page. The NUL check is what settles it.
    const zipish = `PK${"\u0000".repeat(8)}<a href="/x.xlsx">`;
    assert.equal(findMonthlyPortfolioLinks(zipish, cfg.pageUrl, cfg), null);
  });

  it("an unusable base URL yields null rather than a partial list", () => {
    const html = readFileSync(join(FIXTURE_DIR, FIXTURE.PPFAS), "utf8");
    // Silently returning only the absolute links would report a partial list as
    // a complete one — the same failure shape as a wrong URL.
    assert.equal(findMonthlyPortfolioLinks(html, "not a url", cfg), null);
    assert.equal(findMonthlyPortfolioLinks(html, "", cfg), null);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Relative URLs
 * ──────────────────────────────────────────────────────────────────────────── */

describe("relative links resolve against the page's own address", () => {
  it("PPFAS root-relative hrefs become absolute", () => {
    const html = readFileSync(join(FIXTURE_DIR, FIXTURE.PPFAS), "utf8");
    // The fixture really does carry the bare path.
    assert.match(html, /"\/downloads\/portfolio-disclosure\/2026\//);
    for (const link of SCRAPED.PPFAS) {
      assert.match(link.url, /^https:\/\/amc\.ppfas\.com\//);
    }
  });

  it("Strapi houses publish only relative paths and all of them resolve", () => {
    for (const link of SCRAPED.OLD_BRIDGE) {
      assert.match(link.url, /^https:\/\/oldbridgemf\.com\/uploads\//);
    }
    for (const link of SCRAPED.CAPITALMIND) {
      assert.match(link.url, /^https:\/\/capitalmindmf\.com\/uploads\//);
    }
  });

  it("the same file published both relative and absolute is returned once", () => {
    // 32 of PPFAS's 99 raw hrefs are one file counted twice. Dedup is by
    // RESOLVED url, which is the only representation where the two agree.
    const urls = SCRAPED.PPFAS.map((l) => l.url);
    assert.equal(new Set(urls).size, urls.length);
  });

  it("a relative href resolves against a base with a path, not the host root", () => {
    const cfg = config("PPFAS");
    const page = `<a href="../2025/PPFAS_Monthly_Portfolio_Report_July_31_2025.xls">x</a>`;
    const links = findMonthlyPortfolioLinks(
      page,
      "https://amc.ppfas.com/downloads/portfolio-disclosure/2026/",
      cfg,
    );
    assert.ok(links);
    assert.equal(links.length, 1);
    assert.equal(
      links[0]!.url,
      "https://amc.ppfas.com/downloads/portfolio-disclosure/2025/" +
        "PPFAS_Monthly_Portfolio_Report_July_31_2025.xls",
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Per-house filename -> period strategies
 * ──────────────────────────────────────────────────────────────────────────── */

describe("PPFAS: the .xls -> .xlsx flip is per SCHEME, not per date", () => {
  it("matches both extensions in the same month", () => {
    // February 2026: the per-scheme files are still `.xls`. From March 2026 the
    // per-scheme files are `.xlsx` — but the COMBINED file is still `.xls` in
    // July 2026. Any rule of the form "after month X it is .xlsx" is wrong for
    // exactly the file most callers want.
    const feb = linksForMonth(SCRAPED.PPFAS, new Date(Date.UTC(2026, 1, 1)));
    assert.ok(feb.length >= 2);
    assert.ok(feb.every((l) => l.filename.endsWith(".xls")));

    const july = linksForMonth(SCRAPED.PPFAS, JULY_2026);
    const exts = new Set(july.map((l) => l.filename.split(".").pop()));
    assert.deepEqual([...exts].sort(), ["xls", "xlsx"]);
  });

  it("the combined July-2026 workbook is .xls while its per-scheme siblings are .xlsx", () => {
    const combined = pickLinkForMonth(SCRAPED.PPFAS, JULY_2026, null);
    assert.ok(combined);
    assert.equal(
      combined.filename,
      "PPFAS_Monthly_Portfolio_Report_July_31_2026.xls",
    );
    assert.equal(combined.scheme, null);

    const ppfcf = pickLinkForMonth(SCRAPED.PPFAS, JULY_2026, "ppfcf");
    assert.ok(ppfcf);
    assert.equal(
      ppfcf.filename,
      "PPFCF_PPFAS_Monthly_Portfolio_Report_July_31_2026.xlsx",
    );
  });

  it("the AMC's own name is boilerplate, so the combined file has no scheme", () => {
    // `PPFAS_…` and `PPAF_PPFAS_…` differ only in a prefix; without treating
    // `ppfas` as a stop word the combined workbook would claim scheme "ppfas"
    // and never be reachable as the whole-AMC file.
    const cfg = config("PPFAS");
    const links = findMonthlyPortfolioLinks(
      `<a href="/downloads/portfolio-disclosure/2026/PPFAS_Monthly_Portfolio_Report_July_31_2026.xls">a</a>` +
        `<a href="/downloads/portfolio-disclosure/2026/PPAF_PPFAS_Monthly_Portfolio_Report_July_31_2026.xlsx">b</a>`,
      cfg.pageUrl,
      cfg,
    );
    assert.ok(links);
    assert.deepEqual(
      links.map((l) => l.scheme),
      [null, "ppaf"],
    );
  });

  it("the 2015-2018 era spelling still parses", () => {
    assert.equal(
      ym(byName("PPFAS", "Monthly-Portfolio_April-2018.xlsx").period),
      "2018-04",
    );
    assert.equal(
      ym(byName("PPFAS", "Monthly-Portfolio_February-28-2015.xls").period),
      "2015-02",
    );
  });
});

describe("Tata: escaped JSON, two naming eras, and a publication-month path", () => {
  it("reads links out of an ESCAPED JSON blob, not anchors", () => {
    // The value is `\"field_media_document\":\"https://…xlsx\"`. A closing
    // lookahead for a bare quote sees the backslash and fails — silently, and
    // the house returns zero links, which is indistinguishable from "Tata
    // published nothing" unless you already know the page has 98 of them.
    const html = readFileSync(join(FIXTURE_DIR, FIXTURE.TATA), "utf8");
    assert.match(html, /\\"field_media_document\\":\\"https:/);
    assert.ok(SCRAPED.TATA.length > 5);
  });

  it("dates from the FILENAME even though the path names the publication month", () => {
    const july = pickLinkForMonth(SCRAPED.TATA, JULY_2026);
    assert.ok(july);
    // Path says 2026-08; filename says July. The filename wins.
    assert.match(july.url, /\/system\/files\/2026-08\//);
    assert.equal(ym(july.period), "2026-07");
  });

  it("both naming eras are recognised as the same monthly disclosure", () => {
    assert.equal(
      ym(byName("TATA", "portfolio-as-on-31st-july-2017.xls").period),
      "2017-07",
    );
    assert.equal(
      ym(byName("TATA", "Monthly Portfolio as on 31st July 2026.xlsx").period),
      "2026-07",
    );
  });

  it("the missing 'on' and the ' (1)' copy suffix are both survivable", () => {
    assert.equal(
      ym(byName("TATA", "Monthly Portfolio as 31st October 2025.xlsx").period),
      "2025-10",
    );
    assert.equal(
      ym(
        byName("TATA", "Monthly Portfolio as on 30th April 2026 (1).xlsx")
          .period,
      ),
      "2026-04",
    );
  });

  it("a content hash glued straight onto the year is still read correctly", () => {
    // `…-31-may-202018547fb5675f4cf188bebc0c610bd187.xls` has NO four-digit run
    // anywhere; the digits are `202018547`. Recovering 2020 is safe only because
    // the hash is APPENDED, so the year is necessarily the leading four.
    assert.equal(
      ym(
        byName(
          "TATA",
          "monthly-portfolio-as-on-31-may-202018547fb5675f4cf188bebc0c610bd187.xls",
        ).period,
      ),
      "2020-05",
    );
  });
});

describe("Zerodha: literal spaces in URLs, and two spellings of September", () => {
  it("a URL containing unencoded spaces is extracted whole", () => {
    const html = readFileSync(join(FIXTURE_DIR, FIXTURE.ZERODHA), "utf8");
    assert.match(html, /ZSLVR - Monthly Portfolio July 2026\.xlsx/);
    const july = pickLinkForMonth(SCRAPED.ZERODHA, JULY_2026, "zslvr");
    assert.ok(july);
    // The URL is percent-encoded on resolution; the decoded filename is not.
    assert.match(
      july.url,
      /ZSLVR%20-%20Monthly%20Portfolio%20July%202026\.xlsx$/,
    );
    assert.equal(july.filename, "ZSLVR - Monthly Portfolio July 2026.xlsx");
  });

  it("`Sep` and `Sept` both mean September — and both being present is ambiguity, not a tie", () => {
    const sep = new Date(Date.UTC(2025, 8, 1));
    const both = linksForMonth(SCRAPED.ZERODHA, sep, "zslvr");
    assert.equal(both.length, 2);
    assert.deepEqual(both.map((l) => l.filename).sort(), [
      "ZSLVR - Monthly Portfolio Sep 2025.xlsx",
      "ZSLVR - Monthly Portfolio Sept 2025.xlsx",
    ]);
    // Nothing in either name says which is authoritative, so the resolver
    // refuses rather than picking. 13 of Zerodha's schemes are like this.
    assert.equal(pickLinkForMonth(SCRAPED.ZERODHA, sep, "zslvr"), null);
  });

  it("the scheme code is read with or without a space before the dash", () => {
    assert.equal(
      byName("ZERODHA", "ZN250- Monthly Portfolio November 2023.xlsx").scheme,
      "zn250",
    );
    assert.equal(
      byName("ZERODHA", "ZSLVR - Monthly Portfolio July 2026.xlsx").scheme,
      "zslvr",
    );
  });
});

describe("Groww: the day, the month abbreviation and the comma all move", () => {
  it("every spelling in the fixture resolves to the right month", () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["Monthly Portfolio- July 31 2026.xlsx", "2026-07"],
      ["Monthly Portfolio - Mar 31, 2026.xlsx", "2026-03"],
      ["Monthly Portfolio- Jun 30, 2025.xls", "2025-06"],
      ["Monthly Portfolio- Nov 30, 2025.xls", "2025-11"],
    ];
    for (const [filename, period] of expected) {
      assert.equal(ym(byName("GROWW", filename).period), period, filename);
    }
  });

  it("the financial-year directory `2026 -2027` never becomes the period", () => {
    // The clearest case for reading the filename only: the path names two
    // calendar years, neither of which is wrong to want.
    const july = pickLinkForMonth(SCRAPED.GROWW, JULY_2026);
    assert.ok(july);
    assert.match(july.url, /Portfolio\/2026%20-2027\//);
    assert.equal(ym(july.period), "2026-07");
  });
});

describe("Old Bridge and Capitalmind: Strapi hashes must be stripped first", () => {
  it("Old Bridge's two-digit year is the year, not a day", () => {
    // `…_Portfolio_July_26_ca0b230896.xlsx` is July 2026. There is no
    // four-digit year anywhere in the name.
    assert.equal(
      ym(
        byName(
          "OLD_BRIDGE",
          "Old_Bridge_Focused_Fund_Portfolio_July_26_1729091a89.xlsx",
        ).period,
      ),
      "2026-07",
    );
    assert.equal(
      ym(
        byName(
          "OLD_BRIDGE",
          "Arbitrage_Fund_Monthly_Portfolio_Nov_25_dfc88d9a08.xlsx",
        ).period,
      ),
      "2025-11",
    );
  });

  it("a four-digit year still wins on a two-digit-rule house", () => {
    // Defensive: if Old Bridge ever writes `March_31_2026`, the 31 must not be
    // read as the year 2031.
    const cfg = config("OLD_BRIDGE");
    assert.equal(
      ym(
        parsePeriodFromFilename(
          "Fund_Portfolio_March_31_2026_aaaaaaaaaa.xlsx",
          cfg,
        ),
      ),
      "2026-03",
    );
    assert.equal(
      ym(
        byName("OLD_BRIDGE", "Monthly_Portfolio_Sep2025_df5535812a.xlsx")
          .period,
      ),
      "2025-09",
    );
  });

  it("a hex hash can spell a month or a year, so it is removed before parsing", () => {
    const ob = config("OLD_BRIDGE");
    const cm = config("CAPITALMIND");

    // Hex is [0-9a-f]: `2dec4b1a09` contains `dec`, `2050abcdef` contains 2050.
    // Both are hashes, neither is a date.
    assert.equal(
      parsePeriodFromFilename("Portfolio_2dec4b1a09.xlsx", ob),
      null,
    );
    assert.equal(
      ym(
        parsePeriodFromFilename(
          "CMX_Monthly_Portfolio_July_31_2026_2050abcdef.xlsx",
          cm,
        ),
      ),
      "2026-07",
    );

    // ...and with the hash left on, the same name reads as two different years.
    const withoutStrip = { yearRule: "four-digit" as const, strapiHash: false };
    assert.equal(
      parsePeriodFromFilename(
        "CMX_Monthly_Portfolio_July_31_2026_2050abcdef.xlsx",
        withoutStrip,
      ),
      null,
      "un-stripped, 2026 and 2050 are both present and the month is unresolvable",
    );
  });

  it("Capitalmind uses a four-digit year, so the two Strapi houses cannot share a config", () => {
    assert.equal(config("OLD_BRIDGE").yearRule, "two-digit-follows-month");
    assert.equal(config("CAPITALMIND").yearRule, "four-digit");
    assert.equal(config("OLD_BRIDGE").strapiHash, true);
    assert.equal(config("CAPITALMIND").strapiHash, true);
  });

  it("Old Bridge's scheme token is not stable across months — recorded, not smoothed", () => {
    // `AF`/`FE` in one month, spelled-out fund names in another. Anything that
    // assumed a stable per-scheme key across months would silently split a
    // series in two.
    const schemes = new Set(SCRAPED.OLD_BRIDGE.map((l) => l.scheme));
    assert.ok(schemes.has("focused fund"));
    assert.ok(schemes.has("fe"));
  });
});

describe("DSP: six filename spellings across thirteen years", () => {
  it("every observed spelling resolves", () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["monthend-portfolios_31_july_2026.zip", "2026-07"],
      ["monthend-portfolio-31march2026.zip", "2026-03"],
      ["monthend-portfolio-january-31-2026.zip", "2026-01"],
      ["month_end_portfolio_disclosure_feb2019.zip", "2019-02"],
      ["month_end_portfolio_disclosure_january2016.zip", "2016-01"],
      [
        "month_end_portfolio_disclosure_march-20144783ceb8a31c664285b8ff02003db0a3.zip",
        "2014-03",
      ],
    ];
    for (const [filename, period] of expected) {
      assert.equal(ym(byName("DSP", filename).period), period, filename);
    }
  });

  it("`31march2026` parses even with no separators at all", () => {
    // A `\b`-style word boundary would have missed this and `feb2019`; the
    // non-LETTER boundary check is what makes both work.
    const cfg = config("DSP");
    assert.equal(
      ym(parsePeriodFromFilename("monthend-portfolio-31march2026.zip", cfg)),
      "2026-03",
    );
    assert.equal(ym(parsePeriodFromFilename("x_feb2019.zip", cfg)), "2019-02");
  });

  it("January 2016 is published twice and therefore has no single answer", () => {
    const jan = new Date(Date.UTC(2016, 0, 1));
    const both = linksForMonth(SCRAPED.DSP, jan);
    assert.equal(both.length, 2);
    assert.deepEqual(both.map((l) => l.filename).sort(), [
      "month_end_portfolio_disclosure_jan2016.zip",
      "month_end_portfolio_disclosure_january2016.zip",
    ]);
    assert.equal(pickLinkForMonth(SCRAPED.DSP, jan), null);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Mirae: a JSON API wearing the same interface as six HTML pages
 * ──────────────────────────────────────────────────────────────────────────── */

describe("Mirae: the listing is JSON, and a GET to it succeeds with an error", () => {
  const cfg = config("MIRAE");

  it("reads links out of a JSON body with no markup in it anywhere", () => {
    const body = readFileSync(join(FIXTURE_DIR, FIXTURE.MIRAE), "utf8");
    // Not a single tag: the HTML shape test would have called this "not a page".
    assert.doesNotMatch(body, /<[a-z!/][^>]*>/i);
    assert.ok(SCRAPED.MIRAE.length > 5);
    assert.equal(
      ym(pickLinkForMonth(SCRAPED.MIRAE, JULY_2026, "mascf")!.period),
      "2026-07",
    );
  });

  it("a 200 carrying ReturnCode 9999 is NOT a page, and not an empty one either", () => {
    // This is what a GET to the POST-only endpoint returns — measured, 584 B.
    // Without `errorBody` it parses as JSON, yields zero links, and reads as
    // "Mirae published nothing this month" on every single run.
    const err = readFileSync(join(FIXTURE_DIR, MIRAE_ERROR_FIXTURE), "utf8");
    assert.match(err, /"ReturnCode":"9999"/);
    assert.equal(findMonthlyPortfolioLinks(err, cfg.pageUrl, cfg), null);
    // ...and the same bytes with a success code are a page again, so the rule
    // keys on the CODE rather than on anything incidental to the error text.
    const ok = err.replace('"ReturnCode":"9999"', '"ReturnCode":"0"');
    assert.deepEqual(findMonthlyPortfolioLinks(ok, cfg.pageUrl, cfg), []);
  });

  it("input that is not JSON at all is null on a JSON house", () => {
    for (const notJson of ["", "   ", "<html><a href='/x.xlsx'>x</a></html>"]) {
      assert.equal(findMonthlyPortfolioLinks(notJson, cfg.pageUrl, cfg), null);
    }
    // Truncated JSON is the shape a capped response would take.
    assert.equal(
      findMonthlyPortfolioLinks('{"Data":[{"URL":"/x.xlsx"', cfg.pageUrl, cfg),
      null,
    );
  });

  it("the POST body asks for all 3,616 rows, not the default page of 25", () => {
    // Measured: the endpoint pages at 25 by default and reports the true size
    // only in `DataCount`. A caller that trusts the array length sees 25 files
    // and no error — the same trap NSE's integrated-filing index sets.
    assert.equal(cfg.pageRequest.method, "POST");
    assert.match(cfg.pageRequest.body ?? "", /"pgsize":\s*5000/);
    assert.match(cfg.pageRequest.body ?? "", /"modulename":"portfolio_tab1"/);
  });

  it("scheme codes beginning `hy` are not eaten by the half-yearly exclusion", () => {
    // `hybetf` and `hybif` are Mirae's hybrid ETF and hybrid fund. NOT_MONTH_END
    // matches `hy` only when a non-alphanumeric follows, which is exactly what
    // saves them — and exactly what a "simplification" of that rule would undo.
    const schemes = schemesForMonth(SCRAPED.MIRAE, JULY_2026);
    assert.ok(schemes.includes("hybetf"), "hybetf was excluded as half-yearly");
    assert.ok(schemes.includes("hybif"), "hybif was excluded as half-yearly");
  });

  it("the path filter is what makes a file a portfolio file here", () => {
    // Mirae's filenames are a scheme code and a date and nothing else, so there
    // is no word to include on. Everything kept must come from the one bucket.
    assert.deepEqual(cfg.include, []);
    for (const link of SCRAPED.MIRAE) {
      assert.match(link.url, /\/docs\/default-source\/portfolios\//);
    }
    // A workbook served from anywhere else is dropped, however it is named.
    const stray =
      '{"Data":[{"URL":"/docs/default-source/factsheets/mascf-july2026.xlsx"}]}';
    assert.deepEqual(findMonthlyPortfolioLinks(stray, cfg.pageUrl, cfg), []);
  });

  it("its four older filename spellings all resolve, and the undated one does not", () => {
    const expected: ReadonlyArray<readonly [string, string | null]> = [
      ["mascf-july2026.xlsx", "2026-07"],
      ["macbf_dec2024.xlsx", "2024-12"],
      // September spelled with four letters, again.
      ["maipf_sept2024.xlsx", "2024-09"],
      // Day glued to the month with no separator.
      ["manbt_31aug2024.xlsx", "2024-08"],
      // A real file that names no date at all.
      ["alphafof.xlsx", null],
    ];
    for (const [filename, period] of expected) {
      assert.equal(ym(byName("MIRAE", filename).period), period, filename);
    }
  });

  it("the `?sfvrsn=` cache-buster is preserved in the URL and absent from the filename", () => {
    // The query is part of the published link, so it is kept; the period parser
    // must never see it, or `_2` would be a digit run in the name.
    const dec = byName("MIRAE", "macbf_dec2024.xlsx");
    assert.match(dec.url, /\?sfvrsn=/);
    assert.equal(dec.filename, "macbf_dec2024.xlsx");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Baroda BNP: a date with no month name in it
 * ──────────────────────────────────────────────────────────────────────────── */

describe("Baroda BNP: the month is digits, and the house keeps one file", () => {
  const cfg = config("BARODA_BNP");

  it("`31-07-2026` is July 2026, and under the default rule it is nothing", () => {
    assert.equal(
      ym(
        parsePeriodFromFilename(
          "BOBBNPMF_Monthly_Portfolio_31-07-2026_19490.xls",
          cfg,
        ),
      ),
      "2026-07",
    );
    // The same name on a month-name house dates to null — which is why this is
    // a per-house declaration and not a global fallback.
    assert.equal(
      parsePeriodFromFilename(
        "BOBBNPMF_Monthly_Portfolio_31-07-2026_19490.xls",
        config("GROWW"),
      ),
      null,
    );
  });

  it("the trailing document id is not mistaken for part of the date", () => {
    // `_19490` is a CMS id. Both ends of the numeric pattern are bounded by
    // non-digits precisely so a neighbouring run cannot donate digits.
    const link = byName(
      "BARODA_BNP",
      "BOBBNPMF_Monthly_Portfolio_31-07-2026_19490.xls",
    );
    assert.equal(ym(link.period), "2026-07");
    assert.equal(link.scheme, null);
  });

  it("an out-of-range field means the run is not a date, and is not clamped", () => {
    // Month 13 and day 45 are not dates. Clamping either would file a workbook
    // under a month nobody published.
    for (const bad of [
      "Monthly_Portfolio_31-13-2026.xls",
      "Monthly_Portfolio_45-07-2026.xls",
      "Monthly_Portfolio_31-07-1899.xls",
    ]) {
      assert.equal(parsePeriodFromFilename(bad, cfg), null, bad);
    }
  });

  it("two numeric dates in one name is ambiguity, not a first-match", () => {
    assert.equal(
      parsePeriodFromFilename(
        "Monthly_Portfolio_01-06-2026_31-07-2026.xls",
        cfg,
      ),
      null,
    );
  });

  it("a numeric house still reads a month NAME when there is no numeric date", () => {
    // An older era spelled in words keeps working; the numeric rule is additive.
    assert.equal(
      ym(parsePeriodFromFilename("Monthly_Portfolio_July_2026.xls", cfg)),
      "2026-07",
    );
    // ...but a name that states BOTH and disagrees with itself resolves to
    // neither.
    assert.equal(
      parsePeriodFromFilename("Monthly_Portfolio_June_31-07-2026.xls", cfg),
      null,
    );
  });

  it("a mid-month numeric date is still caught by the month-end rule", () => {
    // The stated day comes from the same single reading the period did, so a
    // fortnightly file cannot slip past by being spelled in digits.
    const page = `<a href="/assets/download_documents/BOBBNPMF_Monthly_Portfolio_15-07-2026_19491.xls">x</a>`;
    assert.deepEqual(findMonthlyPortfolioLinks(page, cfg.pageUrl, cfg), []);
  });

  it("the five `YR5x` sheets on the same page are not portfolios", () => {
    // The page carries exactly six workbook links; five of them are something
    // else, and the include rule is the only thing separating them.
    const html = readFileSync(join(FIXTURE_DIR, FIXTURE.BARODA_BNP), "utf8");
    assert.match(html, /YR51_19485\.xlsx/);
    assert.equal(SCRAPED.BARODA_BNP.length, 1);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Shriram, Helios, 360 ONE
 * ──────────────────────────────────────────────────────────────────────────── */

describe("Shriram: 2,593 workbooks on one page, 153 of them portfolios", () => {
  it("a DAILY file whose whole name is a date is not a monthly portfolio", () => {
    // `31st-July-2026.xls` is a debt-transaction disclosure. It dates perfectly
    // to July 2026 and would have been picked by any `portfolio`-only rule —
    // the worst shape of wrong answer, since it parses and stores cleanly.
    const html = readFileSync(join(FIXTURE_DIR, FIXTURE.SHRIRAM), "utf8");
    assert.match(html, /2026-2027\/31st-July-2026\.xls/);
    assert.equal(
      SCRAPED.SHRIRAM.some((l) => l.filename === "31st-July-2026.xls"),
      false,
    );
  });

  it("the AUM annexure and the WEEKLY portfolio are excluded too", () => {
    const html = readFileSync(join(FIXTURE_DIR, FIXTURE.SHRIRAM), "utf8");
    assert.match(html, /Shriram-MF-Average-AUM-Annexures-Jul-2026\.xls/);
    assert.match(html, /Weekly-Portfolio-Shriram-Mutual-Fund-07-August-2026/);
    for (const link of SCRAPED.SHRIRAM) {
      assert.doesNotMatch(link.filename, /AUM|Weekly/i);
    }
  });

  it("July-2026 is a single combined workbook", () => {
    assert.deepEqual(schemesForMonth(SCRAPED.SHRIRAM, JULY_2026), [null]);
  });

  it("the pre-2019 per-scheme era still parses, with its scheme code", () => {
    assert.equal(
      ym(
        byName("SHRIRAM", "Monthly-Portfolio-SHREDOF-APRIL-2015-NEW.xlsx")
          .period,
      ),
      "2015-04",
    );
    assert.equal(
      byName("SHRIRAM", "Monthly-Portfolio-SHREDOF-APRIL-2015-NEW.xlsx").scheme,
      "shredof",
    );
    assert.equal(
      byName("SHRIRAM", "Monthly-Portfolio-SHEF-July-2018.xls").scheme,
      "shef",
    );
  });
});

describe("Helios: a fortnightly file dated the 31st", () => {
  it("the overnight fund's monthly and fortnightly July files both exist", () => {
    // The stated-day rule cannot separate these — both say 31st — so the name
    // exclusion is carrying the whole load for this one scheme.
    const html = readFileSync(join(FIXTURE_DIR, FIXTURE.HELIOS), "utf8");
    assert.match(
      html,
      /helios-overnight-fund-fortnightly-portfolio-as-on-31st-july-2026\.xls/,
    );
    assert.match(
      html,
      /helios-overnight-fund-monthly-portfolio-as-on-31st-july-2026\.xlsx/,
    );
    // ...and only the monthly one survives, so the month is not ambiguous.
    const overnight = pickLinkForMonth(
      SCRAPED.HELIOS,
      JULY_2026,
      "overnight fund",
    );
    assert.ok(overnight);
    assert.match(overnight.filename, /monthly-portfolio/);
  });

  it("the WordPress upload month in the path is not the data month", () => {
    const july = pickLinkForMonth(SCRAPED.HELIOS, JULY_2026, "flexi cap fund");
    assert.ok(july);
    assert.match(july.url, /\/wp-content\/uploads\/2026\/08\//);
    assert.equal(ym(july.period), "2026-07");
  });

  it("Title-Case and lowercase eras yield the same scheme token", () => {
    assert.equal(
      byName(
        "HELIOS",
        "Helios-Balanced-Advantage-Fund-Monthly-Portfolio-as-on-30th-June-2026.xlsx",
      ).scheme,
      "balanced advantage fund",
    );
    assert.equal(
      byName(
        "HELIOS",
        "helios-arbitrage-fund-monthly-portfolio-as-on-31st-july-2026.xlsx",
      ).scheme,
      "arbitrage fund",
    );
  });
});

describe("360 ONE: three renames and three unreadable date spellings", () => {
  it("every era's name that CAN be read, is", () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["IN_MF_MONTHLY_PORTFOLIO_July2026_94296a0535.xls", "2026-07"],
      ["IN_MF_MONTHLY_PORTFOLIO_June2026_Final_8ded2027a1.xls", "2026-06"],
      ["IN_MF_MONTHLY_PORTFOLIO_Apr_2026_final_f3e5d29a9b.xlsx", "2026-04"],
      // 09052022 is an EIGHT-digit run, so `findYears` ignores it and only the
      // clean 2022 counts. A windowed scan would have found two years here.
      [
        "IN_MF_MONTHLY_PORTFOLIO_APRIL_2022_09052022_b2e2ead650.xlsx",
        "2022-04",
      ],
      [
        "IIFLAMC_Mutual_Funds_MONTHLY_PORTFOLIO_MAY_2018_web_download_96050002a6.xls",
        "2018-05",
      ],
    ];
    for (const [filename, period] of expected) {
      assert.equal(
        ym(byName("THREE_SIXTY_ONE", filename).period),
        period,
        filename,
      );
    }
  });

  it("the spellings that cannot be read report null instead of guessing", () => {
    // `300923` could be 30/09/23 or a sequence number and nothing in the name
    // decides. `April_18` is a two-digit year on a four-digit house. `060919`
    // has leading four digits of 0609, which is not a year.
    for (const filename of [
      "IN_MF_MONTHLY_PORTFOLIO_300923_dd5cf2a9c9.xlsx",
      "IN_MF_MONTHLY_PORTFOLIO_310823_31ff172f05.xlsx",
      "IIFLAMC_IN_MF_MONTHLY_PORTFOLIO_April_18_81e2dffdd0.xls",
      "IN_MF_MONTHLY_PORTFOLIO_AUGUST_060919_e4d2dc16e0.XLS",
    ]) {
      assert.equal(byName("THREE_SIXTY_ONE", filename).period, null, filename);
    }
  });

  it("all three house names collapse to the same whole-AMC file", () => {
    for (const filename of [
      "IN_MF_MONTHLY_PORTFOLIO_July2026_94296a0535.xls",
      "360_ONE_MF_MONTHLY_PORTFOLIO_July2024_f65e0651e5.xls",
      "IIFLAMC_Mutual_Funds_MONTHLY_PORTFOLIO_MAY_2018_web_download_96050002a6.xls",
    ]) {
      assert.equal(byName("THREE_SIXTY_ONE", filename).scheme, null, filename);
    }
  });

  it("Strapi's hash convention travels to a different host and a different AMC", () => {
    // Old Bridge and Capitalmind serve `_<10 hex>` from their own domains;
    // 360 ONE serves the identical convention from S3. That is the N-for-1.
    assert.equal(config("THREE_SIXTY_ONE").strapiHash, true);
    for (const link of SCRAPED.THREE_SIXTY_ONE) {
      assert.match(link.url, /^https:\/\/s3\.ap-south-1\.amazonaws\.com\//);
    }
    // With the hash left on, `_94296a0535` contributes no clean four-digit run,
    // so July2026 still reads — but `_dbce7a92f6` would spell nothing either.
    // The case that matters is pinned on the Strapi houses next door.
  });

  it("half-yearly files share the bucket and are excluded by name", () => {
    const html = readFileSync(
      join(FIXTURE_DIR, FIXTURE.THREE_SIXTY_ONE),
      "utf8",
    );
    assert.match(html, /360_ONE_MF_Half_yearly_portfolio_Mar_2026/);
    for (const link of SCRAPED.THREE_SIXTY_ONE) {
      assert.doesNotMatch(link.filename, /half/i);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * An unparseable month is null, never "the newest"
 * ──────────────────────────────────────────────────────────────────────────── */

describe("an unidentifiable month returns null rather than the newest link", () => {
  it("a real file naming no month at all reports period: null", () => {
    const final = byName(
      "OLD_BRIDGE",
      "Monthly_Portfolio_Final_174b126654.xlsx",
    );
    assert.equal(final.period, null);
    // Reported, not dropped: the link is visible with its period absent, which
    // is what "absent must be visibly absent" means here.
    assert.ok(final.url.endsWith("Monthly_Portfolio_Final_174b126654.xlsx"));
  });

  it("undated links are never selected for any month", () => {
    const undated = SCRAPED.OLD_BRIDGE.filter((l) => l.period === null);
    assert.ok(undated.length > 0, "the fixture must contain an undated link");
    for (const month of [JULY_2026, new Date(Date.UTC(2020, 0, 1))]) {
      for (const link of linksForMonth(SCRAPED.OLD_BRIDGE, month)) {
        assert.notEqual(link.period, null);
      }
    }
  });

  it("a month with no file returns null, not the closest one", () => {
    // The failure this prevents: storing August's holdings from July's file.
    const august = new Date(Date.UTC(2026, 7, 1));
    for (const cfg of AMC_PAGE_SCRAPERS) {
      const picked = pickLinkForMonth(
        SCRAPED[cfg.id],
        august,
        PROVEN[cfg.id].scheme,
      );
      if (picked !== null) {
        assert.equal(
          ym(picked.period),
          "2026-08",
          `${cfg.id} returned a non-August file`,
        );
      }
    }
  });

  it("ambiguous inputs return null: no month, two months, two years", () => {
    const cfg = config("DSP");
    assert.equal(
      parsePeriodFromFilename("month_end_portfolio_disclosure.zip", cfg),
      null,
    );
    assert.equal(
      parsePeriodFromFilename("portfolio_july_august_2026.zip", cfg),
      null,
    );
    assert.equal(
      parsePeriodFromFilename("portfolio_july_2025_2026.zip", cfg),
      null,
    );
    assert.equal(parsePeriodFromFilename("", cfg), null);
    // `july-19` cannot be told apart from a day; four-digit houses say so.
    assert.equal(
      parsePeriodFromFilename(
        "month_end_portfolio_disclosure_july-19.zip",
        cfg,
      ),
      null,
    );
  });

  it("an Invalid Date selects nothing rather than throwing or matching everything", () => {
    const bad = new Date("not a date");
    assert.deepEqual(linksForMonth(SCRAPED.DSP, bad), []);
    assert.equal(pickLinkForMonth(SCRAPED.DSP, bad), null);
    assert.deepEqual(linksForMonth(SCRAPED.DSP, new Date(Number.NaN)), []);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * A `text/html` "file" link is not a workbook
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a handler URL that serves HTML is never classified as a workbook", () => {
  it("`njmf_download.php` and `other.php` are not extracted", () => {
    // Both return HTTP 200 with a body and `text/html` — the worst available
    // failure shape, because a fetcher stores 137 KB of HTML and every log line
    // reads as success. `.php`, `.aspx` and `.jsp` are HANDLER extensions; only
    // extensions that cannot be anything but a document are matched.
    const cfg = config("DSP");
    const page =
      "<html><body>" +
      `<a href="https://www.njmutualfund.com/downloads/njmf_download.php?nme=127">Monthly portfolio</a>` +
      `<a href="https://www.ilfsmf.com/other.php">Month end portfolio</a>` +
      `<a href="/monthend-portfolios_31_july_2026.aspx">Month end</a>` +
      `<a href="/monthend-portfolios_31_july_2026.zip">Month end</a>` +
      "</body></html>";
    const links = findMonthlyPortfolioLinks(page, cfg.pageUrl, cfg);
    assert.ok(links);
    assert.equal(links.length, 1);
    assert.equal(links[0]!.filename, "monthend-portfolios_31_july_2026.zip");
  });

  it("an extension that merely CONTAINS a workbook extension does not count", () => {
    const cfg = config("DSP");
    const page = `<html><a href="/monthend-portfolio-july-2026.xlsx.html">x</a></html>`;
    assert.deepEqual(findMonthlyPortfolioLinks(page, cfg.pageUrl, cfg), []);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Purity
 * ──────────────────────────────────────────────────────────────────────────── */

describe("purity", () => {
  it("repeated calls on the same input return identical results", () => {
    // The specific hazard: a `g`-flagged RegExp in the config table carries
    // `lastIndex` between `.test()` calls, so alternate invocations would see
    // different include/exclude decisions. That reads as flakiness, not a bug.
    for (const cfg of AMC_PAGE_SCRAPERS) {
      const html = readFileSync(join(FIXTURE_DIR, FIXTURE[cfg.id]), "utf8");
      const a = findMonthlyPortfolioLinks(html, cfg.pageUrl, cfg);
      const b = findMonthlyPortfolioLinks(html, cfg.pageUrl, cfg);
      const c = findMonthlyPortfolioLinks(html, cfg.pageUrl, cfg);
      assert.deepEqual(a, b, `${cfg.id} is not idempotent`);
      assert.deepEqual(b, c, `${cfg.id} is not idempotent`);
    }
  });

  it("no configured RegExp is global or sticky", () => {
    for (const cfg of AMC_PAGE_SCRAPERS) {
      for (const re of [
        ...cfg.include,
        ...cfg.exclude,
        ...cfg.errorBody,
        ...cfg.pathInclude,
      ]) {
        assert.equal(re.global, false, `${cfg.id}: ${re} must not be /g`);
        assert.equal(re.sticky, false, `${cfg.id}: ${re} must not be /y`);
      }
    }
  });

  it("the input HTML and the returned links are not mutated", () => {
    const cfg = config("CAPITALMIND");
    const html = readFileSync(join(FIXTURE_DIR, FIXTURE.CAPITALMIND), "utf8");
    const before = html;
    const links = findMonthlyPortfolioLinks(html, cfg.pageUrl, cfg);
    assert.ok(links);
    const snapshot = JSON.stringify(links);
    pickLinkForMonth(links, JULY_2026, "cmflexi");
    linksForMonth(links, JULY_2026);
    assert.equal(html, before);
    assert.equal(JSON.stringify(links), snapshot);
  });

  it("periods are UTC month starts, so two resolvers' periods compare", () => {
    for (const cfg of AMC_PAGE_SCRAPERS) {
      for (const link of SCRAPED[cfg.id]) {
        if (link.period === null) continue;
        assert.equal(link.period.getUTCDate(), 1);
        assert.equal(link.period.getUTCHours(), 0);
        assert.equal(link.period.getUTCMinutes(), 0);
        assert.equal(link.period.getUTCSeconds(), 0);
        assert.equal(link.period.getUTCMilliseconds(), 0);
      }
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The scheme argument's three meanings
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the scheme argument distinguishes 'any', 'whole-AMC' and 'this one'", () => {
  it("omitted means no filter, so a per-scheme house is ambiguous", () => {
    // PPFAS publishes 6 files for July 2026 in the fixture. Asking without a
    // scheme is a question with no single answer, and gets none.
    assert.ok(linksForMonth(SCRAPED.PPFAS, JULY_2026).length > 1);
    assert.equal(pickLinkForMonth(SCRAPED.PPFAS, JULY_2026), null);
  });

  it("null means the whole-AMC file specifically", () => {
    const combined = linksForMonth(SCRAPED.PPFAS, JULY_2026, null);
    assert.equal(combined.length, 1);
    assert.equal(combined[0]!.scheme, null);
  });

  it("a string matches case-insensitively and ignores surrounding space", () => {
    const a = pickLinkForMonth(SCRAPED.ZERODHA, JULY_2026, "ZSLVR");
    const b = pickLinkForMonth(SCRAPED.ZERODHA, JULY_2026, "  zslvr ");
    assert.ok(a);
    assert.equal(a.url, PROVEN.ZERODHA.url);
    assert.equal(b?.url, a.url);
  });

  it("an unknown scheme returns null rather than falling back", () => {
    assert.equal(pickLinkForMonth(SCRAPED.ZERODHA, JULY_2026, "zzzzz"), null);
    assert.deepEqual(linksForMonth(SCRAPED.ZERODHA, JULY_2026, "zzzzz"), []);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The production log of 2026-08-14, reproduced and diagnosed
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a per-scheme house asked without a scheme is null BY CONSTRUCTION", () => {
  // A real mf-portfolio-sync run logged, for a month both houses had published:
  //
  //   no single link for this month { amc: 'ZERODHA', period: '2026-07', linksOnPage: 338 }
  //   no single link for this month { amc: 'PPFAS',   period: '2026-07', linksOnPage: 403 }
  //
  // The question worth answering is which of two very different things that is:
  // a matcher failing to match (a bug in here), or a month that genuinely has
  // more than one file (working as designed, asked wrongly). These assertions
  // settle it against the committed fixtures.

  it("the matcher DOES match — every per-scheme house has July-2026 files", () => {
    // Not zero. If the resolver were failing to match, this is where it shows.
    const counts: Partial<Record<AmcPageScrapeId, number>> = {};
    for (const cfg of AMC_PAGE_SCRAPERS) {
      if (!cfg.perScheme) continue;
      counts[cfg.id] = linksForMonth(SCRAPED[cfg.id], JULY_2026).length;
    }
    assert.deepEqual(counts, {
      // Trimmed fixtures, so these are subsets of the live pages — the live
      // Zerodha page carries 22 scheme codes and Mirae's endpoint 97.
      PPFAS: 6,
      ZERODHA: 2,
      OLD_BRIDGE: 3,
      CAPITALMIND: 2,
      MIRAE: 5,
      HELIOS: 3,
    });
    for (const n of Object.values(counts)) assert.ok(n > 1);
  });

  it("...so the null is 'more than one', which is the CALL that is wrong", () => {
    // This is the exact call the worker makes: no scheme argument at all.
    for (const cfg of AMC_PAGE_SCRAPERS) {
      if (!cfg.perScheme) continue;
      assert.equal(
        pickLinkForMonth(SCRAPED[cfg.id], JULY_2026),
        null,
        `${cfg.id} must refuse a scheme-less pick`,
      );
    }
  });

  it("and it is NOT the Sep/Sept spelling collision, which looks identical", () => {
    // Zerodha has both defects. They need opposite responses, so a caller must
    // not treat them as one: the September pair is unresolvable, while July is
    // fully resolvable the moment a scheme is named.
    const sep = new Date(Date.UTC(2025, 8, 1));
    assert.equal(pickLinkForMonth(SCRAPED.ZERODHA, sep, "zslvr"), null);
    assert.ok(pickLinkForMonth(SCRAPED.ZERODHA, JULY_2026, "zslvr"));
  });

  it("schemesForMonth is the list a caller iterates to reach every file", () => {
    // The fix shape, pinned: one pick per scheme, each still unique.
    for (const cfg of AMC_PAGE_SCRAPERS) {
      const schemes = schemesForMonth(SCRAPED[cfg.id], JULY_2026);
      const reached = schemes
        .map((s) => pickLinkForMonth(SCRAPED[cfg.id], JULY_2026, s))
        .filter((l): l is ScrapedLink => l !== null);
      assert.equal(
        reached.length,
        linksForMonth(SCRAPED[cfg.id], JULY_2026).length,
        `${cfg.id}: iterating schemes must reach every July-2026 file`,
      );
      assert.equal(new Set(reached.map((l) => l.url)).size, reached.length);
    }
  });

  it("the whole-AMC entry sorts first, so a combined workbook is tried first", () => {
    // PPFAS publishes BOTH shapes; a caller that only wants one file should get
    // the combined one without knowing the house's scheme codes.
    assert.equal(schemesForMonth(SCRAPED.PPFAS, JULY_2026)[0], null);
    assert.deepEqual(schemesForMonth(SCRAPED.PPFAS, JULY_2026), [
      null,
      "ppaf",
      "ppchf",
      "ppdaaf",
      "ppfcf",
      "pplf",
    ]);
    // A pure per-scheme house has no null entry at all.
    assert.deepEqual(schemesForMonth(SCRAPED.ZERODHA, JULY_2026), [
      "zbsen",
      "zslvr",
    ]);
  });

  it("schemesForMonth is empty for a month nobody published, and for junk", () => {
    // Empty is the honest answer, and it must not be confused with "one file
    // whose scheme is null" — that is `[null]`.
    assert.deepEqual(
      schemesForMonth(SCRAPED.ZERODHA, new Date(Date.UTC(2013, 0, 1))),
      [],
    );
    assert.deepEqual(schemesForMonth(SCRAPED.DSP, new Date("not a date")), []);
    assert.deepEqual(schemesForMonth(SCRAPED.DSP, JULY_2026), [null]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The table itself
 * ──────────────────────────────────────────────────────────────────────────── */

describe("AMC_PAGE_SCRAPERS is internally consistent", () => {
  it("ids are unique and every id is reachable", () => {
    const ids = AMC_PAGE_SCRAPERS.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.equal(amcPageScraper(id)?.id, id);
  });

  it("every page URL is absolute https", () => {
    for (const s of AMC_PAGE_SCRAPERS) {
      const url = new URL(s.pageUrl);
      assert.equal(url.protocol, "https:", s.id);
    }
  });

  it("every house records what it is and why, in prose", () => {
    // The notes ARE the deliverable for a registry like this: the next person
    // needs the evidence, not the regex.
    for (const s of AMC_PAGE_SCRAPERS) {
      assert.ok(s.notes.length > 120, `${s.id} needs real notes`);
    }
  });

  it("no house accepts a link on no evidence at all", () => {
    // `include` may be empty (Mirae's filenames carry no word to key on), but
    // then `pathInclude` must not be — a house with neither would take every
    // workbook on the page, which on Shriram means 2,593 of them including a
    // DAILY debt-transaction file that dates cleanly to the current month.
    for (const s of AMC_PAGE_SCRAPERS) {
      assert.ok(
        s.include.length > 0 || s.pathInclude.length > 0,
        `${s.id} filters on neither filename nor path`,
      );
    }
  });

  it("only a JSON house may be requested with anything other than GET", () => {
    // Not a style rule: `pageRequest` exists because a caller that ignores it
    // gets HTTP 200 back from Mirae, not a transport error.
    for (const s of AMC_PAGE_SCRAPERS) {
      if (s.pageRequest.method === "GET") {
        assert.equal(s.pageRequest.body, undefined, `${s.id} GET with a body`);
        continue;
      }
      assert.equal(s.bodyKind, "json", `${s.id} POSTs but claims HTML`);
      assert.ok(s.pageRequest.body, `${s.id} POSTs with no body`);
      assert.ok(
        s.pageRequest.contentType,
        `${s.id} POSTs with no content-type`,
      );
      // A POST that can silently return an error 200 needs the detector.
      assert.ok(s.errorBody.length > 0, `${s.id} POSTs with no errorBody rule`);
    }
  });

  it("is disjoint from the template-based registry next door", () => {
    // An AMC belongs to exactly one resolver. Overlap would mean two answers
    // for one house with nothing to say which runs.
    const templated = new Set(["SBI", "NIPPON", "HDFC", "KOTAK", "ICICI", "UTI"]);
    for (const s of AMC_PAGE_SCRAPERS) {
      assert.equal(templated.has(s.id), false, `${s.id} is in both tables`);
    }
  });
});

describe("ABSL: seven filename conventions and a host with no DNS", () => {
  // MONEY-1405 D3. ABSL used to live in `amc-portfolio-sources.ts` marked
  // `needs-discovery` because five spellings of July-2026 404'd beside a
  // June-2026 that served. That measurement was right and the conclusion was
  // the filename is genuinely AD-HOC — seven conventions in the twenty months
  // of the committed listing — so no template can exist and this is a scrape.

  const links = SCRAPED.ABSL;
  const at = (year: number, month: number) =>
    pickLinkForMonth(links, new Date(Date.UTC(year, month, 15)), null);

  it("resolves every one of the seven spellings in the committed listing", () => {
    // Each of these is a different convention and all were published by the
    // same house inside eight months.
    assert.deepEqual(
      [7, 6, 5, 4, 3, 2, 1, 0].map((m) => at(2026, m)?.filename ?? null),
      [
        "monthly-portfolio-31082026_abslmf.zip",
        "absl_monthly_portfolio_report_july--2026.zip",
        "monthly-portfolio-30-june-2026.zip",
        "31052026_abslmf_monthly-portfolio.zip",
        "monthly-disclosure-april-30-2026.zip",
        "monthly-portfolio-mar-2026.zip",
        "sebi_monthly_portfolio-28-feb-2026.zip",
        "sebi_monthly_portfolio-31-jan-2026.zip",
      ],
    );
  });

  it("dates the two separator-less `DDMMYYYY` names, including the newest", () => {
    // MUTATION: drop the `NUMERIC_DMY_COMPACT` fallback from
    // `findNumericDates` -> August and May resolve to null, RED here. August
    // 2026 is the CURRENT month, so an undatable compact name is a house that
    // never ingests rather than one that misses an old month.
    assert.equal(
      parsePeriodFromFilename("monthly-portfolio-31082026_abslmf.zip", {
        yearRule: "four-digit",
        strapiHash: false,
        dateStyle: "numeric-dmy",
      })?.toISOString(),
      "2026-08-01T00:00:00.000Z",
    );
    assert.equal(
      parsePeriodFromFilename("31052026_abslmf_monthly-portfolio.zip", {
        yearRule: "four-digit",
        strapiHash: false,
        dateStyle: "numeric-dmy",
      })?.toISOString(),
      "2026-05-01T00:00:00.000Z",
    );
  });

  it("does NOT read a compact date out of an implausible 8-digit run", () => {
    // The three constraints that make eight digits safe where six are not:
    // day 1-31, month 1-12, year 1990-2100. A document id that fails any of
    // them is not a date, and `null` is the honest answer.
    for (const name of [
      "monthly-portfolio-99992026_absl.zip", // day 99, month 99
      "monthly-portfolio-31131998_absl.zip", // month 13
      "monthly-portfolio-31080099_absl.zip", // year 0099
    ]) {
      assert.equal(
        parsePeriodFromFilename(name, {
          yearRule: "four-digit",
          strapiHash: false,
          dateStyle: "numeric-dmy",
        }),
        null,
        name,
      );
    }
  });

  it("REBASES the dead CDN host onto the AMC's own origin", () => {
    // Every `pdfUrl` in the listing points at `abcscprod.azureedge.net`, which
    // has NO DNS RECORD — Azure CDN's `*.azureedge.net` was retired — so a
    // fetch fails to RESOLVE rather than 404ing, which reads as a network
    // fault rather than a bad link. The same paths serve 200 from the AMC's
    // own origin; measured 2026-09-13 at 1,755,538 bytes for August-2026.
    // MUTATION: empty ABSL's `rebaseHosts` -> every URL keeps the dead host,
    // RED here.
    assert.ok(links.length > 0, "the fixture must carry links");
    for (const l of links) {
      assert.ok(
        l.url.startsWith("https://mutualfund.adityabirlacapital.com/-/media/"),
        `not rebased: ${l.url}`,
      );
    }
  });

  it("keeps the fund-of-funds file out — it names no month-end portfolio", () => {
    // The listing carries `…/monthly-portfolio---fof/2020/fof-portfolio-1.zip`,
    // whose FILENAME says neither "monthly portfolio" nor a date. Including it
    // on the strength of its DIRECTORY is exactly the path-based dating this
    // module refuses to do.
    assert.ok(
      !links.some((l) => l.filename === "fof-portfolio-1.zip"),
      "a file the include rules do not name must not be scraped in",
    );
  });
});
