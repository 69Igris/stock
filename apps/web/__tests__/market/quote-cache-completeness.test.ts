/**
 * MONEY-1255 — the quote DB cache must not be LOSSY.
 *
 * `LatestQuote` is consulted BEFORE live Yahoo (`quote-cache-logic.ts` tries
 * the DB leg first, live Yahoo only on a miss). So any field the row cannot
 * hold, or holds but does not project back, arrives `undefined` at the caller
 * on every cache HIT — and the KEY METRICS card renders a missing metric as
 * "—". The observed symptom was a card that flickered: P/E, EPS and the 52-week
 * pair populated on a cold miss and went dashed 30s later on the next poll,
 * while MARKET CAP (which the row did store) stayed put throughout. The
 * degraded envelope was then written into the 15s shared cache, propagating the
 * loss to every other reader.
 *
 * A behavioural test for this needs a Prisma double and would only prove the
 * four fields fixed today. The defect is STRUCTURAL — "the row stores a subset
 * of the type it caches" — so this file encodes the invariant instead:
 *
 *   every field that BOTH `QuoteData` declares AND `LatestQuote` can store
 *   MUST be projected at every DB read-back site.
 *
 * That catches the next field added to `QuoteData` without a matching column,
 * which is exactly how this one arrived (`pe`/`eps`/`week52*` were added to the
 * type by MONEY-1198 and the row was never widened).
 *
 * Source: packages/database/prisma/schema.prisma (model LatestQuote),
 *         apps/web/lib/market/yahoo-client-logic.ts (interface QuoteData),
 *         apps/web/lib/market/yahoo-client.ts (the read-back sites)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const REPO = join(ROOT, "..", "..");

function read(abs: string): string {
  return readFileSync(abs, "utf8");
}

/** Scalar field names declared on a Prisma model, relations excluded. */
function prismaModelFields(schema: string, model: string): string[] {
  const m = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`));
  if (!m) return [];
  return (
    m[1]
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, "").trim())
      .filter((l) => l && !l.startsWith("///") && !l.startsWith("@@"))
      .map((l) => l.match(/^(\w+)\s+(\w+)/))
      .filter((x): x is RegExpMatchArray => Boolean(x))
      // Relation fields point at another model; they are not stored scalars.
      .filter((x) => !/^(InstrumentMapping|User)$/.test(x[2]))
      .map((x) => x[1])
  );
}

/** Field names declared on a TS interface. */
function interfaceFields(src: string, name: string): string[] {
  const m = src.match(new RegExp(`interface ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((l) => l.trim())
    .map((l) => l.match(/^(\w+)\??:/))
    .filter((x): x is RegExpMatchArray => Boolean(x))
    .map((x) => x[1]);
}

const schema = read(
  join(REPO, "packages", "database", "prisma", "schema.prisma")
);
const clientLogic = read(join(ROOT, "lib", "market", "yahoo-client-logic.ts"));
const client = read(join(ROOT, "lib", "market", "yahoo-client.ts"));

const rowFields = prismaModelFields(schema, "LatestQuote");
const quoteFields = interfaceFields(clientLogic, "QuoteData");

/**
 * Fields on `QuoteData` that describe the INSTRUMENT rather than the quote.
 * They are hydrated from `instrumentMapping` at read time, by design, and are
 * deliberately not columns on the quote row.
 */
const INSTRUMENT_FIELDS = new Set(["symbol", "exchange", "name"]);

/**
 * Fields that describe WHERE A QUOTE CAME FROM, not the quote itself.
 *
 * MONEY-1309 added `provenance` to `QuoteData`. It is exempt from the column
 * invariant for a reason specific to this row, not as a convenience:
 *
 *   - `LatestQuote` is a YAHOO row. It is written by `quote-service.ts` from
 *     Yahoo data and already carries its own `source` column, so a `provenance`
 *     column there could only ever say "yahoo, delayed" — a constant.
 *   - Nothing that populates `provenance` can ever be READ BACK from this row.
 *     It is set only on the US path, and the US path does not go through
 *     `LatestQuote` at all: `fetchUsQuotesUncached` bypasses the whole cache
 *     module (Tiingo's Commercial licence is internal-use-only, so its quotes
 *     must not enter a cross-user store). So the lossy-cache-hit failure this
 *     file exists to catch is unreachable for this field.
 *
 * The exemption is PINNED below rather than left as a filter, so it cannot
 * quietly grow into a general escape hatch for the next field somebody does not
 * want to add a column for.
 */
const PROVENANCE_FIELDS = new Set(["provenance"]);

describe("LatestQuote cache completeness (MONEY-1255)", () => {
  // ── Falsifiable ceiling ───────────────────────────────────────────
  // Every assertion below is of the form "X is a subset of Y". If either
  // parser silently returned [], every such assertion passes vacuously and
  // this file would report green against arbitrarily broken source. Prove the
  // parsers found something real FIRST, and pin known members so a parser that
  // half-works cannot hide either.

  it("parses the LatestQuote model (ceiling check)", () => {
    assert.ok(
      rowFields.length >= 10,
      `expected >=10 scalar fields on LatestQuote, parsed ${rowFields.length}: ${rowFields.join(", ")}`
    );
    for (const known of ["price", "marketCap", "timestamp", "source"]) {
      assert.ok(
        rowFields.includes(known),
        `parser missed the known LatestQuote field "${known}"`
      );
    }
  });

  it("parses the QuoteData interface (ceiling check)", () => {
    assert.ok(
      quoteFields.length >= 10,
      `expected >=10 fields on QuoteData, parsed ${quoteFields.length}: ${quoteFields.join(", ")}`
    );
    for (const known of ["price", "marketCap", "pe", "eps"]) {
      assert.ok(
        quoteFields.includes(known),
        `parser missed the known QuoteData field "${known}"`
      );
    }
  });

  // ── The invariant ─────────────────────────────────────────────────

  it("the exemption lists stay exactly what they claim to be", () => {
    // A guard on the guard. Both sets are subtractions from the invariant, so
    // growing one is the cheapest possible way to make this file stop
    // protecting anything — and it would look like a passing test.
    assert.deepStrictEqual([...INSTRUMENT_FIELDS].sort(), [
      "exchange",
      "name",
      "symbol",
    ]);
    assert.deepStrictEqual([...PROVENANCE_FIELDS], ["provenance"]);
    // And every exempted name must actually be ON the type — an exemption for
    // a field that no longer exists is dead weight that hides the next one.
    for (const f of [...INSTRUMENT_FIELDS, ...PROVENANCE_FIELDS]) {
      assert.ok(
        quoteFields.includes(f),
        `"${f}" is exempted but is no longer a QuoteData field`
      );
    }
  });

  it("every quote-describing QuoteData field has a LatestQuote column", () => {
    const missing = quoteFields
      .filter((f) => !INSTRUMENT_FIELDS.has(f) && !PROVENANCE_FIELDS.has(f))
      .filter((f) => !rowFields.includes(f));

    assert.deepStrictEqual(
      missing,
      [],
      `QuoteData declares ${missing.join(", ")} but LatestQuote cannot store ` +
        `them, so every DB-leg cache HIT returns them undefined and the UI ` +
        `renders "—". Add the column(s) to model LatestQuote.`
    );
  });

  it("every storable field is projected at every DB read-back site", () => {
    // The two sites that rebuild a QuoteData from a `cached` row. One is a
    // bare `return { ... };`, the other a `results.set(id, { ... });` — hence
    // the optional paren before the terminator.
    const sites =
      client.match(/price: cached\.price[\s\S]{0,1400}?\}\)?;/g) ?? [];
    assert.strictEqual(
      sites.length,
      2,
      `expected 2 DB read-back sites in yahoo-client.ts, found ${sites.length}` +
        ` — the matcher has drifted from the source and every projection ` +
        `assertion below would be vacuous`
    );

    const storable = quoteFields.filter(
      (f) =>
        !INSTRUMENT_FIELDS.has(f) &&
        !PROVENANCE_FIELDS.has(f) &&
        rowFields.includes(f)
    );
    assert.ok(storable.length >= 10, "ceiling: too few storable fields");

    for (const [i, site] of sites.entries()) {
      for (const f of storable) {
        assert.ok(
          new RegExp(`\\b${f}: cached\\.${f}\\b`).test(site),
          `read-back site #${i + 1} does not project "${f}" from the cached ` +
            `row, so a cache HIT silently drops it`
        );
      }
    }
  });

  it("persists pe/eps/52w as null, never 0, when Yahoo omits them", () => {
    // `?? 0` would assert a fact about the company that a screen would act on
    // (a loss-making firm has NO trailing P/E; a rejected 52-week window means
    // "not established"). `undefined` on a Mongo update means "leave as-is",
    // which would re-serve a value we no longer believe. Only `?? null` erases.
    const service = read(
      join(
        REPO,
        "packages",
        "core",
        "src",
        "market-data",
        "prices",
        "quote-service.ts"
      )
    );
    for (const f of ["pe", "eps", "week52High", "week52Low"]) {
      assert.ok(
        new RegExp(`${f}: yahooData\\.${f} \\?\\? null,`).test(service),
        `${f} must be written as "?? null" so a value that stops being ` +
          `reported is erased rather than left stale`
      );
      assert.ok(
        !new RegExp(`${f}: yahooData\\.${f} \\?\\? 0`).test(service),
        `${f} must never be coerced to 0 — that is a factual claim`
      );
    }
  });
});
