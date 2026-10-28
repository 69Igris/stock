/**
 * THE NULL-VS-ABSENT TEST for MONEY-1324.
 *
 * ## What this file used to assert, and why it was worse than no test
 *
 * It opened: "`us_filing_documents` is written by `services/us-fundamentals/`
 * through pymongo, and that writer's third rule is 'an unknown field is ABSENT,
 * never null': `Row.to_doc()` (app/store/models.py:223) drops every `None` …
 * so `{ textPath: { not: null } }` returns ZERO ROWS." Every clause of that is
 * false for THIS collection, and the arm it justified — `isSet: true` — filters
 * NOTHING.
 *
 * The fixtures were built to match the claim rather than the table, so the
 * suite was green, confident, and testing a row shape prod does not store. That
 * is the specific failure this file is now written against: a `[premise]` case
 * that pins the wrong premise makes every case under it unfalsifiable.
 *
 * ## MEASURED, on prod `us_filing_documents`, 2026-09-02
 *
 *     rows                      3,509
 *     textPath $exists: true    3,509   ← 100%. NOT ONE absent key.
 *     textPath BSON null        1,963
 *     textPath string           1,546
 *     textPath ""                   0
 *
 * The siblings match: `textHash` 1,963 null, `textBytes` 1,963 null, `symbol`
 * 769 null. `extractionStatus` is `PENDING` on all 3,509.
 *
 * ## Root cause — the typed row model is not the writer
 *
 * `UsFilingDocumentRow` exists and `Row.to_doc()` really does drop `None`, but
 * NOTHING CALLS IT for this collection. `eightk_logic.build_rows`
 * (app/parsers/eightk_logic.py:200) returns `list[dict[str, Any]]` with a
 * literal `"textPath": text_paths.get(doc.sequence)` — `None` for an exhibit
 * that produced no text. `dispatch.py:515` hands those plain dicts to
 * `_Write("filing_documents", …)`, and `MongoRowWriter.upsert_rows` wraps a
 * plain dict in `_DocRow`, whose `to_doc` passes it through UNTOUCHED. The
 * `None` reaches MongoDB as a BSON null.
 *
 * The Python service's own suite already says so, in the MONEY-1317 note at
 * `tests/test_store_writers.py:643`: "`upsert_filing_documents`, the typed one,
 * has zero callers." The error was citing `models.py` for a collection
 * `models.py` does not write.
 *
 * ## What it cost, measured against the live table
 *
 *     cohort WHERE, old  { isSet: true, notIn: [""] }   481 documents
 *     cohort predicate   isCohortDocument()             477 documents
 *
 * Four EX-99 exhibits — WYNN, WPM, TMQ and one more, all `PRINTER FRIENDLY
 * VERSION` PDFs whose extraction produced nothing — were SELECTED by the query
 * and REJECTED by the predicate. The documented "MUST stay in exact agreement"
 * invariant was false on prod. It stayed contained only because
 * `hasExtractedText`'s `typeof` test drops them in memory, so no model call was
 * wasted; the cost was that the premise and its guard were both wrong, and the
 * next query written from them would be wrong by 1,963 rows.
 *
 * ## THE ABSENT-FIELD CLASS IS REAL. It is just not this table.
 *
 * Do not read any of the above as "absent fields were a myth". Measured on the
 * SAME prod database, the same day:
 *
 *     stock_financials.basis             32,359 rows, 32,359 ABSENT (100%)
 *     instrument_mappings.usEodSyncedAt  27,016 rows, 27,016 ABSENT (100%)
 *     stock_documents.documentsSyncedAt  90,213 rows, 90,213 ABSENT (100%)
 *     us_cusip_map.figi                  23,229 rows, 23,229 ABSENT (100%)
 *
 * That last one is written by the SAME Python service through the TYPED
 * `UsCusipMapRow`, so one service produces both shapes and the code path — not
 * the language — decides which. MONEY-1050, MONEY-1205, MONEY-1234, MONEY-1235
 * and MONEY-1236 are still real bugs about still-real data, and
 * `us_filing_insights` (Prisma-written, key-omitting) still needs its
 * `isSet: false` arms. Both spellings are asserted below.
 *
 * ## What Prisma actually does, counted rather than reasoned
 *
 * With the generated client, against both populations:
 *
 *                                 us_filing_documents   stock_financials
 *     filter                        .textPath (nulls)     .basis (absent)
 *     ─────────────────────────────────────────────────────────────────
 *     { isSet: true }                    3,509  (all)          0
 *     { isSet: false }                       0               32,359
 *     { equals: null }                   1,963                  0
 *     { not: null }                      1,546                  0
 *
 * So `{ not: null }` excludes an ABSENT attribute as well as a null one, which
 * makes it correct AND sufficient here — and it stays correct if this
 * collection's writer is ever switched to the typed row. `isSet: true` is
 * therefore not paired with it: a second arm that filters nothing while
 * advertising itself as the one doing the work is the error this file is a
 * correction of.
 *
 * ## Why the where-clause and the predicate are checked AGAINST EACH OTHER
 *
 * A rule stated twice is a rule that drifts, and MONEY-1255 paid for exactly
 * that: one job named a GCS object with a substring test while selecting the
 * row with an exact match, so the FILE was right and the ROW was unreachable
 * for the life of the table. This file does not assert the query shape and the
 * predicate separately and hope. It EVALUATES the query against row fixtures
 * copied VERBATIM from prod and asserts the two agree on every one.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  INSIGHT_STATUS,
  DOCUMENT_CLASSES,
  FILING_DOCUMENT_CLASSES,
  SWEEP_ONLY_DOCUMENT_CLASS,
  INSIGHT_COHORT_FORMS,
  INSIGHT_COHORT_TYPE_PREFIX,
  PENDING_OR_ABSENT_INSIGHT_STATUS,
  buildInsightCohortWhere,
  buildInsightCohortOrderBy,
  buildInsightByDocumentWhere,
  buildSweepableInsightWhere,
  isCohortDocument,
  hasExtractedText,
  type CohortDocument,
} from "../../src/processors/us-filing-insight-selectors-logic";

/* ─────────────────────────────────────────────────────────────────────────
   A MINIMAL PRISMA-WHERE EVALUATOR

   Only the operators the selectors actually use. It is deliberately STRICT:
   an operator it does not know THROWS rather than being ignored, because an
   ignored operator is a filter that silently stops filtering — which is the
   whole failure mode under test.
   ──────────────────────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;

function matchesField(row: Row, field: string, cond: unknown): boolean {
  const present = Object.prototype.hasOwnProperty.call(row, field);
  const value = row[field];

  // A bare scalar is an equality test.
  if (cond === null || typeof cond !== "object")
    return present && value === cond;

  let ok = true;
  for (const [op, operand] of Object.entries(cond as Record<string, unknown>)) {
    switch (op) {
      case "isSet":
        // THE ONE UNDER TEST. Mongo's `$exists`: absent is not null.
        ok &&= present === (operand as boolean);
        break;
      case "in":
        ok &&= present && (operand as unknown[]).includes(value);
        break;
      case "notIn":
        ok &&= present && !(operand as unknown[]).includes(value);
        break;
      case "startsWith":
        ok &&=
          present &&
          typeof value === "string" &&
          value.startsWith(operand as string);
        break;
      case "equals":
        ok &&= present && value === operand;
        break;
      case "not":
        // Modelled HONESTLY, which is the point of this case existing at all.
        // On MongoDB a `not` against an ABSENT attribute does not match, so
        // `{ not: null }` cannot stand in for `{ isSet: true }`.
        ok &&= present && value !== operand;
        break;
      case "gte":
        ok &&= present && (value as number) >= (operand as number);
        break;
      default:
        throw new Error(
          `unmodelled Prisma operator ${op} — extend the evaluator`,
        );
    }
  }
  return ok;
}

function matchesWhere(where: Record<string, unknown>, row: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "NOT") {
      if (matchesWhere(cond as Record<string, unknown>, row)) return false;
      continue;
    }
    if (key === "OR") {
      const arms = cond as Record<string, unknown>[];
      if (!arms.some((arm) => matchesWhere(arm, row))) return false;
      continue;
    }
    if (key === "AND") {
      const arms = cond as Record<string, unknown>[];
      if (!arms.every((arm) => matchesWhere(arm, row))) return false;
      continue;
    }
    if (!matchesField(row, key, cond)) return false;
  }
  return true;
}

/* ─────────────────────────────────────────────────────────────────────────
   FIXTURES — rows exactly as prod stores them
   ──────────────────────────────────────────────────────────────────────── */

/** The document actually read while designing this: an EX-99.1 that is AUDITED
 *  CONSOLIDATED FINANCIAL STATEMENTS on a merger 8-K, not an earnings release. */
const EX99_1_8K: CohortDocument & Row = {
  id: "d1",
  accession: "0001193125-26-378529",
  sequence: 11,
  cik10: "0000866829",
  symbol: "HOS",
  form: "8-K",
  documentType: "EX-99.1",
  filedAt: new Date("2026-08-29"),
  items: ["1.01", "2.01", "5.01"],
  textPath: "edgar/text/0000866829/0001193125-26-378529/11.txt",
  textHash: "abc123",
  extractionStatus: "PENDING",
};

/** A 6-K exhibit. `items` is EMPTY — foreign private issuers file no item
 *  numbers at all. This row is the reason the cohort must not be item-gated. */
const EX99_1_6K: CohortDocument & Row = {
  id: "d2",
  accession: "0001193125-26-400001",
  sequence: 2,
  cik10: "0000123456",
  symbol: "ABC",
  form: "6-K",
  documentType: "EX-99.1",
  filedAt: new Date("2026-08-30"),
  items: [],
  textPath: "edgar/text/0000123456/0001193125-26-400001/2.txt",
  textHash: "def456",
  extractionStatus: "PENDING",
};

/** EX-99.2 — the cohort is `EX-99*`, not `EX-99.1`. */
const EX99_2_8K: CohortDocument & Row = {
  ...EX99_1_8K,
  id: "d3",
  sequence: 12,
  documentType: "EX-99.2",
  textPath: "edgar/text/0000866829/0001193125-26-378529/12.txt",
};

/**
 * A GRAPHIC row EXACTLY as prod stores one: `textPath`, `textBytes` and
 * `textHash` are PRESENT and hold EXPLICIT NULLS.
 *
 * This fixture used to OMIT those keys, on the premise that `Row.to_doc()`
 * drops `None` for this collection. It does not run for this collection — see
 * the file docblock. 1,956 of 3,509 prod rows are GRAPHIC and 0 of them have a
 * textPath; 1,963 rows in total carry `textPath: null`, and NOT ONE row in the
 * table is missing the key.
 */
const GRAPHIC_NO_TEXT: CohortDocument & Row = {
  id: "d4",
  accession: "0001193125-26-378529",
  sequence: 20,
  cik10: "0000866829",
  symbol: "HOS",
  form: "8-K",
  documentType: "GRAPHIC",
  filedAt: new Date("2026-08-29"),
  items: ["1.01"],
  textPath: null,
  textBytes: null,
  textHash: null,
  extractionStatus: "PENDING",
};

/**
 * A VERBATIM prod row — one of the FOUR that broke the WHERE/predicate
 * invariant, copied field for field out of `us_filing_documents` on
 * 2026-09-02 (`_id` 6a9602d4aa632b2c727d0a78).
 *
 * It is in the cohort by form and documentType, and its extraction produced
 * nothing. The old `{ isSet: true, notIn: [""] }` SELECTED it (481) while
 * `isCohortDocument` REJECTED it (477). Driving the agreement case from a real
 * row rather than an invented one is the whole point: the invented fixtures
 * agreed with the broken query, because they were built from the same false
 * premise.
 */
const PROD_EX99_NULL_PATH: CohortDocument & Row = {
  id: "6a9602d4aa632b2c727d0a78",
  accession: "0001174922-26-000057",
  sequence: 2,
  cik10: "0001174922",
  symbol: "WYNN",
  form: "8-K",
  documentType: "EX-99.1",
  filedAt: new Date("2026-08-31T00:00:00.000Z"),
  items: ["7.01", "9.01"],
  textPath: null,
  textBytes: null,
  textHash: null,
  extractionStatus: "PENDING",
};

/**
 * A VERBATIM prod row from the OTHER side of the same disagreement: a 6-K
 * exhibit typed with the BARE `EX-99` spelling (`_id`
 * 6a97423baa632b2c72800f4d, WPM). It is here because it proves the prefix
 * match is doing real work — a cohort pinned to `EX-99.1` would drop it — and
 * because it is a second, independently-sourced instance of the null shape.
 */
const PROD_BARE_EX99_NULL_PATH: CohortDocument & Row = {
  id: "6a97423baa632b2c72800f4d",
  accession: "0001279569-26-000844",
  sequence: 3,
  cik10: "0001323404",
  symbol: "WPM",
  form: "6-K",
  documentType: "EX-99",
  filedAt: new Date("2026-09-01T00:00:00.000Z"),
  items: [],
  textPath: null,
  textBytes: null,
  textHash: null,
  extractionStatus: "PENDING",
};

/** An EX-99.1 whose extraction produced nothing — same absent-key shape as the
 *  GRAPHIC row, but a cohort documentType. This is the row that separates
 *  "is in the cohort" from "has text to read". */
const EX99_NO_TEXT: CohortDocument & Row = {
  ...GRAPHIC_NO_TEXT,
  id: "d5",
  sequence: 21,
  documentType: "EX-99.1",
};

/** Not an exhibit — the 8-K primary document. 377 of these. */
const PRIMARY_8K: CohortDocument & Row = {
  ...EX99_1_8K,
  id: "d6",
  sequence: 1,
  documentType: "8-K",
};

/** An EX-10.1 material contract. In the table, out of the cohort. */
const EX10_1: CohortDocument & Row = {
  ...EX99_1_8K,
  id: "d7",
  sequence: 5,
  documentType: "EX-10.1",
};

/** A 10-K exhibit: right documentType, wrong FORM. */
const EX99_ON_10K: CohortDocument & Row = {
  ...EX99_1_8K,
  id: "d8",
  sequence: 3,
  form: "10-K",
};

/** The empty-string path. `gcsPath: ""` is a real shape in this repo (6,125
 *  BSE rows), so the sibling column is guarded the same way. */
const EX99_EMPTY_PATH: CohortDocument & Row = {
  ...EX99_1_8K,
  id: "d9",
  sequence: 22,
  textPath: "",
};

/** The prod rows whose `textPath` is an EXPLICIT NULL. */
const PROD_NULL_PATH_ROWS: readonly (CohortDocument & Row)[] = [
  GRAPHIC_NO_TEXT,
  EX99_NO_TEXT,
  PROD_EX99_NULL_PATH,
  PROD_BARE_EX99_NULL_PATH,
];

const ALL_ROWS: readonly (CohortDocument & Row)[] = [
  EX99_1_8K,
  EX99_1_6K,
  EX99_2_8K,
  GRAPHIC_NO_TEXT,
  EX99_NO_TEXT,
  PRIMARY_8K,
  EX10_1,
  EX99_ON_10K,
  EX99_EMPTY_PATH,
  PROD_EX99_NULL_PATH,
  PROD_BARE_EX99_NULL_PATH,
];

/** The WHERE this file exists because it was wrong. Kept as a live MUTATION. */
function isSetOnlyCohortWhere(): Record<string, unknown> {
  return {
    ...buildInsightCohortWhere(),
    textPath: { isSet: true, notIn: [""] },
  };
}

describe("MONEY-1324 — the cohort selector's null-vs-absent arms", () => {
  it("[premise] the no-text prod rows carry an EXPLICIT NULL, not an absent key", () => {
    // THE CORRECTED PREMISE, and the case that has to go RED if anyone
    // restores the old one. It previously asserted `"textPath" in row === false`
    // — a row shape `us_filing_documents` does not contain a single instance of
    // — which made the `isSet` arm below unfalsifiable while staying green.
    //
    // Measured on prod 2026-09-02: 3,509 rows, `$exists: true` on ALL of them,
    // BSON null on 1,963. Root cause in the file docblock: this collection's
    // rows are plain dicts, so `Row.to_doc()` never runs and `None` is stored.
    for (const row of PROD_NULL_PATH_ROWS) {
      assert.equal(
        "textPath" in row,
        true,
        `fixture ${String(row.id)} is MISSING the textPath key. Prod stores an ` +
          "explicit null on all 1,963 text-less rows and an absent key on ZERO " +
          "of 3,509 — a fixture without the key is testing a shape that does " +
          "not exist, which is how the isSet arm passed review.",
      );
      assert.equal(
        row.textPath,
        null,
        `fixture ${String(row.id)} does not hold null`,
      );
      assert.equal("textHash" in row, true);
      assert.equal(row.textHash, null);
    }
  });

  it("the cohort where uses `not: null`, and does NOT lean on `isSet`", () => {
    const where = buildInsightCohortWhere() as Record<string, unknown>;
    const cond = where.textPath as Record<string, unknown> | undefined;
    assert.ok(
      cond && typeof cond === "object",
      "the cohort where does not constrain textPath at all — a GRAPHIC row " +
        "with no text would be selected and the GCS read would 404",
    );
    assert.ok(
      "not" in cond && cond.not === null,
      `textPath must be selected with { not: null }; got ${JSON.stringify(cond)}. ` +
        "Measured on prod: `not: null` -> 1,546 rows (correct), " +
        "`isSet: true` -> 3,509 (the whole table).",
    );
    assert.equal(
      cond.isSet,
      undefined,
      "textPath carries an `isSet` arm beside `not: null`. It filters NOTHING " +
        "on this table — `$exists` is true on all 3,509 rows — and Prisma's " +
        "`not: null` already excludes an absent attribute (0 hits against " +
        "32,359 absent stock_financials.basis rows). A second arm that does no " +
        "work while advertising itself as the load-bearing one is the exact " +
        "error this file is a correction of.",
    );
  });

  it("MUTATION: the old `isSet`-only arm ADMITS the null rows", () => {
    // The mutation run for real. Restoring `{ isSet: true, notIn: [""] }`
    // re-admits every text-less exhibit in the cohort — 481 against 477 on
    // prod — and the four extra rows are exactly this shape.
    const broken = isSetOnlyCohortWhere();
    for (const row of [PROD_EX99_NULL_PATH, PROD_BARE_EX99_NULL_PATH]) {
      assert.equal(
        matchesWhere(broken, row),
        true,
        "the mutation did not bite: the isSet-only where already excludes " +
          `${String(row.id)}, so this case proves nothing about the real fix`,
      );
      assert.equal(
        matchesWhere(buildInsightCohortWhere(), row),
        false,
        `the CORRECTED where still admits ${String(row.id)} — a text-less ` +
          "exhibit reaching the sweep is a GCS read of a null path",
      );
      // ...and the predicate agreed with the FIX all along, which is why this
      // stayed contained: `hasExtractedText` drops the row in memory.
      assert.equal(isCohortDocument(row), false);
    }
  });

  it('[control] `notIn: [""]` does NOT exclude a null — measured on Mongo', () => {
    // The half of the old arm that looked like it might have been doing the
    // work. `$nin: [""]` matches a null, because null is not "". So
    // `{ isSet: true, notIn: [""] }` admitted all 1,963 null rows, and pairing
    // `notIn` with anything other than a null test cannot fix that.
    assert.equal(
      matchesWhere({ textPath: { notIn: [""] } }, PROD_EX99_NULL_PATH),
      true,
      "the evaluator models notIn as excluding null — it does not, and " +
        "modelling it wrongly would make the mutation case above vacuous",
    );
    assert.equal(
      matchesWhere({ textPath: { not: null } }, PROD_EX99_NULL_PATH),
      false,
    );
    // `notIn` still earns its place: it is the only thing excluding "".
    assert.equal(
      matchesWhere({ textPath: { not: null } }, EX99_EMPTY_PATH),
      true,
      "[control] not: null alone admits the empty string, so notIn is load-bearing",
    );
    assert.equal(
      matchesWhere(buildInsightCohortWhere(), EX99_EMPTY_PATH),
      false,
    );
  });

  it("[control] the evaluator distinguishes ABSENT from NULL", () => {
    // The whole file turns on that distinction, so the detector is checked
    // before it is trusted. A row with the key absent and a row holding null
    // must answer differently to `isSet` and identically to `not: null`.
    const absent: Row = { documentType: "EX-99.1" };
    const held: Row = { documentType: "EX-99.1", textPath: null };

    assert.equal(matchesWhere({ textPath: { isSet: true } }, absent), false);
    assert.equal(matchesWhere({ textPath: { isSet: true } }, held), true);
    assert.equal(matchesWhere({ textPath: { isSet: false } }, absent), true);
    assert.equal(matchesWhere({ textPath: { isSet: false } }, held), false);
    // `not: null` rejects BOTH, which is the property that makes it sufficient.
    assert.equal(matchesWhere({ textPath: { not: null } }, absent), false);
    assert.equal(matchesWhere({ textPath: { not: null } }, held), false);
    assert.equal(matchesWhere({ textPath: { not: null } }, EX99_1_8K), true);
  });

  it("[control] the text arm is what excludes the no-text rows", () => {
    // Proves the arm DOES work rather than being carried by some other clause.
    // Without this, `textPath` could be dropped from the where entirely and
    // every "is excluded" case above would still pass on documentType alone.
    const withoutTextArm = { ...buildInsightCohortWhere() } as Record<
      string,
      unknown
    >;
    delete withoutTextArm.textPath;

    assert.ok(
      matchesWhere(withoutTextArm, EX99_NO_TEXT),
      "control broken: with the text arm removed, the no-text EX-99 must be " +
        "admitted — otherwise something else is doing the excluding and the " +
        "arm is untested",
    );
    assert.ok(matchesWhere(withoutTextArm, EX99_EMPTY_PATH));
    // ...and putting it back excludes both again.
    assert.equal(matchesWhere(buildInsightCohortWhere(), EX99_NO_TEXT), false);
    assert.equal(
      matchesWhere(buildInsightCohortWhere(), EX99_EMPTY_PATH),
      false,
    );
  });

  it("[control] `isSet` on a PROD row is answered by presence, and prod is 100% present", () => {
    // The measurement, restated as an assertion. Against the real row shape
    // `isSet: true` is TRUE for the text-bearing and the text-LESS row alike —
    // which is precisely why it filtered nothing and why 481 != 477.
    assert.equal(
      matchesWhere({ textPath: { isSet: true } }, GRAPHIC_NO_TEXT),
      true,
    );
    assert.equal(matchesWhere({ textPath: { isSet: true } }, EX99_1_8K), true);
    assert.equal(
      matchesWhere({ textPath: { isSet: false } }, GRAPHIC_NO_TEXT),
      false,
    );
    assert.equal(
      matchesWhere({ textPath: { isSet: false } }, EX99_1_8K),
      false,
    );
  });

  it("the ABSENT-field arms are KEPT — for us_filing_insights, the other shape", () => {
    // Guard against over-correcting. `us_filing_documents` stores nulls;
    // `us_filing_insights` is written only by this lane through Prisma, and
    // both builders OMIT a key they cannot fill. Same lane, two tables, two
    // spellings — and the absent-field class is alive on four other
    // collections measured the same day (file docblock), including
    // `us_cusip_map`, written by the SAME Python service through its TYPED row.
    const admitsAbsent = PENDING_OR_ABSENT_INSIGHT_STATUS.some((arm) => {
      const v = (arm as Record<string, { isSet?: boolean }>).insightStatus;
      return typeof v === "object" && v !== null && v.isSet === false;
    });
    assert.ok(
      admitsAbsent,
      "the insight-status arms lost their { isSet: false } branch. That arm is " +
        "CORRECT for this table — do not delete it on the strength of the " +
        "textPath correction, which is about a different writer.",
    );
    const sweepable = buildSweepableInsightWhere() as {
      OR: Record<string, unknown>[];
    };
    assert.ok(
      sweepable.OR.some((arm) => {
        const v = (arm as Record<string, { isSet?: boolean }>).insightStatus;
        return typeof v === "object" && v !== null && v.isSet === false;
      }),
      "buildSweepableInsightWhere lost its absent-status arm",
    );
  });

  it("the cohort admits a 6-K whose `items` is EMPTY", () => {
    // 1,256 6-K documents carry `items: []` — foreign private issuers file no
    // item numbers. This is the founder decision, and the reason the cohort is
    // documentType-and-form gated rather than item-gated.
    const where = buildInsightCohortWhere();
    assert.ok(
      matchesWhere(where, EX99_1_6K),
      "the cohort excludes 6-K exhibits — every one of them has items: []",
    );
    assert.ok(isCohortDocument(EX99_1_6K));
  });

  it("MUTATION: adding an item filter turns the 6-K RED", () => {
    // The mutation this suite exists to catch, run for real rather than
    // described. `EX-99* AND item 2.02` is a handful against the cohort's
    // 477 — and ZERO of the 1,256 6-K rows, because their items list is empty.
    const itemGated = {
      ...buildInsightCohortWhere(),
      items: { in: ["2.02"] },
    } as Record<string, unknown>;

    assert.equal(
      matchesWhere(itemGated, EX99_1_6K),
      false,
      "an item-gated cohort still admits the 6-K — the mutation did not bite, " +
        "so this test proves nothing about the real selector",
    );
    // ...and it would drop the merger 8-K too: its items are 1.01/2.01/5.01.
    assert.equal(matchesWhere(itemGated, EX99_1_8K), false);
    // The unmutated selector admits both.
    assert.ok(matchesWhere(buildInsightCohortWhere(), EX99_1_6K));
    assert.ok(matchesWhere(buildInsightCohortWhere(), EX99_1_8K));
  });

  it("the cohort admits EX-99.2, not just EX-99.1", () => {
    assert.ok(
      matchesWhere(buildInsightCohortWhere(), EX99_2_8K),
      "EX-99.2 is out of the cohort — 58 documents, and the prefix is EX-99*",
    );
    assert.equal(INSIGHT_COHORT_TYPE_PREFIX, "EX-99");
  });

  it("MUTATION: pinning documentType to EX-99.1 turns EX-99.2 RED", () => {
    const pinned = {
      ...buildInsightCohortWhere(),
      documentType: { equals: "EX-99.1" },
    };
    assert.equal(matchesWhere(pinned, EX99_2_8K), false);
    assert.ok(matchesWhere(buildInsightCohortWhere(), EX99_2_8K));
  });

  it("a GRAPHIC row is NEVER selected — it has no textPath", () => {
    const where = buildInsightCohortWhere();
    assert.equal(
      matchesWhere(where, GRAPHIC_NO_TEXT),
      false,
      "a GRAPHIC row reached the sweep; the GCS read would 404 on a path that " +
        "does not exist for 1,963 of 3,509 rows",
    );
    assert.equal(isCohortDocument(GRAPHIC_NO_TEXT), false);
  });

  it("an EX-99 with NO extracted text is excluded on the text arm alone", () => {
    // Separates the two reasons a row can be out: documentType and text. If
    // this passed only because of documentType, the text arm would be untested.
    assert.equal(hasExtractedText(EX99_NO_TEXT), false);
    assert.equal(matchesWhere(buildInsightCohortWhere(), EX99_NO_TEXT), false);
    // ...and the SAME row with text is admitted, so nothing else is excluding it.
    const withText = { ...EX99_NO_TEXT, textPath: "edgar/text/x/y/1.txt" };
    assert.ok(matchesWhere(buildInsightCohortWhere(), withText));
  });

  it("an empty-string textPath is excluded", () => {
    assert.equal(
      matchesWhere(buildInsightCohortWhere(), EX99_EMPTY_PATH),
      false,
    );
    assert.equal(hasExtractedText(EX99_EMPTY_PATH), false);
  });

  it("non-cohort documentTypes and forms are excluded", () => {
    const where = buildInsightCohortWhere();
    assert.equal(
      matchesWhere(where, PRIMARY_8K),
      false,
      "8-K primary admitted",
    );
    assert.equal(matchesWhere(where, EX10_1), false, "EX-10.1 admitted");
    assert.equal(
      matchesWhere(where, EX99_ON_10K),
      false,
      "EX-99 on a 10-K admitted",
    );
  });

  it("the where clause and the pure predicate AGREE on every fixture", () => {
    // The join, not the halves. A `not: null` that slipped into the where, or a
    // predicate that tested `!== undefined` while the where tested `isSet`,
    // shows up here and nowhere else.
    const where = buildInsightCohortWhere();
    for (const row of ALL_ROWS) {
      assert.equal(
        matchesWhere(where, row),
        isCohortDocument(row),
        `where and predicate disagree on fixture ${String(row.id)} ` +
          `(${String(row.form)} ${String(row.documentType)})`,
      );
    }
  });

  it("[control] the fixture table separates admitted from rejected", () => {
    // A table that is all-in or all-out would make the agreement case above
    // pass without discriminating anything.
    const admitted = ALL_ROWS.filter((r) =>
      matchesWhere(buildInsightCohortWhere(), r),
    );
    assert.equal(
      admitted.length,
      3,
      "expected exactly the three text-bearing EX-99*",
    );
    assert.deepEqual(admitted.map((r) => r.id).sort(), ["d1", "d2", "d3"]);
  });

  it("the cohort does NOT gate on extractionStatus — all 3,509 rows are PENDING", () => {
    // The other silent zero, and it is not an absent-field bug. Every row's
    // extractionStatus is PENDING; zero are READY. Gating on READY looks
    // defensive and selects NOTHING. `textPath` is the evidence of text.
    const where = buildInsightCohortWhere() as Record<string, unknown>;
    assert.equal(
      where.extractionStatus,
      undefined,
      "the cohort constrains extractionStatus. All 3,509 prod rows are " +
        "PENDING (zero READY), so any status gate selects zero rows while " +
        "looking stricter and safer than not gating.",
    );
    // The fixtures are all PENDING and three of them are still selected.
    assert.ok(ALL_ROWS.every((r) => r.extractionStatus === "PENDING"));
  });

  it("the sweep's rotation marker is ASC, on a growing table", () => {
    // `us_filing_documents` grows daily (2026-08-28..2026-09-01 at measurement).
    // `desc` on a growing queue pushes the oldest rows further down every cycle
    // and never reaches them — MONEY-1255, ~2 years of undrainable backlog.
    // A constant column never advances at all — MONEY-1211, 681 of 781 symbols.
    const order = buildInsightCohortOrderBy();
    assert.ok(Array.isArray(order) && order.length > 0, "no ordering at all");
    const first = order[0] as Record<string, string>;
    assert.equal(
      Object.values(first)[0],
      "asc",
      `the primary sort must be asc; got ${JSON.stringify(first)}`,
    );
    for (const clause of order) {
      assert.ok(
        Object.values(clause as Record<string, string>).every(
          (d) => d === "asc",
        ),
        `every sort key must be asc, got ${JSON.stringify(clause)}`,
      );
    }
    // And it must be a column that VARIES across the population. `filedAt`
    // spans five days and grows; `form` and `source` would not.
    assert.ok(
      "filedAt" in first,
      "the primary sort is not filedAt — check it is not a constant column",
    );
  });

  it("the ordering is TOTAL, so paging cannot loop or skip", () => {
    // filedAt alone is not unique — one submission's exhibits share it. A
    // non-total order makes a cursor page re-read or skip rows arbitrarily.
    const keys = buildInsightCohortOrderBy().flatMap((c) =>
      Object.keys(c as Record<string, string>),
    );
    for (const k of ["accession", "sequence"]) {
      assert.ok(
        keys.includes(k),
        `ordering lacks ${k}; filedAt alone is not unique`,
      );
    }
  });

  it("the insight-status arms admit an ABSENT status", () => {
    // `us_filing_insights` is a NEW collection, so there is no legacy
    // population today — the arm is not load-bearing on day one and is here
    // for the day it is: any field added to this table later is absent on
    // every row written before it, which is the same bug one release apart.
    const admits = PENDING_OR_ABSENT_INSIGHT_STATUS.some((arm) => {
      const v = (arm as Record<string, { isSet?: boolean }>).insightStatus;
      return typeof v === "object" && v !== null && v.isSet === false;
    });
    assert.ok(
      admits,
      "PENDING_OR_ABSENT_INSIGHT_STATUS has no { isSet: false } arm",
    );
    assert.ok(
      PENDING_OR_ABSENT_INSIGHT_STATUS.some(
        (a) =>
          (a as Record<string, string>).insightStatus ===
          INSIGHT_STATUS.PENDING,
      ),
      "the arms must also admit the value Prisma's @default writes",
    );
  });

  it("buildInsightByDocumentWhere uses the NATURAL key, not the ObjectId", () => {
    // The lookup must be the same key the table is unique on, so a re-analysis
    // updates rather than duplicating.
    const where = buildInsightByDocumentWhere(EX99_1_8K);
    assert.deepEqual(where, {
      accession_sequence: {
        accession: "0001193125-26-378529",
        sequence: 11,
      },
    });
  });

  it("the vocabularies match the schema doc comments exactly", () => {
    assert.deepEqual(Object.values(INSIGHT_STATUS).sort(), [
      "FAILED",
      "PENDING",
      "READY",
      "SKIPPED",
    ]);
    assert.deepEqual([...INSIGHT_COHORT_FORMS].sort(), [
      "6-K",
      "6-K/A",
      "8-K",
      "8-K/A",
    ]);
  });

  it("documentClass is the ANALYSER's list plus the sweep's sentinel", () => {
    // Single-sourced. `FILING_DOCUMENT_CLASSES` is what the model's
    // `responseSchema` constrains it to, so it is the only list that can be
    // true about the column. A second enumeration here would be one rule
    // stated twice — and these two DID disagree while this ticket was built
    // (the sweep had invented TRANSACTION/GUIDANCE/PERSONNEL; the analyser
    // emits PROXY_OR_MEETING/BUSINESS_DESCRIPTION).
    assert.deepEqual(
      [...DOCUMENT_CLASSES],
      [...FILING_DOCUMENT_CLASSES, SWEEP_ONLY_DOCUMENT_CLASS],
    );
    assert.ok(
      !FILING_DOCUMENT_CLASSES.includes(SWEEP_ONLY_DOCUMENT_CLASS as never),
      "UNCLASSIFIED leaked into the model's own schema list — the model could " +
        "then emit it, making 'could not classify' indistinguishable from " +
        "'nothing read this'",
    );
  });

  it("[control] the evaluator THROWS on an operator it does not model", () => {
    // An evaluator that silently ignored unknown operators would report every
    // query as matching everything, making the agreement case vacuous.
    assert.throws(
      () => matchesWhere({ textPath: { contains: "x" } }, EX99_1_8K),
      /unmodelled Prisma operator contains/,
    );
  });
});

const SCHEMA_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "packages",
  "database",
  "prisma",
  "schema.prisma",
);
const schemaText = (): string => readFileSync(SCHEMA_PATH, "utf8");

describe("MONEY-1324 — the schema placement that keeps parity green", () => {
  it("UsFilingInsight is declared ABOVE the MONEY-979 block marker", () => {
    // `schema-parity.test.ts` slices schema.prisma at that banner and holds
    // EVERY model after it to the eleven the Python service writes. A model
    // below the line fails that suite and demands five coordinated changes in
    // `services/us-fundamentals/`, which do not apply — Python does not write
    // this table. The placement is the structural statement of ownership, and
    // it is invisible unless something checks it.
    const schema = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "packages",
        "database",
        "prisma",
        "schema.prisma",
      ),
      "utf8",
    );

    const marker = ["US FUNDAMENTALS", "SEC EDGAR (MONEY-979)"].join(" — ");
    const markerAt = schema.indexOf(marker);
    const modelAt = schema.indexOf("model UsFilingInsight {");

    assert.notEqual(
      markerAt,
      -1,
      "the MONEY-979 banner moved; update this test",
    );
    assert.notEqual(
      modelAt,
      -1,
      "model UsFilingInsight is not in schema.prisma",
    );
    assert.ok(
      modelAt < markerAt,
      "model UsFilingInsight is BELOW the MONEY-979 banner. schema-parity's " +
        "slice runs from that banner to end of file, so the model is now being " +
        "compared against a Python row model that does not exist. Move it back " +
        "above the banner.",
    );

    // The banner must occur exactly once: this test's own prose, or a comment
    // quoting it verbatim, becomes the slice point for schema-parity's
    // `indexOf` and silently changes which models it compares. That happened
    // while writing this ticket.
    const occurrences = schema.split(marker).length - 1;
    assert.equal(
      occurrences,
      1,
      `the MONEY-979 banner text appears ${occurrences} times in schema.prisma. ` +
        "schema-parity slices at the FIRST occurrence, so a comment quoting it " +
        "verbatim moves the block boundary.",
    );
  });

  it("the model carries no Prisma relation — a dangling required one THROWS", () => {
    // `documentId` is a plain String on purpose. A required relation whose
    // target is missing does not read null; it throws, and one orphan blanks
    // every result the caller asked for (MONEY-1216).
    const schema = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "packages",
        "database",
        "prisma",
        "schema.prisma",
      ),
      "utf8",
    );
    const start = schema.indexOf("model UsFilingInsight {");
    const body = schema.slice(start, schema.indexOf("\n}", start));
    assert.ok(
      !body.includes("@relation"),
      "UsFilingInsight declared a relation",
    );
    assert.ok(
      /documentId\s+String\b/.test(body),
      "documentId is no longer a plain String",
    );
  });

  it("the schema's documentClass comment enumerates EXACTLY the code list", () => {
    // The schema comment CLAIMS this test pins it. A doc comment cannot fail a
    // build on its own, and this exact enumeration was already wrong once —
    // it listed TRANSACTION / GUIDANCE / PERSONNEL, three values the model's
    // responseSchema cannot emit, while omitting PROXY_OR_MEETING and
    // BUSINESS_DESCRIPTION, which it can.
    const start = schemaText().indexOf("model UsFilingInsight {");
    const body = schemaText().slice(start, schemaText().indexOf("\n}", start));

    const at = body.indexOf("── THE DISCRIMINATOR");
    assert.notEqual(at, -1, "the DISCRIMINATOR section header moved");

    // The enumeration is the run of `///` lines after the header up to the
    // first empty `///` separator.
    const lines = body.slice(at).split("\n").slice(1);
    const enumLines: string[] = [];
    let started = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("///")) break;
      const text = line.replace(/^\/\/\/\s?/, "").trim();
      // The header is followed by a blank `///` separator, so leading blanks
      // are skipped; the FIRST blank after content ends the enumeration.
      if (text === "") {
        if (started) break;
        continue;
      }
      started = true;
      enumLines.push(text);
    }
    assert.ok(enumLines.length > 0, "found no enumeration under the header");

    const declared = enumLines
      .join(" ")
      .split("|")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);

    assert.deepEqual(
      declared.sort(),
      [...DOCUMENT_CLASSES].sort(),
      "schema.prisma's documentClass comment and DOCUMENT_CLASSES disagree. " +
        "The code list is derived from FILING_DOCUMENT_CLASSES (what the " +
        "model's responseSchema constrains it to); the comment must follow it.",
    );
  });

  it("the unique key is (accession, sequence) — provenance stays OUT of it", () => {
    const schema = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "packages",
        "database",
        "prisma",
        "schema.prisma",
      ),
      "utf8",
    );
    const start = schema.indexOf("model UsFilingInsight {");
    const body = schema.slice(start, schema.indexOf("\n}", start));

    assert.ok(
      body.includes("@@unique([accession, sequence])"),
      "the unique key changed; a re-analysis must be an UPDATE, not a new row",
    );
    // Adding any of these to the key makes each model revision a SEPARATE row
    // for one document, which every reader double-counts while looking normal
    // — the StockFinancials.basis reasoning in CLAUDE.md.
    for (const provenance of ["model", "promptVersion", "sourceTextHash"]) {
      assert.ok(
        !body.includes(`@@unique([accession, sequence, ${provenance}])`),
        `${provenance} is in the unique key — readers will double-count`,
      );
    }
  });
});
