/**
 * Official-channel source fetchers (MONEY-587).
 *
 * De-shadowed (MONEY-620 / task 185): the previous version re-declared
 * byte-identical copies of `mapBoardMeetings`, `mapAnnouncements`,
 * `canonicalSymbol` and `stockDocPath` inline and asserted the copies. All
 * four are REAL exported pure functions that the production tools call:
 *   - mapBoardMeetings   ← fetch-shareholder-meetings.ts (line 66)
 *   - mapAnnouncements   ← fetch-exchange-announcements.ts (line 68)
 *   - canonicalSymbol / stockDocPath ← data-sources/source-cache.ts
 * This file now imports and asserts those real symbols.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapBoardMeetings } from "@usemoney/research/tools/fetch-shareholder-meetings";
import {
  mapAnnouncements,
  announcementPeriod,
} from "@usemoney/research/tools/fetch-exchange-announcements";
import {
  canonicalSymbol,
  stockDocPath,
} from "@usemoney/research/data-sources/source-cache";

describe("Official-channel source fetchers (MONEY-587)", () => {
  describe("mapBoardMeetings (real)", () => {
    it("reads the { data: [] } wrapper and NSE field aliases", () => {
      const out = mapBoardMeetings({
        data: [
          {
            bm_date: "12-Jun-2026",
            bm_purpose: "Quarterly Results",
            meeting_type: "Board",
          },
        ],
      });
      assert.equal(out.length, 1);
      assert.equal(out[0]!.date, "12-Jun-2026");
      assert.equal(out[0]!.purpose, "Quarterly Results");
      assert.equal(out[0]!.type, "Board");
    });

    it("accepts a bare array + alternate field names (AGM)", () => {
      const out = mapBoardMeetings([{ date: "20-Aug-2026", purpose: "AGM" }]);
      assert.equal(out[0]!.date, "20-Aug-2026");
      assert.equal(out[0]!.purpose, "AGM");
    });

    it("drops rows with neither date nor purpose", () => {
      assert.equal(mapBoardMeetings([{ meeting_type: "Board" }]).length, 0);
    });

    it("returns [] for an unexpected shape", () => {
      assert.deepEqual(mapBoardMeetings(null), []);
      assert.deepEqual(mapBoardMeetings({ nope: 1 }), []);
    });
  });

  describe("mapAnnouncements (real)", () => {
    it("maps subject + the official attachment URL", () => {
      const out = mapAnnouncements({
        data: [
          {
            an_dt: "01-Jun-2026 18:30",
            desc: "Outcome of Board Meeting",
            attchmntFile: "https://nsearchives.nseindia.com/corporate/x.pdf",
          },
        ],
      });
      assert.equal(out.length, 1);
      assert.equal(out[0]!.subject, "Outcome of Board Meeting");
      assert.equal(
        out[0]!.url,
        "https://nsearchives.nseindia.com/corporate/x.pdf"
      );
      assert.equal(out[0]!.date, "01-Jun-2026 18:30");
    });

    it("keeps an announcement that has only a detail body", () => {
      const out = mapAnnouncements([
        { attchmntText: "Investor meet intimation" },
      ]);
      assert.equal(out.length, 1);
      assert.equal(out[0]!.detail, "Investor meet intimation");
    });

    it("drops rows with neither subject nor detail", () => {
      assert.equal(mapAnnouncements([{ an_dt: "x" }]).length, 0);
    });
  });

  // MONEY-798 (P3c): per-filing period token for the RAG enqueue unique key.
  describe("announcementPeriod (real — RAG enqueue idempotency token)", () => {
    const a = {
      date: "01-Jun-2026 18:30",
      subject: "Outcome of Board Meeting",
      url: "https://nsearchives.nseindia.com/corporate/x.pdf",
    };

    it("is STABLE: the same filing re-surfaced yields the same token", () => {
      assert.equal(announcementPeriod(a), announcementPeriod({ ...a }));
    });

    it("is DISTINCT: different attachments → different tokens", () => {
      const b = {
        ...a,
        url: "https://nsearchives.nseindia.com/corporate/y.pdf",
      };
      assert.notEqual(announcementPeriod(a), announcementPeriod(b));
    });

    it("prefixes the date (YYYY-MM-DD-ish) when present", () => {
      // The date slice keeps only digits/hyphens from the first 10 chars.
      assert.match(announcementPeriod(a), /^01-Jun-20/);
    });

    it("falls back to a bare hash token when no date is present", () => {
      const out = announcementPeriod({ url: a.url });
      assert.ok(out.length > 0);
      assert.doesNotMatch(out, /^-/);
    });
  });

  describe("canonicalSymbol / stockDocPath (real — NSE + BSE share one folder)", () => {
    it("strips the exchange suffix so NSE and BSE collapse to one key", () => {
      assert.equal(canonicalSymbol("RELIANCE.NS"), "RELIANCE");
      assert.equal(canonicalSymbol("RELIANCE.BO"), "RELIANCE");
      assert.equal(canonicalSymbol("reliance"), "RELIANCE");
    });

    it("strips the NSE series suffix", () => {
      assert.equal(canonicalSymbol("TCS-EQ"), "TCS");
    });

    it("NSE + BSE resolve to the same single folder path", () => {
      assert.equal(
        stockDocPath("INFY.NS", "announcements"),
        stockDocPath("INFY.BO", "announcements")
      );
      assert.equal(
        stockDocPath("INFY.NS", "announcements"),
        "stocks/INFY/announcements.json"
      );
    });
  });
});
