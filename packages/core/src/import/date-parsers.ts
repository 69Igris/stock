/**
 * Date parsing utilities for trade imports.
 * Handles ISO, DD-MM-YYYY, DD/MM/YYYY, and datetime formats.
 */

/**
 * Parse a date string in multiple formats.
 * Supports: ISO (YYYY-MM-DD), DD-MM-YYYY, DD/MM/YYYY.
 * Returns null for unparseable strings.
 */
export function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const cleaned = dateStr.trim();

  // Try ISO format first (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)
  if (/^\d{4}-\d{2}-\d{2}/.test(cleaned)) {
    const date = new Date(cleaned);
    if (!isNaN(date.getTime())) return date;
  }

  // Try DD/MM/YYYY or DD-MM-YYYY format
  const dmyMatch = cleaned.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (dmyMatch && dmyMatch[1] && dmyMatch[2] && dmyMatch[3]) {
    const yearNum = parseInt(dmyMatch[3]);
    const year = yearNum < 100 ? yearNum + 2000 : yearNum;
    const date = new Date(
      year,
      parseInt(dmyMatch[2]) - 1,
      parseInt(dmyMatch[1]),
    );
    if (!isNaN(date.getTime())) return date;
  }

  // Fallback to standard Date parse
  const standardParse = new Date(cleaned);
  if (!isNaN(standardParse.getTime())) return standardParse;

  return null;
}

/**
 * Parse a datetime string (includes time component).
 * Supports: ISO (YYYY-MM-DDTHH:mm:ss), YYYY-MM-DD HH:mm:ss.
 * Returns null for unparseable strings.
 */
export function parseDateTime(dateTimeStr: string): Date | null {
  if (!dateTimeStr) return null;

  // Try ISO format (2025-10-08T00:00:00)
  const isoParse = new Date(dateTimeStr);
  if (!isNaN(isoParse.getTime())) return isoParse;

  // Try YYYY-MM-DD HH:mm:ss
  const isoSpaceMatch = dateTimeStr.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})$/,
  );
  if (
    isoSpaceMatch &&
    isoSpaceMatch[1] &&
    isoSpaceMatch[2] &&
    isoSpaceMatch[3] &&
    isoSpaceMatch[4] &&
    isoSpaceMatch[5] &&
    isoSpaceMatch[6]
  ) {
    return new Date(
      parseInt(isoSpaceMatch[1]),
      parseInt(isoSpaceMatch[2]) - 1,
      parseInt(isoSpaceMatch[3]),
      parseInt(isoSpaceMatch[4]),
      parseInt(isoSpaceMatch[5]),
      parseInt(isoSpaceMatch[6]),
    );
  }

  return null;
}
