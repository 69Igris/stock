/**
 * Domestic GST Tax Invoice PDF - UMAI/DOM/YY-YY/NNNN (MONEY-227).
 *
 * Issued to individual Indian users via /billing. Distinct from the export
 * template (export-invoice.tsx) in three ways:
 *   - No LUT declaration; replaced by §31 CGST tax-invoice statement
 *   - No FX section; supply is always INR
 *   - Tax breakdown shows CGST/SGST or IGST per place-of-supply rule
 *
 * The mandatory CGST Rules 46 fields are still all present:
 *   - Both parties (seller GSTIN displayed; buyer GSTIN if B2B)
 *   - Sequential invoice number + date
 *   - SAC code, description
 *   - Taxable value, tax breakdown, total
 *   - Total in words
 *   - Place of supply (state code)
 */

import React from "react";
import { Document, Page, View, Text, StyleSheet } from "@react-pdf/renderer";

const C = {
  primary: "#0f172a",
  text: "#0f172a",
  muted: "#475569",
  border: "#cbd5e1",
  accent: "#1e40af",
  surface: "#ffffff",
  zebra: "#f8fafc",
};

const styles = StyleSheet.create({
  page: {
    padding: 36,
    fontFamily: "Helvetica",
    fontSize: 9,
    color: C.text,
    backgroundColor: C.surface,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 2,
    borderBottomColor: C.primary,
    paddingBottom: 10,
    marginBottom: 14,
  },
  brand: { fontSize: 16, fontFamily: "Helvetica-Bold", color: C.primary },
  brandTagline: { fontSize: 8, color: C.muted, marginTop: 2 },
  invoiceNumberBox: { textAlign: "right" },
  invoiceTitle: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  invoiceNumberLabel: { fontSize: 8, color: C.muted, marginTop: 4 },
  invoiceNumberValue: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    marginTop: 2,
  },
  parties: { flexDirection: "row", gap: 20, marginBottom: 14 },
  partyBox: {
    flex: 1,
    borderWidth: 1,
    borderColor: C.border,
    padding: 8,
  },
  partyLabel: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: C.accent,
    marginBottom: 4,
    textTransform: "uppercase",
  },
  partyName: { fontSize: 10, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  partyMeta: { fontSize: 8, color: C.muted, marginBottom: 1 },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: C.border,
    paddingVertical: 6,
    marginBottom: 12,
  },
  metaCell: { flex: 1 },
  metaLabel: { fontSize: 7, color: C.muted, textTransform: "uppercase" },
  metaValue: { fontSize: 10, fontFamily: "Helvetica-Bold", marginTop: 2 },
  table: { marginBottom: 12 },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: C.primary,
    paddingVertical: 6,
    paddingHorizontal: 6,
  },
  th: { fontSize: 8, fontFamily: "Helvetica-Bold", color: C.surface },
  thDescription: { flex: 4 },
  thHsn: { flex: 1, textAlign: "center" },
  thQty: { flex: 1, textAlign: "right" },
  thRate: { flex: 1.5, textAlign: "right" },
  thAmount: { flex: 1.5, textAlign: "right" },
  tr: {
    flexDirection: "row",
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderBottomWidth: 0.5,
    borderBottomColor: C.border,
  },
  td: { fontSize: 9 },
  totalsBox: {
    alignSelf: "flex-end",
    width: "55%",
    marginBottom: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  totalRowAlt: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: C.zebra,
  },
  grandTotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: C.primary,
  },
  grandTotalLabel: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: C.surface,
  },
  grandTotalValue: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: C.surface,
  },
  totalLabel: { fontSize: 9, color: C.text },
  totalValue: { fontSize: 9, fontFamily: "Helvetica-Bold" },
  amountWordsBox: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: C.border,
    paddingVertical: 6,
    paddingHorizontal: 8,
    marginBottom: 12,
  },
  amountWordsLabel: { fontSize: 7, color: C.muted, marginBottom: 2 },
  amountWordsValue: { fontSize: 9, fontFamily: "Helvetica-Bold" },
  declarationBox: {
    backgroundColor: C.zebra,
    padding: 8,
    marginBottom: 8,
    borderLeftWidth: 3,
    borderLeftColor: C.accent,
  },
  declarationLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    color: C.accent,
    textTransform: "uppercase",
    marginBottom: 3,
  },
  declarationText: { fontSize: 8, lineHeight: 1.4 },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 36,
    right: 36,
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingTop: 6,
  },
  footerText: { fontSize: 7, color: C.muted, textAlign: "center" },
});

export interface GstDomesticInvoiceProps {
  invoiceNumber: string;
  invoiceDate: Date;
  paymentDate?: Date;
  placeOfSupply: string; // GST state code, e.g. "27"
  seller: {
    legalName: string;
    address: string;
    gstin: string;
    pan: string;
    stateCode: string;
  };
  // Indian buyer block - name + address always present; gstin only B2B; pan optional
  buyer: {
    name: string;
    address: string;
    stateCode: string;
    gstin?: string;
    pan?: string;
  };
  // Money - always INR for domestic flow
  subtotalInr: number;
  cgstRate: number;
  cgstAmountInr: number;
  sgstRate: number;
  sgstAmountInr: number;
  igstRate: number;
  igstAmountInr: number;
  totalTaxInr: number;
  totalInr: number;
  items: Array<{
    description: string;
    hsnSac: string;
    quantity: number;
    unitPriceForeign: number; // Reused field name; for domestic it's INR
    lineTotalForeign: number;
  }>;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const fmtDate = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

const fmtInr = (amount: number) => {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  return `${sign}₹${abs.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

function amountToWords(num: number): string {
  const negative = num < 0;
  const abs = Math.abs(num);
  const [whole, fraction] = abs.toFixed(2).split(".");
  const wholeWords = numToIndianWords(parseInt(whole!, 10));
  const fracNum = parseInt(fraction!, 10);
  const fracWords =
    fracNum > 0 ? ` and ${numToIndianWords(fracNum)} Paise` : "";
  const sign = negative ? "Negative " : "";
  return `${sign}${wholeWords} Rupees${fracWords} Only`;
}

function numToIndianWords(n: number): string {
  if (n === 0) return "Zero";
  const ones = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];
  const tens = [
    "",
    "",
    "Twenty",
    "Thirty",
    "Forty",
    "Fifty",
    "Sixty",
    "Seventy",
    "Eighty",
    "Ninety",
  ];
  const twoDigit = (x: number): string => {
    if (x < 20) return ones[x]!;
    return `${tens[Math.floor(x / 10)]}${x % 10 ? " " + ones[x % 10] : ""}`;
  };
  const threeDigit = (x: number): string => {
    const h = Math.floor(x / 100);
    const r = x % 100;
    return `${h ? `${ones[h]} Hundred${r ? " " : ""}` : ""}${twoDigit(r)}`;
  };
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thou = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;
  return [
    crore ? `${twoDigit(crore)} Crore` : "",
    lakh ? `${twoDigit(lakh)} Lakh` : "",
    thou ? `${twoDigit(thou)} Thousand` : "",
    rest ? threeDigit(rest) : "",
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function GstDomesticInvoiceDocument(props: GstDomesticInvoiceProps) {
  const isB2B = !!props.buyer.gstin;
  const isInterState = props.buyer.stateCode !== props.seller.stateCode;
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>UseMoney</Text>
            <Text style={styles.brandTagline}>{props.seller.legalName}</Text>
          </View>
          <View style={styles.invoiceNumberBox}>
            <Text style={styles.invoiceTitle}>TAX INVOICE</Text>
            <Text style={styles.invoiceNumberLabel}>Invoice Number</Text>
            <Text style={styles.invoiceNumberValue}>{props.invoiceNumber}</Text>
          </View>
        </View>

        {/* Parties */}
        <View style={styles.parties}>
          <View style={styles.partyBox}>
            <Text style={styles.partyLabel}>Seller</Text>
            <Text style={styles.partyName}>{props.seller.legalName}</Text>
            <Text style={styles.partyMeta}>{props.seller.address}</Text>
            <Text style={styles.partyMeta}>GSTIN: {props.seller.gstin}</Text>
            <Text style={styles.partyMeta}>PAN: {props.seller.pan}</Text>
            <Text style={styles.partyMeta}>
              State Code: {props.seller.stateCode}
            </Text>
          </View>
          <View style={styles.partyBox}>
            <Text style={styles.partyLabel}>
              {isB2B ? "Buyer (B2B)" : "Buyer"}
            </Text>
            <Text style={styles.partyName}>{props.buyer.name}</Text>
            <Text style={styles.partyMeta}>{props.buyer.address}</Text>
            <Text style={styles.partyMeta}>
              State Code: {props.buyer.stateCode}
            </Text>
            {props.buyer.gstin && (
              <Text style={styles.partyMeta}>GSTIN: {props.buyer.gstin}</Text>
            )}
            {props.buyer.pan && (
              <Text style={styles.partyMeta}>PAN: {props.buyer.pan}</Text>
            )}
            {!props.buyer.gstin && (
              <Text style={styles.partyMeta}>
                GSTIN: N/A - unregistered buyer (B2C)
              </Text>
            )}
          </View>
        </View>

        {/* Meta row */}
        <View style={styles.metaRow}>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>Invoice Date</Text>
            <Text style={styles.metaValue}>{fmtDate(props.invoiceDate)}</Text>
          </View>
          {props.paymentDate && (
            <View style={styles.metaCell}>
              <Text style={styles.metaLabel}>Payment Date</Text>
              <Text style={styles.metaValue}>{fmtDate(props.paymentDate)}</Text>
            </View>
          )}
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>Place of Supply</Text>
            <Text style={styles.metaValue}>{props.placeOfSupply}</Text>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>Tax Type</Text>
            <Text style={styles.metaValue}>
              {isInterState
                ? "IGST (Inter-state)"
                : "CGST + SGST (Intra-state)"}
            </Text>
          </View>
        </View>

        {/* Items */}
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.th, styles.thDescription]}>Description</Text>
            <Text style={[styles.th, styles.thHsn]}>SAC</Text>
            <Text style={[styles.th, styles.thQty]}>Qty</Text>
            <Text style={[styles.th, styles.thRate]}>Rate (INR)</Text>
            <Text style={[styles.th, styles.thAmount]}>Amount (INR)</Text>
          </View>
          {props.items.map((item, idx) => (
            <View key={idx} style={styles.tr}>
              <Text style={[styles.td, styles.thDescription]}>
                {item.description}
              </Text>
              <Text style={[styles.td, styles.thHsn]}>{item.hsnSac}</Text>
              <Text style={[styles.td, styles.thQty]}>{item.quantity}</Text>
              <Text style={[styles.td, styles.thRate]}>
                {fmtInr(item.unitPriceForeign)}
              </Text>
              <Text style={[styles.td, styles.thAmount]}>
                {fmtInr(item.lineTotalForeign)}
              </Text>
            </View>
          ))}
        </View>

        {/* Totals */}
        <View style={styles.totalsBox}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Taxable Value</Text>
            <Text style={styles.totalValue}>{fmtInr(props.subtotalInr)}</Text>
          </View>
          {isInterState ? (
            <View style={styles.totalRowAlt}>
              <Text style={styles.totalLabel}>
                IGST @ {props.igstRate.toFixed(2)}%
              </Text>
              <Text style={styles.totalValue}>
                {fmtInr(props.igstAmountInr)}
              </Text>
            </View>
          ) : (
            <>
              <View style={styles.totalRowAlt}>
                <Text style={styles.totalLabel}>
                  CGST @ {props.cgstRate.toFixed(2)}%
                </Text>
                <Text style={styles.totalValue}>
                  {fmtInr(props.cgstAmountInr)}
                </Text>
              </View>
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>
                  SGST @ {props.sgstRate.toFixed(2)}%
                </Text>
                <Text style={styles.totalValue}>
                  {fmtInr(props.sgstAmountInr)}
                </Text>
              </View>
            </>
          )}
          <View style={styles.totalRowAlt}>
            <Text style={styles.totalLabel}>Total Tax</Text>
            <Text style={styles.totalValue}>{fmtInr(props.totalTaxInr)}</Text>
          </View>
          <View style={styles.grandTotalRow}>
            <Text style={styles.grandTotalLabel}>Total (INR)</Text>
            <Text style={styles.grandTotalValue}>{fmtInr(props.totalInr)}</Text>
          </View>
        </View>

        {/* Amount in words */}
        <View style={styles.amountWordsBox}>
          <Text style={styles.amountWordsLabel}>Amount in words (INR)</Text>
          <Text style={styles.amountWordsValue}>
            {amountToWords(props.totalInr)}
          </Text>
        </View>

        {/* §31 declaration - verbatim, do NOT freelance */}
        <View style={styles.declarationBox}>
          <Text style={styles.declarationLabel}>Tax Invoice</Text>
          <Text style={styles.declarationText}>
            Tax invoice issued under §31 of the Central Goods and Services Tax
            Act, 2017. This is a system-generated document and does not require
            a physical signature. Place of supply: {props.placeOfSupply}.
          </Text>
        </View>

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Generated {fmtDate(new Date())} · Questions? Reply to your
            payment-confirmation email or visit usemoney.ai/help.
          </Text>
        </View>
      </Page>
    </Document>
  );
}
