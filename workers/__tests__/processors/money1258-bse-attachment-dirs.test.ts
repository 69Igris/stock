/**
 * BSE serves attachments from TWO directories, chosen by age — MONEY-1258.
 *
 * ## What happened
 *
 * `parseBseAnnouncementRow` builds `pdfUrl` against `AttachLive`
 * unconditionally. That is right for the nightly job, which walks the last few
 * days, and wrong for every historical walk: older filings move to `AttachHis`.
 *
 * Measured on prod 2026-08-27 against two real 2025 filings:
 *
 *     AttachLive/e77330e4-….pdf   HTTP 404, 8,406 bytes
 *     AttachHis /e77330e4-….pdf   HTTP 200, 4,376,543 bytes
 *     AttachLive/a6d73f10-….pdf   HTTP 404, 8,406 bytes
 *     AttachHis /a6d73f10-….pdf   HTTP 200,   738,768 bytes
 *
 * So `backfill-bse-results.ts --apply` 404'd on EVERY attachment and wrote rows
 * with `gcsPath: ""` — which the parse lane terminal-FAILs — while reporting a
 * clean create/supersede summary, because the download sits in a best-effort
 * catch.
 *
 * ## The 404 body is bigger than MIN_PDF_BYTES
 *
 * 8,406 bytes of HTML, against a 1,000-byte floor. Only the `res.ok` check
 * stands between that and storing error pages as PDFs. A future refactor that
 * "simplifies" the two checks into a length test would silently fill GCS with
 * HTML — and every one of those rows would look extracted.
 *
 * ## Why ordered, not "always both"
 *
 * At ~4,500 attachments a wrong-first guess is ~4,500 extra requests against a
 * host that rate-limits and has 429'd this repo before (MONEY-853). Both URLs
 * are always returned, so the ordering is an optimisation and never a
 * correctness risk: being wrong costs one request, not a missed attachment.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// MONEY-1326 — every path below is anchored to THIS FILE, never to
// `process.cwd()`. The reads used to be bare relative strings, so they resolved
// correctly only when the runner's cwd happened to be `workers/` (which is what
// `yarn test` does, per-workspace) and threw ENOENT from the repo root. Same
// class as the MONEY-1314 coverage test that resolved its roots from the cwd
// and silently scanned ZERO files.
const ROOT = join(import.meta.dirname, "..", "..", "..");

import {
  bseAttachmentCandidates,
  BSE_ATTACH_LIVE_WINDOW_DAYS,
} from "../../src/processors/bse-announcements-sync-logic";

const NOW = new Date("2026-08-27T00:00:00Z");
const LIVE =
  "https://www.bseindia.com/xml-data/corpfiling/AttachLive/e77330e4.pdf";
const HIST =
  "https://www.bseindia.com/xml-data/corpfiling/AttachHis/e77330e4.pdf";

const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("BSE attachment directory is chosen by age (MONEY-1258)", () => {
  it("[meta] the window is a real positive number of days", () => {
    // Ceiling: every ordering assertion below is relative to this constant. A
    // zero or NaN window would make them pass for the wrong reason.
    assert.ok(
      Number.isFinite(BSE_ATTACH_LIVE_WINDOW_DAYS) &&
        BSE_ATTACH_LIVE_WINDOW_DAYS > 0,
      `window is ${BSE_ATTACH_LIVE_WINDOW_DAYS}`,
    );
  });

  it("ALWAYS returns both directories — ordering is never a filter", () => {
    // The correctness guarantee. If only one were returned, a wrong guess
    // would be a permanently missed attachment rather than one extra request.
    for (const [url, when] of [
      [LIVE, days(1)],
      [LIVE, days(400)],
      [HIST, days(1)],
      [HIST, days(400)],
    ] as const) {
      const got = bseAttachmentCandidates(url, when, NOW);
      assert.equal(got.length, 2, `expected both dirs for ${url} @ ${when}`);
      assert.ok(got.some((u) => u.includes("AttachLive")), "AttachLive missing");
      assert.ok(got.some((u) => u.includes("AttachHis")), "AttachHis missing");
    }
  });

  it("puts AttachHis first for an OLD filing — the backfill's case", () => {
    const got = bseAttachmentCandidates(LIVE, days(365), NOW);
    assert.ok(
      got[0].includes("AttachHis"),
      "a year-old filing must try AttachHis first; trying Live first is " +
        "~4,500 guaranteed 404s against a rate-limiting host",
    );
  });

  it("puts AttachLive first for a RECENT filing — the nightly job's case", () => {
    const got = bseAttachmentCandidates(LIVE, days(1), NOW);
    assert.ok(
      got[0].includes("AttachLive"),
      "a filing from yesterday must try AttachLive first",
    );
  });

  it("rewrites the directory rather than appending a second URL", () => {
    // Both entries must name the SAME file. Getting this wrong would fetch a
    // different company's attachment — the failure nothing downstream detects.
    const got = bseAttachmentCandidates(HIST, days(365), NOW);
    for (const u of got) assert.match(u, /e77330e4\.pdf$/);
    assert.equal(new Set(got).size, 2, "the two candidates must differ");
  });

  it("returns an unrecognised URL ALONE rather than inventing a sibling", () => {
    const odd = "https://www.bseindia.com/somewhere/else/x.pdf";
    assert.deepStrictEqual(bseAttachmentCandidates(odd, days(365), NOW), [odd]);
  });

  it("returns nothing when there is no attachment", () => {
    assert.deepStrictEqual(bseAttachmentCandidates(null, days(1), NOW), []);
    assert.deepStrictEqual(bseAttachmentCandidates(undefined, null, NOW), []);
    assert.deepStrictEqual(bseAttachmentCandidates("", days(1), NOW), []);
  });

  it("an unknown publish date orders LIVE first", () => {
    // The nightly job's shape, and where an extra request costs most relative
    // to the work being done.
    for (const bad of [null, undefined, new Date("nonsense")]) {
      const got = bseAttachmentCandidates(LIVE, bad, NOW);
      assert.equal(got.length, 2);
      assert.ok(got[0].includes("AttachLive"), `unknown date (${bad}) must try Live first`);
    }
  });

  it("the backfill still checks res.ok, not just byte length", () => {
    // A 404 returns 8,406 bytes of HTML against a 1,000-byte floor, so the
    // status check is the only thing keeping error pages out of GCS.
    const src = readFileSync(
      join(ROOT, "scripts", "data", "backfill-bse-results.ts"),
      "utf8",
    );
    assert.match(src, /if \(res\.ok\)/, "the status check has been removed");
    assert.match(
      src,
      /bseAttachmentCandidates\(/,
      "the backfill no longer uses the age-ordered candidates and will 404 on " +
        "every historical attachment",
    );
  });
});
