/**
 * Report Renderer
 *
 * Renders PDF reports using @react-pdf/renderer.
 * Fetches user data from DB and generates report buffers.
 */

import { prisma } from "@usemoney/database";
import {
  getCurrentFY,
  fyToDateRange,
  isValidReportType,
} from "./report-renderer-logic";

/**
 * Render a report to a PDF buffer.
 *
 * Uses dynamic imports so @react-pdf/renderer is only loaded when needed.
 */
export async function renderReportToBuffer(
  userId: string,
  reportType: string,
  params?: Record<string, unknown>
): Promise<Buffer> {
  if (!isValidReportType(reportType)) {
    throw new Error(`Unknown report type: ${reportType}`);
  }
  switch (reportType) {
    case "tax":
      return renderTaxReport(userId, params);
    case "risk":
      return renderRiskReport(userId);
    case "portfolio_statement":
      return renderPortfolioStatement(userId);
  }
}

async function renderTaxReport(
  userId: string,
  params?: Record<string, unknown>
): Promise<Buffer> {
  const { renderToBuffer } = await import("@react-pdf/renderer");
  const { TaxReportDocument } = await import("../../report-templates/tax-report");

  // Fetch trade data for tax calculation
  const fy = (params?.fy as string) || getCurrentFY();
  const { startDate, endDate } = fyToDateRange(fy);

  const rawTrades = await prisma.trade.findMany({
    where: {
      userId,
      tradeTime: { gte: startDate, lte: endDate },
    },
    orderBy: { tradeTime: "asc" },
    select: {
      symbol: true,
      tradeType: true,
      quantity: true,
      price: true,
      tradeTime: true,
      exchange: true,
    },
  });

  const trades = rawTrades.map((t) => ({
    symbol: t.symbol,
    tradeType: t.tradeType,
    quantity: t.quantity,
    price: t.price,
    tradeTime: t.tradeTime || new Date(),
    exchange: t.exchange,
  }));

  const rawHoldings = await prisma.holding.findMany({
    where: { userId },
    select: { symbol: true, quantity: true, averagePrice: true },
  });

  const holdings = rawHoldings.map((h) => ({
    symbol: h.symbol,
    quantity: h.quantity,
    averagePrice: h.averagePrice,
  }));

  const buffer = await renderToBuffer(
    TaxReportDocument({ trades, holdings, fy })
  );
  return Buffer.from(buffer);
}

async function renderRiskReport(userId: string): Promise<Buffer> {
  const { renderToBuffer } = await import("@react-pdf/renderer");
  const { RiskReportDocument } = await import("../../report-templates/risk-report");

  const rawHoldings = await prisma.holding.findMany({
    where: { userId },
    select: { symbol: true, quantity: true, averagePrice: true },
  });

  const holdings = rawHoldings.map((h) => ({
    symbol: h.symbol,
    quantity: h.quantity,
    averagePrice: h.averagePrice,
  }));

  const buffer = await renderToBuffer(RiskReportDocument({ holdings }));
  return Buffer.from(buffer);
}

async function renderPortfolioStatement(userId: string): Promise<Buffer> {
  const { renderToBuffer } = await import("@react-pdf/renderer");
  const { PortfolioStatementDocument } = await import(
    "../../report-templates/portfolio-statement"
  );

  const [rawHoldings, rawPositions] = await Promise.all([
    prisma.holding.findMany({
      where: { userId },
      select: { symbol: true, quantity: true, averagePrice: true, exchange: true },
    }),
    prisma.position.findMany({
      where: { userId },
      select: { symbol: true, netQuantity: true, averagePrice: true, productType: true },
    }),
  ]);

  const holdings = rawHoldings.map((h) => ({
    symbol: h.symbol,
    quantity: h.quantity,
    averagePrice: h.averagePrice,
    exchange: h.exchange,
  }));

  const positions = rawPositions.map((p) => ({
    symbol: p.symbol,
    quantity: p.netQuantity || 0,
    averagePrice: p.averagePrice,
    productType: p.productType || undefined,
  }));

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true },
  });

  const buffer = await renderToBuffer(
    PortfolioStatementDocument({
      holdings,
      positions,
      userName: user?.name || "Investor",
    })
  );
  return Buffer.from(buffer);
}
