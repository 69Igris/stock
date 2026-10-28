/**
 * MONEY-1144 — upstream data vendors are not named in the product surface.
 *
 * Two pills were removed from `/stock/[symbol]`: "TICKERTAPE" on the
 * Fundamentals card (which rendered `data.source` straight from the DB row)
 * and "Yahoo" on the Price Chart card.
 *
 * The distinction this file encodes, because it is the part that is easy to
 * get wrong in either direction:
 *
 *   REMOVE — a label naming who we buy/scrape data FROM. It tells the user
 *   nothing they can act on and exposes our supply chain.
 *
 *   KEEP — three things that look similar and are not:
 *     1. "Zerodha" on the same chart pill. That names the USER'S OWN broker
 *        connection and means "this chart is live, not exchange-delayed".
 *        Deleting it would remove a real signal, so the pill still renders for
 *        a connected broker — it just no longer names the fallback vendor.
 *     2. Citation favicons in chat/research (`screener.in`, `tickertape.in`
 *        alongside `moneycontrol.com`, `sebi.gov.in`). Citing a source you
 *        actually read is attribution, and cited live sources are a product
 *        differentiator.
 *     3. The competitor comparison tables on the marketing pages. Naming a
 *        competitor on a "UseMoney vs X" page is the point of the page.
 *
 * Source: apps/web/components/stock/StockFundamentalsCard.tsx,
 *         apps/web/app/stock/[symbol]/client.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/**
 * LINE comments first, then BLOCK comments — the order is load-bearing
 * (MONEY-1143). Reversed, a `//` comment containing `/*` opens a phantom block
 * that swallows everything to the next `*` + `/`, and every "this label is
 * absent" assertion below would pass because the text was eaten rather than
 * because the label is gone. This file explains the removals in comments that
 * necessarily quote the removed strings, so correct stripping is what makes
 * the assertions mean anything at all.
 */
function stripComments(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const fundamentalsSrc = read("components/stock/StockFundamentalsCard.tsx");
const stockClientSrc = read("app/stock/[symbol]/client.tsx");
const sectionShellSrc = read("components/stock/SectionShell.tsx");
// MONEY-1211 — `StockFinancialsSourceBadge.tsx` was this rule's second
// subject; the whole "Financials provenance" section is deleted. The RULE is
// not: `sourceLabel` still renders on the stock page through
// `StockFlagsBadges`, so the guard moves to the surface that still mints
// labels rather than being retired with the file it happened to be pointed at.
const flagsBadgesSrc = read("components/stock/StockFlagsBadges.tsx");
// MONEY-1255 — the market-cap UNIT guard below. Scoped to the RULE (every
// surface that renders a crores-denominated market cap) rather than to the one
// file that happened to break, which is the lesson MONEY-1207 wrote down.
const peersTabSrc = read("components/stock/StockPeersTab.tsx");

/**
 * Vendors this rule is about. Deliberately NOT a regex over the whole file:
 * a comment may need to name the vendor to explain why it is absent, and the
 * stripComments pass above is what makes that safe.
 */
const VENDOR_NAMES = [
  "Tickertape",
  "Screener.in",
  "Yahoo Finance",
  "Kuvera",
  "Moneycontrol",
] as const;

/** Keys of the `KNOWN` decode table in SectionShell, with their labels. */
function knownSourceLabels(src: string): Array<[string, string]> {
  const start = src.indexOf("const KNOWN: Record<string, string> = {");
  assert.notEqual(start, -1, "the KNOWN decode table was renamed or removed");
  const end = src.indexOf("\n  };", start);
  assert.notEqual(end, -1, "could not find the end of the KNOWN table");
  const body = stripComments(src.slice(start, end));
  const out: Array<[string, string]> = [];
  for (const m of body.matchAll(/^\s*"?([A-Za-z0-9_-]+)"?:\s*"([^"]*)"/gm)) {
    out.push([m[1]!, m[2]!]);
  }
  return out;
}

describe("MONEY-1144 — vendor names are not rendered", () => {
  it("[meta] stripComments cannot swallow the code under assertion", () => {
    const fixture = [
      "const a = 1;",
      "// a line comment mentioning tours/* which opens nothing",
      'const KEEP = "Zerodha";',
      "/* a real block */",
      "const b = 2;",
    ].join("\n");
    const stripped = stripComments(fixture);
    assert.match(
      stripped,
      /KEEP/,
      "LINE comments must be stripped before BLOCK comments, or these " +
        "absence assertions become unfalsifiable"
    );
    assert.doesNotMatch(stripped, /a real block/);
  });

  describe("Fundamentals card", () => {
    it("[regression] does not render the row's `source` as a pill", () => {
      const live = stripComments(fundamentalsSrc);
      assert.doesNotMatch(
        live,
        /\{\s*data\.source\s*\}/,
        "rendering `data.source` puts the vendor name (TICKERTAPE) back on screen"
      );
      assert.doesNotMatch(
        live,
        /data\?\.source\s*&&/,
        "the conditional that gated the vendor pill is back"
      );
    });

    it("does not hard-code a vendor name either", () => {
      assert.doesNotMatch(stripComments(fundamentalsSrc), /TICKERTAPE/i);
    });

    it("uses the CRORES formatter for market cap, not the rupees one", () => {
      // The other half of MONEY-1144: `StockRatios.marketCap` is in crores, and
      // the rupees formatter rendered every mid-cap as "₹0 Cr".
      const live = stripComments(fundamentalsSrc);
      assert.match(live, /formatMarketCapCrores\(/);
      assert.doesNotMatch(
        live,
        /[^s]formatMarketCap\(/,
        "the rupees formatter divides by 1e7 again and yields ₹0 Cr"
      );
    });
  });

  describe("Price chart card", () => {
    it("[regression] does not render 'Yahoo' as a source label", () => {
      assert.doesNotMatch(
        stripComments(stockClientSrc),
        /["']Yahoo["']/,
        "the chart pill must not name the fallback data vendor"
      );
    });

    it("still renders 'Zerodha' — that one is the user's own connection", () => {
      // Guards the over-correction: stripping the whole pill would delete the
      // live-vs-delayed signal, which is a real thing the user acts on.
      const live = stripComments(stockClientSrc);
      assert.match(
        live,
        /Zerodha/,
        "a connected broker must still be surfaced — it means the chart is live"
      );
      assert.match(
        live,
        /chartSourceLabel === "zerodha"/,
        "the connected-broker branch must survive"
      );
    });
  });

  describe("public marketing surfaces", () => {
    it("[regression] the changelog does not advertise scraping a named site", () => {
      // Worse than an in-app provenance pill: this is a PUBLIC page, and it
      // described the practice, not just the source.
      const changelog = stripComments(
        read("app/(marketing)/changelog/releases.tsx")
      );
      assert.doesNotMatch(
        changelog,
        /Screener\.in scraper/i,
        "do not describe a named third party's site as something we scrape"
      );
    });

    it("competitor comparison tables are left alone (not a leak)", () => {
      // Liveness guard for this whole file: if these disappear, someone has
      // over-applied the rule and gutted the comparison pages.
      const alternatives = read("app/(marketing)/alternatives/page.tsx");
      assert.match(
        alternatives,
        /Tickertape/,
        "naming competitors on a 'UseMoney vs X' page is the point of the page"
      );
    });
  });
});

/**
 * MONEY-1207 — the same rule, on the surface that reintroduced the breach.
 *
 * MONEY-1144 removed two vendor PILLS and this file guarded those two files.
 * P14 then added a provenance chip to every new section, decoding the stored
 * source code through `sourceLabel` — and put "Tickertape", "Screener.in",
 * "Yahoo Finance" and "Kuvera" straight back on screen, on the stock page and
 * on `/v1` for mobile. Nothing failed, because the guard was scoped to the two
 * original files rather than to the RULE.
 *
 * So this asserts the rule where the labels are minted, not where they render.
 */
describe("MONEY-1207 — sourceLabel does not name a data vendor", () => {
  it("no KNOWN decode maps to a vendor name", () => {
    const offenders = knownSourceLabels(sectionShellSrc).filter(([, label]) =>
      VENDOR_NAMES.some((v) => label.toLowerCase().includes(v.toLowerCase()))
    );
    assert.deepEqual(
      offenders,
      [],
      "these source codes decode to a vendor name on screen. Name the " +
        "AUTHORITY (an exchange, regulator, or the issuer's own disclosure) " +
        "or say 'Third-party data' — never who we buy or scrape from."
    );
  });

  it("the four vendor codes still HAVE a decode — silence is not the fix", () => {
    // Deleting the rows would be the other failure: the raw code would then
    // reach the screen through the UPPER_SNAKE fallback as "TICKERTAPE".
    const labels = new Map(knownSourceLabels(sectionShellSrc));
    for (const code of ["TICKERTAPE", "SCREENER", "YAHOO", "KUVERA"]) {
      const label = labels.get(code);
      assert.ok(label, `${code} lost its decode — it would render raw`);
      assert.ok(label.trim().length > 0, `${code} decodes to an empty string`);
    }
  });

  it("no sourceLabel consumer hard-codes a vendor name", () => {
    for (const [name, src] of [
      ["SectionShell.tsx", sectionShellSrc],
      ["StockFlagsBadges.tsx", flagsBadgesSrc],
    ] as const) {
      const body = stripComments(src);
      for (const vendor of VENDOR_NAMES) {
        assert.ok(
          !body.includes(vendor),
          `${name} renders the vendor name "${vendor}"`
        );
      }
    }
  });
});

/**
 * MONEY-1255 — a crores market cap is never rendered through a rupees formatter.
 *
 * MONEY-1144 fixed this on the Fundamentals card and this file guarded THAT
 * FILE. The Peers table on the same page then shipped its own file-local
 * `fmtMcap` doing `const cr = v / 1e7`, treating `StockRatios.marketCap` — which
 * is already crores — as rupees. APOLLOTYRE's ₹28,023 Cr became 0.0028, and
 * `.toFixed(0)` rendered "₹0 Cr". Every row, every company, market-wide.
 *
 * Two things made it survive, and both are what this section actually guards:
 *
 *   1. The formatter was FILE-LOCAL, so it could not be imported and therefore
 *      could not be unit-tested. `stock-formatters.test.ts` covered the shared
 *      pair exhaustively and could not see this one at all.
 *   2. The failure renders a confident WRONG number rather than an empty state,
 *      so no "no data" branch fires and the page looks healthy.
 *
 * So the assertions are about the SHAPE of the code, not about output: use the
 * shared formatter, and do not re-derive a scale factor locally.
 */
describe("MONEY-1255 — crores market caps use the shared crores formatter", () => {
  /** Every surface that renders a CRORES-denominated market cap. */
  const CRORES_SURFACES = [
    ["StockFundamentalsCard.tsx", fundamentalsSrc],
    ["StockPeersTab.tsx", peersTabSrc],
  ] as const;

  it("[meta] the sources under assertion are non-empty and really read", () => {
    // Guards the unfalsifiable case: a renamed/moved file would make `read`
    // throw, but a wrong-but-existing path would silently pass every
    // `doesNotMatch` below.
    for (const [name, body] of CRORES_SURFACES) {
      assert.ok(body.length > 500, `${name} looks empty — path wrong?`);
      assert.match(body, /marketCap/, `${name} does not mention marketCap`);
    }
  });

  for (const [name, body] of CRORES_SURFACES) {
    describe(name, () => {
      const live = stripComments(body);

      it("calls the CRORES formatter", () => {
        assert.match(
          live,
          /formatMarketCapCrores\(/,
          `${name} must render market cap through the shared crores formatter`
        );
      });

      it("does NOT call the rupees formatter", () => {
        // `[^s]` so `formatMarketCapCrores(` cannot satisfy this by accident.
        assert.doesNotMatch(
          live,
          /[^s]formatMarketCap\(/,
          `${name}: the rupees formatter divides by 1e7 again -> "₹0 Cr"`
        );
      });

      it("imports it rather than redefining a local copy", () => {
        assert.match(
          live,
          /import\s*\{[^}]*formatMarketCapCrores[^}]*\}\s*from\s*["'][^"']*stock-format["']/,
          `${name} must import the shared formatter — a file-local one is ` +
            `unimportable, therefore untestable, which is how this bug shipped`
        );
        assert.doesNotMatch(
          live,
          /function\s+\w*[Mm]cap\w*\s*\(/,
          `${name} defines a local market-cap formatter again`
        );
      });

      it("[regression] re-derives no crore scale factor of its own", () => {
        // The literal defect: `const cr = v / 1e7`. Any local division by a
        // crore is a second unit conversion on a value already in crores.
        assert.doesNotMatch(
          live,
          /\/\s*(1e7|10_000_000|10000000)\b/,
          `${name} divides by a crore locally. \`StockRatios.marketCap\` is ` +
            `ALREADY crores; dividing again is MONEY-1144 / MONEY-1255 exactly.`
        );
      });
    });
  }

  it("the peers table actually renders the peer's marketCap through it", () => {
    // Liveness: the assertions above are all satisfiable by a file that
    // imports the formatter and never calls it on the real field.
    assert.match(
      stripComments(peersTabSrc),
      /formatMarketCapCrores\(\s*p\.marketCap\s*\)/,
      "the MCap cell must format the row's own marketCap"
    );
  });
});
