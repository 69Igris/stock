/**
 * The parse selector must be a VALID Prisma query, not merely a plausible
 * object — MONEY-1256.
 *
 * ## What happened
 *
 * `StockDocument.parseStatus` shipped as `String @default("PENDING")`, and the
 * parse job's selector used `{ parseStatus: { isSet: false } }` to reach the
 * 43,233 rows written before the field existed — because `@default` applies
 * only to rows PRISMA creates, so the attribute is genuinely ABSENT on all of
 * them.
 *
 * But Prisma's `isSet` filter exists ONLY on OPTIONAL fields. Against a
 * required field it is `Unknown argument`, and Prisma rejects the query SHAPE
 * before it looks at any data. So the job threw `PrismaClientValidationError`
 * on every single run: HTTP 200, cohort split logged, then nothing. Zero
 * extracts, and no error surfaced anywhere a monitor could see.
 *
 * The field's own doc comment MANDATED the `isSet` selector. The declaration
 * one line below made that selector illegal. The comment and the schema
 * contradicted each other, and the schema won silently.
 *
 * ## Why every existing test missed it
 *
 * They all mock Prisma. A mock accepts any `where` object, so the selector was
 * only ever asserted STRUCTURALLY — "does it contain these keys" — which is
 * exactly what it did contain. Structural assertions cannot distinguish a valid
 * query from an invalid one; only Prisma's own types can.
 *
 * ## Why this is a SOURCE guard and not a type guard
 *
 * The obvious fix is a type-level assertion against
 * `Prisma.StockDocumentWhereInput`. Two attempts at that BOTH survived a
 * mutation reverting the field to required, and the reason is worth recording:
 * `packages/core/tsconfig.json` limits `include` to the src glob only, so
 * `__tests__/**` is NEVER TYPE-CHECKED. A deliberate
 * `const x: number = "string"` in this very file passes `yarn type-check`.
 *
 * So in this package a compile-time assertion is not a weak guard — it is not
 * a guard at all. Any test here that relies on TypeScript rejecting something
 * is vacuous, and reads exactly like one that works.
 *
 * What CAN be checked is that the two artefacts which must agree do agree: the
 * SCHEMA declaring the field optional, and the SELECTOR using the filter that
 * only optional fields support. Either one alone is fine; the pairing is what
 * broke, so the pairing is what is asserted.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PENDING_OR_ABSENT_PARSE_STATUS } from "../../../../workers/src/processors/stock-document-parse-logic";

const SCHEMA = readFileSync(
  join("..", "..", "packages", "database", "prisma", "schema.prisma"),
  "utf8",
);

/** The `parseStatus` line inside `model StockDocument`. */
function parseStatusDeclaration(): string {
  const model = SCHEMA.match(/model StockDocument \{([\s\S]*?)\n\}/);
  assert.ok(
    model,
    "ceiling: could not locate model StockDocument in the schema",
  );
  const line = model[1].split("\n").find((l) => /^\s*parseStatus\s/.test(l));
  assert.ok(line, "ceiling: StockDocument has no parseStatus field");
  return line.trim();
}

describe("the parse selector is a valid Prisma query (MONEY-1256)", () => {
  it("[meta] the schema is readable and the field exists", () => {
    // Ceiling: both assertions below are "does this string contain X". A failed
    // read or a drifted regex would make them fail confusingly rather than
    // vacuously, but pin the basics anyway so the failure is legible.
    assert.ok(SCHEMA.length > 10_000, `schema read as ${SCHEMA.length} chars`);
    assert.match(parseStatusDeclaration(), /^parseStatus\s/);
  });

  it("declares parseStatus OPTIONAL, because the selector uses isSet", () => {
    const decl = parseStatusDeclaration();
    assert.match(
      decl,
      /^parseStatus\s+String\?/,
      `parseStatus is declared "${decl}". It MUST be optional (String?). ` +
        `Prisma's isSet filter exists only on optional fields, so a required ` +
        `declaration makes the selector below an Unknown-argument validation ` +
        `error — thrown on EVERY run, after a 200 and a cohort-split log line, ` +
        `writing nothing. That is how this shipped.`,
    );
  });

  it("the absent-arm uses isSet — the filter that needs the ? above", () => {
    const arms = [...PENDING_OR_ABSENT_PARSE_STATUS] as ReadonlyArray<
      Record<string, unknown>
    >;
    assert.equal(
      arms.length,
      2,
      "PENDING and ABSENT are two DIFFERENT states and both must be selected: " +
        "@default fills only rows Prisma creates, so the 43,233 documents " +
        "written before the field existed carry no such attribute at all",
    );
    const absent = arms.find(
      (a) => typeof a.parseStatus === "object" && a.parseStatus !== null,
    );
    assert.ok(absent, "one arm must target the ABSENT case");
    assert.deepStrictEqual(
      absent.parseStatus,
      { isSet: false },
      "the absent case is `isSet: false` — NOT `null`, which on Mongo matches " +
        "only STORED nulls and never a missing key",
    );
  });
});
