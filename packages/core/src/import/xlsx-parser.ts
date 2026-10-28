/**
 * XLSX (Excel) file parsing using the xlsx library.
 * Handles header row scanning in workbooks with metadata rows.
 */

import * as XLSX from "xlsx";
import type { ParsedFileData } from "./types";
import { neutralizeFormulaCell } from "./sanitize";

/**
 * Parse XLSX content (base64-encoded) into structured row data.
 * Handles:
 * - Base64 decoding
 * - Multi-sheet workbooks (uses first sheet)
 * - Header row detection (skips metadata rows)
 * - Empty row filtering
 */
export function parseXLSXContent(base64Content: string): ParsedFileData {
  try {
    const binaryStr = atob(base64Content);
    const workbook = XLSX.read(binaryStr, { type: "binary" });

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      return {
        rows: [],
        columns: [],
        errors: ["No sheets found in Excel file"],
      };
    }

    const worksheet = workbook.Sheets[sheetName]!;

    // Get as array of arrays to find the actual header row
    const aoa = XLSX.utils.sheet_to_json<string[]>(worksheet, {
      header: 1,
      raw: false,
      defval: "",
    });

    // Find header row - look for a row that contains expected column names
    const expectedHeaders = [
      "symbol",
      "trade date",
      "trade_date",
      "quantity",
      "price",
      "trade type",
      "trade_type",
      "isin",
    ];
    let headerRowIndex = -1;

    for (let i = 0; i < Math.min(aoa.length, 30); i++) {
      const row = aoa[i];
      if (!row || !Array.isArray(row)) continue;

      const rowLower = row.map((cell) =>
        String(cell || "")
          .toLowerCase()
          .trim(),
      );
      const matchCount = expectedHeaders.filter((h) =>
        rowLower.some((cell) => cell.includes(h)),
      ).length;

      if (matchCount >= 3) {
        headerRowIndex = i;
        break;
      }
    }

    if (headerRowIndex === -1) headerRowIndex = 0;

    // Get column headers from the identified row
    const headerRow = aoa[headerRowIndex] || [];
    const columns: string[] = headerRow.map((cell, idx) =>
      cell ? String(cell).trim() : `Column${idx}`,
    );

    // Parse data rows (everything after header row)
    const rows: Record<string, unknown>[] = [];
    for (let i = headerRowIndex + 1; i < aoa.length; i++) {
      const rowData = aoa[i];
      if (!rowData || !Array.isArray(rowData)) continue;

      // Skip empty rows
      const hasData = rowData.some(
        (cell) => cell && String(cell).trim() !== "",
      );
      if (!hasData) continue;

      const rowObj: Record<string, unknown> = {};
      columns.forEach((col, idx) => {
        // Neutralize formula injection on the parsed cell value. XLSX content
        // is not run through the raw text sanitizer (it is base64 binary), so
        // this is the only guard against a cell like "=cmd|calc" reaching
        // persistence/display.
        const cell =
          rowData[idx] !== undefined ? String(rowData[idx]).trim() : "";
        rowObj[col] = neutralizeFormulaCell(cell);
      });
      rows.push(rowObj);
    }

    return { rows, columns, errors: [] };
  } catch (error) {
    return {
      rows: [],
      columns: [],
      errors: [
        `Failed to parse Excel file: ${error instanceof Error ? error.message : "Unknown error"}`,
      ],
    };
  }
}
