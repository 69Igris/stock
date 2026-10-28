/**
 * One fund, one page — MONEY-1205.
 *
 * `SBIETFQLTY` rendered at `/etf/SBIETFQLTY`, `/mf/145648` AND
 * `/stock/SBIETFQLTY`, with disjoint and partly-fabricated data on each. This
 * file pins the three route decisions and the ETF page's data wiring, because
 * every one of them is a one-line deletion away from coming back.
 *
 * Source-text assertions: these are React server components whose behaviour is
 * `redirect()` and JSX props, neither of which is reachable without a Next
 * runtime and a database. Each assertion below targets a specific line the
 * defect lived on, not the general shape of the file.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

/** LINE comments before BLOCK comments — MONEY-1143. */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const read = (rel: string) =>
  stripComments(readFileSync(join(ROOT, rel), "utf8"));

const stockPage = read("app/stock/[symbol]/page.tsx");
const mfPage = read("app/mf/[schemeCode]/page.tsx");
const etfPage = read("app/etf/[symbol]/page.tsx");
const etfClient = read("app/etf/[symbol]/client.tsx");
const mfClient = read("app/mf/[schemeCode]/client.tsx");

describe("MONEY-1205 — /stock/[symbol] is not the fund route", () => {
  it("[regression] an ETF redirects to /etf/", () => {
    assert.match(
      stockPage,
      /if \(instrument\?\.instrumentType === "ETF"\) \{\s*redirect\(/,
      "the OHLC/PE page must hand an ETF to its own route"
    );
  });

  it("the redirect target comes from the shared helper", () => {
    // Otherwise the destination can drift from what the link sites emit, which
    // is the bug one level up.
    assert.match(
      stockPage,
      /redirect\(\s*instrumentDetailHref\(\{[\s\S]{0,200}?instrumentType: "ETF"/
    );
  });

  it("the redirect sits OUTSIDE the swallowing try/catch", () => {
    // `redirect()` signals by throwing. Inside the bare `catch {}` that wraps
    // the instrument read, the page would silently fall through and render an
    // equity page instead. Measured on the RAW source so comment-stripping
    // cannot move the landmarks.
    const raw = readFileSync(join(ROOT, "app/stock/[symbol]/page.tsx"), "utf8");
    const instrumentRead = raw.indexOf(
      "instrument = await prisma.instrumentMapping.findFirst"
    );
    const catchEnd = raw.indexOf("}", raw.indexOf("} catch {", instrumentRead));
    const etfRedirect = raw.indexOf('instrument?.instrumentType === "ETF"');
    assert.ok(instrumentRead > 0, "the instrument read must still be there");
    assert.ok(
      etfRedirect > catchEnd,
      "the ETF redirect must follow the catch block, never sit inside it"
    );
  });

  it("[regression] the numeric scheme-code redirect re-throws NEXT_REDIRECT", () => {
    // Pre-existing defect found while adding the ETF branch: this redirect was
    // wrapped in a bare `catch {}`, which caught Next's own control-flow throw.
    // `/stock/119551` therefore never reached `/mf/119551` at all.
    assert.match(
      stockPage,
      /catch \(e\) \{[\s\S]{0,200}?if \(e && typeof e === "object" && "digest" in e\) throw e;/,
      "a bare catch swallows redirect() and the redirect becomes a no-op"
    );
  });
});

describe("MONEY-1205 — /mf/[schemeCode] defers to /etf/ for a listed ETF", () => {
  it("[regression] redirects when the scheme resolves to an ETF instrument", () => {
    assert.match(
      mfPage,
      /if \(identity\?\.instrumentType === "ETF" && identity\.symbol\) \{\s*redirect\(/
    );
  });

  it("resolves through the SAME seam the ETF page uses", () => {
    assert.match(
      mfPage,
      /resolveFundIdentity\(\{ schemeCode: mfData\.schemeCode \}\)/
    );
  });

  it("the ISIN redirects still work", () => {
    // /mf/INF200KA1WX6 -> /mf/145648 -> /etf/SBIETFQLTY.
    assert.match(mfPage, /isinGrowth: schemeCode/);
    assert.match(mfPage, /resolveIsinToSchemeCode\(schemeCode\)/);
  });
});

describe("MONEY-1205 — the ETF page reads identity from the master", () => {
  it("[regression] selects the identity columns it was already joining past", () => {
    assert.match(
      etfPage,
      /resolveFundIdentity\(\{[\s\S]{0,160}?instrumentTypes: \["ETF"\]/
    );
    assert.match(
      etfPage,
      /const fundHouse = master\?\.amcName \?\? derivedHouse;/
    );
    assert.match(
      etfPage,
      /const category = master\?\.category \?\? derivedCategory;/
    );
  });

  it("keeps etf-derive as the FALLBACK, not the source", () => {
    // 541/541 ETFs join a master today, but a newly listed one does not, and
    // the page must still render for it.
    assert.match(etfPage, /extractEtfFundHouse\(/);
    assert.match(etfPage, /deriveEtfCategory\(/);
    assert.doesNotMatch(
      etfPage,
      /fundHouse=\{extractEtfFundHouse/,
      "the name-parse must not be passed straight to the view"
    );
  });

  it("[regression] the benchmark is never fed the category", () => {
    assert.match(
      etfPage,
      /benchmarkName=\{master\?\.benchmarkName \?\? null\}/
    );
    assert.doesNotMatch(
      etfClient,
      /benchmarkName=\{category\}/,
      "MONEY-610 removed a fabricated benchmark once; the category is not one"
    );
    // Both the stats grid and the About card were fed it.
    assert.equal(
      (etfClient.match(/benchmarkName=\{benchmarkName\}/g) ?? []).length,
      2,
      "both consumers must take the resolved (possibly null) benchmark"
    );
  });

  it("[regression] the 52-week range is price-based AND labelled", () => {
    // The page hard-passed navHigh/navLow null despite holding 1,892 daily bars
    // for this very ETF. A traded-price high is not a NAV high.
    assert.match(etfPage, /priceHigh52=\{range\.high\}/);
    assert.match(etfClient, /navHigh=\{priceHigh52\}/);
    assert.match(etfClient, /rangeBasis="PRICE"/);
    assert.doesNotMatch(etfClient, /navHigh=\{null\}/);
    assert.doesNotMatch(etfClient, /returnsInception=\{null\}/);
  });
});

describe("MONEY-1205 — the ETF page shows the AMC's own disclosure", () => {
  it("[regression] MfPortfolioTab is imported and mounted", () => {
    // 52 ETF scheme codes have real `mf_portfolio_holdings` on prod while this
    // page rendered only a model estimate of what the fund holds.
    assert.match(
      etfClient,
      /import \{ MfPortfolioTab \} from "@\/components\/mf\/MfPortfolioTab"/
    );
    assert.match(etfClient, /<MfPortfolioTab schemeCode=\{schemeCode\}/);
  });

  it("the composition panel is demoted, not deleted", () => {
    // It owns the sector/cap donuts and is the only writer of `FundHolding`,
    // which `getMfPortfolioSection` falls back to.
    assert.match(etfClient, /<FundCompositionSection\s+fundType="ETF"/);
  });

  it("[regression] MONEY-1405 D5 — it is given the SCHEME CODE, not only the symbol", () => {
    // `mf_portfolio_holdings` has never been keyed by a trading symbol. Without
    // this prop the panel can only ever serve the model recollection, however
    // complete the AMC's filing is. ETFs are schemes and appear in the SAME
    // monthly AMC file.
    assert.match(
      etfClient,
      /<FundCompositionSection[\s\S]{0,200}?schemeCode=\{schemeCode \?\? undefined\}/
    );
    // MONEY-1401 — the BEHAVIOUR behind this prop lives in
    // `__tests__/components/fund-composition-auto-trigger.test.ts`
    // ("hasOfficialDisclosure HAS behaviour"). This assertion alone is a scan of
    // the PAGE: measured by mutation, it stays green with the component
    // ignoring the prop outright, because for two releases its only consumer
    // was `shouldAutoExtractComposition`, whose body is `return false`.
    assert.match(
      etfClient,
      /<FundCompositionSection[\s\S]{0,240}?hasOfficialDisclosure=\{disclosure === "official"\}/
    );
  });

  it("[regression] mounted for BOTH disclosure states, and NEVER while UNKNOWN", () => {
    // MONEY-1405 D4 relaxed the old `no-official` gate so the donuts can be
    // built FROM the disclosure. The reason that gate existed — never two
    // tables of different numbers for one fund — moved one layer down rather
    // than being abandoned; the companion assertion lives in
    // `components/fund-composition-auto-trigger.test.ts`.
    assert.match(
      etfClient,
      /disclosure !== "unknown" && \(\s*<FundCompositionSection/,
      "UNKNOWN must still hide it: a disappearing panel moves the page"
    );
    assert.doesNotMatch(
      etfClient,
      /disclosure === "no-official" && \(\s*<FundCompositionSection/
    );
  });

  it("the gate is TRI-state and UNKNOWN hides the estimate", () => {
    assert.match(
      etfClient,
      /useState<\s*"unknown" \| "official" \| "no-official"\s*>\("unknown"\)/
    );
  });

  it("a failed read is not evidence that a disclosure exists", () => {
    assert.match(
      etfClient,
      /if \(!r\.success\) \{\s*setDisclosure\("no-official"\);/
    );
    assert.match(
      etfClient,
      /\.catch\(\(\) => \{[\s\S]{0,160}?setDisclosure\("no-official"\)/
    );
  });

  it("uses the exact rule the MF page uses", () => {
    const rule =
      /r\.data\.empty \|\| r\.data\.fallback \? "no-official" : "official"/;
    assert.match(mfClient, rule, "the MF page's rule");
    assert.match(
      etfClient,
      rule,
      "and the ETF page's, character for character"
    );
  });
});

describe("MONEY-1205 — key numbers come from the server derivation", () => {
  it("[regression] the client useMemo re-derivation is gone", () => {
    assert.doesNotMatch(mfClient, /const computedReturns = useMemo/);
    assert.doesNotMatch(mfClient, /const navRange = useMemo/);
    assert.doesNotMatch(mfClient, /function findNavAtYearsAgo/);
  });

  it("both pages call the same derivation", () => {
    // Whitespace-tolerant: prettier reflows these calls across lines, and the
    // assertion is about the CALL, not its line breaks.
    assert.match(
      mfPage,
      /getFundNavDerivatives\(\{\s*schemeCode:\s*data\.schemeCode,?\s*\}\)/
    );
    assert.match(
      etfPage,
      /getFundNavDerivatives\(\{\s*schemeCode:\s*identity\.schemeCode,?\s*\}\)/
    );
  });

  it("and both hand the grid the WHY, not just the number", () => {
    assert.match(mfClient, /history=\{navStats\}/);
    assert.match(etfClient, /history=\{navStats\}/);
  });
});
