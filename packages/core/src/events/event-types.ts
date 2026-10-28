/**
 * `instrument_event` — the contract. MONEY-1507 (data-platform C1).
 *
 * One shape for "something happened to a security", produced by several
 * producers (SEC EDGAR and the Tiingo news poll today; the news bridge and the
 * exchange filings lanes in C3) and read by several consumers (the alert
 * evaluator, chart marks, the events tab, the research lake tool in C5).
 *
 * PURE. No Prisma, no Pub/Sub, no BigQuery, no clock. The Mongo projection is
 * `packages/services/src/events.service.ts`, the silver table is
 * `packages/lake/ddl/008_silver_instrument_event.sql`, and both are written
 * against this file rather than restating it.
 *
 * ## THE EVENT ID IS DETERMINISTIC, AND THAT IS THE IDEMPOTENCY
 *
 * `sha1(source + NUL + source_record_key)`. Four things converge on one filing
 * in this repo — the minutely Atom walk, the hourly EFTS sweep, the nightly
 * `submissions.zip` ledger and a Pub/Sub redelivery — and every one of them
 * must produce the SAME event id so the Mongo upsert collapses them.
 *
 * A random id, or one carrying a timestamp, would make each of those a separate
 * row: the same 8-K notified four times, and the `supersedes_event_id` chain
 * impossible to follow. The enrichment pass (`UsFilingInsight`) deliberately
 * re-derives the SAME id so its summary UPDATES the row rather than adding one.
 *
 * The separator is a NUL for the reason `ledger-logic.ts` gives about its own
 * five-part key: this repo's identifiers legitimately contain `:`, `|`, `/` and
 * `.` (`RELIANCE:NSE`, `664UP30-SG`, `BRK.B`, `0000320193-26-000106`), so any
 * printable separator can itself be produced by a source key and collapse two
 * distinct events onto one id. A collision here does not error — it silently
 * overwrites.
 *
 * SHA-1 rather than SHA-256 because this is an identity, not a signature: there
 * is no adversary choosing source record keys, and 40 hex characters index
 * better than 64. Stated so the next reader does not "upgrade" it and orphan
 * every stored row.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

/** Bumped when the MEANING of a produced field changes, not when code moves. */
export const EVENT_CONTRACT_VERSION = "instrument-event-v1";

/** NUL. Named so the two producers and the tests cannot spell it differently. */
const KEY_SEPARATOR = "\u0000";

/** Markets. A COLUMN, never a second dataset (lake-layout.md §4). */
export const EVENT_MARKETS = ["US", "IN"] as const;
export type EventMarket = (typeof EVENT_MARKETS)[number];

/**
 * The closed event vocabulary.
 *
 * BigQuery has no ENUM type, so this list is the only thing that closes it —
 * the DDL stores a STRING and the refusal happens here, on write. Adding a
 * member is a deliberate edit to an exported constant that a test pins, which
 * is the point: an event type nobody declared reaches every consumer's `switch`
 * as a silent default branch.
 */
export const EVENT_TYPES = [
  "FILING_8K",
  "FILING_10Q",
  "FILING_10K",
  "FILING_13F",
  "FILING_OTHER",
  "INSIDER_TXN",
  "OWNERSHIP_13D_G",
  "NEWS",
  "CORP_ACTION",
  "RESULT",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Severity, 0-3. A PRODUCT ranking, not a legal one.
 *
 *   0  informational - routine, never alerts
 *   1  notable       - shows on the events tab and the chart
 *   2  material      - alertable (C4's HOLDING_EVENT floor)
 *   3  critical      - auditor change / non-reliance; alert regardless of prefs
 */
export const MIN_SEVERITY = 0;
export const MAX_SEVERITY = 3;

/**
 * `sha1(source NUL source_record_key)`, lowercase hex.
 *
 * Both halves are required and neither may be empty: an empty source key means
 * the producer does not actually know which record this is about, and the id it
 * would produce is a constant that every such event collides on.
 */
export function buildEventId(source: string, sourceRecordKey: string): string {
  if (!source || !sourceRecordKey) {
    throw new Error(
      "buildEventId: source and sourceRecordKey are both required, got " +
        `${JSON.stringify(source)} / ${JSON.stringify(sourceRecordKey)}. An ` +
        "empty half makes the id a constant that every such event collides " +
        "on, and the Mongo upsert would then keep exactly one of them.",
    );
  }
  return createHash("sha1")
    .update(`${source}${KEY_SEPARATOR}${sourceRecordKey}`, "utf8")
    .digest("hex");
}

/**
 * The event.
 *
 * `listingId` and `entityId` are BOTH optional and at least one is required —
 * see the refinement. An event about a filer we cannot yet map to a listing is
 * still a real event (a newly-listed issuer, a private filer, a fund manager):
 * dropping it would silently shrink the corpus, and C3's linkers exist
 * precisely to fill `listingId` in later.
 *
 * `publishedAt` is the SOURCE's clock (EDGAR acceptance, the wire's timestamp)
 * and `observedAt` is ours. lake-layout.md §6: point-in-time correctness is
 * `observed_at`, never `ingested_at`, and the two must not be conflated — a
 * filing accepted at 21:53 ET is DATED the next business day, so a consumer
 * that treated the filing date as the observation clock would order the evening
 * peak wrongly every day.
 */
export const instrumentEventSchema = z
  .object({
    eventId: z.string().regex(/^[0-9a-f]{40}$/, "eventId must be sha1 hex"),
    market: z.enum(EVENT_MARKETS),
    listingId: z.string().min(1).nullable().optional(),
    /** `cik10` for SEC, a scrip code / ISIN for India — whatever identifies the FILER. */
    entityId: z.string().min(1).nullable().optional(),
    eventType: z.enum(EVENT_TYPES),
    severity: z.number().int().min(MIN_SEVERITY).max(MAX_SEVERITY),
    title: z.string().min(1),
    summary: z.string().nullable().optional(),
    evidenceUri: z.string().min(1).nullable().optional(),
    source: z.string().min(1),
    sourceRecordKey: z.string().min(1),
    publishedAt: z.date().nullable().optional(),
    observedAt: z.date(),
    linkerVersion: z.string().min(1),
    confidence: z.number().min(0).max(1),
    tags: z.array(z.string().min(1)).default([]),
    /** Corrections are NEW ROWS in silver; this is the back-pointer. */
    supersedesEventId: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable()
      .optional(),
    /** Set by the insight sweep's UPDATE event; absent on the first emission. */
    enrichedAt: z.date().nullable().optional(),
  })
  .strict()
  .refine((e) => Boolean(e.listingId) || Boolean(e.entityId), {
    message:
      "an event must name a listingId or an entityId — an event attached to " +
      "neither can never be retrieved by any consumer, and would sit in the " +
      "table looking like data",
  })
  .refine((e) => e.eventId === buildEventId(e.source, e.sourceRecordKey), {
    message:
      "eventId is not sha1(source NUL sourceRecordKey). It is DERIVED, never " +
      "chosen: a hand-set id breaks the four-detector convergence the id " +
      "exists for, and nothing downstream can tell.",
  });

export type InstrumentEvent = z.infer<typeof instrumentEventSchema>;

/* ─────────────────────────────────────────────────────────────────────────
   SEC: form -> event type, and (form, items) -> severity
   ──────────────────────────────────────────────────────────────────────── */

/** The one `source` value the EDGAR producer writes. Matches `UsFiling.source`. */
export const SEC_SOURCE = "SEC_EDGAR";

/** Bumped when the mapping below changes what it emits for the same filing. */
export const SEC_LINKER_VERSION = "sec-exact-v1";

/**
 * SEC form -> event type.
 *
 * Amendments map to their BASE form (`10-K/A` -> FILING_10K) rather than to a
 * type of their own: a restatement is the same KIND of event, and a consumer
 * filtering `FILING_10K` that missed every amendment would miss exactly the
 * filings that change an answer. The amendment survives as a `tags` entry, so
 * the distinction is kept without splitting the vocabulary.
 *
 * 20-F / 40-F / 6-K are foreign-issuer equivalents and map to the domestic type
 * a consumer already handles — a US-listed foreign issuer's annual report is an
 * annual report, and giving it its own type would make every consumer's
 * coverage silently depend on where the issuer is domiciled.
 */
const SEC_FORM_EVENT_TYPE: readonly (readonly [string, EventType])[] = [
  ["10-K", "FILING_10K"],
  ["20-F", "FILING_10K"],
  ["40-F", "FILING_10K"],
  ["10-Q", "FILING_10Q"],
  ["8-K", "FILING_8K"],
  ["6-K", "FILING_8K"],
  ["13F-HR", "FILING_13F"],
  ["13F-NT", "FILING_13F"],
  ["SC 13D", "OWNERSHIP_13D_G"],
  ["SC 13G", "OWNERSHIP_13D_G"],
  ["SCHEDULE 13D", "OWNERSHIP_13D_G"],
  ["SCHEDULE 13G", "OWNERSHIP_13D_G"],
  ["3", "INSIDER_TXN"],
  ["4", "INSIDER_TXN"],
  ["5", "INSIDER_TXN"],
];

/** `10-K/A` -> `10-K`; `sc 13d` -> `SC 13D`. */
export function normalizeForm(form: string): string {
  return form.trim().toUpperCase().replace(/\/A$/, "");
}

export function eventTypeForForm(form: string): EventType {
  const base = normalizeForm(form);
  for (const [prefix, type] of SEC_FORM_EVENT_TYPE) {
    // EXACT for the single-character ownership forms, PREFIX otherwise.
    //
    // A bare `startsWith` would map "40-F" onto "4" (INSIDER_TXN). The list is
    // ordered so 40-F is seen first, but relying on ORDER for correctness is
    // how a later alphabetical tidy-up silently reclassifies an annual report
    // as an insider transaction.
    if (prefix.length <= 2 ? base === prefix : base.startsWith(prefix)) {
      return type;
    }
  }
  return "FILING_OTHER";
}

/**
 * 8-K item numbers that carry a severity above the form's baseline.
 *
 * From the C1 brief, and each is a decision a holder would want told about on
 * the day rather than at the quarter:
 *
 *   1.01  entry into a material definitive agreement
 *   2.02  results of operations — the earnings release itself
 *   5.02  departure/appointment of directors or principal officers
 *   4.01  change in the registrant's certifying ACCOUNTANT
 *   4.02  non-reliance on previously issued financial statements
 *
 * 4.01 and 4.02 are 3 rather than 2 because both say the NUMBERS may be wrong,
 * which invalidates every derived table a user is looking at; the others say
 * something happened to the business.
 */
const EIGHTK_ITEM_SEVERITY: Readonly<Record<string, 2 | 3>> = {
  "1.01": 2,
  "2.02": 2,
  "5.02": 2,
  "4.01": 3,
  "4.02": 3,
};

/**
 * Baseline severity by event type, before 8-K items are considered.
 *
 * `FILING_8K` deliberately baselines at 1, not 2: SEC's 8-K covers everything
 * from a results release to a change of fiscal year, and treating the whole
 * form as material would put C4's alert floor (severity >= 2) under the
 * noisiest form EDGAR has. The ITEMS are what raise it.
 */
const BASE_SEVERITY: Readonly<Record<EventType, number>> = {
  FILING_10K: 2,
  FILING_10Q: 2,
  FILING_8K: 1,
  FILING_13F: 1,
  FILING_OTHER: 0,
  INSIDER_TXN: 1,
  OWNERSHIP_13D_G: 2,
  NEWS: 1,
  CORP_ACTION: 2,
  RESULT: 2,
};

/** `"Item 2.02 Results of Operations"` -> `"2.02"`; anything else -> null. */
function itemCode(raw: string): string | null {
  return /(\d+\.\d+)/.exec(raw)?.[1] ?? null;
}

/**
 * Severity for a SEC filing.
 *
 * `items` is EDGAR's own item list off the filing row. It is normalised before
 * lookup because the daily index and EFTS spell the same item differently —
 * `"2.02"`, `"Item 2.02"`, `"2.02 Results of Operations"` — and an exact-string
 * map would match none of the decorated spellings and report every 8-K as
 * routine. Same class as the `mimeType: "application/pdf"` exact match that
 * never matched `application/pdf;charset=UTF-8` (MONEY-1255).
 *
 * The MAXIMUM item wins. An 8-K carrying both 2.02 and 4.02 is a non-reliance
 * filing; taking the first or the last would make the answer depend on the
 * order EDGAR happened to list them in.
 */
export function severityForFiling(
  form: string,
  items: readonly string[] = [],
): number {
  const type = eventTypeForForm(form);
  let severity = BASE_SEVERITY[type];
  if (type === "FILING_8K") {
    for (const raw of items) {
      const code = itemCode(raw);
      const bump = code ? EIGHTK_ITEM_SEVERITY[code] : undefined;
      if (bump !== undefined && bump > severity) severity = bump;
    }
  }
  return severity;
}

/* ─────────────────────────────────────────────────────────────────────────
   SEC: a filing -> an event
   ──────────────────────────────────────────────────────────────────────── */

export interface SecFilingFacts {
  accession: string;
  cik10: string;
  form: string;
  items?: readonly string[];
  /** EDGAR's acceptance instant. NOT the filing date — see `publishedAt` below. */
  acceptedAt?: Date | null;
  filedAt?: Date | null;
  /** Resolved by the I/O shell from `UsInstrument.cik`; null when unmapped. */
  listingId?: string | null;
  /** Company name, when the shell could resolve one. Used only for the title. */
  entityName?: string | null;
  // NO `summary` / `enrichedAt`. A SEC event is created without one, and the
  // 8-K insight sweep adds it later through `enrichEvent` — a PARTIAL update of
  // exactly those two columns. Accepting them here would offer a second way to
  // write them, through a builder whose caller (`us_filing_documents`) has no
  // `acceptedAt` and would therefore downgrade `publishedAt` on every enriched
  // row. They stay on the EVENT, which is what `enrichEvent` writes.
}

/**
 * EDGAR's canonical URL for a filing's index page.
 *
 * `cik10` is zero-padded for the JSON and bulk paths but the Archives path
 * takes the UNPADDED integer, and the accession appears twice — once undashed
 * as the directory, once dashed as the file. Getting either wrong produces a
 * 404 that only a human clicking the link would ever notice.
 */
export function secFilingIndexUrl(cik10: string, accession: string): string {
  const cik = String(Number(cik10));
  const undashed = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${undashed}/${accession}-index.htm`;
}

/**
 * Build the event for one SEC filing. PURE — the caller supplies the clock.
 *
 * `observedAt` is a PARAMETER rather than `new Date()` for the reason every
 * `*-logic.ts` in this repo takes one: a function that reads the clock cannot
 * be tested for the boundary that matters, and the four detectors must stamp
 * the instant THEY saw the filing rather than the instant this function ran.
 */
export function secFilingEvent(
  facts: SecFilingFacts,
  observedAt: Date,
): InstrumentEvent {
  const form = facts.form.trim().toUpperCase();
  const items = facts.items ?? [];
  const name = facts.entityName?.trim();
  const isAmendment = /\/A$/.test(form);

  const tags = [
    `form:${form}`,
    ...items
      .map(itemCode)
      .filter((c): c is string => Boolean(c))
      .map((c) => `item:${c}`),
    ...(isAmendment ? ["amendment"] : []),
  ];

  return instrumentEventSchema.parse({
    eventId: buildEventId(SEC_SOURCE, facts.accession),
    market: "US",
    listingId: facts.listingId ?? null,
    entityId: facts.cik10,
    eventType: eventTypeForForm(form),
    severity: severityForFiling(form, items),
    title: `${name ? `${name} — ` : ""}${form}`,
    summary: null,
    evidenceUri: secFilingIndexUrl(facts.cik10, facts.accession),
    source: SEC_SOURCE,
    // The ACCESSION, which is SEC's own primary key for a filing. This is what
    // makes the id stable across all four detectors and across a reparse.
    sourceRecordKey: facts.accession,
    // ACCEPTANCE, falling back to the filing DATE. `acceptedAt` is the only one
    // of the two that can order the evening peak: a filing accepted at 21:53 ET
    // is DATED the next business day, so the filing date runs ahead of the
    // clock and a sort on it interleaves two evenings.
    publishedAt: facts.acceptedAt ?? facts.filedAt ?? null,
    observedAt,
    linkerVersion: SEC_LINKER_VERSION,
    // 1.0 when a listing was resolved from `UsInstrument.cik` (an exact join on
    // SEC's own key), 0.5 when it was not — the event is still true about the
    // FILER, and the confidence says the SECURITY attribution is missing rather
    // than wrong.
    confidence: facts.listingId ? 1 : 0.5,
    tags,
    enrichedAt: null,
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   Tiingo news
   ──────────────────────────────────────────────────────────────────────── */

export const TIINGO_NEWS_SOURCE = "TIINGO_NEWS";

/**
 * Tiingo supplies the tickers itself, so this is exact-ISH and says so.
 *
 * 0.8, not 1.0: the vendor's tagging is good and is not ours to verify, and
 * C3's press linker will produce competing candidates at its own confidence. A
 * vendor tag recorded at 1.0 would outrank an adjudicated match.
 */
export const TIINGO_NEWS_LINKER_VERSION = "tiingo-tags-v1";
export const TIINGO_NEWS_CONFIDENCE = 0.8;

export interface TiingoNewsFacts {
  /** Tiingo's own article id — half of the `source_record_key`. */
  articleId: string;
  title: string;
  url?: string | null;
  publishedAt?: Date | null;
  /** The resolved listing. ONE event per (article, listing) — see below. */
  listingId: string;
  summary?: string | null;
  tags?: readonly string[];
}

/**
 * One NEWS event per (article, listing).
 *
 * The `source_record_key` carries BOTH, and that is deliberate: one article
 * tagged with four tickers is four events, and keying on the article alone
 * would make them one row whose `listingId` is whichever arrived last. The four
 * are genuinely four facts — a holder of one of them must be alerted whether or
 * not a holder of another was.
 */
export function tiingoNewsEvent(
  facts: TiingoNewsFacts,
  observedAt: Date,
): InstrumentEvent {
  const sourceRecordKey = `${facts.articleId}${KEY_SEPARATOR}${facts.listingId}`;
  return instrumentEventSchema.parse({
    eventId: buildEventId(TIINGO_NEWS_SOURCE, sourceRecordKey),
    market: "US",
    listingId: facts.listingId,
    entityId: null,
    eventType: "NEWS",
    // 1, never 2. News never crosses C4's alert floor on a vendor tag alone:
    // the precision gate in C3 is what earns that, and until it passes an
    // alertable NEWS event would page a user about a company that merely shares
    // a name with the one they hold.
    severity: 1,
    title: facts.title.trim(),
    summary: facts.summary ?? null,
    evidenceUri: facts.url ?? null,
    source: TIINGO_NEWS_SOURCE,
    sourceRecordKey,
    publishedAt: facts.publishedAt ?? null,
    observedAt,
    linkerVersion: TIINGO_NEWS_LINKER_VERSION,
    confidence: TIINGO_NEWS_CONFIDENCE,
    tags: [...(facts.tags ?? [])],
  });
}

/** One stored `us_news_articles` row, as the fan-out below reads it. */
export interface TiingoNewsArticleFacts {
  tiingoId: number | string;
  title: string;
  url?: string | null;
  description?: string | null;
  publishedAt?: Date | null;
  /** The tickers that already RESOLVED against our master. */
  tickers: readonly string[];
  tags?: readonly string[];
}

/**
 * Fan one stored article out to one event per listing it names.
 *
 * `symbolToListing` is the SAME map the poller already builds to validate the
 * article's tickers — so a symbol absent from it is one our master does not
 * carry, which the poller has already dropped from the stored row. Skipping
 * here rather than throwing keeps that decision in ONE place: this function
 * must never be the thing that decides whether a ticker is real.
 *
 * DEDUPED on the resolved listing, not on the ticker. Tiingo repeats tickers
 * inside one article's array (measured: 79 of 200 market-wide rows), and two
 * different tickers can legitimately resolve to one listing — a duplicate would
 * be two identical upserts of one `event_id` inside one run.
 */
export function tiingoNewsEvents(
  article: TiingoNewsArticleFacts,
  symbolToListing: ReadonlyMap<string, string>,
  observedAt: Date,
): InstrumentEvent[] {
  const seen = new Set<string>();
  const events: InstrumentEvent[] = [];
  for (const ticker of article.tickers) {
    const listingId = symbolToListing.get(ticker.toUpperCase());
    if (!listingId || seen.has(listingId)) continue;
    seen.add(listingId);
    events.push(
      tiingoNewsEvent(
        {
          articleId: String(article.tiingoId),
          title: article.title,
          url: article.url ?? null,
          publishedAt: article.publishedAt ?? null,
          listingId,
          summary: article.description ?? null,
          tags: article.tags ?? [],
        },
        observedAt,
      ),
    );
  }
  return events;
}
