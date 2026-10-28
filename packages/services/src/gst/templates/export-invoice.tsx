/**
 * GST Export Invoice PDF Template - UMAI/EXP/YY-YY/NNNN
 *
 * Renders an export-of-services invoice under LUT (zero-rated IGST). The
 * template wording is CGST-Rules-mandatory and was reviewed by the CA before
 * the first prod run - DO NOT freelance the declaration or FX disclosure
 * strings without re-running CA review (see MONEY-217 sign-off process).
 *
 * Mandatory blocks per CGST §31 + Rules 46/89:
 *   - Both parties' legal name + address (buyer GSTIN: "N/A - foreign buyer")
 *   - Sequential invoice number + date
 *   - SAC code, description with billing period
 *   - Taxable value in BOTH foreign currency AND INR
 *   - IGST 0% (zero-rated under LUT)
 *   - Total in words
 *   - LUT declaration block (verbatim wording)
 *   - AS-11 currency conversion note (verbatim wording)
 *   - RBI reference rate audit trail in footer
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
  // Top banner
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
  // Two-column parties
  parties: {
    flexDirection: "row",
    gap: 20,
    marginBottom: 14,
  },
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
  // Meta row (date, period, place of supply)
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
  // Line items table
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
  // Totals box
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
  // Amount in words
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
  // Declaration & FX note
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
  // Bank details
  bankBox: {
    flexDirection: "row",
    gap: 16,
    marginBottom: 12,
    padding: 8,
    borderWidth: 1,
    borderColor: C.border,
  },
  bankCol: { flex: 1 },
  // Footer
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

export interface GstExportInvoiceProps {
  // Number + dates
  invoiceNumber: string;
  invoiceDate: Date;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  placeOfSupply: string;
  // Seller (DIS Digital LLP - from env)
  seller: {
    legalName: string;
    address: string;
    gstin: string;
    pan: string;
    stateCode: string;
  };
  // Buyer snapshot (denormalised)
  buyer: {
    name: string;
    email: string;
    country: string;
    address: string;
  };
  // Money
  currencyCode: string;
  exchangeRate: number;
  exchangeRateDate: Date;
  exchangeRateSource: string;
  subtotalForeign: number;
  subtotalInr: number;
  totalInr: number;
  // Items
  items: Array<{
    description: string;
    hsnSac: string;
    quantity: number;
    unitPriceForeign: number;
    lineTotalForeign: number;
  }>;
  // LUT
  lutNumber: string;
  // Bank
  bank: {
    beneficiary: string;
    account: string;
    ifsc: string;
    swift: string;
  };
}

const fmtDate = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, "0")} ${
    [
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
    ][d.getUTCMonth()]
  } ${d.getUTCFullYear()}`;

const fmtMoney = (amount: number, currency: string) => {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${currency} ${formatted}`;
};

/**
 * Convert a number to words for the "amount in words" line. Indian numbering
 * system (Crore / Lakh / Thousand). Up to 99,99,99,999.99.
 */
function amountToWords(num: number): string {
  // Defensive: invoice flows always pass positives, but credit-note + bug
  // paths could surface negatives. Guard so the PDF doesn't render an empty
  // "Rupees Only" line.
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

export function GstExportInvoiceDocument(props: GstExportInvoiceProps) {
  const periodLabel = `${fmtDate(props.billingPeriodStart)} – ${fmtDate(props.billingPeriodEnd)}`;
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
            <Text style={styles.partyLabel}>Seller (Exporter)</Text>
            <Text style={styles.partyName}>{props.seller.legalName}</Text>
            <Text style={styles.partyMeta}>{props.seller.address}</Text>
            <Text style={styles.partyMeta}>GSTIN: {props.seller.gstin}</Text>
            <Text style={styles.partyMeta}>PAN: {props.seller.pan}</Text>
            <Text style={styles.partyMeta}>
              State Code: {props.seller.stateCode}
            </Text>
          </View>
          <View style={styles.partyBox}>
            <Text style={styles.partyLabel}>Buyer (Recipient)</Text>
            <Text style={styles.partyName}>{props.buyer.name}</Text>
            <Text style={styles.partyMeta}>{props.buyer.address}</Text>
            <Text style={styles.partyMeta}>Country: {props.buyer.country}</Text>
            <Text style={styles.partyMeta}>
              GSTIN: N/A - foreign buyer (export of services)
            </Text>
          </View>
        </View>

        {/* Meta row */}
        <View style={styles.metaRow}>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>Invoice Date</Text>
            <Text style={styles.metaValue}>{fmtDate(props.invoiceDate)}</Text>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>Billing Period</Text>
            <Text style={styles.metaValue}>{periodLabel}</Text>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>Place of Supply</Text>
            <Text style={styles.metaValue}>
              {props.placeOfSupply || "96 - Other Territory"}
            </Text>
          </View>
        </View>

        {/* Items */}
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.th, styles.thDescription]}>Description</Text>
            <Text style={[styles.th, styles.thHsn]}>SAC</Text>
            <Text style={[styles.th, styles.thQty]}>Qty</Text>
            <Text style={[styles.th, styles.thRate]}>
              Rate ({props.currencyCode})
            </Text>
            <Text style={[styles.th, styles.thAmount]}>
              Amount ({props.currencyCode})
            </Text>
          </View>
          {props.items.map((item, idx) => (
            <View key={idx} style={styles.tr}>
              <Text style={[styles.td, styles.thDescription]}>
                {item.description}
              </Text>
              <Text style={[styles.td, styles.thHsn]}>{item.hsnSac}</Text>
              <Text style={[styles.td, styles.thQty]}>{item.quantity}</Text>
              <Text style={[styles.td, styles.thRate]}>
                {fmtMoney(item.unitPriceForeign, props.currencyCode)}
              </Text>
              <Text style={[styles.td, styles.thAmount]}>
                {fmtMoney(item.lineTotalForeign, props.currencyCode)}
              </Text>
            </View>
          ))}
        </View>

        {/* Totals */}
        <View style={styles.totalsBox}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>
              Taxable value ({props.currencyCode})
            </Text>
            <Text style={styles.totalValue}>
              {fmtMoney(props.subtotalForeign, props.currencyCode)}
            </Text>
          </View>
          <View style={styles.totalRowAlt}>
            <Text style={styles.totalLabel}>
              Taxable value (INR @ {props.exchangeRate.toFixed(4)})
            </Text>
            <Text style={styles.totalValue}>
              {fmtMoney(props.subtotalInr, "INR")}
            </Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>IGST @ 0% (zero-rated, LUT)</Text>
            <Text style={styles.totalValue}>{fmtMoney(0, "INR")}</Text>
          </View>
          <View style={styles.grandTotalRow}>
            <Text style={styles.grandTotalLabel}>Total (INR)</Text>
            <Text style={styles.grandTotalValue}>
              {fmtMoney(props.totalInr, "INR")}
            </Text>
          </View>
        </View>

        {/* Amount in words */}
        <View style={styles.amountWordsBox}>
          <Text style={styles.amountWordsLabel}>Amount in words (INR)</Text>
          <Text style={styles.amountWordsValue}>
            {amountToWords(props.totalInr)}
          </Text>
        </View>

        {/* Declaration block - verbatim wording, do NOT freelance */}
        <View style={styles.declarationBox}>
          <Text style={styles.declarationLabel}>Declaration</Text>
          <Text style={styles.declarationText}>
            Supply meant for export of services under Letter of Undertaking
            (LUT) without payment of Integrated Tax. LUT ARN: {props.lutNumber}.
            Place of supply: {props.placeOfSupply || "96 - Other Territory"}.
          </Text>
        </View>

        {/* FX disclosure - verbatim wording per AS-11 */}
        {props.currencyCode !== "INR" && (
          <View style={styles.declarationBox}>
            <Text style={styles.declarationLabel}>Currency Conversion</Text>
            <Text style={styles.declarationText}>
              INR equivalent computed at RBI reference rate of{" "}
              {props.exchangeRate.toFixed(4)} on{" "}
              {fmtDate(props.exchangeRateDate)} as per AS-11.
            </Text>
          </View>
        )}

        {/* Bank details */}
        <View style={styles.bankBox}>
          <View style={styles.bankCol}>
            <Text style={styles.partyLabel}>Beneficiary</Text>
            <Text style={styles.partyMeta}>{props.bank.beneficiary}</Text>
            <Text style={styles.partyMeta}>A/c: {props.bank.account}</Text>
          </View>
          <View style={styles.bankCol}>
            <Text style={styles.partyLabel}>Routing</Text>
            <Text style={styles.partyMeta}>IFSC: {props.bank.ifsc}</Text>
            <Text style={styles.partyMeta}>SWIFT: {props.bank.swift}</Text>
          </View>
        </View>

        {/* Footer with FX audit trail */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            FX rate source: {props.exchangeRateSource} · Generated{" "}
            {fmtDate(new Date())} · This is a system-generated document; no
            signature required.
          </Text>
        </View>
      </Page>
    </Document>
  );
}
