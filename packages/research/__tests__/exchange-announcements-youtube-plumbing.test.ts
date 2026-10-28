/**
 * Branch-audit follow-ups — pure helpers (REAL imports, no network / no DB).
 *
 * MONEY-803b — `announcementDocType` (tools/fetch-exchange-announcements.ts):
 *   the categorizer-passthrough that replaces the blanket `corporate_filing`
 *   docType. Asserts each NSE announcement is classified via the shared P3b
 *   `categorizeNseAnnouncement` (investor_presentation / credit_rating /
 *   press_release / earnings_call_intimation / annual_report) and that noise the
 *   categorizer drops (returns null) falls back to `corporate_filing` so a filing
 *   with an attachment URL is never silently lost.
 *
 * MONEY-802 — `extractYoutubeUrl` (executor.ts): the plumbing helper that threads
 *   an already-present YouTube link from an upstream data result into
 *   `fetch_youtube_transcript`'s `url` param. Pure + never-throw.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  announcementDocType,
  type ExchangeAnnouncement,
} from "../src/tools/fetch-exchange-announcements";
import { extractYoutubeUrl } from "../src/executor";

describe("announcementDocType — categorizer passthrough (MONEY-803b)", () => {
  const cases: Array<{ a: ExchangeAnnouncement; expected: string }> = [
    {
      a: { subject: "Annual Report 2024", detail: "AR attached" },
      expected: "annual_report",
    },
    {
      a: { subject: "Investor Presentation Q3 FY24", detail: "" },
      expected: "investor_presentation",
    },
    {
      a: { subject: "Analyst Meet", detail: "schedule" },
      expected: "investor_presentation",
    },
    {
      a: { subject: "Credit Rating update by CRISIL", detail: "" },
      expected: "credit_rating",
    },
    {
      a: { subject: "Intimation of Earnings Conference Call", detail: "" },
      expected: "earnings_call_intimation",
    },
    {
      a: { subject: "Concall intimation", detail: "" },
      expected: "earnings_call_intimation",
    },
    {
      a: { subject: "Press Release on new plant", detail: "" },
      expected: "press_release",
    },
  ];

  for (const { a, expected } of cases) {
    it(`classifies "${a.subject}" → ${expected}`, () => {
      assert.equal(announcementDocType(a), expected);
    });
  }

  it("falls back to corporate_filing for noise the categorizer drops (null)", () => {
    assert.equal(
      announcementDocType({ subject: "Board Meeting Intimation", detail: "" }),
      "corporate_filing",
    );
    assert.equal(
      announcementDocType({ subject: "Trading Window Closure", detail: "" }),
      "corporate_filing",
    );
  });

  it("reads BOTH subject and detail, and tolerates missing fields", () => {
    // Marker only in detail → still classified.
    assert.equal(
      announcementDocType({ subject: "Disclosure", detail: "annual report" }),
      "annual_report",
    );
    // Entirely empty → fallback, never throws.
    assert.equal(announcementDocType({}), "corporate_filing");
  });
});

describe("extractYoutubeUrl — discovered-url plumbing (MONEY-802)", () => {
  it("pulls a watch?v= url out of a news-article result object", () => {
    const result = {
      articles: [
        {
          title: "Q3 concall",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        },
      ],
    };
    assert.equal(
      extractYoutubeUrl(result),
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  it("pulls a youtu.be short link and an embed link", () => {
    assert.equal(
      extractYoutubeUrl("see https://youtu.be/dQw4w9WgXcQ now"),
      "https://youtu.be/dQw4w9WgXcQ",
    );
    assert.equal(
      extractYoutubeUrl({
        html: "<iframe src='https://www.youtube.com/embed/dQw4w9WgXcQ'>",
      }),
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
    );
  });

  it("returns undefined when there's no YouTube link", () => {
    assert.equal(extractYoutubeUrl(null), undefined);
    assert.equal(extractYoutubeUrl(undefined), undefined);
    assert.equal(extractYoutubeUrl("just some text"), undefined);
    assert.equal(
      extractYoutubeUrl({ url: "https://nseindia.com/x.pdf" }),
      undefined,
    );
  });

  it("never throws on a circular / unserialisable result", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.equal(extractYoutubeUrl(circular), undefined);
  });
});
