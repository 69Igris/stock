/**
 * UNIT TESTS — `nse-announcements-sync-logic.ts` (MONEY-1098 P5.1).
 *
 * Every symbol imported here is the REAL export the processor calls; there are
 * no shadow re-implementations. The weight is deliberately on
 * {@link decideNseAnnouncementDedupe}: SEBI single-filing (2025) means NSE and
 * BSE disseminate the SAME document, so a dedupe that is subtly wrong does not
 * fail — it just quietly stores every filing twice (or, worse in the other
 * direction, silently suppresses one leg entirely). Neither shows up as an
 * error anywhere, so the gates, the window, the confidence precedence and the
 * "size 0 is unknown, not equal" rule each get their own case.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BSE_HEURISTIC_DOC_TYPES,
  CONCALL_UPDATE_DESC_KEY,
  DEDUPE_TITLE_SIMILARITY_THRESHOLD,
  DEDUPE_WINDOW_DAYS,
  DEDUPE_WINDOW_MS,
  DEFAULT_WINDOW_DAYS,
  DELAY_BETWEEN_DOWNLOADS_MS,
  DOWNLOAD_FAILURE_BREAKER_THRESHOLD,
  IST_OFFSET_MS,
  MAX_PDF_DOWNLOADS_PER_RUN,
  MAX_WINDOW_DAYS,
  MIN_PDF_BYTES,
  NSE_ANNOUNCEMENTS_PATH,
  buildAnnouncementPeriod,
  buildAnnouncementsPath,
  classifyNseAnnouncement,
  computeAnnouncementWindow,
  decideNseAnnouncementDedupe,
  deriveCandidateConfidence,
  formatIstDate,
  isUsablePdf,
  normalizeDesc,
  parseNseAnnouncementRows,
  parseNseTimestamp,
  planPdfDownload,
  resolveAttachmentUrl,
  splitGcsPath,
  titleSimilarity,
  tokenizeTitle,
  type DedupeCandidate,
  type IncomingAnnouncement,
} from "../src/processors/nse-announcements-sync-logic";

const DAY_MS = 24 * 60 * 60 * 1000;

// ══════════════════════════════════════════════════════════════════════
// Constants — pinned, because the ticket fixes these numbers
// ══════════════════════════════════════════════════════════════════════

describe("tuning constants are the documented values", () => {
  it("dedupe threshold is 0.9 and the window is ±1 day", () => {
    // Pinned rather than assumed: both are part of the P5.1 contract, and a
    // silent tune of either changes how many filings are stored with nothing
    // failing.
    assert.equal(DEDUPE_TITLE_SIMILARITY_THRESHOLD, 0.9);
    assert.equal(DEDUPE_WINDOW_DAYS, 1);
    assert.equal(DEDUPE_WINDOW_MS, DAY_MS);
  });

  it("the fetch window defaults to 2 inclusive days", () => {
    assert.equal(DEFAULT_WINDOW_DAYS, 2);
    assert.equal(MAX_WINDOW_DAYS, 31);
  });

  it("pacing constants match the BSE leg's shape", () => {
    assert.equal(DELAY_BETWEEN_DOWNLOADS_MS, 1500);
    assert.equal(MAX_PDF_DOWNLOADS_PER_RUN, 500);
    assert.equal(MIN_PDF_BYTES, 1000);
    assert.ok(DOWNLOAD_FAILURE_BREAKER_THRESHOLD > 0);
  });

  it("IST is a flat +5:30 offset", () => {
    assert.equal(IST_OFFSET_MS, 5.5 * 60 * 60 * 1000);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Window calculation
// ══════════════════════════════════════════════════════════════════════

describe("computeAnnouncementWindow", () => {
  it("defaults to a 2-day INCLUSIVE window ending today", () => {
    // 2026-08-06 15:45 UTC = 21:15 IST — the actual cron time.
    const now = new Date("2026-08-06T15:45:00Z");
    assert.deepEqual(computeAnnouncementWindow(now), {
      from: "05-08-2026",
      to: "06-08-2026",
      windowDays: 2,
    });
  });

  it("uses the IST calendar date, not the UTC one", () => {
    // 19:30 UTC is already 01:00 IST the NEXT day. A UTC formatter would ask
    // NSE for the 5th and miss everything filed on the 6th — invisible, because
    // an empty answer is indistinguishable from a quiet day.
    const now = new Date("2026-08-05T19:30:00Z");
    const window = computeAnnouncementWindow(now);
    assert.equal(window.to, "06-08-2026");
    assert.equal(window.from, "05-08-2026");
  });

  it("rolls over month and year boundaries", () => {
    const window = computeAnnouncementWindow(new Date("2027-01-01T15:45:00Z"));
    assert.equal(window.from, "31-12-2026");
    assert.equal(window.to, "01-01-2027");
  });

  it("honours an explicit toDate anchor", () => {
    const window = computeAnnouncementWindow(new Date("2026-08-06T15:45:00Z"), {
      toDate: "2026-07-10",
    });
    assert.deepEqual(window, {
      from: "09-07-2026",
      to: "10-07-2026",
      windowDays: 2,
    });
  });

  it("honours an explicit from+to pair and reports the real span", () => {
    const window = computeAnnouncementWindow(new Date("2026-08-06T15:45:00Z"), {
      fromDate: "2026-08-01",
      toDate: "2026-08-05",
    });
    assert.deepEqual(window, {
      from: "01-08-2026",
      to: "05-08-2026",
      windowDays: 5,
    });
  });

  it("swaps a reversed from/to instead of asking for an empty range", () => {
    const window = computeAnnouncementWindow(new Date("2026-08-06T15:45:00Z"), {
      fromDate: "2026-08-05",
      toDate: "2026-08-01",
    });
    assert.equal(window.from, "01-08-2026");
    assert.equal(window.to, "05-08-2026");
  });

  it("ignores an unparseable override rather than throwing", () => {
    // A typo'd manual publish should still archive the default window, not
    // dead-letter the run.
    const now = new Date("2026-08-06T15:45:00Z");
    const window = computeAnnouncementWindow(now, {
      fromDate: "06/08/2026",
      toDate: "not-a-date",
    });
    assert.deepEqual(window, computeAnnouncementWindow(now));
  });

  it("clamps windowDays into [1, MAX_WINDOW_DAYS]", () => {
    const now = new Date("2026-08-06T15:45:00Z");
    assert.equal(computeAnnouncementWindow(now, { windowDays: 0 }).windowDays, 1);
    assert.equal(
      computeAnnouncementWindow(now, { windowDays: 0 }).from,
      "06-08-2026",
    );
    assert.equal(
      computeAnnouncementWindow(now, { windowDays: 9999 }).windowDays,
      MAX_WINDOW_DAYS,
    );
    assert.equal(
      computeAnnouncementWindow(now, { windowDays: Number.NaN }).windowDays,
      DEFAULT_WINDOW_DAYS,
    );
    assert.equal(
      computeAnnouncementWindow(now, { windowDays: 3.7 }).windowDays,
      3,
    );
  });
});

describe("formatIstDate", () => {
  it("formats DD-MM-YYYY with zero padding", () => {
    assert.equal(formatIstDate(new Date("2026-03-05T06:00:00Z")), "05-03-2026");
  });
});

describe("buildAnnouncementsPath", () => {
  it("targets the WHOLE-MARKET endpoint with an equities index", () => {
    const path = buildAnnouncementsPath({ from: "05-08-2026", to: "06-08-2026" });
    assert.ok(path.startsWith(`${NSE_ANNOUNCEMENTS_PATH}?`));
    assert.match(path, /index=equities/);
    assert.match(path, /from_date=05-08-2026/);
    assert.match(path, /to_date=06-08-2026/);
    // No `symbol` param — that is what makes it whole-market rather than the
    // 200-symbol fan-out the per-symbol endpoint forces.
    assert.ok(!path.includes("symbol="));
  });
});

// ══════════════════════════════════════════════════════════════════════
// Feed parsing
// ══════════════════════════════════════════════════════════════════════

describe("parseNseTimestamp", () => {
  it("parses NSE's DD-MMM-YYYY HH:mm:ss as IST wall-clock", () => {
    const d = parseNseTimestamp("05-Aug-2026 18:14:59");
    assert.ok(d);
    assert.equal(d.toISOString(), "2026-08-05T12:44:59.000Z");
  });

  it("parses the sort_date YYYY-MM-DD HH:mm:ss form, also IST", () => {
    const d = parseNseTimestamp("2026-08-05 18:14:59");
    assert.ok(d);
    assert.equal(d.toISOString(), "2026-08-05T12:44:59.000Z");
  });

  it("parses a date with no time component", () => {
    const d = parseNseTimestamp("05-Aug-2026");
    assert.ok(d);
    assert.equal(d.toISOString(), "2026-08-04T18:30:00.000Z");
  });

  it("returns null — never an Invalid Date — for junk", () => {
    // The MONEY-620 class: `new Date("garbage")` is TRUTHY, so a naive parser
    // hands NaN to every getTime() downstream.
    for (const junk of ["garbage", "", "   ", null, undefined, {}, [], NaN]) {
      const out = parseNseTimestamp(junk as unknown);
      assert.equal(out, null, `expected null for ${JSON.stringify(junk)}`);
    }
  });

  it("rejects an unknown month name rather than guessing", () => {
    assert.equal(parseNseTimestamp("05-Zzz-2026 10:00:00"), null);
  });

  it("accepts a finite epoch number", () => {
    const d = parseNseTimestamp(1_754_400_000_000);
    assert.ok(d);
    assert.equal(d.getTime(), 1_754_400_000_000);
  });
});

describe("resolveAttachmentUrl", () => {
  it("passes through an absolute nsearchives URL", () => {
    const url = "https://nsearchives.nseindia.com/corporate/ABC_123.pdf";
    assert.equal(resolveAttachmentUrl(url), url);
  });

  it("absolutises a relative path against the archives host", () => {
    assert.equal(
      resolveAttachmentUrl("/corporate/ABC_123.pdf"),
      "https://nsearchives.nseindia.com/corporate/ABC_123.pdf",
    );
    assert.equal(
      resolveAttachmentUrl("corporate/ABC_123.pdf"),
      "https://nsearchives.nseindia.com/corporate/ABC_123.pdf",
    );
  });

  it("allows other nseindia.com hosts", () => {
    const url = "https://www.nseindia.com/api/x.pdf";
    assert.equal(resolveAttachmentUrl(url), url);
  });

  it("refuses an off-host URL", () => {
    // The value is upstream-controlled text this worker turns into an outbound
    // request from Cloud Run. Anything off nseindia.com is declined.
    assert.equal(resolveAttachmentUrl("https://evil.example.com/x.pdf"), null);
  });

  it("is not fooled by a suffix-lookalike host", () => {
    assert.equal(resolveAttachmentUrl("https://nseindia.com.evil.io/x.pdf"), null);
    assert.equal(resolveAttachmentUrl("https://notnseindia.com/x.pdf"), null);
  });

  it("refuses non-http schemes and empty values", () => {
    assert.equal(resolveAttachmentUrl("javascript:alert(1)"), null);
    assert.equal(resolveAttachmentUrl("file:///etc/passwd"), null);
    assert.equal(resolveAttachmentUrl(""), null);
    assert.equal(resolveAttachmentUrl("   "), null);
    assert.equal(resolveAttachmentUrl(null), null);
    assert.equal(resolveAttachmentUrl(42), null);
  });
});

describe("parseNseAnnouncementRows", () => {
  const row = {
    symbol: " reliance ",
    desc: "Annual Report",
    attchmntText: "Annual Report FY2026",
    attchmntFile: "https://nsearchives.nseindia.com/corporate/RELIANCE.pdf",
    seq_id: 987654,
    sm_name: "Reliance Industries Limited",
    an_dt: "05-Aug-2026 18:14:59",
  };

  it("normalises a bare array", () => {
    const [parsed] = parseNseAnnouncementRows([row]);
    assert.ok(parsed);
    assert.equal(parsed.symbol, "RELIANCE");
    assert.equal(parsed.desc, "Annual Report");
    assert.equal(parsed.attachmentText, "Annual Report FY2026");
    assert.equal(parsed.seqId, "987654");
    assert.equal(parsed.companyName, "Reliance Industries Limited");
    assert.equal(parsed.filedAt?.toISOString(), "2026-08-05T12:44:59.000Z");
  });

  it("accepts a { data: [...] } envelope", () => {
    assert.equal(parseNseAnnouncementRows({ data: [row] }).length, 1);
  });

  it("returns [] for a non-array / null / undefined payload", () => {
    // A shape change must not read as "market holiday, zero filings" by
    // throwing — but it must also not invent rows.
    assert.deepEqual(parseNseAnnouncementRows(null), []);
    assert.deepEqual(parseNseAnnouncementRows(undefined), []);
    assert.deepEqual(parseNseAnnouncementRows("<html>"), []);
    assert.deepEqual(parseNseAnnouncementRows({ rows: [row] }), []);
  });

  it("drops rows with no usable symbol and non-object entries", () => {
    const parsed = parseNseAnnouncementRows([
      row,
      { ...row, symbol: "" },
      { ...row, symbol: 123 },
      null,
      "nope",
    ]);
    assert.equal(parsed.length, 1);
  });

  it("falls back to sort_date when an_dt is unparseable", () => {
    const [parsed] = parseNseAnnouncementRows([
      { ...row, an_dt: "garbage", sort_date: "2026-08-04 09:00:00" },
    ]);
    assert.equal(parsed?.filedAt?.toISOString(), "2026-08-04T03:30:00.000Z");
  });

  it("leaves filedAt null when neither date parses", () => {
    const [parsed] = parseNseAnnouncementRows([
      { ...row, an_dt: "garbage", sort_date: "also garbage" },
    ]);
    assert.equal(parsed?.filedAt, null);
  });

  it("nulls an off-host attachment instead of keeping it", () => {
    const [parsed] = parseNseAnnouncementRows([
      { ...row, attchmntFile: "https://evil.example.com/x.pdf" },
    ]);
    assert.equal(parsed?.attachmentUrl, null);
  });

  it("keeps a string seq_id and nulls a missing one", () => {
    assert.equal(parseNseAnnouncementRows([{ ...row, seq_id: "  55  " }])[0]?.seqId, "55");
    assert.equal(parseNseAnnouncementRows([{ ...row, seq_id: null }])[0]?.seqId, null);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Classification — the ONE rule P5.1 adds on top of categorizeNseAnnouncement
// ══════════════════════════════════════════════════════════════════════

const CONCALL_DESC = "Analysts/Institutional Investor Meet/Con. Call Updates";

describe("classifyNseAnnouncement: the added concall rule", () => {
  it("→ concall_transcript (CONFIRMED) when attchmntText names a Transcript", () => {
    assert.deepEqual(
      classifyNseAnnouncement(CONCALL_DESC, "Transcript of Q1 FY27 Earnings Call"),
      { docType: "concall_transcript", confidence: "confirmed" },
    );
  });

  it("→ earnings_call_intimation (heuristic) without that evidence", () => {
    assert.deepEqual(
      classifyNseAnnouncement(CONCALL_DESC, "Intimation of Q1 FY27 earnings call"),
      { docType: "earnings_call_intimation", confidence: "heuristic" },
    );
  });

  it("matches 'Transcript' case-insensitively", () => {
    for (const text of ["TRANSCRIPT", "transcript", "Audio transcript"]) {
      assert.equal(
        classifyNseAnnouncement(CONCALL_DESC, text)?.docType,
        "concall_transcript",
      );
    }
  });

  it("survives punctuation drift in the subject line", () => {
    // The key is stored normalised precisely so "Con. Call" / "Con Call" /
    // "Analysts /Institutional" cannot silently stop matching.
    for (const desc of [
      "Analysts/Institutional Investor Meet/Con. Call Updates",
      "Analysts / Institutional Investor Meet - Con Call Updates",
      "ANALYSTS/INSTITUTIONAL INVESTOR MEET/CON. CALL UPDATES",
      "Announcement: Analysts/Institutional Investor Meet/Con. Call Updates",
    ]) {
      assert.equal(
        classifyNseAnnouncement(desc, "Transcript")?.docType,
        "concall_transcript",
        `failed for ${desc}`,
      );
    }
  });

  it("BEATS the base categoriser, which calls this an investor_presentation", () => {
    // The regression this rule exists for: the base mapper sees "Investor
    // Meet" and buckets every concall transcript on the exchange as an investor
    // presentation — right PDF, wrong shelf, and the speaker-turn chunker never
    // runs on any of them.
    const viaBase = classifyNseAnnouncement(
      "Investor Meet Presentation",
      "Presentation",
    );
    assert.equal(viaBase?.docType, "investor_presentation");
    assert.equal(
      classifyNseAnnouncement(CONCALL_DESC, "Transcript")?.docType,
      "concall_transcript",
    );
  });

  it("the normalised key is what the rule actually keys on", () => {
    assert.equal(normalizeDesc(CONCALL_DESC), CONCALL_UPDATE_DESC_KEY);
  });
});

describe("classifyNseAnnouncement: delegation to the base categoriser", () => {
  it("keeps every existing bucket, marked heuristic", () => {
    const cases: Array<[string, string, string]> = [
      ["Annual Report 2025-26", "Annual Report", "annual_report"],
      ["Investor Presentation", "Q1 deck", "investor_presentation"],
      ["Credit Rating by CRISIL", "Rating reaffirmed", "credit_rating"],
      ["Press Release", "Media release", "press_release"],
      ["Earnings Call intimation", "Q1 call", "earnings_call_intimation"],
    ];
    for (const [desc, text, expected] of cases) {
      const out = classifyNseAnnouncement(desc, text);
      assert.equal(out?.docType, expected, `docType for "${desc}"`);
      assert.equal(out?.confidence, "heuristic", `confidence for "${desc}"`);
    }
  });

  it("drops noise", () => {
    assert.equal(
      classifyNseAnnouncement("Trading Window Closure", "Closure notice"),
      null,
    );
    assert.equal(classifyNseAnnouncement("", ""), null);
  });

  it("does NOT promote an arbitrary announcement just because a PDF says Transcript", () => {
    // The added rule is scoped to the one NSE subject line. A stray
    // "transcript" elsewhere must not upgrade an unrelated filing to CONFIRMED,
    // because that confidence is what grants dedupe precedence.
    const out = classifyNseAnnouncement("Earnings Call", "Transcript attached");
    assert.equal(out?.docType, "earnings_call_intimation");
    assert.equal(out?.confidence, "heuristic");
  });
});

// ══════════════════════════════════════════════════════════════════════
// period + path helpers
// ══════════════════════════════════════════════════════════════════════

describe("buildAnnouncementPeriod", () => {
  const fallback = { filedAt: new Date("2026-08-05T12:44:59Z"), desc: "Annual Report" };

  it("uses nse-{seq_id} when NSE gives one", () => {
    assert.equal(buildAnnouncementPeriod("987654", fallback), "nse-987654");
  });

  it("strips characters that would break the GCS filename", () => {
    assert.equal(buildAnnouncementPeriod("98/76:54", fallback), "nse-987654");
  });

  it("falls back to an IST date stamp + subject hash", () => {
    const p = buildAnnouncementPeriod(null, fallback);
    assert.match(p, /^nse-20260805-[a-z0-9]+$/);
  });

  it("the fallback is deterministic and subject-sensitive", () => {
    // Deterministic so a re-run upserts in place rather than duplicating; but
    // NOT stable across a reworded subject — which is exactly why seq_id is the
    // primary key and this is only a fallback.
    assert.equal(
      buildAnnouncementPeriod(null, fallback),
      buildAnnouncementPeriod(null, fallback),
    );
    assert.notEqual(
      buildAnnouncementPeriod(null, fallback),
      buildAnnouncementPeriod(null, { ...fallback, desc: "Press Release" }),
    );
  });

  it("handles a missing filing date", () => {
    assert.match(
      buildAnnouncementPeriod(undefined, { filedAt: null, desc: "x" }),
      /^nse-unknown-/,
    );
  });

  it("treats blank/whitespace seq_id as absent", () => {
    assert.match(buildAnnouncementPeriod("   ", fallback), /^nse-20260805-/);
  });
});

describe("splitGcsPath", () => {
  it("splits the stocks/{SYMBOL}/{docType}/ layout", () => {
    assert.deepEqual(
      splitGcsPath("stocks/RELIANCE/concall_transcript/RELIANCE-x.pdf"),
      {
        folder: "stocks/RELIANCE/concall_transcript",
        fileName: "RELIANCE-x.pdf",
      },
    );
  });

  it("handles a bare filename", () => {
    assert.deepEqual(splitGcsPath("x.pdf"), { folder: "", fileName: "x.pdf" });
  });
});

describe("isUsablePdf", () => {
  /** A body of `n` bytes that starts with the given prefix. */
  const body = (prefix: string, n: number): Buffer =>
    Buffer.concat([
      Buffer.from(prefix, "latin1"),
      Buffer.alloc(Math.max(0, n - prefix.length), 0x20),
    ]);

  it("rejects bodies too small to be a PDF", () => {
    assert.equal(isUsablePdf(body("%PDF-1.7", 0)), false);
    assert.equal(isUsablePdf(body("%PDF-1.7", MIN_PDF_BYTES - 1)), false);
    assert.equal(isUsablePdf(body("%PDF-1.7", MIN_PDF_BYTES)), true);
  });

  it("rejects null/undefined without throwing", () => {
    assert.equal(isUsablePdf(null), false);
    assert.equal(isUsablePdf(undefined), false);
  });

  it("REJECTS an Akamai challenge page that clears the size floor", () => {
    // The real failure: NSE answers a throttled client with a 200-carrying
    // HTML challenge of ~3.9KB. Size alone accepted it, so it was stored as
    // application/pdf, upserted as a PENDING StockDocument whose seqId key
    // makes every later run skip it, AND counted as a success that reset the
    // consecutive-failure breaker — disarming the breaker precisely while NSE
    // was throttling.
    const challenge = body(
      "<!DOCTYPE html><html><head><title>Access Denied</title></head><body>",
      3900,
    );
    assert.equal(challenge.length, 3900, "fixture must clear MIN_PDF_BYTES");
    assert.equal(isUsablePdf(challenge), false);
  });

  it("accepts a PDF whose header sits after a short prefix", () => {
    const withJunk = Buffer.concat([
      Buffer.from("\r\n\r\n", "latin1"),
      body("%PDF-1.4", MIN_PDF_BYTES),
    ]);
    assert.equal(isUsablePdf(withJunk), true);
  });

  it("rejects a large body that is simply not a PDF", () => {
    assert.equal(isUsablePdf(body("{\"error\":\"forbidden\"}", 50_000)), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Title similarity
// ══════════════════════════════════════════════════════════════════════

describe("titleSimilarity (token-set Dice)", () => {
  it("scores identical titles 1", () => {
    assert.equal(titleSimilarity("Annual Report 2026", "Annual Report 2026"), 1);
  });

  it("ignores case and punctuation", () => {
    assert.equal(
      titleSimilarity(
        "Financial Results for the Quarter Ended June 30, 2026",
        "FINANCIAL RESULTS FOR THE QUARTER ENDED JUNE 30 2026",
      ),
      1,
    );
  });

  it("ignores word order entirely (set semantics)", () => {
    assert.equal(
      titleSimilarity("Board Meeting Intimation", "Intimation Board Meeting"),
      1,
    );
  });

  it("DOCUMENTED FALSE NEGATIVE: a dropped stop-word costs ~0.14 on a short title", () => {
    // Dice is a ratio, so on a 4-token title one extra word is worth 1/7 —
    // enough to fall under 0.9 and archive a duplicate. This is the measure's
    // known weakness and it is the SAFE direction (a duplicate row, not a
    // suppressed filing). It only bites on very short titles; the exchange
    // subject lines that actually collide are 7-12 tokens, where one word costs
    // ~0.04. Recorded rather than tuned around, so a future threshold change is
    // made with the real number in hand.
    assert.equal(
      titleSimilarity("Intimation of Board Meeting", "Board Meeting Intimation"),
      6 / 7,
    );
    assert.ok(
      titleSimilarity("Intimation of Board Meeting", "Board Meeting Intimation") <
        DEDUPE_TITLE_SIMILARITY_THRESHOLD,
    );

    // The same dropped word on a realistic-length subject stays well above it.
    assert.ok(
      titleSimilarity(
        "Outcome of Board Meeting held on 05 August 2026",
        "Board Meeting Outcome held on 05 August 2026",
      ) >= DEDUPE_TITLE_SIMILARITY_THRESHOLD,
    );
  });

  it("matches the real NSE↔BSE rendering of the same subject", () => {
    // The pair the plural-stripping normalisation exists for: "Analysts" vs
    // "Analyst" alone drags raw Dice to 0.857 and under the threshold.
    const score = titleSimilarity(
      "Analysts/Institutional Investor Meet/Con. Call Updates",
      "Analyst / Institutional Investor Meet - Con Call Update",
    );
    assert.equal(score, 1);
    assert.ok(score >= DEDUPE_TITLE_SIMILARITY_THRESHOLD);
  });

  it("computes Dice exactly at the 0.9 boundary", () => {
    // 10 tokens each, 9 shared → 2*9/(10+10) = 0.9 — the threshold is `>=`.
    const a = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const b = "alpha beta gamma delta epsilon zeta eta theta iota lambda";
    assert.equal(titleSimilarity(a, b), 0.9);
  });

  it("drops below the threshold at 8/10 shared tokens", () => {
    const a = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const b = "alpha beta gamma delta epsilon zeta eta theta mu lambda";
    assert.equal(titleSimilarity(a, b), 0.8);
    assert.ok(titleSimilarity(a, b) < DEDUPE_TITLE_SIMILARITY_THRESHOLD);
  });

  it("separates two genuinely different filings by the same company", () => {
    assert.ok(
      titleSimilarity(
        "Analysts/Institutional Investor Meet/Con. Call Updates",
        "Credit Rating by CRISIL Ratings Limited",
      ) < DEDUPE_TITLE_SIMILARITY_THRESHOLD,
    );
  });

  it("scores an empty title 0 — 'no title' is not 'the same title'", () => {
    // Scoring two empty titles 1 would make an untitled row match everything
    // and suppress the whole day's NSE leg for that symbol.
    assert.equal(titleSimilarity("", ""), 0);
    assert.equal(titleSimilarity("Annual Report", ""), 0);
    assert.equal(titleSimilarity(null, "Annual Report"), 0);
    assert.equal(titleSimilarity("!!! ???", "Annual Report"), 0);
  });

  it("is symmetric", () => {
    const a = "Outcome of Board Meeting held on 05 August 2026";
    const b = "Board Meeting Outcome 05 August 2026";
    assert.equal(titleSimilarity(a, b), titleSimilarity(b, a));
  });

  it("de-duplicates repeated tokens (set semantics)", () => {
    assert.equal(titleSimilarity("report report report", "report"), 1);
  });
});

describe("tokenizeTitle", () => {
  it("lower-cases, splits on non-alphanumerics and de-pluralises", () => {
    assert.deepEqual(tokenizeTitle("Analysts/Institutional Meet - Updates"), [
      "analyst",
      "institutional",
      "meet",
      "update",
    ]);
  });

  it("leaves short tokens and -ss words alone", () => {
    assert.deepEqual(tokenizeTitle("gas loss business is"), [
      "gas",
      "loss",
      "business",
      "is",
    ]);
  });

  it("returns [] for an empty or symbol-only title", () => {
    assert.deepEqual(tokenizeTitle(""), []);
    assert.deepEqual(tokenizeTitle("--- ///"), []);
    assert.deepEqual(tokenizeTitle(undefined), []);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Candidate confidence
// ══════════════════════════════════════════════════════════════════════

describe("deriveCandidateConfidence", () => {
  it("prefers a persisted sourceConfidence when one exists", () => {
    assert.equal(
      deriveCandidateConfidence({
        sourceType: "BSE",
        docType: "corporate_filing",
        sourceConfidence: "heuristic",
      }),
      "heuristic",
    );
    assert.equal(
      deriveCandidateConfidence({
        sourceType: "BSE",
        docType: "concall_transcript",
        sourceConfidence: "confirmed",
      }),
      "confirmed",
    );
  });

  it("derives heuristic for a BSE row carrying a classified docType", () => {
    // bse-announcements-sync writes EVERY row as corporate_filing, so anything
    // more specific on a BSE row came from a title/attachment-name keyword
    // match — the P1-FINDINGS observation, encoded.
    for (const docType of BSE_HEURISTIC_DOC_TYPES) {
      assert.equal(
        deriveCandidateConfidence({ sourceType: "BSE", docType }),
        "heuristic",
        docType,
      );
    }
    assert.equal(
      deriveCandidateConfidence({ sourceType: "bse", docType: "concall_transcript" }),
      "heuristic",
    );
  });

  it("returns 'unknown' — never 'confirmed' — when nothing says so", () => {
    // The fail-open this avoids: defaulting an absent signal to "confirmed"
    // would hand every legacy row a precedence only evidence should earn.
    assert.equal(
      deriveCandidateConfidence({ sourceType: "BSE", docType: "corporate_filing" }),
      "unknown",
    );
    assert.equal(
      deriveCandidateConfidence({ sourceType: "NSE", docType: "concall_transcript" }),
      "unknown",
    );
    assert.equal(
      deriveCandidateConfidence({
        sourceType: "BSE",
        docType: "concall_transcript",
        sourceConfidence: "probably?",
      }),
      "heuristic", // unrecognised string → falls through to derivation
    );
    assert.equal(
      deriveCandidateConfidence({
        sourceType: "SCREENER",
        docType: "annual_report",
        sourceConfidence: null,
      }),
      "unknown",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// The dedupe decision — the piece most likely to silently double-count
// ══════════════════════════════════════════════════════════════════════

const FILED_AT = Date.parse("2026-08-05T12:44:59Z");

function incoming(
  overrides: Partial<IncomingAnnouncement> = {},
): IncomingAnnouncement {
  return {
    symbol: "RELIANCE",
    docType: "earnings_call_intimation",
    title: "Analysts/Institutional Investor Meet/Con. Call Updates",
    fileSize: 245_763,
    filedAtMs: FILED_AT,
    confidence: "heuristic",
    ...overrides,
  };
}

function candidate(overrides: Partial<DedupeCandidate> = {}): DedupeCandidate {
  return {
    id: "bse-row-1",
    symbol: "RELIANCE",
    docType: "earnings_call_intimation",
    title: "Analyst / Institutional Investor Meet - Con Call Update",
    fileSize: 245_763,
    filedAtMs: FILED_AT,
    sourceType: "BSE",
    ...overrides,
  };
}

describe("decideNseAnnouncementDedupe: the three gates", () => {
  it("no candidates → archive", () => {
    assert.deepEqual(decideNseAnnouncementDedupe(incoming(), []), {
      skip: false,
      reason: "no-candidates",
      matchedId: null,
      similarity: null,
    });
  });

  it("all gates pass → SKIP, naming the row it duplicates", () => {
    const decision = decideNseAnnouncementDedupe(incoming(), [candidate()]);
    assert.equal(decision.skip, true);
    assert.equal(decision.reason, "duplicate");
    assert.equal(decision.matchedId, "bse-row-1");
    assert.equal(decision.similarity, 1);
  });

  it("different byte size → archive (different document)", () => {
    const decision = decideNseAnnouncementDedupe(incoming(), [
      candidate({ fileSize: 245_764 }),
    ]);
    assert.equal(decision.skip, false);
    assert.equal(decision.reason, "no-match");
  });

  it("a size-0 candidate is UNKNOWN, not a universal match", () => {
    // The trap: bse-announcements-sync stores `fileSize: 0` on every row whose
    // PDF it failed to fetch. If 0 == 0 counted as equality, one failed BSE row
    // would suppress the NSE copy of every filing that day — worse than the
    // double-count this function exists to prevent.
    const decision = decideNseAnnouncementDedupe(incoming({ fileSize: 0 }), [
      candidate({ fileSize: 0 }),
    ]);
    assert.equal(decision.skip, false);
    assert.equal(decision.reason, "no-match");
  });

  it("an unknown size on EITHER side blocks the match", () => {
    for (const [inSize, candSize] of [
      [null, 245_763],
      [245_763, null],
      [0, 245_763],
      [245_763, 0],
      [Number.NaN, 245_763],
      [-1, 245_763],
    ] as Array<[number | null, number | null]>) {
      const decision = decideNseAnnouncementDedupe(
        incoming({ fileSize: inSize }),
        [candidate({ fileSize: candSize })],
      );
      assert.equal(
        decision.skip,
        false,
        `sizes ${String(inSize)}/${String(candSize)} must not dedupe`,
      );
    }
  });

  it("a low-similarity title blocks the match even at identical byte size", () => {
    const decision = decideNseAnnouncementDedupe(incoming(), [
      candidate({ title: "Credit Rating by CRISIL Ratings Limited" }),
    ]);
    assert.equal(decision.skip, false);
    assert.equal(decision.reason, "no-match");
  });

  it("similarity exactly at the threshold still dedupes (>= not >)", () => {
    const a = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const b = "alpha beta gamma delta epsilon zeta eta theta iota lambda";
    const decision = decideNseAnnouncementDedupe(incoming({ title: a }), [
      candidate({ title: b }),
    ]);
    assert.equal(decision.skip, true);
    assert.equal(decision.similarity, DEDUPE_TITLE_SIMILARITY_THRESHOLD);
  });

  it("a different symbol never matches", () => {
    const decision = decideNseAnnouncementDedupe(incoming(), [
      candidate({ symbol: "TCS" }),
    ]);
    assert.equal(decision.skip, false);
  });
});

describe("decideNseAnnouncementDedupe: the ±1 day window", () => {
  it("matches at the exact boundary", () => {
    for (const delta of [DEDUPE_WINDOW_MS, -DEDUPE_WINDOW_MS]) {
      const decision = decideNseAnnouncementDedupe(incoming(), [
        candidate({ filedAtMs: FILED_AT + delta }),
      ]);
      assert.equal(decision.skip, true, `delta ${delta}`);
    }
  });

  it("does not match one millisecond outside it", () => {
    for (const delta of [DEDUPE_WINDOW_MS + 1, -DEDUPE_WINDOW_MS - 1]) {
      const decision = decideNseAnnouncementDedupe(incoming(), [
        candidate({ filedAtMs: FILED_AT + delta }),
      ]);
      assert.equal(decision.skip, false, `delta ${delta}`);
    }
  });

  it("does not match a filing from a week earlier", () => {
    const decision = decideNseAnnouncementDedupe(incoming(), [
      candidate({ filedAtMs: FILED_AT - 7 * DAY_MS }),
    ]);
    assert.equal(decision.skip, false);
  });
});

describe("decideNseAnnouncementDedupe: heuristic-BSE precedence (P1-FINDINGS)", () => {
  it("a heuristic BSE row IS a valid dedupe target for the same docType", () => {
    // Precedence must not be read as "distrust heuristic rows". The normal case
    // — same filing, same bucket — still dedupes, whatever the confidence.
    const decision = decideNseAnnouncementDedupe(
      incoming({ docType: "concall_transcript", confidence: "confirmed" }),
      [candidate({ docType: "concall_transcript" })],
    );
    assert.equal(decision.skip, true);
    assert.equal(decision.reason, "duplicate");
  });

  it("a CONFIRMED transcript is NOT suppressed by a heuristic intimation of another docType", () => {
    // The whole point: an `earnings_call_intimation` guessed from a BSE title
    // is not the transcript. Skipping here would leave the corpus permanently
    // without the transcript — and the @@unique key differs on docType, so both
    // rows coexist happily.
    const decision = decideNseAnnouncementDedupe(
      incoming({ docType: "concall_transcript", confidence: "confirmed" }),
      [candidate({ docType: "earnings_call_intimation" })],
    );
    assert.equal(decision.skip, false);
    assert.equal(decision.reason, "confirmed-over-heuristic");
    assert.equal(decision.matchedId, "bse-row-1");
    assert.equal(decision.similarity, 1);
  });

  it("a HEURISTIC incoming filing does not get that precedence", () => {
    const decision = decideNseAnnouncementDedupe(
      incoming({ docType: "concall_transcript", confidence: "heuristic" }),
      [candidate({ docType: "earnings_call_intimation" })],
    );
    assert.equal(decision.skip, true);
    assert.equal(decision.reason, "duplicate");
  });

  it("an UNKNOWN-confidence candidate does not license the override", () => {
    // "We could not determine it" is not "we determined it is a guess".
    const decision = decideNseAnnouncementDedupe(
      incoming({ docType: "concall_transcript", confidence: "confirmed" }),
      [candidate({ docType: "corporate_filing" })], // BSE + corporate_filing → unknown
    );
    assert.equal(decision.skip, true);
    assert.equal(decision.reason, "duplicate");
  });

  it("a CONFIRMED candidate of another docType is a real duplicate, not an override", () => {
    const decision = decideNseAnnouncementDedupe(
      incoming({ docType: "concall_transcript", confidence: "confirmed" }),
      [
        candidate({
          docType: "earnings_call_intimation",
          sourceConfidence: "confirmed",
        }),
      ],
    );
    assert.equal(decision.skip, true);
    assert.equal(decision.reason, "duplicate");
  });
});

describe("decideNseAnnouncementDedupe: multiple candidates", () => {
  it("a true same-docType duplicate beats an override, whatever the order", () => {
    // Order independence matters: the candidate list comes from an unordered
    // findMany, so a decision that depended on which row Mongo returned first
    // would be non-deterministic in production and green in a test.
    const dup = candidate({ id: "same-type", docType: "concall_transcript" });
    const override = candidate({
      id: "other-type",
      docType: "earnings_call_intimation",
    });
    const filing = incoming({
      docType: "concall_transcript",
      confidence: "confirmed",
    });

    for (const list of [
      [dup, override],
      [override, dup],
    ]) {
      const decision = decideNseAnnouncementDedupe(filing, list);
      assert.equal(decision.skip, true);
      assert.equal(decision.matchedId, "same-type");
    }
  });

  it("ignores non-matching candidates and finds the one that matches", () => {
    const decision = decideNseAnnouncementDedupe(incoming(), [
      candidate({ id: "wrong-symbol", symbol: "TCS" }),
      candidate({ id: "wrong-size", fileSize: 1 }),
      candidate({ id: "wrong-day", filedAtMs: FILED_AT - 5 * DAY_MS }),
      candidate({ id: "wrong-title", title: "Board Meeting Outcome" }),
      candidate({ id: "the-one" }),
    ]);
    assert.equal(decision.skip, true);
    assert.equal(decision.matchedId, "the-one");
  });

  it("candidates that all miss → archive with reason no-match", () => {
    const decision = decideNseAnnouncementDedupe(incoming(), [
      candidate({ id: "a", fileSize: 1 }),
      candidate({ id: "b", symbol: "TCS" }),
    ]);
    assert.deepEqual(decision, {
      skip: false,
      reason: "no-match",
      matchedId: null,
      similarity: null,
    });
  });

  it("reports the FIRST override when several apply", () => {
    const filing = incoming({
      docType: "concall_transcript",
      confidence: "confirmed",
    });
    const decision = decideNseAnnouncementDedupe(filing, [
      candidate({ id: "first", docType: "earnings_call_intimation" }),
      candidate({ id: "second", docType: "earnings_call_intimation" }),
    ]);
    assert.equal(decision.skip, false);
    assert.equal(decision.matchedId, "first");
  });

  it("does not mutate its inputs", () => {
    const filing = incoming();
    const list = [candidate()];
    const filingCopy = structuredClone(filing);
    const listCopy = structuredClone(list);
    decideNseAnnouncementDedupe(filing, list);
    assert.deepEqual(filing, filingCopy);
    assert.deepEqual(list, listCopy);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Pacing
// ══════════════════════════════════════════════════════════════════════

describe("planPdfDownload", () => {
  it("declines a row with no attachment, at zero cost", () => {
    // delayMs 0 is load-bearing: charging 1.5s to a row we then decline would
    // turn a window full of text-only announcements into a multi-minute no-op
    // that eats the ack deadline doing nothing.
    assert.deepEqual(
      planPdfDownload({ attempted: 0, consecutiveFailures: 0 }, {
        hasAttachment: false,
      }),
      { shouldDownload: false, delayMs: 0, reason: "no-attachment" },
    );
  });

  it("does not pace the FIRST download", () => {
    assert.deepEqual(
      planPdfDownload({ attempted: 0, consecutiveFailures: 0 }, {
        hasAttachment: true,
      }),
      { shouldDownload: true, delayMs: 0, reason: "ok" },
    );
  });

  it("paces every subsequent download", () => {
    const plan = planPdfDownload({ attempted: 1, consecutiveFailures: 0 }, {
      hasAttachment: true,
    });
    assert.deepEqual(plan, {
      shouldDownload: true,
      delayMs: DELAY_BETWEEN_DOWNLOADS_MS,
      reason: "ok",
    });
  });

  it("stops at the per-run cap", () => {
    assert.equal(
      planPdfDownload(
        { attempted: MAX_PDF_DOWNLOADS_PER_RUN - 1, consecutiveFailures: 0 },
        { hasAttachment: true },
      ).shouldDownload,
      true,
    );
    assert.deepEqual(
      planPdfDownload(
        { attempted: MAX_PDF_DOWNLOADS_PER_RUN, consecutiveFailures: 0 },
        { hasAttachment: true },
      ),
      { shouldDownload: false, delayMs: 0, reason: "run-cap" },
    );
  });

  it("opens the circuit after N consecutive failures", () => {
    // NSE has no typed 429 — Akamai answers a throttled client with a
    // 200-carrying challenge page — so only the RUN of failures carries signal.
    assert.equal(
      planPdfDownload(
        {
          attempted: 5,
          consecutiveFailures: DOWNLOAD_FAILURE_BREAKER_THRESHOLD - 1,
        },
        { hasAttachment: true },
      ).shouldDownload,
      true,
    );
    assert.deepEqual(
      planPdfDownload(
        {
          attempted: 5,
          consecutiveFailures: DOWNLOAD_FAILURE_BREAKER_THRESHOLD,
        },
        { hasAttachment: true },
      ),
      { shouldDownload: false, delayMs: 0, reason: "circuit-open" },
    );
  });

  it("reports the breaker ahead of the cap when both apply", () => {
    // Not cosmetic: the two get different log lines and only one of them means
    // "we are being throttled".
    assert.equal(
      planPdfDownload(
        {
          attempted: MAX_PDF_DOWNLOADS_PER_RUN,
          consecutiveFailures: DOWNLOAD_FAILURE_BREAKER_THRESHOLD,
        },
        { hasAttachment: true },
      ).reason,
      "circuit-open",
    );
  });

  it("honours per-call overrides", () => {
    assert.deepEqual(
      planPdfDownload({ attempted: 2, consecutiveFailures: 0 }, {
        hasAttachment: true,
        maxDownloads: 10,
        delayMs: 250,
      }),
      { shouldDownload: true, delayMs: 250, reason: "ok" },
    );
    assert.equal(
      planPdfDownload({ attempted: 0, consecutiveFailures: 2 }, {
        hasAttachment: true,
        breakerThreshold: 2,
      }).reason,
      "circuit-open",
    );
  });
});
