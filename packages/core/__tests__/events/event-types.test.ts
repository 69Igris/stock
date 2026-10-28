/**
 * The `instrument_event` contract — MONEY-1507 (data-platform C1).
 *
 * Every case drives the REAL exports of
 * `packages/core/src/events/event-types.ts`. The properties under test are the
 * ones whose failure is INVISIBLE: an id that is not deterministic makes one
 * 8-K four rows, a severity that reads the wrong item makes a non-reliance
 * filing routine, and an event attached to neither a listing nor an entity sits
 * in the table looking exactly like data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EVENT_MARKETS,
  EVENT_TYPES,
  MAX_SEVERITY,
  SEC_SOURCE,
  TIINGO_NEWS_CONFIDENCE,
  TIINGO_NEWS_SOURCE,
  buildEventId,
  eventTypeForForm,
  instrumentEventSchema,
  normalizeForm,
  secFilingEvent,
  secFilingIndexUrl,
  severityForFiling,
  tiingoNewsEvent,
  tiingoNewsEvents,
} from "../../src/events/event-types";

const OBSERVED = new Date("2026-08-29T02:00:00.000Z");
const ACCEPTED = new Date("2026-08-29T01:53:58.000Z");

describe("buildEventId (MONEY-1507)", () => {
  it("is deterministic — the same source + key is the same id", () => {
    // THE WHOLE IDEMPOTENCY. Four EDGAR detectors converge on one filing: the
    // minutely Atom walk, the hourly EFTS sweep, the nightly submissions
    // ledger, and a Pub/Sub redelivery. Every one must produce this id, or the
    // same 8-K notifies a holder four times.
    assert.equal(
      buildEventId("SEC_EDGAR", "0000320193-26-000106"),
      buildEventId("SEC_EDGAR", "0000320193-26-000106"),
    );
  });

  it("is 40 lowercase hex characters", () => {
    assert.match(buildEventId("SEC_EDGAR", "x"), /^[0-9a-f]{40}$/);
  });

  it("separates on a NUL, so a printable separator cannot be forged", () => {
    // This repo's identifiers legitimately contain `:`, `|`, `/` and `.`
    // (RELIANCE:NSE, 664UP30-SG, BRK.B, 0000320193-26-000106). With any
    // printable separator these two would collide — and a collision does not
    // error, it silently overwrites one event with the other.
    assert.notEqual(buildEventId("A:B", "C"), buildEventId("A", "B:C"));
    assert.notEqual(buildEventId("A/B", "C"), buildEventId("A", "B/C"));
    assert.notEqual(buildEventId("A.B", "C"), buildEventId("A", "B.C"));
    assert.notEqual(buildEventId("A|B", "C"), buildEventId("A", "B|C"));
  });

  it("REFUSES an empty half rather than producing a constant", () => {
    // An empty source key means the producer does not know which record this
    // is about. The id it would produce is the same for every such event, so
    // the Mongo upsert would keep exactly one of them.
    assert.throws(() => buildEventId("", "x"), /required/);
    assert.throws(() => buildEventId("SEC_EDGAR", ""), /required/);
  });
});

describe("eventTypeForForm", () => {
  it("maps the domestic forms", () => {
    assert.equal(eventTypeForForm("10-K"), "FILING_10K");
    assert.equal(eventTypeForForm("10-Q"), "FILING_10Q");
    assert.equal(eventTypeForForm("8-K"), "FILING_8K");
    assert.equal(eventTypeForForm("13F-HR"), "FILING_13F");
  });

  it("maps an AMENDMENT to its base form, not to a type of its own", () => {
    // A consumer filtering FILING_10K that missed every amendment would miss
    // exactly the filings that change an answer.
    assert.equal(eventTypeForForm("10-K/A"), "FILING_10K");
    assert.equal(eventTypeForForm("13F-HR/A"), "FILING_13F");
  });

  it("maps foreign-issuer equivalents onto the domestic type", () => {
    // Otherwise a consumer's coverage silently depends on where the issuer is
    // domiciled.
    assert.equal(eventTypeForForm("20-F"), "FILING_10K");
    assert.equal(eventTypeForForm("40-F"), "FILING_10K");
    assert.equal(eventTypeForForm("6-K"), "FILING_8K");
  });

  it("matches the single-character ownership forms EXACTLY, not by prefix", () => {
    // `424B3` is a real SEC form (a prospectus supplement) and it starts with
    // "4". Under a bare `startsWith` it becomes an INSIDER_TXN — an ownership
    // event on a filing that reports no ownership at all, at severity 1, on a
    // held listing.
    //
    // MEASURED, not assumed: this case was written after the mutation
    // `prefix.length <= 2 ? base === prefix : base.startsWith(prefix)` ->
    // `base.startsWith(prefix)` left the whole suite GREEN. The 40-F assertion
    // below survives that mutation because the LIST happens to put "40-F"
    // ahead of "4" — which is exactly the order-dependence the rule exists to
    // remove, and a test that only checks 40-F is checking the ordering rather
    // than the rule.
    assert.equal(eventTypeForForm("424B3"), "FILING_OTHER");
    assert.equal(eventTypeForForm("3ABC"), "FILING_OTHER");
    assert.equal(eventTypeForForm("40-F"), "FILING_10K");
    assert.equal(eventTypeForForm("4"), "INSIDER_TXN");
    assert.equal(eventTypeForForm("3"), "INSIDER_TXN");
  });

  it("handles both SC 13D spellings, which straddle the Dec-2024 mandate", () => {
    assert.equal(eventTypeForForm("SC 13D"), "OWNERSHIP_13D_G");
    assert.equal(eventTypeForForm("SCHEDULE 13G"), "OWNERSHIP_13D_G");
  });

  it("falls back to FILING_OTHER rather than throwing", () => {
    assert.equal(eventTypeForForm("144"), "FILING_OTHER");
    assert.equal(eventTypeForForm("ABS-EE"), "FILING_OTHER");
  });

  it("normalizeForm upper-cases and strips /A", () => {
    assert.equal(normalizeForm(" sc 13d/a "), "SC 13D");
  });
});

describe("severityForFiling", () => {
  it("baselines an 8-K at 1, below C4's alert floor", () => {
    // SEC's 8-K covers everything from a results release to a change of fiscal
    // year. Treating the whole form as material puts the alert floor under the
    // noisiest form EDGAR has.
    assert.equal(severityForFiling("8-K", []), 1);
  });

  it("raises 1.01 / 2.02 / 5.02 to 2", () => {
    assert.equal(severityForFiling("8-K", ["1.01"]), 2);
    assert.equal(severityForFiling("8-K", ["2.02"]), 2);
    assert.equal(severityForFiling("8-K", ["5.02"]), 2);
  });

  it("raises 4.01 / 4.02 to 3 — the numbers may be wrong", () => {
    assert.equal(severityForFiling("8-K", ["4.01"]), 3);
    assert.equal(severityForFiling("8-K", ["4.02"]), 3);
  });

  it("takes the MAXIMUM item, not the first or the last", () => {
    // An 8-K carrying both 2.02 and 4.02 is a non-reliance filing. Taking the
    // first or the last makes the answer depend on the order EDGAR listed them.
    assert.equal(severityForFiling("8-K", ["2.02", "4.02"]), 3);
    assert.equal(severityForFiling("8-K", ["4.02", "2.02"]), 3);
  });

  it("reads a DECORATED item spelling, not just the bare code", () => {
    // The daily index and EFTS spell the same item three ways. An exact-string
    // map matches none of the decorated ones and reports every 8-K as routine —
    // the `application/pdf;charset=UTF-8` class (MONEY-1255).
    assert.equal(severityForFiling("8-K", ["Item 4.02"]), 3);
    assert.equal(severityForFiling("8-K", ["2.02 Results of Operations"]), 2);
  });

  it("ignores items on a form that does not carry them", () => {
    assert.equal(severityForFiling("10-K", ["4.02"]), 2);
  });

  it("never exceeds the declared ceiling", () => {
    for (const form of ["8-K", "10-K", "4", "144", "SC 13D"]) {
      const s = severityForFiling(form, ["4.02", "2.02"]);
      assert.ok(s >= 0 && s <= MAX_SEVERITY, `${form} -> ${s}`);
    }
  });
});

describe("secFilingIndexUrl", () => {
  it("UNPADS the cik for the Archives path and spells the accession twice", () => {
    // The JSON and bulk paths take the padded form and the Archives path takes
    // the integer. Either mistake is a 404 only a human clicking would notice.
    assert.equal(
      secFilingIndexUrl("0000320193", "0000320193-26-000106"),
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000106/0000320193-26-000106-index.htm",
    );
  });
});

describe("secFilingEvent", () => {
  const facts = {
    accession: "0000320193-26-000106",
    cik10: "0000320193",
    form: "8-K",
    items: ["2.02"],
    acceptedAt: ACCEPTED,
    filedAt: new Date("2026-08-30T00:00:00.000Z"),
    listingId: "AAPL:NASDAQ:1980-12-12",
    entityName: "Apple Inc.",
  };

  it("produces a valid event whose id is derived from the accession", () => {
    const event = secFilingEvent(facts, OBSERVED);
    assert.equal(event.eventId, buildEventId(SEC_SOURCE, facts.accession));
    assert.equal(event.sourceRecordKey, facts.accession);
    assert.equal(event.eventType, "FILING_8K");
    assert.equal(event.severity, 2);
    assert.equal(event.market, "US");
  });

  it("prefers ACCEPTANCE over the filing date for publishedAt", () => {
    // A filing accepted at 21:53 ET is DATED the next business day, so the
    // filing date runs AHEAD of the clock and a sort on it interleaves two
    // evenings.
    const event = secFilingEvent(facts, OBSERVED);
    assert.equal(event.publishedAt?.toISOString(), ACCEPTED.toISOString());
  });

  it("falls back to the filing date when SEC gave no acceptance instant", () => {
    const event = secFilingEvent({ ...facts, acceptedAt: null }, OBSERVED);
    assert.equal(event.publishedAt?.toISOString(), "2026-08-30T00:00:00.000Z");
  });

  it("keeps an UNMAPPED filer as a real event, at lower confidence", () => {
    // A fund manager filing 13F, a private filer, an issuer listed this
    // morning. Dropping them shrinks the corpus with nothing to measure the
    // loss against; C3's linkers fill listingId in later.
    const event = secFilingEvent({ ...facts, listingId: null }, OBSERVED);
    assert.equal(event.listingId, null);
    assert.equal(event.entityId, "0000320193");
    assert.equal(event.confidence, 0.5);
  });

  it("scores an exact CIK join at 1.0", () => {
    assert.equal(secFilingEvent(facts, OBSERVED).confidence, 1);
  });

  it("tags the form, the items and the amendment", () => {
    const event = secFilingEvent(
      { ...facts, form: "8-K/A", items: ["Item 2.02", "9.01"] },
      OBSERVED,
    );
    assert.deepEqual(event.tags, [
      "form:8-K/A",
      "item:2.02",
      "item:9.01",
      "amendment",
    ]);
  });

  it("stamps the OBSERVED instant the caller supplies, not the wall clock", () => {
    assert.equal(
      secFilingEvent(facts, OBSERVED).observedAt.getTime(),
      OBSERVED.getTime(),
    );
  });
});

describe("tiingoNewsEvent", () => {
  const facts = {
    articleId: "12345",
    title: "Apple beats on revenue",
    url: "https://example.test/a",
    publishedAt: ACCEPTED,
    listingId: "AAPL:NASDAQ:1980-12-12",
  };

  it("keys on (article, listing) so one article tagged twice is TWO events", () => {
    // Keying on the article alone would make them one row whose listingId is
    // whichever arrived last — and a holder of the other one is never alerted.
    const a = tiingoNewsEvent(facts, OBSERVED);
    const b = tiingoNewsEvent(
      { ...facts, listingId: "MSFT:NASDAQ:1986-03-13" },
      OBSERVED,
    );
    assert.notEqual(a.eventId, b.eventId);
    assert.equal(a.source, TIINGO_NEWS_SOURCE);
  });

  it("fans one article out to one event per RESOLVED listing", () => {
    const map = new Map([
      ["AAPL", "AAPL:NASDAQ:1980-12-12"],
      ["MSFT", "MSFT:NASDAQ:1986-03-13"],
    ]);
    const events = tiingoNewsEvents(
      {
        tiingoId: 12345,
        title: "Two companies do a thing",
        url: "https://example.test/a",
        description: "snippet",
        publishedAt: ACCEPTED,
        tickers: ["AAPL", "MSFT"],
      },
      map,
      OBSERVED,
    );
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.listingId).sort(), [
      "AAPL:NASDAQ:1980-12-12",
      "MSFT:NASDAQ:1986-03-13",
    ]);
  });

  it("SKIPS a ticker the master does not carry rather than inventing one", () => {
    // The poller has already dropped it from the stored row; deciding it again
    // here would put the rule in two places.
    const events = tiingoNewsEvents(
      { tiingoId: 1, title: "t", tickers: ["AAPL", "NOPE"] },
      new Map([["AAPL", "AAPL:NASDAQ:1980-12-12"]]),
      OBSERVED,
    );
    assert.equal(events.length, 1);
  });

  it("DEDUPES on the resolved listing, not on the ticker", () => {
    // Tiingo repeats tickers inside one article's array (79 of 200 market-wide
    // rows, measured), and two tickers can resolve to one listing. A duplicate
    // would be two identical upserts of one event_id inside one run.
    const events = tiingoNewsEvents(
      { tiingoId: 1, title: "t", tickers: ["AAPL", "aapl", "AAPL"] },
      new Map([["AAPL", "AAPL:NASDAQ:1980-12-12"]]),
      OBSERVED,
    );
    assert.equal(events.length, 1);
  });

  it("returns nothing when no ticker resolves — never a half-formed event", () => {
    assert.deepEqual(
      tiingoNewsEvents(
        { tiingoId: 1, title: "t", tickers: ["NOPE"] },
        new Map(),
        OBSERVED,
      ),
      [],
    );
  });

  it("never crosses C4's alert floor on a vendor tag alone", () => {
    // severity 2 is alertable. Until C3's precision gate passes, an alertable
    // NEWS event would page a user about a company that merely shares a name.
    assert.equal(tiingoNewsEvent(facts, OBSERVED).severity, 1);
    assert.equal(
      tiingoNewsEvent(facts, OBSERVED).confidence,
      TIINGO_NEWS_CONFIDENCE,
    );
  });
});

describe("instrumentEventSchema", () => {
  const valid = () =>
    secFilingEvent(
      {
        accession: "0000320193-26-000106",
        cik10: "0000320193",
        form: "8-K",
        listingId: "AAPL:NASDAQ:1980-12-12",
      },
      OBSERVED,
    );

  it("REFUSES an event attached to neither a listing nor an entity", () => {
    assert.throws(
      () =>
        instrumentEventSchema.parse({
          ...valid(),
          listingId: null,
          entityId: null,
        }),
      /listingId or an entityId/,
    );
  });

  it("REFUSES a hand-set event id", () => {
    // The id is DERIVED. A chosen one breaks the four-detector convergence and
    // nothing downstream can tell.
    assert.throws(
      () =>
        instrumentEventSchema.parse({ ...valid(), eventId: "0".repeat(40) }),
      /DERIVED/,
    );
  });

  it("REFUSES an out-of-range severity and a non-integer one", () => {
    assert.throws(() =>
      instrumentEventSchema.parse({ ...valid(), severity: 4 }),
    );
    assert.throws(() =>
      instrumentEventSchema.parse({ ...valid(), severity: 1.5 }),
    );
  });

  it("REFUSES an unknown event type — the vocabulary is closed here", () => {
    // BigQuery has no ENUM, so this schema is the only thing that closes it. An
    // undeclared type reaches every consumer's switch as a silent default.
    assert.throws(() =>
      instrumentEventSchema.parse({ ...valid(), eventType: "MADE_UP" }),
    );
  });

  it("REFUSES an unknown key rather than dropping it", () => {
    assert.throws(() => instrumentEventSchema.parse({ ...valid(), extra: 1 }));
  });

  it("REFUSES a confidence outside 0..1", () => {
    assert.throws(() =>
      instrumentEventSchema.parse({ ...valid(), confidence: 1.5 }),
    );
  });
});

describe("[control] the declared vocabularies", () => {
  it("markets are exactly US and IN", () => {
    assert.deepEqual([...EVENT_MARKETS], ["US", "IN"]);
  });

  it("every event type the SEC mapper can emit is in EVENT_TYPES", () => {
    // A form the mapper routes to a type nobody declared would fail the schema
    // at run time, on a real filing, in production.
    const forms = ["10-K", "10-Q", "8-K", "13F-HR", "SC 13D", "4", "144"];
    for (const form of forms) {
      assert.ok(
        (EVENT_TYPES as readonly string[]).includes(eventTypeForForm(form)),
        form,
      );
    }
  });
});
