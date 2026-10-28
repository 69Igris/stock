/**
 * Screener full-page scraper — NEW section parsers (MONEY-853).
 *
 * Covers the structured capture added to `screener-full-scraper.ts`:
 *   - shareholding pattern (#shareholding → promoter/FII/DII/public/govt trend)
 *   - peers / comparison table (#peers → CMP/PE/MCap/DivYld/ROCE per peer)
 *   - Documents → credit-rating + announcement links (parseDocumentLinks)
 *   - parseCompoundedGrowth (Sales/Profit/Stock-CAGR/ROE per 3/5/10yr)
 *
 * These are the REAL parser exports the single-fetch `scrapeScreenerFullPage`
 * calls; we drive them directly with a cheerio object over representative
 * screener.in HTML (same precedent as `corporate-actions-parsing.test.ts`, which
 * tests `parseScreenerActionDate` / `parseCorporateActions`). No network — the
 * 3s self-throttle lives only in `scrapeScreenerFullPage`, not in the parsers.
 *
 * The DOM shapes mirror screener.in's company page (section#shareholding /
 * section#peers / table.ranges-table / the Documents + Announcements lists).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";

import {
  parseShareholding,
  parsePeers,
  parseCompoundedGrowth,
  parseDocumentLinks,
} from "@usemoney/research/data-sources/screener-full-scraper";

// ── Shareholding pattern (#shareholding) ────────────────────────────────────

describe("parseShareholding (#shareholding)", () => {
  const HTML = `
    <html><body><section id="shareholding"><table>
      <thead><tr><th></th><th>Mar 2023</th><th>Jun 2023</th><th>Sep 2023</th></tr></thead>
      <tbody>
        <tr><td>Promoters +</td><td>50.6%</td><td>50.4%</td><td>50.3%</td></tr>
        <tr><td>FIIs +</td><td>23.1%</td><td>22.8%</td><td>22.5%</td></tr>
        <tr><td>DIIs +</td><td>15.2%</td><td>15.6%</td><td>16.0%</td></tr>
        <tr><td>Government +</td><td>0.2%</td><td>0.2%</td><td>0.2%</td></tr>
        <tr><td>Public +</td><td>10.9%</td><td>11.0%</td><td>11.0%</td></tr>
      </tbody>
    </table></section></body></html>`;

  it("captures promoter/FII/DII/public/government per quarter", () => {
    const rows = parseShareholding(cheerio.load(HTML));
    assert.strictEqual(rows.length, 3);

    const q1 = rows[0]!;
    assert.strictEqual(q1.quarter, "Mar 2023");
    assert.strictEqual(q1.promoter, 50.6);
    assert.strictEqual(q1.fii, 23.1);
    assert.strictEqual(q1.dii, 15.2);
    assert.strictEqual(q1.public, 10.9);
    assert.strictEqual(q1.government, 0.2);
  });

  it("preserves the quarterly trend (promoter slipping, DII rising)", () => {
    const rows = parseShareholding(cheerio.load(HTML));
    assert.strictEqual(rows[0]!.promoter, 50.6);
    assert.strictEqual(rows[2]!.promoter, 50.3);
    assert.strictEqual(rows[0]!.dii, 15.2);
    assert.strictEqual(rows[2]!.dii, 16.0);
  });

  it("matches rows by label keyword regardless of order/casing", () => {
    const reordered = `
      <html><body><section id="shareholding"><table>
        <thead><tr><th></th><th>Mar 2024</th></tr></thead>
        <tbody>
          <tr><td>Public</td><td>40%</td></tr>
          <tr><td>FII</td><td>10%</td></tr>
          <tr><td>Promoter</td><td>50%</td></tr>
        </tbody>
      </table></section></body></html>`;
    const [row] = parseShareholding(cheerio.load(reordered));
    assert.strictEqual(row!.promoter, 50);
    assert.strictEqual(row!.fii, 10);
    assert.strictEqual(row!.public, 40);
    assert.strictEqual(row!.dii, null); // absent → null, not 0
    assert.strictEqual(row!.government, null);
  });

  it("returns [] when there is no #shareholding section", () => {
    assert.deepStrictEqual(
      parseShareholding(
        cheerio.load("<html><body><div>nope</div></body></html>")
      ),
      []
    );
  });

  it("returns [] when the section has no period headers", () => {
    assert.deepStrictEqual(
      parseShareholding(
        cheerio.load("<section id='shareholding'><table></table></section>")
      ),
      []
    );
  });
});

// ── Peers / comparison (#peers) ─────────────────────────────────────────────

describe("parsePeers (#peers)", () => {
  const HTML = `
    <html><body><section id="peers"><table>
      <thead><tr>
        <th>S.No.</th><th>Name</th><th>CMP Rs.</th><th>P/E</th>
        <th>Mar Cap Rs.Cr.</th><th>Div Yld %</th><th>ROCE %</th>
      </tr></thead>
      <tbody>
        <tr>
          <td>1</td>
          <td><a href="/company/RELIANCE/consolidated/">Reliance Inds</a></td>
          <td>2,950.00</td><td>28.5</td><td>19,90,000</td><td>0.35</td><td>9.80</td>
        </tr>
        <tr>
          <td>2</td>
          <td><a href="/company/ONGC/consolidated/">ONGC</a></td>
          <td>270.00</td><td>7.2</td><td>3,40,000</td><td>4.10</td><td>16.20</td>
        </tr>
        <tr>
          <td></td><td>Median: 2 Co.</td><td>1,610</td><td>17.8</td><td></td><td></td><td>13.0</td>
        </tr>
      </tbody>
    </table></section></body></html>`;

  it("captures peer rows with header-resolved numeric columns", () => {
    const peers = parsePeers(cheerio.load(HTML));
    assert.strictEqual(peers.length, 2); // Median footer dropped (no link)

    const rel = peers.find((p) => p.symbol === "RELIANCE")!;
    assert.strictEqual(rel.name, "Reliance Inds");
    assert.strictEqual(rel.price, 2950);
    assert.strictEqual(rel.pe, 28.5);
    assert.strictEqual(rel.marketCap, 1990000);
    assert.strictEqual(rel.dividendYield, 0.35);
    assert.strictEqual(rel.roce, 9.8);

    const ongc = peers.find((p) => p.symbol === "ONGC")!;
    assert.strictEqual(ongc.pe, 7.2);
    assert.strictEqual(ongc.roce, 16.2);
  });

  it("derives the symbol from the /company/<SYM>/ href, upper-cased", () => {
    const peers = parsePeers(cheerio.load(HTML));
    assert.deepStrictEqual(peers.map((p) => p.symbol).sort(), [
      "ONGC",
      "RELIANCE",
    ]);
  });

  it("resolves columns by header text even when re-ordered", () => {
    // ROCE before P/E — index-based parsing would mis-map; header-based is safe.
    const reordered = `
      <section id="peers"><table>
        <thead><tr><th>Name</th><th>ROCE %</th><th>P/E</th></tr></thead>
        <tbody><tr>
          <td><a href="/company/TCS/">TCS</a></td><td>55.0</td><td>30.0</td>
        </tr></tbody>
      </table></section>`;
    const [tcs] = parsePeers(cheerio.load(reordered));
    assert.strictEqual(tcs!.roce, 55);
    assert.strictEqual(tcs!.pe, 30);
  });

  it("returns [] when there is no #peers section", () => {
    assert.deepStrictEqual(
      parsePeers(cheerio.load("<html><body><div>x</div></body></html>")),
      []
    );
  });
});

// ── Compounded growth (parseCompoundedGrowth fix) ───────────────────────────

describe("parseCompoundedGrowth (ranges-table)", () => {
  const HTML = `
    <html><body><section id="profit-loss">
      <table class="ranges-table"><tbody>
        <tr><th>Compounded Sales Growth</th></tr>
        <tr><td>10 Years:</td><td>12%</td></tr>
        <tr><td>5 Years:</td><td>18%</td></tr>
        <tr><td>3 Years:</td><td>22%</td></tr>
        <tr><td>TTM:</td><td>9%</td></tr>
      </tbody></table>
      <table class="ranges-table"><tbody>
        <tr><th>Compounded Profit Growth</th></tr>
        <tr><td>10 Years:</td><td>15%</td></tr>
        <tr><td>5 Years:</td><td>20%</td></tr>
        <tr><td>3 Years:</td><td>-4%</td></tr>
      </tbody></table>
      <table class="ranges-table"><tbody>
        <tr><th>Stock Price CAGR</th></tr>
        <tr><td>10 Years:</td><td>17%</td></tr>
        <tr><td>5 Years:</td><td>11%</td></tr>
      </tbody></table>
      <table class="ranges-table"><tbody>
        <tr><th>Return on Equity</th></tr>
        <tr><td>10 Years:</td><td>13%</td></tr>
        <tr><td>3 Years:</td><td>9%</td></tr>
      </tbody></table>
    </section></body></html>`;

  it("structures Sales/Profit/Stock-CAGR/ROE per 3/5/10yr (+ TTM)", () => {
    const g = parseCompoundedGrowth(cheerio.load(HTML));
    assert.deepStrictEqual(g.salesGrowth, {
      "10 Years": 12,
      "5 Years": 18,
      "3 Years": 22,
      TTM: 9,
    });
    assert.deepStrictEqual(g.profitGrowth, {
      "10 Years": 15,
      "5 Years": 20,
      "3 Years": -4, // negative parsed
    });
    assert.deepStrictEqual(g.stockPriceCagr, { "10 Years": 17, "5 Years": 11 });
    assert.deepStrictEqual(g.returnOnEquity, { "10 Years": 13, "3 Years": 9 });
  });

  it("classifies by heading — profit growth does not leak into salesGrowth", () => {
    const g = parseCompoundedGrowth(cheerio.load(HTML));
    assert.strictEqual(g.salesGrowth["10 Years"], 12);
    assert.strictEqual(g.profitGrowth["10 Years"], 15);
  });

  it("parses en-dash negatives and comma cells", () => {
    const html = `
      <section id="profit-loss"><table class="ranges-table"><tbody>
        <tr><th>Compounded Sales Growth</th></tr>
        <tr><td>5 Years:</td><td>–3 %</td></tr>
        <tr><td>3 Years:</td><td>1,234%</td></tr>
      </tbody></table></section>`;
    const g = parseCompoundedGrowth(cheerio.load(html));
    assert.strictEqual(g.salesGrowth["5 Years"], -3);
    assert.strictEqual(g.salesGrowth["3 Years"], 1234);
  });

  it("returns empty maps (never throws) when no ranges-table is present", () => {
    const g = parseCompoundedGrowth(cheerio.load("<html><body></body></html>"));
    assert.deepStrictEqual(g, {
      salesGrowth: {},
      profitGrowth: {},
      stockPriceCagr: {},
      returnOnEquity: {},
    });
  });

  it("skips heading-only rows and blank value cells", () => {
    const html = `
      <section id="profit-loss"><table class="ranges-table"><tbody>
        <tr><th>Return on Equity</th></tr>
        <tr><td>10 Years:</td><td></td></tr>
        <tr><td>5 Years:</td><td>14%</td></tr>
      </tbody></table></section>`;
    const g = parseCompoundedGrowth(cheerio.load(html));
    assert.deepStrictEqual(g.returnOnEquity, { "5 Years": 14 });
  });
});

// ── Documents: credit ratings + announcements (parseDocumentLinks) ──────────

describe("parseDocumentLinks — credit ratings + announcements", () => {
  const HTML = `
    <html><body>
      <section id="documents">
        <div class="annual-reports">
          <a href="https://www.bseindia.com/xml-data/corpfiling/AnnualReport2023.pdf">Financial Year 2023</a>
        </div>
        <div class="concalls">
          <a href="/concall/transcript/1">Transcript</a>
          <a href="/concall/summary/1">AI Summary</a>
          <a href="/concall/ppt/1">PPT</a>
        </div>
        <div class="credit-ratings">
          <a href="https://www.careratings.com/upload/RELIANCE-Mar-2024.pdf">Rating rationale Mar 2024</a>
          <a href="https://www.crisil.com/ratings/RELIANCE-2023.pdf">CRISIL Credit Rating 2023</a>
        </div>
      </section>
      <section id="announcements"><ul>
        <li><a href="https://www.bseindia.com/corporates/anndet/AnnRel-2024.pdf">Board Meeting Outcome 12 May 2024</a></li>
        <li><a href="https://www.nseindia.com/corporate/REL-update.pdf">Quarterly investor update 2024</a></li>
        <li><a href="/in-page-nav">Read more</a></li>
      </ul></section>
    </body></html>`;

  it("captures credit-rating PDFs with agency source + period", () => {
    const docs = parseDocumentLinks(cheerio.load(HTML), "RELIANCE");
    const ratings = docs.filter((d) => d.type === "credit_rating");
    assert.strictEqual(ratings.length, 2);

    const care = ratings.find((r) => r.source === "care")!;
    assert.match(care.url, /careratings\.com/);
    assert.strictEqual(care.period, "Mar 2024");
    assert.match(care.title, /Credit Rating CARE/);

    const crisil = ratings.find((r) => r.source === "crisil")!;
    assert.match(crisil.url, /crisil\.com/);
    assert.strictEqual(crisil.period, "2023");
  });

  it("captures announcement filings but excludes ratings + nav links", () => {
    const docs = parseDocumentLinks(cheerio.load(HTML), "RELIANCE");
    const anns = docs.filter((d) => d.type === "announcement");
    assert.strictEqual(anns.length, 2);
    assert.ok(anns.some((a) => /Board Meeting Outcome/.test(a.title)));
    assert.ok(anns.every((a) => /bseindia|nseindia/.test(a.url)));
    assert.ok(!anns.some((a) => /careratings|crisil/.test(a.url)));
  });

  it("keeps the annual report + concall links intact (existing flow)", () => {
    const docs = parseDocumentLinks(cheerio.load(HTML), "RELIANCE");
    const types = new Set(docs.map((d) => d.type));
    assert.ok(types.has("annual_report"));
    assert.ok(types.has("concall_transcript"));
    assert.ok(types.has("concall_ai_summary"));
    assert.ok(types.has("concall_ppt"));
  });

  it("de-dupes the same (type,url) reachable from two selectors", () => {
    const docs = parseDocumentLinks(cheerio.load(HTML), "RELIANCE");
    const seen = new Set(docs.map((d) => `${d.type}|${d.url}`));
    assert.strictEqual(seen.size, docs.length);
  });

  it("classifies a generic 'credit rating' link with no known agency as unknown", () => {
    const html = `
      <section id="documents"><div>
        <a href="/docs/some-rating.pdf">Credit Rating update</a>
      </div></section>`;
    const docs = parseDocumentLinks(cheerio.load(html), "TCS");
    const rating = docs.find((d) => d.type === "credit_rating");
    assert.ok(rating, "generic credit-rating link captured");
    assert.strictEqual(rating!.source, "unknown");
  });

  it("returns [] for a page with no documents/announcements", () => {
    const docs = parseDocumentLinks(
      cheerio.load("<html><body><div>financials only</div></body></html>"),
      "TCS"
    );
    assert.deepStrictEqual(docs, []);
  });
});
