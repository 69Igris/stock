/**
 * GSTR-1 Table 6A - Export of Services CSV exporter.
 *
 * GSTR-1 is the monthly outward-supplies return. Table 6A is the section
 * for export of services. The GST portal's offline utility imports a CSV
 * with a STRICT column order - extra spaces, reordered columns, or wrong
 * column header text will break the import. This module produces the CSV
 * the offline utility expects.
 *
 * Column order (exact, do NOT rearrange):
 *   1. GSTIN of recipient        - blank for foreign buyers
 *   2. Invoice No.
 *   3. Invoice Date              - DD-MM-YYYY
 *   4. Invoice Value             - total INR including tax (zero for LUT)
 *   5. Port Code                 - blank for services
 *   6. Shipping Bill No.         - blank
 *   7. Shipping Bill Date        - blank
 *   8. GST Rate                  - 0 for LUT
 *   9. Taxable Value             - INR taxable supply
 *   10. IGST Amount              - 0 for LUT
 *
 * One row per ISSUED invoice in the (financialYear, month) window. Cancelled
 * invoices are EXCLUDED from the GSTR-1 export but kept in the local audit
 * trail; the next month's filing reflects the cancellation via a credit note.
 */

import { prisma, GstInvoiceStatus } from "@usemoney/database";

const CSV_HEADERS = [
  "GSTIN of recipient",
  "Invoice No.",
  "Invoice Date",
  "Invoice Value",
  "Port Code",
  "Shipping Bill No.",
  "Shipping Bill Date",
  "GST Rate",
  "Taxable Value",
  "IGST Amount",
] as const;

function formatGstrDate(d: Date): string {
  // GST portal expects DD-MM-YYYY - this is NOT the ISO format we use elsewhere.
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${day}-${month}-${d.getUTCFullYear()}`;
}

function escapeCsvCell(value: string | number): string {
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export interface Gstr1ExportInput {
  /** Calendar month start (1st of month, UTC). */
  monthStart: Date;
  /** Calendar month end inclusive (last day of month, UTC). */
  monthEnd: Date;
}

export interface Gstr1ExportRow {
  recipientGstin: string;
  invoiceNumber: string;
  invoiceDate: string;
  invoiceValue: number;
  portCode: string;
  shippingBillNo: string;
  shippingBillDate: string;
  gstRate: number;
  taxableValue: number;
  igstAmount: number;
}

export interface Gstr1ExportResult {
  csv: string;
  rows: Gstr1ExportRow[];
  monthLabel: string;
}

/**
 * Build the GSTR-1 Table 6A CSV for a calendar month. Only ISSUED invoices
 * dated within the window are included; CANCELLED and DRAFT invoices are
 * excluded (CANCELLED is reported on a credit note, DRAFT shouldn't exist
 * by month-close).
 */
export async function buildGstr1Table6aCsv(
  input: Gstr1ExportInput,
): Promise<Gstr1ExportResult> {
  const invoices = await prisma.gstInvoice.findMany({
    where: {
      status: GstInvoiceStatus.ISSUED,
      invoiceDate: {
        gte: input.monthStart,
        lte: input.monthEnd,
      },
    },
    orderBy: { invoiceDate: "asc" },
  });

  const rows: Gstr1ExportRow[] = invoices.map((inv) => ({
    recipientGstin: inv.customerGstin || "", // blank for export
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: formatGstrDate(inv.invoiceDate),
    invoiceValue: inv.totalInr,
    portCode: "",
    shippingBillNo: "",
    shippingBillDate: "",
    gstRate: 0, // LUT - zero-rated
    taxableValue: inv.subtotalInr,
    igstAmount: inv.totalTaxInr || 0,
  }));

  const headerLine = CSV_HEADERS.join(",");
  const dataLines = rows.map((r) =>
    [
      escapeCsvCell(r.recipientGstin),
      escapeCsvCell(r.invoiceNumber),
      escapeCsvCell(r.invoiceDate),
      escapeCsvCell(r.invoiceValue.toFixed(2)),
      escapeCsvCell(r.portCode),
      escapeCsvCell(r.shippingBillNo),
      escapeCsvCell(r.shippingBillDate),
      escapeCsvCell(r.gstRate),
      escapeCsvCell(r.taxableValue.toFixed(2)),
      escapeCsvCell(r.igstAmount.toFixed(2)),
    ].join(","),
  );
  const csv = [headerLine, ...dataLines].join("\n") + "\n";

  const monthLabel = `${input.monthStart.toISOString().slice(0, 7)}`;
  return { csv, rows, monthLabel };
}

export const GSTR1_TABLE_6A_HEADERS = CSV_HEADERS;
