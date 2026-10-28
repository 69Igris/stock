/**
 * Tax Report PDF Template
 *
 * Generates capital gains tax summary with STCG/LTCG breakdown,
 * trade-level details, and ITR schedule references.
 */

import React from "react";
import { Document, Page, View, Text } from "@react-pdf/renderer";
import { styles, colors, formatCurrency, formatDate } from "./styles";

interface Trade {
  symbol: string;
  tradeType: string;
  quantity: number;
  price: number;
  tradeTime: Date;
  exchange: string;
}

interface Holding {
  symbol: string;
  quantity: number;
  averagePrice: number;
}

interface TaxReportProps {
  trades: Trade[];
  holdings: Holding[];
  fy: string;
}

export function TaxReportDocument({ trades, holdings, fy }: TaxReportProps) {
  const sellTrades = trades.filter((t) => t.tradeType === "SELL");

  // Calculate STCG vs LTCG (simplified: < 1 year = STCG, >= 1 year = LTCG)
  const stcgTrades: (Trade & { pnl: number })[] = [];
  const ltcgTrades: (Trade & { pnl: number })[] = [];

  for (const sell of sellTrades) {
    const holding = holdings.find((h) => h.symbol === sell.symbol);
    const costBasis = holding?.averagePrice || sell.price;
    const pnl = (sell.price - costBasis) * sell.quantity;
    // Simplified: all equity trades treated as STCG for now
    stcgTrades.push({ ...sell, pnl });
  }

  const totalSTCG = stcgTrades.reduce((sum, t) => sum + t.pnl, 0);
  const totalLTCG = ltcgTrades.reduce((sum, t) => sum + t.pnl, 0);
  const totalTurnover = sellTrades.reduce(
    (sum, t) => sum + t.price * t.quantity,
    0,
  );

  // Tax computation (FY 2025-26 rates)
  const stcgTax = Math.max(0, totalSTCG) * 0.2; // 20% STCG on equities
  const ltcgTax = Math.max(0, totalLTCG - 125000) * 0.125; // 12.5% LTCG > 1.25L

  return (
    <Document>
      <Page size='A4' style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.logo}>UseMoney</Text>
          <Text style={styles.headerDate}>
            Generated: {formatDate(new Date())}
          </Text>
        </View>

        <Text style={styles.title}>Capital Gains Tax Report</Text>
        <Text style={styles.subtitle}>Financial Year {fy}</Text>

        {/* Summary */}
        <View style={styles.summaryBox}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>
              Short-Term Capital Gains (Section 111A)
            </Text>
            <Text
              style={[
                styles.summaryValue,
                totalSTCG >= 0 ? styles.positive : styles.negative,
              ]}
            >
              {formatCurrency(totalSTCG)}
            </Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>
              Long-Term Capital Gains (Section 112A)
            </Text>
            <Text
              style={[
                styles.summaryValue,
                totalLTCG >= 0 ? styles.positive : styles.negative,
              ]}
            >
              {formatCurrency(totalLTCG)}
            </Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Total Turnover</Text>
            <Text style={styles.summaryValue}>
              {formatCurrency(totalTurnover)}
            </Text>
          </View>
          <View
            style={[
              styles.summaryRow,
              {
                borderTopWidth: 1,
                borderTopColor: colors.border,
                marginTop: 4,
                paddingTop: 4,
              },
            ]}
          >
            <Text
              style={[styles.summaryLabel, { fontFamily: "Helvetica-Bold" }]}
            >
              Estimated Tax Liability
            </Text>
            <Text style={styles.summaryValue}>
              {formatCurrency(stcgTax + ltcgTax)}
            </Text>
          </View>
        </View>

        {/* STCG Details */}
        {stcgTrades.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>
              STCG Trades ({stcgTrades.length})
            </Text>
            <View style={styles.table}>
              <View style={styles.tableHeader}>
                <Text style={[styles.tableHeaderCell, { width: "15%" }]}>
                  Date
                </Text>
                <Text style={[styles.tableHeaderCell, { width: "20%" }]}>
                  Symbol
                </Text>
                <Text style={[styles.tableHeaderCell, { width: "15%" }]}>
                  Qty
                </Text>
                <Text style={[styles.tableHeaderCell, { width: "20%" }]}>
                  Sell Price
                </Text>
                <Text style={[styles.tableHeaderCell, { width: "15%" }]}>
                  P&L
                </Text>
                <Text style={[styles.tableHeaderCell, { width: "15%" }]}>
                  Tax @20%
                </Text>
              </View>
              {stcgTrades.slice(0, 50).map((trade, i) => (
                <View
                  key={i}
                  style={i % 2 === 0 ? styles.tableRow : styles.tableRowAlt}
                >
                  <Text style={[styles.tableCell, { width: "15%" }]}>
                    {formatDate(new Date(trade.tradeTime))}
                  </Text>
                  <Text style={[styles.tableCell, { width: "20%" }]}>
                    {trade.symbol}
                  </Text>
                  <Text style={[styles.tableCell, { width: "15%" }]}>
                    {trade.quantity}
                  </Text>
                  <Text style={[styles.tableCell, { width: "20%" }]}>
                    {formatCurrency(trade.price)}
                  </Text>
                  <Text
                    style={[
                      styles.tableCell,
                      { width: "15%" },
                      trade.pnl >= 0 ? styles.positive : styles.negative,
                    ]}
                  >
                    {formatCurrency(trade.pnl)}
                  </Text>
                  <Text style={[styles.tableCell, { width: "15%" }]}>
                    {formatCurrency(Math.max(0, trade.pnl) * 0.2)}
                  </Text>
                </View>
              ))}
            </View>
          </>
        )}

        {/* Disclaimer */}
        <Text style={styles.disclaimer}>
          This report is for informational purposes only and should not be
          considered as tax advice. Consult a qualified chartered accountant for
          accurate tax computation. Tax rates are as per Finance Act 2025.
          UseMoney is not responsible for any errors in calculation.
        </Text>

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text>UseMoney Tax Report - FY {fy}</Text>
          <Text
            render={({ pageNumber, totalPages }) =>
              `Page ${pageNumber} of ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  );
}
