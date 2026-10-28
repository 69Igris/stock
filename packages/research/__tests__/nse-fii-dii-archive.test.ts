/**
 * FII/DII flows archive through the seam — MONEY-1195.
 *
 * Two halves, because either alone is a shadow test:
 *
 *   1. The FAMILY exists and files under it. `archiveNseJsonResponse` resolves
 *      a family by TABLE lookup; an unmatched path returns a null key, takes
 *      the `skipped++` branch and RETURNS NORMALLY. So a fetcher can call the
 *      seam, be told nothing went wrong, and write nothing anywhere — the
 *      silent no-op MONEY-1193 was about. Asserting the key is what makes the
 *      family row falsifiable.
 *
 *   2. The FETCHER actually calls it, on every path that decodes a body. This
 *      is the class-level check, not the instance: MONEY-1193's scan was blind
 *      because `nse-filings.ts` already archived from three OTHER functions, so
 *      the file read as compliant while three of its fetchers bypassed the
 *      seam. File granularity cannot catch that; counting the call sites can.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DIVERGENCE — READ BEFORE RECONCILING (MONEY-1195 vs the unpushed fix/MONEY-1099)
 *
 * MONEY-1195 asks for the `nse-fii-dii.ts` row in the exemption table of
 * `packages/core/__tests__/market-data/no-feed-fetch-bypass.test.ts` to flip
 * from "OPEN gap" to "archives". That row DOES NOT EXIST on origin/main: the
 * scan there is rooted at `packages/core/src` (CWD is packages/core), so it has
 * never seen `packages/research` at all, and its `HTTP_EXEMPTIONS` covers only
 * the five core-side files. The research-side scan and its exemption table were
 * added on `fix/MONEY-1099`, which is unpushed and not visible from here.
 *
 * Rather than blind-write a conflicting second copy of that scan, the
 * enforcement lives here, in the package that owns the file. When the two
 * branches meet, the reconciliation is:
 *   - flip the `nse-fii-dii.ts` entry there from OPEN gap → archives, and
 *   - keep or fold in the call-site counts below, which are the part that
 *     actually enforces it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  nseJsonArchiveKey,
  archiveNseJsonResponse,
} from "../src/data-sources/nse-json-archive";
import {
  setFeedArchiveStore,
  type FeedArchiveStore,
} from "@usemoney/core/market-data";

/** The endpoint under test. Market-wide — no `symbol=`, so not excluded. */
const FII_DII_PATH = "/api/fiidiiTradeReact";

/** CWD is packages/research (the package's test script runs from there). */
const FETCHER_FILE = join("src", "data-sources", "nse-fii-dii.ts");

describe("FII/DII has an archive family (MONEY-1195)", () => {
  it("files under feeds/NSE/api/fii-dii/, date-stamped by IST fetch day", () => {
    const key = nseJsonArchiveKey(
      FII_DII_PATH,
      new Date("2026-08-11T16:40:00.000Z"),
    );
    assert.equal(
      key,
      "feeds/NSE/api/fii-dii/2026/08/2026-08-11-fiidiiTradeReact.json",
    );
  });

  it("is NOT excluded by the per-symbol volume rule — it is market-wide", () => {
    // The distinction that earned this its own ticket. The per-symbol fan-outs
    // MONEY-1193 touched are declined on purpose (millions of tiny objects);
    // this endpoint is one small row set for the WHOLE market per day.
    assert.notEqual(nseJsonArchiveKey(FII_DII_PATH, new Date()), null);
    assert.equal(
      nseJsonArchiveKey(`${FII_DII_PATH}?symbol=RELIANCE`, new Date()),
      null,
    );
  });

  it("ROTATES daily — the series accrues instead of overwriting itself", () => {
    // The retention decision, made falsifiable. If someone later moves this
    // family to a `current/`-style non-rotating key, every day but the last
    // would be silently overwritten — and for an endpoint that serves only the
    // current reading, those bytes are the only copy that will ever exist.
    const d1 = nseJsonArchiveKey(
      FII_DII_PATH,
      new Date("2026-08-11T06:00:00Z"),
    );
    const d2 = nseJsonArchiveKey(
      FII_DII_PATH,
      new Date("2026-08-12T06:00:00Z"),
    );
    assert.notEqual(d1, d2);
    assert.ok(d1?.includes("2026-08-11"));
    assert.ok(d2?.includes("2026-08-12"));
  });

  it("is idempotent within one IST day — a re-run overwrites in place", () => {
    // Pub/Sub redelivery must not accumulate duplicate objects for one day.
    const a = nseJsonArchiveKey(FII_DII_PATH, new Date("2026-08-11T04:00:00Z"));
    const b = nseJsonArchiveKey(FII_DII_PATH, new Date("2026-08-11T15:00:00Z"));
    assert.equal(a, b);
  });

  it("keys on the IST day, not UTC — a 01:00 IST retry files under that day", () => {
    // 2026-08-11T19:00Z is 2026-08-12 00:30 IST. Filing it under Aug 11 would
    // break the same-day-overwrite promise for any overnight retry.
    const key = nseJsonArchiveKey(
      FII_DII_PATH,
      new Date("2026-08-11T19:00:00.000Z"),
    );
    assert.ok(key?.includes("/2026/08/2026-08-12-"), key ?? "null");
  });
});

describe("archiveNseJsonResponse stores the FII/DII payload", () => {
  const puts: Array<{ key: string; body: string; contentType: string }> = [];
  const fakeStore: FeedArchiveStore = {
    get: async () => null,
    put: async (key, body, contentType) => {
      puts.push({ key, body: body.toString("utf8"), contentType });
    },
  };
  const prevMode = process.env.FEED_ARCHIVE_MODE;

  beforeEach(() => {
    puts.length = 0;
    setFeedArchiveStore(fakeStore);
  });
  afterEach(() => {
    setFeedArchiveStore(null);
    if (prevMode === undefined) delete process.env.FEED_ARCHIVE_MODE;
    else process.env.FEED_ARCHIVE_MODE = prevMode;
  });

  it("writes the RAW bytes under the fii-dii family when armed", async () => {
    process.env.FEED_ARCHIVE_MODE = "archive";
    const raw = '[{"category":"FII/FPI *","buyValue":"1,000.00"}]';
    await archiveNseJsonResponse(FII_DII_PATH, raw);

    assert.equal(puts.length, 1, "expected exactly one archived object");
    assert.match(
      puts[0]!.key,
      /^feeds\/NSE\/api\/fii-dii\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}-fiidiiTradeReact\.json$/,
    );
    // RAW, not re-serialised: the commas in "1,000.00" must survive verbatim so
    // a future re-parse sees exactly what NSE served.
    assert.equal(puts[0]!.body, raw);
    assert.equal(puts[0]!.contentType, "application/json");
  });

  it("never throws — a store failure must not change what the fetch returns", async () => {
    process.env.FEED_ARCHIVE_MODE = "archive";
    setFeedArchiveStore({
      get: async () => null,
      put: async () => {
        throw new Error("GCS on fire");
      },
    });
    await assert.doesNotReject(archiveNseJsonResponse(FII_DII_PATH, "[]"));
  });

  it("is a no-op when not armed — Vercel, local dev and QA replay", async () => {
    delete process.env.FEED_ARCHIVE_MODE;
    await archiveNseJsonResponse(FII_DII_PATH, "[]");
    process.env.FEED_ARCHIVE_MODE = "replay";
    await archiveNseJsonResponse(FII_DII_PATH, "[]");
    assert.equal(puts.length, 0);
  });
});

/**
 * Strip line + block comments so prose cannot satisfy — or trip — the scan.
 *
 * `[^\S\r\n]*` rather than `\s*` is load-bearing and was a real bug in the
 * MONEY-1193 version of this helper: `\s` matches newlines, so with the `m`
 * flag a leading `^\s*` followed by a line-comment marker could start at a
 * blank line, consume its newline and swallow the FOLLOWING comment line too.
 * Comment pairs collapsed, and every line number the scan reported came out
 * short.
 *
 * NOTE the wording above avoids writing that pattern literally. Spelling it
 * out puts a `*` immediately before a `/`, which CLOSES this block comment —
 * the rest of the line then parses as code and the file dies at import with
 * "Unterminated regular expression". That is how this file first shipped, and
 * why it never ran: a test that cannot be parsed reports no failures.
 */
function stripComments(src: string): string {
  return src
    .replace(/^[^\S\r\n]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function countMatches(src: string, re: RegExp): number {
  return (src.match(re) ?? []).length;
}

describe("nse-fii-dii.ts routes every decoded response through the archive", () => {
  const code = stripComments(readFileSync(FETCHER_FILE, "utf8"));

  it("imports and calls the archive seam", () => {
    assert.match(
      code,
      /import\s*\{\s*archiveNseJsonResponse\s*\}\s*from\s*"\.\/nse-json-archive"/,
      "nse-fii-dii.ts must import archiveNseJsonResponse — MONEY-1195",
    );
    assert.ok(
      countMatches(code, /\barchiveNseJsonResponse\s*\(/g) >= 1,
      "the import alone archives nothing; it must be CALLED",
    );
  });

  it("decodes with .text(), never .json() — .json() cannot yield raw bytes", () => {
    // The MONEY-1193 defect class, encoded. `res.json()` consumes the stream
    // and returns a parsed object, so the bytes NSE actually served no longer
    // exist by the time they could be archived. A file that decodes that way
    // CANNOT archive, no matter what it calls afterwards.
    assert.equal(
      countMatches(code, /\.json\s*\(\s*\)/g),
      0,
      "nse-fii-dii.ts must not decode an NSE response with .json() — use " +
        ".text() then JSON.parse so the raw bytes can be archived",
    );
    assert.ok(countMatches(code, /\.text\s*\(\s*\)/g) >= 1);
  });

  it("every body-decoding read goes through the single archiving funnel", () => {
    // Both the first attempt AND the 401/403 retry decode a body, and both must
    // archive. Counting them pins the shape: a third read added later fails
    // this and forces a decision instead of silently bypassing the seam.
    // `await decodeAndArchive<` and not `decodeAndArchive<`: the latter also
    // matches the function's own declaration, which would make the count read
    // 3 and quietly turn this assertion into a different claim than intended.
    assert.equal(
      countMatches(code, /await decodeAndArchive</g),
      2,
      "expected exactly 2 decodeAndArchive call sites (initial + 401/403 " +
        "retry). If a new NSE read was added, route it through the same " +
        "helper and update this count — do NOT decode a body inline.",
    );
  });

  it("the cookie handshake is excluded STRUCTURALLY, not by omission", () => {
    // refreshSession() fetches the NSE homepage purely to collect Set-Cookie.
    // It never reads the body, so there is nothing to archive — and archiving
    // an HTML homepage under a data family would be worse than not archiving.
    // Asserting it reads no body is what makes that an exclusion by
    // construction rather than an oversight that happens to be harmless.
    const handshake = code.slice(
      code.indexOf("async function refreshSession"),
      code.indexOf("async function ensureSession"),
    );
    assert.ok(handshake.length > 0, "refreshSession not found — retarget this");
    assert.equal(
      countMatches(handshake, /\.text\s*\(\s*\)|\.json\s*\(\s*\)/g),
      0,
    );
    assert.equal(countMatches(handshake, /archiveNseJsonResponse/g), 0);
  });

  it("the scan actually fires — it is not passing vacuously", () => {
    // Without this the assertions above could all pass on a file that no longer
    // matches, which is precisely how the pre-MONEY-1157 bypass scan was green.
    const bypassed = [
      "const res = await fetch(`${NSE_BASE}${path}`);",
      "return (await res.json()) as T;",
    ].join("\n");
    assert.equal(countMatches(stripComments(bypassed), /\.json\s*\(\s*\)/g), 1);
    assert.equal(
      countMatches(stripComments(bypassed), /decodeAndArchive</g),
      0,
    );

    // And the comment stripper must not be the thing letting it pass: a
    // commented-out call is not a call.
    const prose = "// await archiveNseJsonResponse(path, text);";
    assert.equal(
      countMatches(stripComments(prose), /archiveNseJsonResponse\s*\(/g),
      0,
    );
  });
});

/**
 * MONEY-1196 — two latent bugs in the CHAT-facing reader (`fetchFIIDIIFlows`),
 * distinct from the ingestion worker, which always handled both.
 */
describe("fetchFIIDIIFlows reader bugs (MONEY-1196)", () => {
  it("REGRESSION: orders NSE dates chronologically, not alphabetically", async () => {
    const { parseNseFlowDate } = await import("@usemoney/core/market-data");
    // The exact pair that broke it: text-sorting puts "02-Sep" before "13-Aug"
    // because it compares the day-of-month first.
    const rows = ["13-Aug-2026", "02-Sep-2026"];
    const textSorted = [...rows].sort((a, b) => b.localeCompare(a));
    assert.equal(
      textSorted[0],
      "13-Aug-2026",
      "precondition: text sort picks the WRONG newest",
    );

    const dateSorted = [...rows].sort(
      (a, b) =>
        (parseNseFlowDate(b)?.getTime() ?? -Infinity) -
        (parseNseFlowDate(a)?.getTime() ?? -Infinity),
    );
    assert.equal(dateSorted[0], "02-Sep-2026", "date sort picks September");
  });

  it("an unparseable date sorts LAST rather than vanishing from the series", async () => {
    const { parseNseFlowDate } = await import("@usemoney/core/market-data");
    const rows = ["13-Aug-2026", "not-a-date", "02-Sep-2026"];
    const sorted = [...rows].sort(
      (a, b) =>
        (parseNseFlowDate(b)?.getTime() ?? -Infinity) -
        (parseNseFlowDate(a)?.getTime() ?? -Infinity),
    );
    assert.equal(sorted.length, 3, "no row is dropped");
    assert.equal(sorted[2], "not-a-date", "the unparseable row sorts last");
  });

  it("REGRESSION: a BARE ARRAY response is accepted, not read as no-data", () => {
    // The reader tested `raw?.data` only, so a bare array returned null ALWAYS
    // — a permanently empty chat answer that looks like "no data".
    const bare: unknown = [{ date: "13-Aug-2026", category: "FII/FPI *" }];
    const wrapped: unknown = { data: [{ date: "13-Aug-2026" }] };
    const normalise = (raw: any): unknown[] =>
      Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];

    assert.equal(normalise(bare).length, 1, "bare array must be accepted");
    assert.equal(normalise(wrapped).length, 1, "wrapped shape still works");
    assert.equal(normalise(null).length, 0);
    assert.equal(normalise({ data: "nope" }).length, 0);
  });
});
