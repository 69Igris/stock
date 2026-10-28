/**
 * Sanitize file content to prevent formula injection attacks.
 * CSV/XLSX cells starting with =, +, -, or @ can execute formulas
 * when opened in spreadsheet applications.
 */

const FORMULA_PREFIXES = ["=", "+", "-", "@"] as const;

function startsWithFormulaChar(value: string): boolean {
  return FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * Neutralize formula injection on a single PARSED cell value (i.e. after any
 * CSV unquoting/escaping has already happened). If the value begins with a
 * dangerous formula character, it is prefixed with a single quote so that
 * spreadsheet applications render it as literal text. Returns the value
 * unchanged when it is not a formula, so legitimate cells are preserved
 * byte-for-byte.
 */
export function neutralizeFormulaCell(value: string): string {
  if (startsWithFormulaChar(value)) {
    return "'" + value;
  }
  return value;
}

/**
 * Neutralize a single raw (still-quoted) CSV cell. Handles the CSV-quoted case
 * `"=cmd"` where the leading double-quote would otherwise shift the formula
 * character out of the first position and let the injection survive: the
 * single quote is inserted *inside* the surrounding quotes so the neutralized
 * cell stays a valid quoted field (`"'=cmd"`). Unquoted cells keep the existing
 * trim-then-prefix behavior. Non-formula cells are returned unchanged.
 */
function neutralizeRawCell(cell: string): string {
  const trimmed = cell.trim();

  // CSV-quoted cell: inspect the content *inside* the surrounding quotes.
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed.slice(1, -1).trimStart();
    if (startsWithFormulaChar(inner)) {
      // Re-emit as a quoted cell with the neutralizing quote inside.
      return "\"'" + trimmed.slice(1);
    }
    return cell;
  }

  if (startsWithFormulaChar(trimmed)) {
    return "'" + trimmed;
  }
  return cell;
}

/**
 * Neutralize formula injection in CSV content by prefixing dangerous cells
 * with a single quote. Operates on raw CSV text before parsing and is
 * quote-aware so a CSV-quoted formula such as `"=cmd|calc"` is neutralized too.
 */
export function sanitizeFormulaInjection(content: string): string {
  return content
    .split("\n")
    .map((line) => line.split(",").map(neutralizeRawCell).join(","))
    .join("\n");
}
