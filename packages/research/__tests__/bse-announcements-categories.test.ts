/**
 * UNIT TESTS — the BSE announcements fetch, MONEY-1255.
 *
 * Every symbol here is the REAL export `bse-announcements-sync` calls; there
 * are no shadow re-implementations and no network. `globalThis.fetch` is
 * stubbed so the URL the client BUILDS is asserted directly — which is the
 * whole point, because the defect that made this job write zero rows for its
 * entire life was one query parameter and nothing else:
 *
 *   strCat=-1   200 OK, body `{}`, zero rows, no error, exit 0, forever.
 *
 * The load-bearing assertion in this file is therefore the negative one:
 * `strCat=-1` must never appear in any URL the client emits, and every request
 * must carry one of the nine real category names.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  BSE_ANNOUNCEMENT_CATEGORIES,
  BSE_RESULT_CATEGORIES,
  BseRateLimitError,
  MAX_FUTURE_DATE_STEP_BACKS,
  clampBseWindowEnd,
  detectBseApiError,
  fetchBSEAnnouncements,
  fetchBSEAnnouncementsByCategory,
  parseBseAnnouncementRow,
} from "@usemoney/research/data-sources/bse-client";

// ── stub plumbing ───────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
let requested: string[] = [];

/** One announcement row, shaped like the live payload (28 columns observed). */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    NEWSID: "n1",
    SCRIP_CD: "530127",
    XML_NAME: "ANN_530127_AD76AC5C-0000-0000",
    NEWSSUB: "UNAUDITED RESULTS QUARTER ENDED 30/06/2026",
    DT_TM: "2026-08-14T18:05:00",
    QUARTER_ID: "0",
    ATTACHMENTNAME: "b2235ebf-1111-2222-3333-444455556666.pdf",
    CATEGORYNAME: "Result",
    SUBCATNAME: "Financial Results",
    SLONGNAME: "Test Industries Ltd",
    ...overrides,
  };
}

/**
 * Stub `fetch` with a function of the parsed query string. Records every URL.
 */
function stubFetch(
  handler: (q: URLSearchParams, url: string) => unknown,
): void {
  globalThis.fetch = (async (url: string) => {
    requested.push(String(url));
    const q = new URLSearchParams(String(url).split("?")[1] ?? "");
    const body = handler(q, String(url));
    if (body instanceof Error) throw body;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  requested = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── A1.1 — the nine named categories ────────────────────────────────────────

describe("BSE_ANNOUNCEMENT_CATEGORIES", () => {
  it("carries exactly the nine categories captured from DDLSubCategoryData", () => {
    assert.deepStrictEqual(
      [...BSE_ANNOUNCEMENT_CATEGORIES],
      [
        "AGM/EGM",
        "Board Meeting",
        "Company Update",
        "Corp. Action",
        "Insider Trading / SAST",
        "New Listing",
        "Result",
        "Integrated Filing",
        "Others",
      ],
    );
  });

  it("never contains the sentinel that produced the defect", () => {
    assert.ok(!BSE_ANNOUNCEMENT_CATEGORIES.includes("-1"));
  });

  it("BSE_RESULT_CATEGORIES is a SUBSET of the nine (a typo here is silent)", () => {
    for (const c of BSE_RESULT_CATEGORIES) {
      assert.ok(
        BSE_ANNOUNCEMENT_CATEGORIES.includes(c),
        `"${c}" is not one of the nine categories strCat accepts`,
      );
    }
  });
});

describe("fetchBSEAnnouncementsByCategory — category iteration", () => {
  it("walks ALL NINE categories by default, one strCat per category", async () => {
    stubFetch(() => ({ Table: [] }));

    const out = await fetchBSEAnnouncementsByCategory({
      fromDate: "2026-08-01",
      toDate: "2026-08-10",
      maxPages: 1,
      now: new Date("2026-08-26T12:00:00Z"),
    });

    assert.strictEqual(requested.length, 9);
    assert.strictEqual(out.byCategory.length, 9);
    const sent = requested.map((u) =>
      new URLSearchParams(u.split("?")[1]).get("strCat"),
    );
    assert.deepStrictEqual(sent, [...BSE_ANNOUNCEMENT_CATEGORIES]);
  });

  it("NEVER sends strCat=-1 — the exact param that returned {} forever", async () => {
    stubFetch(() => ({ Table: [] }));
    await fetchBSEAnnouncementsByCategory({
      fromDate: "2026-08-01",
      toDate: "2026-08-10",
      maxPages: 2,
      now: new Date("2026-08-26T12:00:00Z"),
    });
    assert.ok(requested.length > 0, "no request was made at all");
    for (const url of requested) {
      assert.ok(
        !url.includes("strCat=-1"),
        `built a URL with the defective sentinel: ${url}`,
      );
      const cat = new URLSearchParams(url.split("?")[1]).get("strCat");
      assert.ok(
        cat !== null && BSE_ANNOUNCEMENT_CATEGORIES.includes(cat),
        `strCat "${cat}" is not one of the nine real categories`,
      );
    }
  });

  it("URL-encodes the category names that contain / and spaces", async () => {
    stubFetch(() => ({ Table: [] }));
    await fetchBSEAnnouncementsByCategory({
      fromDate: "2026-08-01",
      toDate: "2026-08-10",
      maxPages: 1,
      categories: ["Insider Trading / SAST"],
      now: new Date("2026-08-26T12:00:00Z"),
    });
    assert.strictEqual(requested.length, 1);
    assert.match(requested[0]!, /strCat=Insider%20Trading%20%2F%20SAST/);
    // And it round-trips back to the exact spelling BSE published.
    assert.strictEqual(
      new URLSearchParams(requested[0]!.split("?")[1]).get("strCat"),
      "Insider Trading / SAST",
    );
  });

  it("page-loops EACH category independently and stops that one on an empty page", async () => {
    stubFetch((q) => {
      const cat = q.get("strCat");
      const page = Number(q.get("pageno"));
      // "Result" has 2 pages; every other category has 0.
      if (cat === "Result" && page <= 2)
        return { Table: [row({ NEWSID: `r${page}` })] };
      return {};
    });

    const out = await fetchBSEAnnouncementsByCategory({
      fromDate: "2026-08-01",
      toDate: "2026-08-10",
      maxPages: 5,
      now: new Date("2026-08-26T12:00:00Z"),
    });

    assert.strictEqual(out.announcements.length, 2);
    const result = out.byCategory.find((c) => c.category === "Result")!;
    assert.strictEqual(result.count, 2);
    assert.strictEqual(result.pages, 3); // 2 with rows + the empty one that stopped it
    assert.strictEqual(result.stop, "exhausted");
    // A quiet category is `exhausted` at 0 — one request, not zero.
    const listing = out.byCategory.find((c) => c.category === "New Listing")!;
    assert.strictEqual(listing.count, 0);
    assert.strictEqual(listing.pages, 1);
    assert.strictEqual(listing.stop, "exhausted");
  });

  it("honours maxPages PER CATEGORY and marks the walk CAPPED", async () => {
    stubFetch(() => ({ Table: [row()] })); // never runs out

    const out = await fetchBSEAnnouncementsByCategory({
      fromDate: "2026-08-01",
      toDate: "2026-08-10",
      maxPages: 3,
      categories: ["Result", "Board Meeting"],
      now: new Date("2026-08-26T12:00:00Z"),
    });

    assert.strictEqual(requested.length, 6); // 2 categories x 3 pages
    for (const c of out.byCategory) {
      assert.strictEqual(c.pages, 3);
      assert.strictEqual(c.stop, "maxPages");
    }
  });

  it("one category failing does NOT abort the others (counted, not fatal)", async () => {
    stubFetch((q) => {
      if (q.get("strCat") === "Corp. Action") return new Error("boom");
      return { Table: [row()] };
    });

    const out = await fetchBSEAnnouncementsByCategory({
      fromDate: "2026-08-01",
      toDate: "2026-08-10",
      maxPages: 1,
      now: new Date("2026-08-26T12:00:00Z"),
    });

    assert.strictEqual(out.transportFailures, 1);
    assert.strictEqual(out.byCategory.length, 9);
    assert.strictEqual(out.announcements.length, 8);
    const failed = out.byCategory.find((c) => c.category === "Corp. Action")!;
    assert.strictEqual(failed.stop, "failed");
    assert.strictEqual(failed.count, 0);
    assert.match(String(failed.error), /boom/);
  });

  it("a PERSISTENT 429 propagates and aborts the whole run (no 9x tarpit)", async () => {
    const prevBase = process.env.BSE_BACKOFF_BASE_MS;
    const prevRetries = process.env.BSE_MAX_RETRIES;
    process.env.BSE_BACKOFF_BASE_MS = "1";
    process.env.BSE_MAX_RETRIES = "1";
    try {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return {
          ok: false,
          status: 429,
          headers: { get: () => null },
          text: async () => "",
        };
      }) as unknown as typeof fetch;

      await assert.rejects(
        fetchBSEAnnouncementsByCategory({
          fromDate: "2026-08-01",
          toDate: "2026-08-10",
          maxPages: 3,
          now: new Date("2026-08-26T12:00:00Z"),
        }),
        BseRateLimitError,
      );
      // 1 initial + 1 retry on the FIRST category, then it gives up. It must
      // not walk the remaining eight.
      assert.strictEqual(calls, 2);
    } finally {
      if (prevBase === undefined) delete process.env.BSE_BACKOFF_BASE_MS;
      else process.env.BSE_BACKOFF_BASE_MS = prevBase;
      if (prevRetries === undefined) delete process.env.BSE_MAX_RETRIES;
      else process.env.BSE_MAX_RETRIES = prevRetries;
    }
  });

  it("passes strScrip through for the per-scrip backfill mode", async () => {
    stubFetch(() => ({}));
    await fetchBSEAnnouncementsByCategory({
      fromDate: "2026-03-01",
      toDate: "2026-08-10",
      maxPages: 1,
      categories: ["Result"],
      scripCode: "530127",
      now: new Date("2026-08-26T12:00:00Z"),
    });
    assert.strictEqual(
      new URLSearchParams(requested[0]!.split("?")[1]).get("strScrip"),
      "530127",
    );
  });

  it("fetchBSEAnnouncements flattens the same walk (nine categories by default)", async () => {
    stubFetch((q) => ({ Table: [row({ NEWSID: q.get("strCat") })] }));
    const flat = await fetchBSEAnnouncements({
      fromDate: "2026-08-01",
      toDate: "2026-08-10",
      maxPages: 1,
      now: new Date("2026-08-26T12:00:00Z"),
    });
    assert.strictEqual(flat.length, 9);
    assert.deepStrictEqual(
      flat.map((a) => a.newsId),
      [...BSE_ANNOUNCEMENT_CATEGORIES],
    );
  });
});

// ── A1.2 — category vs subcategory, XML_NAME, QUARTER_ID ────────────────────

describe("parseBseAnnouncementRow — category / subcategory separation", () => {
  it("category is CATEGORYNAME only; subcategory is SUBCATNAME only", () => {
    const a = parseBseAnnouncementRow(row())!;
    assert.strictEqual(a.category, "Result");
    assert.strictEqual(a.subcategory, "Financial Results");
  });

  it("a MISSING CATEGORYNAME does NOT fall back to SUBCATNAME", () => {
    // The old `CATEGORYNAME || SUBCATNAME` collapse presented "Financial
    // Results" as a CATEGORY — a string strCat would never accept and the
    // classifier would never match against BSE_RESULT_CATEGORIES.
    const a = parseBseAnnouncementRow(
      row({ CATEGORYNAME: "", SUBCATNAME: "Financial Results" }),
    )!;
    assert.strictEqual(a.category, "");
    assert.strictEqual(a.subcategory, "Financial Results");
  });

  it("a missing SUBCATNAME leaves subcategory empty, not the category", () => {
    const a = parseBseAnnouncementRow(
      row({ CATEGORYNAME: "Board Meeting", SUBCATNAME: "" }),
    )!;
    assert.strictEqual(a.category, "Board Meeting");
    assert.strictEqual(a.subcategory, "");
  });

  it("persists XML_NAME — the breadcrumb for BSE XBRL discovery", () => {
    const a = parseBseAnnouncementRow(row())!;
    assert.strictEqual(a.xmlName, "ANN_530127_AD76AC5C-0000-0000");
  });

  it("persists QUARTER_ID verbatim and uninterpreted", () => {
    const a = parseBseAnnouncementRow(row({ QUARTER_ID: "202606" }))!;
    assert.strictEqual(a.quarterId, "202606");
  });

  it("absent XML_NAME / QUARTER_ID are empty strings, never undefined", () => {
    const a = parseBseAnnouncementRow({ SCRIP_CD: "1", NEWSSUB: "x" })!;
    assert.strictEqual(a.xmlName, "");
    assert.strictEqual(a.quarterId, "");
    assert.strictEqual(a.subcategory, "");
  });

  it("builds the absolute AttachLive URL from ATTACHMENTNAME", () => {
    const a = parseBseAnnouncementRow(row())!;
    assert.strictEqual(
      a.pdfUrl,
      "https://www.bseindia.com/xml-data/corpfiling/AttachLive/" +
        "b2235ebf-1111-2222-3333-444455556666.pdf",
    );
  });
});

// ── The DATE TRAP — future-date clamp + in-band error envelope ──────────────

describe("detectBseApiError", () => {
  it("recognises the future-date envelope BSE returns under a 200", () => {
    const e = detectBseApiError({
      Table: [{ Column1: "Future Date cannot be selected" }],
    });
    assert.ok(e, "the error envelope was read as a normal empty page");
    assert.strictEqual(e.futureDate, true);
    assert.match(e.message, /Future Date/);
  });

  it("a genuinely empty payload is NOT an error", () => {
    assert.strictEqual(detectBseApiError({}), null);
    assert.strictEqual(detectBseApiError({ Table: [] }), null);
    assert.strictEqual(detectBseApiError([]), null);
  });

  it("a real announcement row is NOT an error envelope", () => {
    assert.strictEqual(detectBseApiError({ Table: [row()] }), null);
  });

  it("a non-future Column1 error is reported but not flagged futureDate", () => {
    const e = detectBseApiError({ Table: [{ Column1: "Invalid Category" }] })!;
    assert.strictEqual(e.futureDate, false);
    assert.match(e.message, /Invalid Category/);
  });
});

describe("clampBseWindowEnd", () => {
  const now = new Date("2026-08-26T18:30:00Z"); // 2026-08-27 00:00 IST

  it("clamps a window end in the future down to TODAY in IST", () => {
    const out = clampBseWindowEnd(new Date("2027-01-01T00:00:00Z"), now);
    assert.strictEqual(out.toISOString().slice(0, 10), "2026-08-27");
  });

  it("leaves a past window end alone", () => {
    const out = clampBseWindowEnd(new Date("2026-08-10T00:00:00Z"), now);
    assert.strictEqual(out.toISOString().slice(0, 10), "2026-08-10");
  });

  it("uses the IST calendar day, not the UTC one", () => {
    // 19:00 UTC on the 26th is already the 27th in IST.
    const out = clampBseWindowEnd(
      new Date("2030-01-01T00:00:00Z"),
      new Date("2026-08-26T19:00:00Z"),
    );
    assert.strictEqual(out.toISOString().slice(0, 10), "2026-08-27");
  });

  it("an Invalid Date collapses to today rather than propagating NaN", () => {
    const out = clampBseWindowEnd(new Date("nope"), now);
    assert.strictEqual(out.toISOString().slice(0, 10), "2026-08-27");
  });
});

describe("future-date step-back (the trap, end to end)", () => {
  it("steps the window end back a day and RETRIES the same page", async () => {
    stubFetch((q) => {
      // BSE's clock is a day behind: it rejects the 26th and serves the 25th.
      if (q.get("strToDate") === "20260826") {
        return { Table: [{ Column1: "Future Date cannot be selected" }] };
      }
      return Number(q.get("pageno")) === 1 ? { Table: [row()] } : {};
    });

    const out = await fetchBSEAnnouncementsByCategory({
      fromDate: "2026-08-20",
      toDate: "2026-08-26",
      maxPages: 2,
      categories: ["Result"],
      now: new Date("2026-08-26T12:00:00Z"),
    });

    assert.strictEqual(out.futureDateStepBacks, 1);
    assert.strictEqual(out.window.to, "20260825");
    assert.strictEqual(out.announcements.length, 1);
    // The rejected page 1 was re-requested against the new end, not skipped.
    const pagenos = requested.map((u) =>
      new URLSearchParams(u.split("?")[1]).get("pageno"),
    );
    assert.deepStrictEqual(pagenos, ["1", "1", "2"]);
    assert.strictEqual(out.byCategory[0]!.stop, "exhausted");
  });

  it("the step-back is applied to the REMAINING categories too", async () => {
    stubFetch((q) => {
      if (q.get("strToDate") === "20260826") {
        return { Table: [{ Column1: "Future Date cannot be selected" }] };
      }
      return {};
    });

    const out = await fetchBSEAnnouncementsByCategory({
      fromDate: "2026-08-20",
      toDate: "2026-08-26",
      maxPages: 1,
      categories: ["Result", "Board Meeting", "Others"],
      now: new Date("2026-08-26T12:00:00Z"),
    });

    assert.strictEqual(out.futureDateStepBacks, 1);
    const ends = requested.map((u) =>
      new URLSearchParams(u.split("?")[1]).get("strToDate"),
    );
    // Only the first request used the rejected date.
    assert.strictEqual(ends[0], "20260826");
    assert.deepStrictEqual(ends.slice(1), ["20260825", "20260825", "20260825"]);
  });

  it("TERMINATES on a server that rejects every date — bounded step-backs", async () => {
    stubFetch(() => ({
      Table: [{ Column1: "Future Date cannot be selected" }],
    }));

    const out = await fetchBSEAnnouncementsByCategory({
      fromDate: "2026-01-01",
      toDate: "2026-08-26",
      maxPages: 5,
      categories: ["Result"],
      now: new Date("2026-08-26T12:00:00Z"),
    });

    assert.strictEqual(out.futureDateStepBacks, MAX_FUTURE_DATE_STEP_BACKS);
    // MAX step-backs + the request that finally gave up.
    assert.strictEqual(requested.length, MAX_FUTURE_DATE_STEP_BACKS + 1);
    assert.strictEqual(out.byCategory[0]!.stop, "failed");
    assert.strictEqual(out.transportFailures, 1);
  });

  it("a future-date envelope is NOT silently read as an empty page", async () => {
    // The regression that matters: `Column1` rows carry no SCRIP_CD, so
    // parseBseAnnouncements drops them and the page looks EMPTY. Without
    // detectBseApiError the walk would report `exhausted` with 0 rows and 0
    // transport failures — a healthy-looking run over a dead window.
    stubFetch(() => ({
      Table: [{ Column1: "Future Date cannot be selected" }],
    }));
    const out = await fetchBSEAnnouncementsByCategory({
      fromDate: "2026-01-01",
      toDate: "2026-08-26",
      maxPages: 1,
      categories: ["Result"],
      now: new Date("2026-08-26T12:00:00Z"),
    });
    assert.notStrictEqual(
      out.byCategory[0]!.stop,
      "exhausted",
      "an API error was reported as a normal end-of-pages",
    );
    assert.ok(out.transportFailures > 0);
  });
});
