/**
 * Top-level file parsing orchestrator.
 * Routes to CSV or XLSX parser based on file type.
 */

import type { ParsedFileData } from "./types";
import { parseCSVContent } from "./csv-parser";
import { parseXLSXContent } from "./xlsx-parser";

/**
 * Parse an uploaded file (CSV or XLSX) into structured row data.
 *
 * @param content - File content (plain text for CSV, base64-encoded for XLSX)
 * @param fileType - "csv" or "xlsx"
 * @returns Parsed rows, column names, and any parsing errors
 */
export function parseFile(
  content: string,
  fileType: "csv" | "xlsx",
): ParsedFileData {
  if (fileType === "xlsx") {
    return parseXLSXContent(content);
  }
  return parseCSVContent(content);
}
