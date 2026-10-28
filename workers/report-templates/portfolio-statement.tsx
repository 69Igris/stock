/**
 * Portfolio Statement PDF Template
 *
 * Holdings table with cost basis, current values (at cost),
 * sector allocation summary, and P&L overview.
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
  exchange?: string;
}

interface Position {
  symbol: string;
  quantity: number;
  averagePrice: number;
  productType?: string;
}

interface PortfolioStatementProps {
  holdings: Holding[];
  positions: Position[];
  userName: string;
}

export function PortfolioStatementDocument({
  holdings,
  positions,
  userName,
}: PortfolioStatementProps) {
  const totalHoldingsValue = holdings.reduce(
    (sum, h) => sum + h.quantity * h.averagePrice,
    0,
  );

  const totalPositionsValue = positions.reduce(
    (sum, p) => sum + p.quantity * p.averagePrice,
    0,
  );

  const totalPortfolio = totalHoldingsValue + totalPositionsValue;

  // Group holdings by exchange
  const byExchange = holdings.reduce(
    (acc, h) => {
      const ex = h.exchange || "NSE";
      acc[ex] = (acc[ex] || 0) + h.quantity * h.averagePrice;
      return acc;
    },
    {} as Record<string, number>,
  );

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

        <Text style={styles.title}>Portfolio Statement</Text>
        <Text style={styles.subtitle}>
          {userName} - As of {formatDate(new Date())}
        </Text>

        {/* Portfolio Summary */}
        <View style={styles.summaryBox}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Total Holdings Value</Text>
            <Text style={styles.summaryValue}>
              {formatCurrency(totalHoldingsValue)}
            </Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Open Positions Value</Text>
            <Text style={styles.summaryValue}>
              {formatCurrency(totalPositionsValue)}
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
              Total Portfolio Value (at cost)
            </Text>
            <Text style={styles.summaryValue}>
              {formatCurrency(totalPortfolio)}
            </Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Number of Stocks</Text>
            <Text style={styles.summaryValue}>{holdings.length}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Open Positions</Text>
            <Text style={styles.summaryValue}>{positions.length}</Text>
          </View>
        </View>

        {/* Exchange Breakdown */}
        {Object.keys(byExchange).length > 1 && (
          <>
            <Text style={styles.sectionTitle}>Exchange Breakdown</Text>
            <View style={styles.summaryBox}>
              {Object.entries(byExchange)
                .sort((a, b) => b[1] - a[1])
                .map(([exchange, value]) => (
                  <View key={exchange} style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>{exchange}</Text>
                    <Text style={styles.summaryValue}>
                      {formatCurrency(value)} (
                      {formatPercent(
                        totalHoldingsValue > 0
                          ? (value / totalHoldingsValue) * 100
                          : 0,
                      )}
                      )
                    </Text>
                  </View>
                ))}
            </View>
          </>
        )}

        {/* Holdings Table */}
        <Text style={styles.sectionTitle}>Holdings ({holdings.length})</Text>
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.tableHeaderCell, { width: "5%" }]}>#</Text>
            <Text style={[styles.tableHeaderCell, { width: "25%" }]}>
              Symbol
            </Text>
            <Text style={[styles.tableHeaderCell, { width: "15%" }]}>Qty</Text>
            <Text style={[styles.tableHeaderCell, { width: "20%" }]}>
              Avg Price
            </Text>
            <Text style={[styles.tableHeaderCell, { width: "20%" }]}>
              Cost Basis
            </Text>
            <Text style={[styles.tableHeaderCell, { width: "15%" }]}>
              Weight
            </Text>
          </View>
          {holdings
            .sort(
              (a, b) =>
                b.quantity * b.averagePrice - a.quantity * a.averagePrice,
            )
            .slice(0, 50)
            .map((h, i) => {
              const value = h.quantity * h.averagePrice;
              const weight =
                totalHoldingsValue > 0 ? (value / totalHoldingsValue) * 100 : 0;
              return (
                <View
                  key={i}
                  style={i % 2 === 0 ? styles.tableRow : styles.tableRowAlt}
                >
                  <Text style={[styles.tableCell, { width: "5%" }]}>
                    {i + 1}
                  </Text>
                  <Text style={[styles.tableCell, { width: "25%" }]}>
                    {h.symbol}
                  </Text>
                  <Text style={[styles.tableCell, { width: "15%" }]}>
                    {h.quantity}
                  </Text>
                  <Text style={[styles.tableCell, { width: "20%" }]}>
                    {formatCurrency(h.averagePrice)}
                  </Text>
                  <Text style={[styles.tableCell, { width: "20%" }]}>
                    {formatCurrency(value)}
                  </Text>
                  <Text style={[styles.tableCell, { width: "15%" }]}>
                    {formatPercent(weight)}
                  </Text>
                </View>
              );
            })}
        </View>

        {holdings.length > 50 && (
          <Text
            style={[
              styles.tableCell,
              { color: colors.textSecondary, marginTop: 4 },
            ]}
          >
            ... and {holdings.length - 50} more holdings
          </Text>
        )}

        {/* Disclaimer */}
        <Text style={styles.disclaimer}>
          Values shown are at cost basis, not current market price. This
          statement is for informational purposes only and does not constitute
          financial advice.
        </Text>

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text>UseMoney Portfolio Statement - {userName}</Text>
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
