/**
 * Risk Report PDF Template
 *
 * Portfolio concentration, VaR estimate, drawdown metrics,
 * and rebalancing suggestions.
 */

import React from "react";
import { Document, Page, View, Text } from "@react-pdf/renderer";
import {
  styles,
  colors,
  formatCurrency,
  formatPercent,
  formatDate,
} from "./styles";

interface Holding {
  symbol: string;
  quantity: number;
  averagePrice: number;
}

interface RiskReportProps {
  holdings: Holding[];
}

export function RiskReportDocument({ holdings }: RiskReportProps) {
  const totalValue = holdings.reduce(
    (sum, h) => sum + h.quantity * h.averagePrice,
    0,
  );

  // Calculate concentration
  const holdingsWithWeight = holdings
    .map((h) => ({
      ...h,
      value: h.quantity * h.averagePrice,
      weight:
        totalValue > 0 ? ((h.quantity * h.averagePrice) / totalValue) * 100 : 0,
    }))
    .sort((a, b) => b.weight - a.weight);

  const top5Weight = holdingsWithWeight
    .slice(0, 5)
    .reduce((sum, h) => sum + h.weight, 0);

  // HHI (Herfindahl-Hirschman Index) - simplified
  const hhi = holdingsWithWeight.reduce((sum, h) => sum + h.weight ** 2, 0);
  const concentrationLevel =
    hhi > 3000 ? "HIGH" : hhi > 1500 ? "MODERATE" : "LOW";

  // Simple VaR estimate (parametric, 95% confidence, 1-day)
  // Using a rough 2% daily volatility assumption for Indian equities
  const dailyVolatility = 0.02;
  const var95 = totalValue * dailyVolatility * 1.645;

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

        <Text style={styles.title}>Portfolio Risk Report</Text>
        <Text style={styles.subtitle}>
          {holdings.length} holdings - Total Value: {formatCurrency(totalValue)}
        </Text>

        {/* Risk Summary */}
        <View style={styles.summaryBox}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Number of Holdings</Text>
            <Text style={styles.summaryValue}>{holdings.length}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Total Portfolio Value</Text>
            <Text style={styles.summaryValue}>
              {formatCurrency(totalValue)}
            </Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>
              Concentration (Top 5 Holdings)
            </Text>
            <Text
              style={[
                styles.summaryValue,
                top5Weight > 70 ? styles.negative : styles.positive,
              ]}
            >
              {formatPercent(top5Weight)}
            </Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Concentration Level (HHI)</Text>
            <Text
              style={[
                styles.summaryValue,
                concentrationLevel === "HIGH"
                  ? styles.negative
                  : concentrationLevel === "MODERATE"
                    ? { color: colors.warning }
                    : styles.positive,
              ]}
            >
              {concentrationLevel} ({Math.round(hhi)})
            </Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>
              Value at Risk (1-day, 95% CI)
            </Text>
            <Text style={[styles.summaryValue, styles.negative]}>
              {formatCurrency(var95)}
            </Text>
          </View>
        </View>

        {/* Holdings by Weight */}
        <Text style={styles.sectionTitle}>Holdings by Portfolio Weight</Text>
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.tableHeaderCell, { width: "5%" }]}>#</Text>
            <Text style={[styles.tableHeaderCell, { width: "25%" }]}>
              Symbol
            </Text>
            <Text style={[styles.tableHeaderCell, { width: "15%" }]}>Qty</Text>
            <Text style={[styles.tableHeaderCell, { width: "20%" }]}>
              Value
            </Text>
            <Text style={[styles.tableHeaderCell, { width: "15%" }]}>
              Weight
            </Text>
            <Text style={[styles.tableHeaderCell, { width: "20%" }]}>
              Status
            </Text>
          </View>
          {holdingsWithWeight.slice(0, 30).map((h, i) => (
            <View
              key={i}
              style={i % 2 === 0 ? styles.tableRow : styles.tableRowAlt}
            >
              <Text style={[styles.tableCell, { width: "5%" }]}>{i + 1}</Text>
              <Text style={[styles.tableCell, { width: "25%" }]}>
                {h.symbol}
              </Text>
              <Text style={[styles.tableCell, { width: "15%" }]}>
                {h.quantity}
              </Text>
              <Text style={[styles.tableCell, { width: "20%" }]}>
                {formatCurrency(h.value)}
              </Text>
              <Text style={[styles.tableCell, { width: "15%" }]}>
                {formatPercent(h.weight)}
              </Text>
              <Text
                style={[
                  styles.tableCell,
                  { width: "20%" },
                  h.weight > 20 ? styles.negative : styles.positive,
                ]}
              >
                {h.weight > 20
                  ? "Over-concentrated"
                  : h.weight > 10
                    ? "Watch"
                    : "OK"}
              </Text>
            </View>
          ))}
        </View>

        {/* Recommendations */}
        <Text style={styles.sectionTitle}>Rebalancing Suggestions</Text>
        <View style={styles.summaryBox}>
          {holdingsWithWeight.filter((h) => h.weight > 15).length > 0 ? (
            <Text style={[styles.tableCell, { lineHeight: 1.5 }]}>
              {holdingsWithWeight
                .filter((h) => h.weight > 15)
                .map(
                  (h) =>
                    `• Consider reducing ${h.symbol} (${formatPercent(h.weight)} of portfolio)`,
                )
                .join("\n")}
            </Text>
          ) : (
            <Text style={[styles.tableCell, styles.positive]}>
              Portfolio appears well-diversified. No immediate rebalancing
              needed.
            </Text>
          )}
        </View>

        {/* Disclaimer */}
        <Text style={styles.disclaimer}>
          Risk metrics are estimates based on simplified models. Actual risk may
          differ. Past performance does not guarantee future results. This is
          not financial advice.
        </Text>

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text>UseMoney Risk Report</Text>
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
