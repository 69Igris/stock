/**
 * Reading the lake DDL. MONEY-1472 (data-platform B1).
 *
 * PURE — no BigQuery, no filesystem. `scripts/ops/lake-apply-ddl.ts` is the I/O
 * shell, per the run protocol's `<name>-logic.ts` (pure) + `<name>.ts` (shell)
 * split. It lives in the PACKAGE rather than beside the script so the tests can
 * import it across a workspace boundary: a script that also does I/O straddles
 * ESM and CJS under tsx, and its named exports are then invisible to an
 * importing test.
 */

/**
 * Split a .sql file into statements, respecting quotes.
 *
 * QUOTE-AWARE, not a `split(";")`. The first cut forbade a `;` inside a string
 * literal and threw — and the very first DDL file tripped it FIVE times,
 * because `OPTIONS(description = "...")` is prose and prose has semicolons in
 * it. Forbidding punctuation in a comment field is a trap set for whoever
 * writes the next migration; tracking the quote is ten lines.
 *
 * Handles the three delimiters BigQuery uses — `"`, `'` and a backtick
 * identifier — plus backslash escapes inside them.
 */
export function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

  const out: string[] = [];
  let buf = "";
  let quote: string | null = null;

  for (let i = 0; i < withoutComments.length; i++) {
    const ch = withoutComments[i]!;

    if (quote) {
      buf += ch;
      // A backslash escapes the NEXT character, including the closing quote.
      if (ch === "\\" && i + 1 < withoutComments.length) {
        buf += withoutComments[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      buf += ch;
      continue;
    }

    if (ch === ";") {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = "";
      continue;
    }
    buf += ch;
  }

  if (quote) {
    // An unterminated literal means the file is malformed, and running the
    // fragment would produce a parse error pointing at the wrong place.
    throw new Error(`unterminated ${quote} string literal in the DDL`);
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/** `{{DATASET}}` -> `lake_bronze_{env}`. Refuses an unsubstituted placeholder. */
export function renderDdl(
  sql: string,
  datasetOrSubs: string | Readonly<Record<string, string>>,
): string {
  // A GOLD object is almost always a projection OVER silver, so its SQL has to
  // name TWO datasets: its own and its source. `{{DATASET}}` alone cannot
  // express that — MONEY-1498 found it while writing
  // `005_gold_instrument_current.sql`.
  //
  // A plain string still means `{{DATASET}}`, so every existing call site and
  // every existing test passes verbatim; the map form is purely additive.
  const subs =
    typeof datasetOrSubs === "string"
      ? { DATASET: datasetOrSubs }
      : datasetOrSubs;

  let out = sql;
  for (const [key, value] of Object.entries(subs)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }

  const leftover = out.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) {
    // A statement carrying `{{...}}` would run and create a table literally
    // named that — a silently wrong schema that every later loader misses.
    // Refusing is what makes the map form safe: a typo'd key does not fall
    // through to a default dataset, it stops the run.
    throw new Error(
      `unsubstituted placeholder ${leftover[0]} in the DDL — ` +
        `known keys: ${Object.keys(subs).sort().join(", ")}`,
    );
  }
  return out;
}
