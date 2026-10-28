/**
 * BSE client — REAL source (MONEY-852).
 *
 * Covers the pure parse/normalize helpers (purpose-code → type mapping, the
 * shared free-text ratio/FV/dividend parse, the dd-MMM-yyyy + yyyymmdd window
 * formatters, the DefaultData/w action-row parser, and the AnnSubCategoryGetData/w
 * announcement-row parser) WITHOUT network IO, plus the paginated
 * `fetchBSEAnnouncements` loop with `globalThis.fetch` stubbed so the page-walk /
 * stop-on-empty behaviour is pinned deterministically.
 *
 * The ratio parsing is load-bearing: a BSE split/bonus must yield the SAME
 * structured ratio as the NSE source so the two merge in the CorporateAction
 * table (the FIFO cost-basis math reads `ratio`).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  mapBsePurposeCode,
  BSE_PURPOSE_CODE_MAP,
  formatBseDate,
  formatBseCompactDate,
  parseBseActionRow,
  parseBseCorporateActions,
  parseBseAnnouncementRow,
  parseBseAnnouncements,
  fetchBSEAnnouncements,
  fetchBSECorporateActions,
  BseRateLimitError,
  BSE_ATTACHMENT_BASE,
} from "@usemoney/research/data-sources/bse-client";

// ── mapBsePurposeCode ────────────────────────────────────────────────────────

describe("mapBsePurposeCode", () => {
  it("maps the known purpose codes (P5/P6/P9/P26)", () => {
    assert.strictEqual(mapBsePurposeCode("P5"), "BONUS");
    assert.strictEqual(mapBsePurposeCode("P6"), "BUYBACK");
    assert.strictEqual(mapBsePurposeCode("P9"), "DIVIDEND");
    assert.strictEqual(mapBsePurposeCode("P26"), "SPLIT");
  });

  it("accepts a bare numeric code (without the leading P)", () => {
    assert.strictEqual(mapBsePurposeCode("5"), "BONUS");
    assert.strictEqual(mapBsePurposeCode("26"), "SPLIT");
  });

  it("the exported map only contains valid CorporateActionType values", () => {
    const valid = new Set([
      "SPLIT",
      "BONUS",
      "BUYBACK",
      "DEMERGER",
      "MERGER",
      "DIVIDEND",
      "RIGHTS",
      "OTHER",
    ]);
    for (const v of Object.values(BSE_PURPOSE_CODE_MAP)) {
      assert.ok(valid.has(v), `${v} is a valid type`);
    }
  });

  it("falls back to the free-text classifier for an unknown / missing code", () => {
    assert.strictEqual(mapBsePurposeCode("P999", "Bonus issue 1:1"), "BONUS");
    assert.strictEqual(
      mapBsePurposeCode("", "Face Value Split From Rs 10 To Rs 1"),
      "SPLIT"
    );
    assert.strictEqual(mapBsePurposeCode(null, "Rights Issue 1:4"), "RIGHTS");
  });

  it("upgrades the delisting catch-all (P29→OTHER) via descriptive free text", () => {
    // P29 maps to OTHER; when free text actually describes a known class we
    // prefer that, otherwise we keep OTHER.
    assert.strictEqual(
      mapBsePurposeCode("P29", "Scheme of Arrangement (Demerger)"),
      "DEMERGER"
    );
    assert.strictEqual(
      mapBsePurposeCode("P29", "Delisting of Shares"),
      "OTHER"
    );
  });

  it("returns OTHER when neither code nor text classifies", () => {
    assert.strictEqual(mapBsePurposeCode("", ""), "OTHER");
    assert.strictEqual(
      mapBsePurposeCode("P77", "Annual General Meeting"),
      "OTHER"
    );
  });
});

// ── date formatters ──────────────────────────────────────────────────────────

describe("formatBseDate / formatBseCompactDate", () => {
  it("formatBseDate → 'dd MMM yyyy'", () => {
    assert.strictEqual(
      formatBseDate(new Date(Date.UTC(2024, 2, 15))),
      "15 Mar 2024"
    );
    assert.strictEqual(
      formatBseDate(new Date(Date.UTC(2024, 0, 1))),
      "01 Jan 2024"
    );
  });

  it("formatBseDate accepts a YYYY-MM-DD string", () => {
    assert.strictEqual(formatBseDate("2024-12-31"), "31 Dec 2024");
  });

  it("formatBseCompactDate → 'yyyymmdd'", () => {
    assert.strictEqual(
      formatBseCompactDate(new Date(Date.UTC(2024, 2, 5))),
      "20240305"
    );
    assert.strictEqual(formatBseCompactDate("2024-12-31"), "20241231");
  });

  it("returns '' for an invalid date (never a NaN-laden string)", () => {
    assert.strictEqual(formatBseDate("garbage"), "");
    assert.strictEqual(formatBseCompactDate("garbage"), "");
  });
});

// ── parseBseActionRow (purpose-code + free-text ratio) ───────────────────────

describe("parseBseActionRow", () => {
  it("maps a P26 split row → SPLIT with face-value ratio from the free text", () => {
    const a = parseBseActionRow({
      scrip_code: "500325",
      short_name: "RELIANCE",
      Purpose: "Face Value Split (Sub-Division) - From Rs 10 To Rs 1",
      Purposecode: "P26",
      Ex_date: "2024-03-15",
      RD_Date: "2024-03-16",
    });
    assert.ok(a);
    assert.strictEqual(a!.symbol, "RELIANCE");
    assert.strictEqual(a!.type, "SPLIT");
    assert.strictEqual(a!.ratio, 10);
    assert.strictEqual(a!.oldFaceValue, 10);
    assert.strictEqual(a!.newFaceValue, 1);
    assert.deepStrictEqual(a!.exDate, new Date("2024-03-15"));
    assert.deepStrictEqual(a!.recordDate, new Date("2024-03-16"));
    assert.strictEqual(
      a!.details,
      "Face Value Split (Sub-Division) - From Rs 10 To Rs 1"
    );
  });

  it("maps a P5 bonus row → BONUS with ratio 2 from 'Bonus 1:1'", () => {
    const a = parseBseActionRow({
      scrip_code: "532540",
      short_name: "TCS",
      Purpose: "Bonus 1:1",
      Purposecode: "P5",
      Ex_date: "2023-06-01",
    });
    assert.strictEqual(a!.type, "BONUS");
    assert.strictEqual(a!.ratio, 2);
    assert.strictEqual(a!.dividendPerShare, null);
  });

  it("maps a P9 dividend row → DIVIDEND with per-share amount", () => {
    const a = parseBseActionRow({
      scrip_code: "500209",
      short_name: "INFY",
      Purpose: "Dividend - Rs 18 Per Share",
      Purposecode: "P9",
      Ex_date: "2024-05-30",
    });
    assert.strictEqual(a!.type, "DIVIDEND");
    assert.strictEqual(a!.dividendPerShare, 18);
    assert.strictEqual(a!.ratio, null);
  });

  it("tolerates casing variants of the field names", () => {
    const a = parseBseActionRow({
      ScripCode: "500325",
      Short_Name: "RELIANCE",
      purpose: "Bonus 1:1",
      purpose_code: "P5",
      ExDate: "2024-03-15",
    });
    assert.strictEqual(a!.symbol, "RELIANCE");
    assert.strictEqual(a!.type, "BONUS");
    assert.strictEqual(a!.ratio, 2);
  });

  it("falls back to the numeric scrip code as the symbol when no short_name", () => {
    const a = parseBseActionRow({
      scrip_code: "500325",
      Purpose: "Dividend Rs 5 Per Share",
      Purposecode: "P9",
      Ex_date: "2024-05-30",
    });
    assert.strictEqual(a!.symbol, "500325");
    assert.strictEqual(a!.type, "DIVIDEND");
  });

  it("does NOT mis-attribute structured fields when code disagrees with text", () => {
    // Code says SPLIT but the free text is a terse dividend line → the free-text
    // parser classifies it as DIVIDEND (≠ the code's SPLIT), so the structured
    // ratio/FV fall back to null rather than being wrongly attributed.
    const a = parseBseActionRow({
      scrip_code: "500325",
      short_name: "RELIANCE",
      Purpose: "Dividend Rs 5 Per Share",
      Purposecode: "P26", // SPLIT
      Ex_date: "2024-05-30",
    });
    assert.strictEqual(a!.type, "SPLIT"); // code wins for the TYPE
    assert.strictEqual(a!.ratio, null); // but no split ratio is invented
    assert.strictEqual(a!.dividendPerShare, null);
  });

  it("returns null when there's no symbol AND no scrip code", () => {
    assert.strictEqual(
      parseBseActionRow({ Purpose: "Bonus 1:1", Ex_date: "2024-01-01" }),
      null
    );
  });
});

describe("parseBseCorporateActions", () => {
  it("parses a bare array of rows", () => {
    const rows = parseBseCorporateActions([
      {
        short_name: "TCS",
        Purpose: "Bonus 1:1",
        Purposecode: "P5",
        Ex_date: "2023-06-01",
      },
      {
        short_name: "INFY",
        Purpose: "Dividend Rs 1 Per Share",
        Purposecode: "P9",
        Ex_date: "2024-05-30",
      },
    ]);
    assert.strictEqual(rows.length, 2);
  });

  it("unwraps a { Table: [...] } envelope", () => {
    const rows = parseBseCorporateActions({
      Table: [
        {
          short_name: "RELIANCE",
          Purpose: "Bonus 1:1",
          Purposecode: "P5",
          Ex_date: "2024-01-01",
        },
      ],
    });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!.symbol, "RELIANCE");
  });

  it("returns [] for a null / non-list payload", () => {
    assert.deepStrictEqual(parseBseCorporateActions(null), []);
    assert.deepStrictEqual(parseBseCorporateActions({ nope: 1 }), []);
  });
});

// ── parseBseAnnouncementRow ──────────────────────────────────────────────────

describe("parseBseAnnouncementRow", () => {
  it("maps an announcement row and builds the absolute AttachLive PDF URL", () => {
    const a = parseBseAnnouncementRow({
      SCRIP_CD: "500325",
      SLONGNAME: "Reliance Industries Ltd",
      NEWSSUB: "Board Meeting Outcome",
      NEWSID: "abc-123",
      ATTACHMENTNAME: "file123.pdf",
      NEWS_DT: "2024-03-15T10:00:00",
      CATEGORYNAME: "Board Meeting",
    });
    assert.ok(a);
    assert.strictEqual(a!.scripCode, "500325");
    assert.strictEqual(a!.company, "Reliance Industries Ltd");
    assert.strictEqual(a!.title, "Board Meeting Outcome");
    assert.strictEqual(a!.category, "Board Meeting");
    assert.strictEqual(a!.newsId, "abc-123");
    assert.strictEqual(a!.pdfUrl, `${BSE_ATTACHMENT_BASE}/file123.pdf`);
    assert.ok(a!.publishedAt instanceof Date);
  });

  it("falls back to the company name for the title when there's no subject", () => {
    const a = parseBseAnnouncementRow({
      SCRIP_CD: "500325",
      SLONGNAME: "Reliance Industries Ltd",
    });
    assert.strictEqual(a!.title, "Reliance Industries Ltd");
  });

  it("sets pdfUrl null when the row has no attachment", () => {
    const a = parseBseAnnouncementRow({
      SCRIP_CD: "500325",
      NEWSSUB: "Update",
    });
    assert.strictEqual(a!.pdfUrl, null);
  });

  it("returns null (skip) when the row has no scrip code", () => {
    assert.strictEqual(
      parseBseAnnouncementRow({ NEWSSUB: "Orphan filing" }),
      null
    );
  });

  it("publishedAt is null (never Invalid Date) for a bad timestamp", () => {
    const a = parseBseAnnouncementRow({
      SCRIP_CD: "500325",
      NEWSSUB: "x",
      NEWS_DT: "not-a-date",
    });
    assert.strictEqual(a!.publishedAt, null);
  });
});

describe("parseBseAnnouncements", () => {
  it("unwraps { Table: [...] } and drops scrip-less rows", () => {
    const out = parseBseAnnouncements({
      Table: [
        { SCRIP_CD: "500325", NEWSSUB: "A" },
        { NEWSSUB: "no scrip" },
        { SCRIP_CD: "532540", NEWSSUB: "B" },
      ],
    });
    assert.strictEqual(out.length, 2);
  });
});

// ── fetchBSEAnnouncements (paginated, fetch stubbed) ─────────────────────────

describe("fetchBSEAnnouncements (pagination)", () => {
  const realFetch = globalThis.fetch;
  // Map pageno → rows; page 3 is empty to assert the stop-on-empty walk.
  const pages: Record<string, unknown> = {
    "1": {
      Table: [
        { SCRIP_CD: "1", NEWSSUB: "p1a" },
        { SCRIP_CD: "2", NEWSSUB: "p1b" },
      ],
    },
    "2": { Table: [{ SCRIP_CD: "3", NEWSSUB: "p2a" }] },
    "3": { Table: [] },
  };
  const calledPages: string[] = [];

  before(() => {
    globalThis.fetch = (async (url: string) => {
      const m = String(url).match(/pageno=(\d+)/);
      const page = m ? m[1]! : "1";
      calledPages.push(page);
      const body = JSON.stringify(pages[page] ?? { Table: [] });
      return {
        ok: true,
        status: 200,
        text: async () => body,
      };
    }) as unknown as typeof fetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  it("walks pages until an empty page and concatenates the rows", async () => {
    calledPages.length = 0;
    const out = await fetchBSEAnnouncements({
      fromDate: "2024-03-14",
      toDate: "2024-03-15",
      // MONEY-1255 — these four pin the PAGE WALK, not the category sweep.
      // The walk is now per-category, so scope them to one category to
      // preserve their original contract exactly. Category iteration is
      // covered by bse-announcements-categories.test.ts.
      categories: ["Result"],
      maxPages: 5,
    });
    // 2 + 1 rows from pages 1 & 2; page 3 (empty) stops the walk.
    assert.strictEqual(out.length, 3);
    assert.deepStrictEqual(calledPages, ["1", "2", "3"]);
    assert.strictEqual(out[0]!.scripCode, "1");
    assert.strictEqual(out[2]!.scripCode, "3");
  });

  it("honours maxPages (stops before the empty page)", async () => {
    calledPages.length = 0;
    const out = await fetchBSEAnnouncements({
      fromDate: "2024-03-14",
      toDate: "2024-03-15",
      // MONEY-1255 — these four pin the PAGE WALK, not the category sweep.
      // The walk is now per-category, so scope them to one category to
      // preserve their original contract exactly. Category iteration is
      // covered by bse-announcements-categories.test.ts.
      categories: ["Result"],
      maxPages: 1,
    });
    assert.strictEqual(out.length, 2); // only page 1
    assert.deepStrictEqual(calledPages, ["1"]);
  });

  it("returns what it has when a page fetch fails mid-walk", async () => {
    calledPages.length = 0;
    const prev = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      const m = String(url).match(/pageno=(\d+)/);
      const page = m ? m[1]! : "1";
      calledPages.push(page);
      if (page === "2") return { ok: false, status: 500, text: async () => "" };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(pages[page] ?? { Table: [] }),
      };
    }) as unknown as typeof fetch;

    const out = await fetchBSEAnnouncements({
      fromDate: "2024-03-14",
      toDate: "2024-03-15",
      // MONEY-1255 — these four pin the PAGE WALK, not the category sweep.
      // The walk is now per-category, so scope them to one category to
      // preserve their original contract exactly. Category iteration is
      // covered by bse-announcements-categories.test.ts.
      categories: ["Result"],
      maxPages: 5,
    });
    assert.strictEqual(out.length, 2); // page 1 only; page 2 failed → stop
    globalThis.fetch = prev;
  });
});

// ── 429 backoff + circuit-break (MONEY-852/853 — mirrors the Screener limits) ─
//
// BSE's api host 429s under whole-market pulls. `bseGetJson` retries with
// backoff (honouring Retry-After) and, on a PERSISTENT 429, throws
// `BseRateLimitError` — which BOTH public fetchers PROPAGATE so the worker can
// circuit-break the run. The backoff base + retry budget are env-tunable AND
// read per-call, so we shrink them to ~1ms here (a 5s base × 4 retries ≈ 75s).

describe("BseRateLimitError (shape)", () => {
  it("is an Error subclass with a stable name + descriptive message", () => {
    const e = new BseRateLimitError("corp-actions 01 Jan..02 Jan");
    assert.ok(e instanceof Error);
    assert.strictEqual(e.name, "BseRateLimitError");
    assert.match(e.message, /rate-limited \(429\)/);
    assert.match(e.message, /corp-actions 01 Jan/);
  });
});

describe("BSE 429 retry + propagation (fetch stubbed)", () => {
  const realFetch = globalThis.fetch;
  const prevBase = process.env.BSE_BACKOFF_BASE_MS;
  const prevRetries = process.env.BSE_MAX_RETRIES;

  before(() => {
    // Shrink the backoff so the retry loop is effectively instant in the test.
    process.env.BSE_BACKOFF_BASE_MS = "1";
    process.env.BSE_MAX_RETRIES = "2";
  });

  after(() => {
    globalThis.fetch = realFetch;
    if (prevBase === undefined) delete process.env.BSE_BACKOFF_BASE_MS;
    else process.env.BSE_BACKOFF_BASE_MS = prevBase;
    if (prevRetries === undefined) delete process.env.BSE_MAX_RETRIES;
    else process.env.BSE_MAX_RETRIES = prevRetries;
  });

  /** A 429 response stub (no `Retry-After` → uses the computed backoff). */
  const resp429 = () => ({
    ok: false,
    status: 429,
    headers: { get: () => null },
    text: async () => "",
  });
  const resp200 = (body: unknown) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  });

  it("retries a transient 429 then succeeds (announcements)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? resp429()
        : resp200({ Table: [{ SCRIP_CD: "1", NEWSSUB: "ok" }] });
    }) as unknown as typeof fetch;

    const out = await fetchBSEAnnouncements({
      fromDate: "2024-03-14",
      toDate: "2024-03-15",
      // MONEY-1255 — these four pin the PAGE WALK, not the category sweep.
      // The walk is now per-category, so scope them to one category to
      // preserve their original contract exactly. Category iteration is
      // covered by bse-announcements-categories.test.ts.
      categories: ["Result"],
      maxPages: 1,
    });
    assert.strictEqual(out.length, 1); // page 1 recovered after one retry
    assert.strictEqual(calls, 2); // first 429 + one successful retry
  });

  it("throws BseRateLimitError on a PERSISTENT 429 (announcements propagate)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return resp429();
    }) as unknown as typeof fetch;

    await assert.rejects(
      fetchBSEAnnouncements({
        fromDate: "2024-03-14",
        toDate: "2024-03-15",
        maxPages: 3,
      }),
      BseRateLimitError
    );
    // 1 initial + 2 retries (BSE_MAX_RETRIES=2), then it gives up — it must NOT
    // keep walking to page 2/3 (the error short-circuits the page loop).
    assert.strictEqual(calls, 3);
  });

  it("throws BseRateLimitError on a PERSISTENT 429 (corporate actions propagate)", async () => {
    globalThis.fetch = (async () => resp429()) as unknown as typeof fetch;

    await assert.rejects(
      fetchBSECorporateActions({
        fromDate: "2024-03-14",
        toDate: "2024-03-15",
      }),
      BseRateLimitError
    );
  });

  it("a HUNG window hits the ceiling and is reported, not waited on forever", async () => {
    // MONEY-1189: the heal run sat 14+ minutes inside one BSE window with zero
    // open sockets and zero CPU — no network in flight, no 429 backoff (each of
    // those logs, and none did). `AbortSignal.timeout` bounds each fetch, which
    // is not the same as bounding the operation, so nothing ever settled and the
    // run had to be killed by hand.
    const prev = process.env.BSE_WINDOW_CEILING_MS;
    process.env.BSE_WINDOW_CEILING_MS = "20";
    // The stub must HANG for the ceiling to fire, but the pending promise has to
    // be settled afterwards or the file orphans work and node:test flags it with
    // ZERO failing cases. It is RESOLVED, not rejected: `bseGetJson` is still
    // awaiting this fetch, so rejecting it throws into a chain the race already
    // abandoned — an unhandled rejection, which fails the file just as surely.
    // Resolving lets that chain finish harmlessly; the race discarded its
    // result long ago.
    const pending: Array<() => void> = [];
    try {
      globalThis.fetch = (() =>
        new Promise((resolve) => {
          pending.push(() =>
            resolve({
              ok: true,
              status: 200,
              headers: { get: () => null },
              text: async () => "[]",
            } as unknown as Response)
          );
        })) as unknown as typeof fetch;
      const out = await fetchBSECorporateActions({
        fromDate: "2024-03-14",
        toDate: "2024-03-15",
      });
      assert.deepStrictEqual(out.rows, []);
      assert.strictEqual(
        out.failedWindows.length,
        1,
        "a hang is a FAILED window"
      );
    } finally {
      for (const release of pending) release();
      if (prev === undefined) delete process.env.BSE_WINDOW_CEILING_MS;
      else process.env.BSE_WINDOW_CEILING_MS = prev;
    }
  });

  it("a non-429 failure degrades without throwing, but REPORTS the window", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: async () => "",
    })) as unknown as typeof fetch;

    const out = await fetchBSECorporateActions({
      fromDate: "2024-03-14",
      toDate: "2024-03-15",
    });
    // 500 ≠ 429 → swallowed, not thrown (best-effort contract unchanged)…
    assert.deepStrictEqual(out.rows, []);
    // …but MONEY-1189: no longer indistinguishable from "BSE listed nothing".
    // A real 500 on 16-Aug-2014..11-Feb-2015 went unretried for exactly that
    // reason during the 20-year backfill.
    assert.strictEqual(out.failedWindows.length, 1);
  });
});
