/**
 * RFC-4180 CSV line splitting — the ONE copy — MONEY-1205.
 *
 * ## Why this file exists
 *
 * Three feed parsers in this package need to split a CSV line while honouring
 * double-quoted fields, and until this file there were two implementations and
 * one line-noise `split(",")`:
 *
 *   - `instruments/nse-master-logic.ts` had the good one, but MODULE-PRIVATE.
 *   - `mwpl-logic.ts` carried a hand-copied duplicate whose own comment said
 *     "a local copy of the splitter in `instruments/nse-master-logic.ts`,
 *     which is module-private there".
 *   - `instruments/zerodha-instruments-logic.ts` had `line.split(",")`, and
 *     that is the defect: Kite's `/instruments` dump quotes its `name` column
 *     (106,262 of 114,427 lines on 2026-08-18), so a naive split kept the
 *     literal quote characters and 13,287 of 26,669 `InstrumentMapping.name`
 *     values on prod were stored as `"SBI NIFTY 200 QUALITY 30 ETF"` —
 *     quotes and all — including 540 of 541 active ETFs.
 *
 * A private helper that other modules can only consume by copy-paste is how the
 * third caller ends up writing a fourth implementation instead of a fourth
 * import. So the implementation moved here and all three now import it. There
 * is no other copy; `csv-line.test.ts` pins the behaviour.
 *
 * ## Scope
 *
 * Deliberately a LINE splitter, not a document parser: it does not handle a
 * newline inside a quoted field, because no feed this package ingests has ever
 * produced one and pretending otherwise would mean rewriting three callers'
 * line-splitting too. A quoted field containing a newline would surface as a
 * field-count rejection in the caller, which is counted and logged rather than
 * silently dropped.
 */

/**
 * Split one CSV line into its fields, honouring double-quoted cells.
 *
 * - A quoted cell's surrounding quotes are REMOVED: `"A B"` yields `A B`.
 * - A comma inside quotes is literal: `"A, B"` yields one field `A, B`.
 * - A doubled quote inside a quoted cell is one literal quote: `"A""B"` yields
 *   `A"B`.
 * - Whitespace is NOT trimmed here. Callers that want the legacy trim apply it
 *   themselves, so this function stays a faithful splitter and the trimming
 *   policy stays visible at the call site.
 *
 * An unbalanced quote does not throw — it runs to end of line, which yields a
 * short field count that every caller already treats as a counted rejection.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // A doubled quote inside a quoted field is a literal quote.
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
