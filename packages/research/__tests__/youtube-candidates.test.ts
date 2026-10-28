/**
 * MONEY-802 (discovery half) — pure helpers for YouTube video discovery.
 * REAL imports, NO network (every covered fn is a pure parse / string builder).
 *
 * Covers:
 *   - extractSearchVideoIds (data-sources/youtube-search.ts)
 *       parse from a ytInitialData-style blob (first-seen order + de-dupe + cap),
 *       no-match HTML, junk / empty input, and the {11}-char id bound.
 *   - buildCandidateQuery + resolveCompanyLabel (tools/fetch-youtube-candidates.ts)
 *       company vs symbol precedence, .NS suffix strip, kind phrasing, default
 *       intent, deterministic year, and empty-input guards.
 *   - extractCandidateUrl (executor.ts) — the executor's first-candidate pull.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractSearchVideoIds } from "../src/data-sources/youtube-search";
import {
  buildCandidateQuery,
  resolveCompanyLabel,
} from "../src/tools/fetch-youtube-candidates";
import { extractCandidateUrl } from "../src/executor";

describe("extractSearchVideoIds (MONEY-802)", () => {
  it("extracts video ids from a ytInitialData-style blob, in first-seen order", () => {
    const html =
      'var ytInitialData = {"contents":[' +
      '{"videoRenderer":{"videoId":"AAAAAAAAAAA","title":"call 1"}},' +
      '{"videoRenderer":{"videoId":"BBBBBBBBBBB","title":"call 2"}},' +
      '{"videoRenderer":{"videoId":"CCCCCCCCCCC","title":"call 3"}}' +
      "]};";
    assert.deepEqual(extractSearchVideoIds(html), [
      "AAAAAAAAAAA",
      "BBBBBBBBBBB",
      "CCCCCCCCCCC",
    ]);
  });

  it("de-dupes repeated ids and preserves first-seen order", () => {
    const html =
      '"videoId":"AAAAAAAAAAA" ... "videoId":"BBBBBBBBBBB" ... "videoId":"AAAAAAAAAAA"';
    assert.deepEqual(extractSearchVideoIds(html), [
      "AAAAAAAAAAA",
      "BBBBBBBBBBB",
    ]);
  });

  it("caps the number of ids returned", () => {
    const ids = ["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC", "DDDDDDDDDDD"];
    const html = ids.map((id) => `"videoId":"${id}"`).join(" ");
    assert.deepEqual(extractSearchVideoIds(html, 2), [
      "AAAAAAAAAAA",
      "BBBBBBBBBBB",
    ]);
  });

  it("returns [] when the html has no videoId tokens", () => {
    assert.deepEqual(
      extractSearchVideoIds("<html><body>no results here</body></html>"),
      [],
    );
  });

  it("returns [] for empty / non-string input (junk)", () => {
    assert.deepEqual(extractSearchVideoIds(""), []);
    // @ts-expect-error — exercising the runtime guard with a non-string.
    assert.deepEqual(extractSearchVideoIds(null), []);
    // @ts-expect-error — exercising the runtime guard with a non-string.
    assert.deepEqual(extractSearchVideoIds(42), []);
  });

  it("does not match ids that are not exactly 11 chars", () => {
    // 10 chars (too short) and 12 chars (too long) must not be captured.
    const html = '"videoId":"AAAAAAAAAA" "videoId":"CCCCCCCCCCCC"';
    assert.deepEqual(extractSearchVideoIds(html), []);
  });

  it("tolerates whitespace around the key/value separators", () => {
    const html = '"videoId" : "AAAAAAAAAAA"';
    assert.deepEqual(extractSearchVideoIds(html), ["AAAAAAAAAAA"]);
  });
});

describe("resolveCompanyLabel (MONEY-802)", () => {
  it("prefers an explicit company name over the symbol", () => {
    assert.equal(
      resolveCompanyLabel("TCS.NS", "Tata Consultancy Services"),
      "Tata Consultancy Services",
    );
  });

  it("falls back to the symbol with the exchange suffix stripped", () => {
    assert.equal(resolveCompanyLabel("RELIANCE.NS"), "RELIANCE");
    assert.equal(resolveCompanyLabel("INFY.BO"), "INFY");
    assert.equal(resolveCompanyLabel("TCS"), "TCS");
  });

  it("returns '' when neither symbol nor company is usable", () => {
    assert.equal(resolveCompanyLabel(), "");
    assert.equal(resolveCompanyLabel("", "  "), "");
    assert.equal(resolveCompanyLabel(42, {}), "");
  });
});

describe("buildCandidateQuery (MONEY-802)", () => {
  it("builds an earnings-call query by default (no kind), with the given year", () => {
    assert.equal(
      buildCandidateQuery("Reliance Industries", undefined, 2026),
      "Reliance Industries earnings call concall 2026",
    );
  });

  it("phrases each known kind distinctly", () => {
    assert.equal(
      buildCandidateQuery("Infosys", "interview", 2026),
      "Infosys management interview 2026",
    );
    assert.equal(
      buildCandidateQuery("Infosys", "concall", 2026),
      "Infosys concall earnings call 2026",
    );
    assert.equal(
      buildCandidateQuery("Infosys", "earnings_call", 2026),
      "Infosys earnings call concall 2026",
    );
  });

  it("falls back to the default phrase for an unknown kind", () => {
    assert.equal(
      buildCandidateQuery("HDFC Bank", "totally-unknown", 2026),
      "HDFC Bank earnings call concall 2026",
    );
  });

  it("collapses extra whitespace in the company label", () => {
    assert.equal(
      buildCandidateQuery("  Tata   Motors  ", "concall", 2025),
      "Tata Motors concall earnings call 2025",
    );
  });

  it("returns '' for an empty company label", () => {
    assert.equal(buildCandidateQuery("", "concall", 2026), "");
    assert.equal(buildCandidateQuery("   ", undefined, 2026), "");
  });

  it("defaults the year to the current UTC year when not supplied", () => {
    const year = new Date().getUTCFullYear();
    assert.equal(
      buildCandidateQuery("TCS", "concall"),
      `TCS concall earnings call ${year}`,
    );
  });
});

describe("extractCandidateUrl (MONEY-802)", () => {
  it("returns the first candidate url from a candidates payload", () => {
    const result = {
      available: true,
      query: "TCS earnings call concall 2026",
      candidates: [
        { url: "https://www.youtube.com/watch?v=AAAAAAAAAAA" },
        { url: "https://www.youtube.com/watch?v=BBBBBBBBBBB" },
      ],
    };
    assert.equal(
      extractCandidateUrl(result),
      "https://www.youtube.com/watch?v=AAAAAAAAAAA",
    );
  });

  it("skips blank/missing urls and returns the first usable one", () => {
    const result = {
      candidates: [
        { url: "   " },
        {},
        { url: "https://www.youtube.com/watch?v=CCCCCCCCCCC" },
      ],
    };
    assert.equal(
      extractCandidateUrl(result),
      "https://www.youtube.com/watch?v=CCCCCCCCCCC",
    );
  });

  it("returns undefined for non-candidate / empty payloads", () => {
    assert.equal(extractCandidateUrl(null), undefined);
    assert.equal(extractCandidateUrl("a string"), undefined);
    assert.equal(extractCandidateUrl({ candidates: [] }), undefined);
    assert.equal(extractCandidateUrl({ candidates: "nope" }), undefined);
    assert.equal(extractCandidateUrl({ foo: "bar" }), undefined);
  });
});
