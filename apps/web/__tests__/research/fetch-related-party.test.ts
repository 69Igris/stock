/**
 * fetch_related_party tool tests (MONEY-543)
 *
 * Tests packages/research/src/tools/fetch-related-party.ts
 *
 * The tool intentionally degrades for ALL inputs in v1: full related-party
 * transaction (RPT) line-item extraction needs the annual-report RAG/embedding
 * pipeline (MONEY-270), which is NOT yet wired. The correct, expected outcome
 * is therefore { success: true, data: { available: false, ... reason ...,
 * sourceDocs, observations, transactions: [] } } — NOT success:false.
 *
 * success:false is reserved for genuinely malformed input (empty / non-string
 * symbol) or a thrown runtime exception (the Screener fetch throwing — which is
 * actually swallowed by fetchScreenerDocuments, so in practice only malformed
 * input reaches success:false here).
 *
 * Determinism / no live IO:
 *   The only side effect is fetchScreenerDocuments(symbol), which performs an
 *   HTTP GET against screener.in via `ky` (the global fetch). We replace
 *   globalThis.fetch with a deterministic stub that routes on the requested
 *   URL's symbol and returns a fixed Response — no network is ever touched and
 *   no randomness is relied upon. Two routes:
 *     • a page whose #documents section links N annual reports  → sourceDocs[N]
 *     • a non-OK (404) response                                 → docs = null
 *       (fetchScreenerDocuments returns null on non-ok)         → sourceDocs[0]
 *
 *   fetchScreenerDocuments has an unconditional 3s inter-request delay; the
 *   network-touching cases are grouped under a single { concurrency: true }
 *   parent so their delays overlap instead of summing.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { fetchRelatedPartyTool } from "../../../../packages/research/src/tools/fetch-related-party";

// ── Deterministic network stub ──────────────────────────────────────
// fetchScreenerDocuments calls `ky.get(...)`, which invokes globalThis.fetch
// with a Request object whose `.url` carries the full screener.in URL. We route
// the canned HTML on the symbol embedded in that URL. Symbols not matched below
// receive a 404, which fetchScreenerDocuments maps to `null` (no docs).
const realFetch = globalThis.fetch;

// Padding so the parser sees a "real" page (the live client ignores tiny pages
// elsewhere; the documents path here only needs valid HTML to parse).
const PAD = "<p>padding</p>".repeat(200);

function docsSection(reports: Array<{ year: string; label: string }>): string {
  const links = reports
    .map(
      (r) =>
        `<a href="https://www.bseindia.com/annual-reports/${r.year}.pdf">${r.label}</a>`
    )
    .join("\n");
  return `<!DOCTYPE html><html><head><title>x</title></head><body>${PAD}<section id="documents">${links}</section></body></html>`;
}

// symbol (clean, uppercase) -> HTML | null(=404)
const ROUTES: Record<string, string | null> = {
  // Two annual reports — drives the known-value plural-observation payload.
  RELIANCE: docsSection([
    { year: "2025", label: "Financial Year 2025" },
    { year: "2024", label: "Financial Year 2024" },
  ]),
  // Exactly one annual report — drives the singular-observation branch.
  TCS: docsSection([{ year: "2025", label: "Financial Year 2025" }]),
  // A valid page with NO matching document links — sourceDocs stays empty.
  INFY: `<!DOCTYPE html><html><body>${PAD}<section id="documents"><p>nothing here</p></section></body></html>`,
  // Non-OK response → fetchScreenerDocuments returns null.
  ZZZNOTAREALSYM: null,
  HDFCBANK: null,
};

before(() => {
  globalThis.fetch = (async (input: unknown) => {
    // ky passes a Request; tolerate URL / string forms too.
    const url =
      typeof input === "object" && input !== null && "url" in input
        ? String((input as { url: unknown }).url)
        : String(input);
    const m = url.match(/\/company\/([^/]+)\//);
    const sym = m ? decodeURIComponent(m[1]!).toUpperCase() : "";
    const html = sym in ROUTES ? ROUTES[sym] : null;
    if (html == null) {
      return new Response("not found", { status: 404 });
    }
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

// ── Local mirror of the tool's output data shape ────────────────────
interface SourceDoc {
  type: string;
  title: string;
  url: string | null;
  period: string;
  source?: string;
}
interface RelatedPartyData {
  available: boolean;
  symbol: string;
  transactions: unknown[];
  sourceDocs: SourceDoc[];
  observations: string[];
  reason?: string;
}

const RAG_NOT_WIRED_REASON =
  "Related-party detail requires annual-report RAG (MONEY-270); not yet wired";

async function run(args: Record<string, unknown>) {
  return fetchRelatedPartyTool.execute(args);
}

// ── 1. Static metadata ──────────────────────────────────────────────

test("tool exposes expected static metadata", () => {
  assert.equal(fetchRelatedPartyTool.name, "fetch_related_party");
  assert.equal(fetchRelatedPartyTool.category, "data");
  assert.equal(typeof fetchRelatedPartyTool.description, "string");
  assert.ok(fetchRelatedPartyTool.description.length > 0);
  assert.equal(typeof fetchRelatedPartyTool.execute, "function");
  assert.equal(fetchRelatedPartyTool.parameters.symbol!.required, true);
  assert.equal(fetchRelatedPartyTool.parameters.symbol!.type, "string");
  // 24h cache TTL — disclosures change at most quarterly/annually.
  assert.equal(fetchRelatedPartyTool.cacheTTL, 86400);
});

// ── 2. Malformed input → success:false (no IO, runs synchronously) ──

test("empty symbol → success:false with 'symbol is required'", async () => {
  const r = await run({ symbol: "" });
  assert.equal(r.success, false);
  assert.equal(r.error, "symbol is required");
  assert.equal(r.data, undefined);
});

test("whitespace-only symbol → success:false (trimmed to empty)", async () => {
  const r = await run({ symbol: "   " });
  assert.equal(r.success, false);
  assert.equal(r.error, "symbol is required");
});

test("missing / non-string symbol → success:false", async () => {
  const noArg = await run({});
  assert.equal(noArg.success, false);
  assert.equal(noArg.error, "symbol is required");

  const numeric = await run({ symbol: 123 as unknown as string });
  assert.equal(numeric.success, false);
  assert.equal(numeric.error, "symbol is required");
});

// ── 3–5. Network-touching cases (concurrent so the 3s delays overlap) ─

test(
  "fetch_related_party degraded contract",
  { concurrency: true },
  async (t) => {
    // Launch the subtests WITHOUT awaiting each inline so their unconditional
    // 3s Screener delays overlap (≈3s wall instead of summing). Each routes on
    // a distinct symbol, so the shared fetch stub stays deterministic.
    const pending: Array<Promise<unknown>> = [];

    // 1 + 2. Happy path AND exact known-value payload: RELIANCE.NS → two
    //         annual reports, success:true, available:false, plural observation.
    pending.push(
      t.test(
        "happy path + known value: RELIANCE.NS → 2 annual reports, exact degraded payload",
        async () => {
          const r = await run({ symbol: "RELIANCE.NS" });
          assert.equal(r.success, true);
          assert.ok(r.data, "expected data payload");
          const data = r.data as RelatedPartyData;

          // Degraded-but-successful is the contract (NOT success:false).
          assert.equal(data.available, false);

          // Key fields present + correct types.
          assert.equal(typeof data.symbol, "string");
          assert.equal(data.symbol, "RELIANCE"); // .NS stripped + uppercased
          assert.ok(Array.isArray(data.transactions));
          assert.equal(data.transactions.length, 0); // never fabricated in v1
          assert.ok(Array.isArray(data.sourceDocs));
          assert.ok(Array.isArray(data.observations));
          assert.equal(typeof data.reason, "string");

          // Exact source-doc list (two annual reports, BSE source).
          assert.equal(data.sourceDocs.length, 2);
          assert.deepEqual(data.sourceDocs, [
            {
              type: "annual_report",
              title: "Financial Year 2025",
              url: "https://www.bseindia.com/annual-reports/2025.pdf",
              period: "FY2025",
              source: "bse",
            },
            {
              type: "annual_report",
              title: "Financial Year 2024",
              url: "https://www.bseindia.com/annual-reports/2024.pdf",
              period: "FY2024",
              source: "bse",
            },
          ]);

          // Exact observation string (plural form, count = 2).
          assert.deepEqual(data.observations, [
            "2 annual reports found for RELIANCE - related-party transactions are disclosed in the notes to accounts of each.",
          ]);

          // Exact reason (the "+ See the linked..." variant when docs exist).
          assert.equal(
            data.reason,
            `${RAG_NOT_WIRED_REASON}. See the linked annual-report/disclosure documents for the RPT note.`
          );
        }
      )
    );

    // 2 (null branch). Known value: no docs located → exact empty-doc payload.
    pending.push(
      t.test(
        "known value: no docs found (404) → empty sourceDocs + 'No annual-report...' observation",
        async () => {
          const r = await run({ symbol: "ZZZNOTAREALSYM" });
          assert.equal(r.success, true);
          const data = r.data as RelatedPartyData;

          assert.equal(data.available, false);
          assert.equal(data.symbol, "ZZZNOTAREALSYM");
          assert.deepEqual(data.sourceDocs, []);
          assert.deepEqual(data.transactions, []);
          assert.deepEqual(data.observations, [
            "No annual-report or disclosure documents could be located for ZZZNOTAREALSYM via Screener.",
          ]);
          // Bare reason (no doc-link suffix) when nothing is found.
          assert.equal(data.reason, RAG_NOT_WIRED_REASON);
        }
      )
    );

    // Singular-observation branch: exactly one annual report.
    pending.push(
      t.test(
        "single annual report → singular observation wording",
        async () => {
          const r = await run({ symbol: "TCS.NS" });
          assert.equal(r.success, true);
          const data = r.data as RelatedPartyData;
          assert.equal(data.symbol, "TCS");
          assert.equal(data.available, false);
          assert.equal(data.sourceDocs.length, 1);
          assert.deepEqual(data.observations, [
            "1 annual report found for TCS - related-party transactions are disclosed in the notes to accounts of each.",
          ]);
          // doc-link suffix present because a source doc exists.
          assert.equal(
            data.reason,
            `${RAG_NOT_WIRED_REASON}. See the linked annual-report/disclosure documents for the RPT note.`
          );
        }
      )
    );

    // 3. Graceful degradation: a page with no matching doc links still
    //    degrades to success:true / available:false (never success:false).
    pending.push(
      t.test(
        "graceful degradation: valid page, no doc links → available:false with bare reason",
        async () => {
          const r = await run({ symbol: "INFY" });
          assert.equal(r.success, true); // degraded path is a SUCCESS
          const data = r.data as RelatedPartyData;
          assert.equal(data.available, false);
          assert.deepEqual(data.sourceDocs, []);
          assert.deepEqual(data.transactions, []);
          assert.equal(typeof data.reason, "string");
          assert.equal(data.reason, RAG_NOT_WIRED_REASON);
          assert.deepEqual(data.observations, [
            "No annual-report or disclosure documents could be located for INFY via Screener.",
          ]);
        }
      )
    );

    // 4. Edge case: lowercase + .bo suffix normalizes and never throws.
    pending.push(
      t.test(
        "edge: lowercase symbol with .bo suffix is normalized; resolves without throwing",
        async () => {
          const r = await run({ symbol: "hdfcbank.bo" });
          assert.equal(typeof r, "object");
          assert.ok(r !== null);
          assert.equal(r.success, true);
          const data = r.data as RelatedPartyData;
          assert.equal(data.symbol, "HDFCBANK"); // .BO stripped + uppercased
          assert.equal(data.available, false);
          assert.deepEqual(data.sourceDocs, []); // HDFCBANK routed to 404 → null
        }
      )
    );

    // 5. Clearly-unknown symbol resolves to a ToolOutput (no live-IO failure):
    //    fetch is stubbed; fetchScreenerDocuments swallows the 404 and the tool
    //    degrades cleanly rather than rejecting.
    pending.push(
      t.test(
        "edge: clearly-unknown symbol resolves to a degraded ToolOutput, never throws",
        async () => {
          const r = await fetchRelatedPartyTool.execute({
            symbol: "ZZZNOTAREALSYM",
          });
          assert.equal(typeof r, "object");
          assert.ok(r !== null);
          assert.equal(r.success, true);
          const data = r.data as RelatedPartyData;
          assert.equal(data.available, false);
          assert.equal(data.symbol, "ZZZNOTAREALSYM");
          assert.deepEqual(data.transactions, []);
        }
      )
    );

    // Await all subtests so the parent test only completes once every assertion
    // has run; their 3s Screener delays overlap rather than sum.
    await Promise.all(pending);
  }
);
