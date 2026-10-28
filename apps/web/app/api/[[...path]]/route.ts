import { NextRequest, NextResponse } from "next/server";
import {
  manualHoldingWhere,
  mergeManualHolding,
  newManualHoldingValues,
  parseManualHoldingInput,
} from "@/lib/actions/holdings-dedup-logic";
import { auth, currentUser } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";
import { isDemoSession } from "@/lib/demo/session";
import { apiLogger as logger } from "@usemoney/logger";
import {
  calculateTradeRealizedPnL,
  calculateClosePositionPnL,
} from "@/lib/db/trades-logic";
import {
  parseApiPath,
  splitPathParts,
  parseSkip,
  parseLimit,
  filterTrades,
  validateTradeInput,
  calculateWinRate,
  parseTags,
  sanitizeUpdateBody,
  TRADE_UPDATABLE_FIELDS,
  HOLDING_UPDATABLE_FIELDS,
  MF_UPDATABLE_FIELDS,
} from "./route-logic";

// Demo data for demo mode users
const generateDemoData = () => {
  const demoTrades = [
    {
      id: "demo-1",
      symbol: "RELIANCE",
      exchange: "NSE",
      segment: "EQUITY",
      tradeType: "BUY",
      positionType: "LONG",
      quantity: 50,
      price: 2450.75,
      exitPrice: 2520.0,
      realizedPnL: 3462.5,
      status: "CLOSED",
      tradeDate: new Date("2024-12-15"),
      brokerName: "zerodha",
      orderType: "MARKET",
      productType: "CNC",
    },
    {
      id: "demo-2",
      symbol: "TCS",
      exchange: "NSE",
      segment: "EQUITY",
      tradeType: "BUY",
      positionType: "LONG",
      quantity: 25,
      price: 3850.0,
      exitPrice: 3920.5,
      realizedPnL: 1762.5,
      status: "CLOSED",
      tradeDate: new Date("2024-12-16"),
      brokerName: "groww",
      orderType: "LIMIT",
      productType: "CNC",
    },
    {
      id: "demo-3",
      symbol: "INFY",
      exchange: "NSE",
      segment: "EQUITY",
      tradeType: "BUY",
      positionType: "LONG",
      quantity: 75,
      price: 1520.25,
      exitPrice: 1485.0,
      realizedPnL: -2643.75,
      status: "CLOSED",
      tradeDate: new Date("2024-12-17"),
      brokerName: "zerodha",
      orderType: "MARKET",
      productType: "CNC",
    },
    {
      id: "demo-4",
      symbol: "HDFCBANK",
      exchange: "NSE",
      segment: "EQUITY",
      tradeType: "BUY",
      positionType: "LONG",
      quantity: 40,
      price: 1680.5,
      exitPrice: null,
      realizedPnL: null,
      status: "OPEN",
      tradeDate: new Date("2024-12-18"),
      brokerName: "dhan",
      orderType: "MARKET",
      productType: "CNC",
    },
    {
      id: "demo-5",
      symbol: "NIFTY25JAN",
      exchange: "NFO",
      segment: "FUTURES",
      tradeType: "BUY",
      positionType: "LONG",
      quantity: 50,
      price: 24250.0,
      exitPrice: 24450.0,
      realizedPnL: 10000.0,
      status: "CLOSED",
      tradeDate: new Date("2024-12-18"),
      brokerName: "zerodha",
      orderType: "LIMIT",
      productType: "NRML",
    },
    {
      id: "demo-6",
      symbol: "ICICIBANK",
      exchange: "NSE",
      segment: "EQUITY",
      tradeType: "SELL",
      positionType: "SHORT",
      quantity: 100,
      price: 1050.0,
      exitPrice: null,
      realizedPnL: null,
      status: "OPEN",
      tradeDate: new Date("2024-12-19"),
      brokerName: "groww",
      orderType: "MARKET",
      productType: "MIS",
    },
    {
      id: "demo-7",
      symbol: "TATAMOTORS",
      exchange: "NSE",
      segment: "EQUITY",
      tradeType: "BUY",
      positionType: "LONG",
      quantity: 100,
      price: 785.5,
      exitPrice: 812.25,
      realizedPnL: 2675.0,
      status: "CLOSED",
      tradeDate: new Date("2024-12-10"),
      brokerName: "zerodha",
      orderType: "LIMIT",
      productType: "CNC",
    },
    {
      id: "demo-8",
      symbol: "BANKNIFTY25JAN",
      exchange: "NFO",
      segment: "OPTIONS",
      tradeType: "BUY",
      positionType: "LONG",
      quantity: 25,
      price: 450.0,
      exitPrice: 580.0,
      realizedPnL: 3250.0,
      status: "CLOSED",
      tradeDate: new Date("2024-12-12"),
      brokerName: "dhan",
      orderType: "LIMIT",
      productType: "NRML",
    },
  ];

  const demoHoldings = [
    {
      id: "hold-1",
      symbol: "RELIANCE",
      name: "Reliance Industries",
      sector: "Energy",
      exchange: "NSE",
      quantity: 100,
      averagePrice: 2380.5,
      currentPrice: 2520.75,
      investedValue: 238050,
      currentValue: 252075,
      unrealizedPnL: 14025,
      pnlPercentage: 5.89,
      brokerName: "zerodha",
    },
    {
      id: "hold-2",
      symbol: "TCS",
      name: "Tata Consultancy",
      sector: "IT",
      exchange: "NSE",
      quantity: 50,
      averagePrice: 3750.0,
      currentPrice: 3920.5,
      investedValue: 187500,
      currentValue: 196025,
      unrealizedPnL: 8525,
      pnlPercentage: 4.55,
      brokerName: "groww",
    },
    {
      id: "hold-3",
      symbol: "INFY",
      name: "Infosys",
      sector: "IT",
      exchange: "NSE",
      quantity: 150,
      averagePrice: 1480.25,
      currentPrice: 1520.0,
      investedValue: 222037.5,
      currentValue: 228000,
      unrealizedPnL: 5962.5,
      pnlPercentage: 2.69,
      brokerName: "zerodha",
    },
    {
      id: "hold-4",
      symbol: "HDFCBANK",
      name: "HDFC Bank",
      sector: "Banking",
      exchange: "NSE",
      quantity: 80,
      averagePrice: 1620.0,
      currentPrice: 1680.5,
      investedValue: 129600,
      currentValue: 134440,
      unrealizedPnL: 4840,
      pnlPercentage: 3.73,
      brokerName: "dhan",
    },
    {
      id: "hold-5",
      symbol: "TATAMOTORS",
      name: "Tata Motors",
      sector: "Automobile",
      exchange: "NSE",
      quantity: 200,
      averagePrice: 720.0,
      currentPrice: 785.5,
      investedValue: 144000,
      currentValue: 157100,
      unrealizedPnL: 13100,
      pnlPercentage: 9.1,
      brokerName: "zerodha",
    },
    {
      id: "hold-6",
      symbol: "ICICIBANK",
      name: "ICICI Bank",
      sector: "Banking",
      exchange: "NSE",
      quantity: 120,
      averagePrice: 980.0,
      currentPrice: 1050.25,
      investedValue: 117600,
      currentValue: 126030,
      unrealizedPnL: 8430,
      pnlPercentage: 7.17,
      brokerName: "groww",
    },
  ];

  const demoMutualFunds = [
    {
      id: "mf-1",
      schemeName: "HDFC Flexi Cap Fund - Direct Growth",
      schemeCode: "MF001",
      amcName: "HDFC AMC",
      folioNumber: "HD123456",
      category: "Flexi Cap",
      units: 1250.45,
      averageNav: 85.5,
      currentNav: 98.75,
      investedAmount: 106913.48,
      currentValue: 123481.96,
      unrealizedGain: 16568.48,
      xirr: 15.5,
      sipActive: true,
      sipAmount: 5000,
      sipDate: 5,
      brokerName: "groww",
    },
    {
      id: "mf-2",
      schemeName: "ICICI Pru Bluechip Fund - Direct Growth",
      schemeCode: "MF002",
      amcName: "ICICI AMC",
      folioNumber: "IC789012",
      category: "Large Cap",
      units: 850.75,
      averageNav: 72.0,
      currentNav: 82.45,
      investedAmount: 61254.0,
      currentValue: 70146.34,
      unrealizedGain: 8892.34,
      xirr: 14.5,
      sipActive: true,
      sipAmount: 10000,
      sipDate: 15,
      brokerName: "groww",
    },
    {
      id: "mf-3",
      schemeName: "Parag Parikh Flexi Cap Fund - Direct Growth",
      schemeCode: "MF003",
      amcName: "PPFAS AMC",
      folioNumber: "PP345678",
      category: "Flexi Cap",
      units: 520.3,
      averageNav: 55.0,
      currentNav: 68.25,
      investedAmount: 28616.5,
      currentValue: 35510.48,
      unrealizedGain: 6893.98,
      xirr: 18.2,
      sipActive: false,
      sipAmount: null,
      sipDate: null,
      brokerName: "zerodha",
    },
  ];

  return { demoTrades, demoHoldings, demoMutualFunds };
};

// Helper to get user ID.
//
// MONEY-595 (A01): demo mode MUST derive solely from the HMAC-signed `sb_demo`
// cookie — the canonical demo source (`lib/demo/session.ts`) used everywhere
// else in the app. The legacy `x-demo-mode` request header was client-supplied
// and forgeable: any authenticated-looking caller could set it to `true` and be
// served the static demo dataset (or, worse, bypass the real-user code path).
// `isDemoSession()` also short-circuits to non-demo whenever a Clerk session is
// present, so a signed-in user can never be downgraded to demo here.
async function getUserId(
  _request: NextRequest
): Promise<{ userId: string | null; isDemo: boolean }> {
  if (await isDemoSession()) {
    return { userId: "demo-user-123", isDemo: true };
  }

  const { userId } = await auth();
  return { userId, isDemo: false };
}

// Helper to get or create real user in database
async function getOrCreateUser(clerkId: string) {
  const clerkUser = await currentUser();

  let user = await prisma.user.findFirst({
    where: { email: clerkUser?.emailAddresses[0]?.emailAddress },
  });

  if (!user && clerkUser) {
    user = await prisma.user.create({
      data: {
        email:
          clerkUser.emailAddresses[0]?.emailAddress || `${clerkId}@clerk.user`,
        name: clerkUser.fullName || "Trader",
      },
    });
  }

  return user;
}

// GET Handler
export async function GET(request: NextRequest) {
  try {
    const { userId, isDemo } = await getUserId(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { pathname, searchParams } = new URL(request.url);
    const path = parseApiPath(pathname);

    // Extract filters from search params
    const filters = {
      symbol: searchParams.get("symbol") || undefined,
      broker: searchParams.get("broker") || undefined,
      segment: searchParams.get("segment") || undefined,
      tradeType: searchParams.get("tradeType") || undefined,
      fromDate: searchParams.get("fromDate") || undefined,
      toDate: searchParams.get("toDate") || undefined,
    };

    // Demo mode - return demo data
    if (isDemo) {
      const { demoTrades, demoHoldings, demoMutualFunds } = generateDemoData();

      if (path === "dashboard/stats") {
        const closedTrades = demoTrades.filter((t) => t.status === "CLOSED");
        const winners = closedTrades.filter((t) => (t.realizedPnL || 0) > 0);
        const losers = closedTrades.filter((t) => (t.realizedPnL || 0) < 0);
        const totalRealizedPnL = closedTrades.reduce(
          (sum, t) => sum + (t.realizedPnL || 0),
          0
        );
        const totalHoldingsValue = demoHoldings.reduce(
          (sum, h) => sum + h.currentValue,
          0
        );
        const totalHoldingsPnL = demoHoldings.reduce(
          (sum, h) => sum + h.unrealizedPnL,
          0
        );

        // Generate daily P&L chart data
        const dailyPnL = [];
        let cumulative = 0;
        for (let i = 29; i >= 0; i--) {
          const date = new Date();
          date.setDate(date.getDate() - i);
          const pnl = Math.random() * 10000 - 3000;
          cumulative += pnl;
          dailyPnL.push({
            date: date.toISOString().split("T")[0],
            pnl,
            cumulativePnL: cumulative,
          });
        }

        return NextResponse.json({
          portfolio: {
            totalValue: totalHoldingsValue,
            totalPnL: totalHoldingsPnL,
            pnlPercentage: (
              (totalHoldingsPnL / totalHoldingsValue) *
              100
            ).toFixed(2),
          },
          trading: {
            totalRealizedPnL,
            totalTrades: demoTrades.length,
            todaysPnL: 2580.25,
            todaysTrades: 2,
            winRate: calculateWinRate(winners.length, closedTrades.length),
            winners: winners.length,
            losers: losers.length,
            bestTrade: { symbol: "NIFTY25JAN", pnl: 10000 },
            worstTrade: { symbol: "INFY", pnl: -2643.75 },
          },
          charts: { dailyPnL },
          recentTrades: demoTrades.slice(0, 5),
        });
      }

      if (path === "trades") {
        const limit = parseLimit(searchParams.get("limit"));
        const skip = parseSkip(searchParams.get("skip"));

        // Apply filters
        let filteredTrades = filterTrades(demoTrades, filters);

        // Sort by date desc
        filteredTrades.sort(
          (a, b) =>
            new Date(b.tradeDate).getTime() - new Date(a.tradeDate).getTime()
        );

        const total = filteredTrades.length;
        const paginatedTrades = filteredTrades.slice(skip, skip + limit);

        const closedTrades = filteredTrades.filter(
          (t) => t.status === "CLOSED"
        );
        const winners = closedTrades.filter((t) => (t.realizedPnL || 0) > 0);
        const totalPnL = closedTrades.reduce(
          (sum, t) => sum + (t.realizedPnL || 0),
          0
        );

        return NextResponse.json({
          trades: paginatedTrades,
          total,
          stats: {
            totalPnL,
            winRate: calculateWinRate(winners.length, closedTrades.length),
            winners: winners.length,
            losers: closedTrades.length - winners.length,
          },
        });
      }

      if (path === "positions") {
        let openPositions = demoTrades
          .filter((t) => t.status === "OPEN")
          .map((t) => ({
            ...t,
            entryPrice: t.price,
            currentPrice: t.price * (1 + (Math.random() * 0.05 - 0.02)), // Random price movement
          }));

        // Apply filters
        if (filters.symbol) {
          openPositions = openPositions.filter((p) =>
            p.symbol.toLowerCase().includes(filters.symbol!.toLowerCase())
          );
        }
        if (filters.broker && filters.broker !== "all") {
          openPositions = openPositions.filter(
            (p) => p.brokerName === filters.broker
          );
        }
        if (filters.segment && filters.segment !== "all") {
          openPositions = openPositions.filter(
            (p) => p.segment === filters.segment
          );
        }

        const totalInvested = openPositions.reduce(
          (sum, p) => sum + p.quantity * p.price,
          0
        );
        const unrealizedPnL = openPositions.reduce((sum, p) => {
          const pnl =
            p.positionType === "LONG"
              ? (p.currentPrice - p.entryPrice) * p.quantity
              : (p.entryPrice - p.currentPrice) * p.quantity;
          return sum + pnl;
        }, 0);

        return NextResponse.json({
          positions: openPositions,
          summary: {
            totalPositions: openPositions.length,
            totalInvested,
            unrealizedPnL,
            longPositions: openPositions.filter(
              (p) => p.positionType === "LONG"
            ).length,
            shortPositions: openPositions.filter(
              (p) => p.positionType === "SHORT"
            ).length,
          },
        });
      }

      if (path === "holdings") {
        let filteredHoldings = [...demoHoldings];

        if (filters.symbol) {
          filteredHoldings = filteredHoldings.filter(
            (h) =>
              h.symbol.toLowerCase().includes(filters.symbol!.toLowerCase()) ||
              h.name.toLowerCase().includes(filters.symbol!.toLowerCase())
          );
        }

        const totalInvested = filteredHoldings.reduce(
          (sum, h) => sum + h.investedValue,
          0
        );
        const totalCurrent = filteredHoldings.reduce(
          (sum, h) => sum + h.currentValue,
          0
        );
        const totalPnL = filteredHoldings.reduce(
          (sum, h) => sum + h.unrealizedPnL,
          0
        );

        return NextResponse.json({
          holdings: filteredHoldings,
          summary: {
            totalInvested,
            totalCurrent,
            totalPnL,
            pnlPercentage: ((totalPnL / totalInvested) * 100).toFixed(2),
          },
        });
      }

      if (path === "mutualfunds") {
        let filteredFunds = [...demoMutualFunds];

        if (filters.symbol) {
          filteredFunds = filteredFunds.filter((f) =>
            f.schemeName.toLowerCase().includes(filters.symbol!.toLowerCase())
          );
        }

        const totalInvested = filteredFunds.reduce(
          (sum, f) => sum + f.investedAmount,
          0
        );
        const totalCurrent = filteredFunds.reduce(
          (sum, f) => sum + f.currentValue,
          0
        );
        const totalPnL = filteredFunds.reduce(
          (sum, f) => sum + f.unrealizedGain,
          0
        );

        return NextResponse.json({
          funds: filteredFunds,
          summary: {
            totalInvested,
            totalCurrent,
            totalPnL,
            pnlPercentage:
              totalInvested > 0
                ? ((totalPnL / totalInvested) * 100).toFixed(2)
                : 0,
          },
        });
      }

      if (path === "brokers") {
        return NextResponse.json([
          {
            id: "broker-1",
            brokerName: "zerodha",
            connected: true,
            lastSynced: new Date().toISOString(),
          },
          {
            id: "broker-2",
            brokerName: "groww",
            connected: true,
            lastSynced: new Date().toISOString(),
          },
          {
            id: "broker-3",
            brokerName: "dhan",
            connected: true,
            lastSynced: new Date().toISOString(),
          },
        ]);
      }

      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Real user - fetch from database
    const user = await getOrCreateUser(userId);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    if (path === "auth/user" || path === "user") {
      return NextResponse.json(user);
    }

    if (path === "dashboard/stats") {
      const [trades, holdings] = await Promise.all([
        prisma.trade.findMany({
          where: { userId: user.id },
          orderBy: { tradeDate: "desc" },
        }),
        prisma.holding.findMany({
          where: { userId: user.id },
        }),
      ]);

      const closedTrades = trades.filter((t) => t.status === "CLOSED");
      const winners = closedTrades.filter((t) => (t.realizedPnL || 0) > 0);
      const losers = closedTrades.filter((t) => (t.realizedPnL || 0) < 0);
      const totalRealizedPnL = closedTrades.reduce(
        (sum, t) => sum + (t.realizedPnL || 0),
        0
      );

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todaysTrades = trades.filter((t) => new Date(t.tradeDate) >= today);
      const todaysPnL = todaysTrades.reduce(
        (sum, t) => sum + (t.realizedPnL || 0),
        0
      );

      const totalHoldingsValue = holdings.reduce(
        (sum, h) => sum + h.currentValue,
        0
      );
      const totalHoldingsPnL = holdings.reduce(
        (sum, h) => sum + h.unrealizedPnL,
        0
      );

      // Generate daily P&L chart data from actual trades
      const dailyPnL = [];
      let cumulative = 0;
      for (let i = 29; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split("T")[0];
        const dayPnL = trades
          .filter((t) => t.tradeDate.toISOString().split("T")[0] === dateStr)
          .reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
        cumulative += dayPnL;
        dailyPnL.push({
          date: dateStr,
          pnl: dayPnL,
          cumulativePnL: cumulative,
        });
      }

      const bestTrade = closedTrades.reduce(
        (best, t) =>
          (t.realizedPnL || 0) > (best?.realizedPnL || 0) ? t : best,
        closedTrades[0]
      );
      const worstTrade = closedTrades.reduce(
        (worst, t) =>
          (t.realizedPnL || 0) < (worst?.realizedPnL || 0) ? t : worst,
        closedTrades[0]
      );

      return NextResponse.json({
        portfolio: {
          totalValue: totalHoldingsValue,
          totalPnL: totalHoldingsPnL,
          pnlPercentage:
            totalHoldingsValue > 0
              ? ((totalHoldingsPnL / totalHoldingsValue) * 100).toFixed(2)
              : 0,
        },
        trading: {
          totalRealizedPnL,
          totalTrades: trades.length,
          todaysPnL,
          todaysTrades: todaysTrades.length,
          winRate:
            closedTrades.length > 0
              ? Math.round((winners.length / closedTrades.length) * 100)
              : 0,
          winners: winners.length,
          losers: losers.length,
          bestTrade: bestTrade
            ? { symbol: bestTrade.symbol, pnl: bestTrade.realizedPnL }
            : null,
          worstTrade: worstTrade
            ? { symbol: worstTrade.symbol, pnl: worstTrade.realizedPnL }
            : null,
        },
        charts: { dailyPnL },
        recentTrades: trades.slice(0, 10),
      });
    }

    if (path === "trades") {
      const limit = parseLimit(searchParams.get("limit"));
      const skip = parseSkip(searchParams.get("skip"));

      // Build where clause with filters
      const where: any = { userId: user.id };

      if (filters.symbol) {
        where.symbol = { contains: filters.symbol, mode: "insensitive" };
      }
      if (filters.broker && filters.broker !== "all") {
        where.brokerName = filters.broker;
      }
      if (filters.segment && filters.segment !== "all") {
        where.segment = filters.segment;
      }
      if (filters.tradeType && filters.tradeType !== "all") {
        where.tradeType = filters.tradeType;
      }
      if (filters.fromDate || filters.toDate) {
        where.tradeDate = {};
        if (filters.fromDate) {
          where.tradeDate.gte = new Date(filters.fromDate);
        }
        if (filters.toDate) {
          const toDate = new Date(filters.toDate);
          toDate.setHours(23, 59, 59, 999);
          where.tradeDate.lte = toDate;
        }
      }

      const [trades, total] = await Promise.all([
        prisma.trade.findMany({
          where,
          orderBy: { tradeDate: "desc" },
          take: limit,
          skip,
        }),
        prisma.trade.count({ where }),
      ]);

      // Get stats for all filtered trades (not just paginated)
      const allFilteredTrades = await prisma.trade.findMany({ where });
      const closedTrades = allFilteredTrades.filter(
        (t) => t.status === "CLOSED"
      );
      const winners = closedTrades.filter((t) => (t.realizedPnL || 0) > 0);
      const totalPnL = closedTrades.reduce(
        (sum, t) => sum + (t.realizedPnL || 0),
        0
      );

      return NextResponse.json({
        trades,
        total,
        stats: {
          totalPnL,
          winRate:
            closedTrades.length > 0
              ? Math.round((winners.length / closedTrades.length) * 100)
              : 0,
          winners: winners.length,
          losers: closedTrades.length - winners.length,
        },
      });
    }

    if (path === "positions") {
      const where: any = { userId: user.id, status: "OPEN" };

      if (filters.symbol) {
        where.symbol = { contains: filters.symbol, mode: "insensitive" };
      }
      if (filters.broker && filters.broker !== "all") {
        where.brokerName = filters.broker;
      }
      if (filters.segment && filters.segment !== "all") {
        where.segment = filters.segment;
      }

      const positions = await prisma.trade.findMany({
        where,
        orderBy: { tradeDate: "desc" },
      });

      // Calculate unrealized P&L (in real app, fetch current prices from market data API)
      const positionsWithPnL = positions.map((p) => {
        const currentPrice = p.price * (1 + (Math.random() * 0.05 - 0.02)); // Simulated - replace with real market data
        const unrealizedPnL =
          p.positionType === "LONG"
            ? (currentPrice - p.price) * p.quantity
            : (p.price - currentPrice) * p.quantity;
        return {
          ...p,
          entryPrice: p.price,
          currentPrice,
          unrealizedPnL,
        };
      });

      const totalInvested = positionsWithPnL.reduce(
        (sum, p) => sum + p.quantity * p.price,
        0
      );
      const unrealizedPnL = positionsWithPnL.reduce(
        (sum, p) => sum + p.unrealizedPnL,
        0
      );

      return NextResponse.json({
        positions: positionsWithPnL,
        summary: {
          totalPositions: positionsWithPnL.length,
          totalInvested,
          unrealizedPnL,
          longPositions: positionsWithPnL.filter(
            (p) => p.positionType === "LONG"
          ).length,
          shortPositions: positionsWithPnL.filter(
            (p) => p.positionType === "SHORT"
          ).length,
        },
      });
    }

    if (path === "holdings") {
      const where: any = { userId: user.id };

      if (filters.symbol) {
        where.OR = [
          { symbol: { contains: filters.symbol, mode: "insensitive" } },
          { name: { contains: filters.symbol, mode: "insensitive" } },
        ];
      }

      const holdings = await prisma.holding.findMany({ where });

      const totalInvested = holdings.reduce(
        (sum, h) => sum + h.investedValue,
        0
      );
      const totalCurrent = holdings.reduce((sum, h) => sum + h.currentValue, 0);
      const totalPnL = holdings.reduce((sum, h) => sum + h.unrealizedPnL, 0);

      return NextResponse.json({
        holdings,
        summary: {
          totalInvested,
          totalCurrent,
          totalPnL,
          pnlPercentage:
            totalInvested > 0
              ? ((totalPnL / totalInvested) * 100).toFixed(2)
              : 0,
        },
      });
    }

    if (path === "mutualfunds") {
      const where: any = { userId: user.id };

      if (filters.symbol) {
        where.schemeName = { contains: filters.symbol, mode: "insensitive" };
      }

      const funds = await prisma.mutualFund.findMany({ where });

      const totalInvested = funds.reduce((sum, f) => sum + f.investedAmount, 0);
      const totalCurrent = funds.reduce((sum, f) => sum + f.currentValue, 0);
      const totalGain = funds.reduce(
        (sum, f) => sum + (f.unrealizedGain ?? 0),
        0
      );

      return NextResponse.json({
        funds,
        summary: {
          totalInvested,
          totalCurrent,
          totalPnL: totalGain,
          pnlPercentage:
            totalInvested > 0
              ? ((totalGain / totalInvested) * 100).toFixed(2)
              : 0,
        },
      });
    }

    if (path === "brokers") {
      const brokers = await prisma.brokerConnection.findMany({
        where: { userId: user.id },
      });
      return NextResponse.json(brokers);
    }

    return NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    logger.error({ error, method: "GET" }, "API Error");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST Handler
export async function POST(request: NextRequest) {
  try {
    const { userId, isDemo } = await getUserId(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { pathname } = new URL(request.url);
    const path = parseApiPath(pathname);
    const body = await request.json().catch(() => ({}));

    // Demo mode - limited functionality
    if (isDemo) {
      if (
        path === "chat" ||
        path === "tutor/chat" ||
        path === "analysis/chat" ||
        path === "fire/chat"
      ) {
        return NextResponse.json({
          response:
            "🔒 This is a demo preview. Please sign up for a free account to use AI chat features!",
        });
      }

      if (
        path === "trades" ||
        path === "positions/close" ||
        path === "holdings" ||
        path === "mutualfunds"
      ) {
        return NextResponse.json({
          success: false,
          message:
            "Demo mode: Data modification not available. Sign up for a free account!",
        });
      }

      if (path === "sync/manual") {
        return NextResponse.json({
          success: true,
          message: "Demo sync complete!",
        });
      }

      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Real user - full functionality
    const user = await getOrCreateUser(userId);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    if (path === "trades") {
      // Validate required fields
      const tradeValidation = validateTradeInput(body);
      if (!tradeValidation.valid) {
        return NextResponse.json(
          { error: tradeValidation.error },
          { status: 400 }
        );
      }

      // Calculate realized P&L if exit price provided. Reuses the shared
      // realized-P&L helper (lib/db/trades-logic) so the SHORT/LONG sign +
      // brokerage subtraction stay identical to the trade-pairing math.
      let realizedPnL = body.realizedPnL;
      if (body.exitPrice && !realizedPnL) {
        realizedPnL = calculateTradeRealizedPnL(
          body.positionType,
          body.price,
          body.exitPrice,
          body.quantity,
          body.brokerage || 20
        );
      }

      const trade = await prisma.trade.create({
        data: {
          userId: user.id,
          symbol: body.symbol.toUpperCase(),
          exchange: body.exchange || "NSE",
          segment: body.segment || "EQUITY",
          tradeType: body.tradeType || "BUY",
          positionType: body.positionType || "LONG",
          orderType: body.orderType || "MARKET",
          productType: body.productType || "CNC",
          quantity: parseInt(body.quantity),
          price: parseFloat(body.price),
          exitPrice: body.exitPrice ? parseFloat(body.exitPrice) : null,
          tradeValue: parseInt(body.quantity) * parseFloat(body.price),
          brokerage: parseFloat(body.brokerage) || 20,
          taxes: body.taxes || 0,
          realizedPnL: realizedPnL ? parseFloat(realizedPnL) : null,
          status: body.exitPrice ? "CLOSED" : "OPEN",
          tradeDate: new Date(body.tradeDate || Date.now()),
          brokerName: body.brokerName || body.broker || "manual",
          tags: parseTags(body.tags),
          notes: body.notes || null,
        },
      });
      return NextResponse.json(trade);
    }

    if (path === "positions/close") {
      const { positionId, exitPrice } = body;

      const trade = await prisma.trade.findFirst({
        where: { id: positionId, userId: user.id },
      });

      if (!trade) {
        return NextResponse.json(
          { error: "Position not found" },
          { status: 404 }
        );
      }

      // Reuses the shared close-position P&L helper (lib/db/trades-logic):
      // LONG profits when exit > entry, SHORT when entry > exit, minus brokerage.
      const netPnl = calculateClosePositionPnL(
        trade.positionType,
        trade.price,
        exitPrice,
        trade.quantity,
        trade.brokerage
      );

      await prisma.trade.update({
        where: { id: positionId },
        data: {
          exitPrice: parseFloat(exitPrice),
          exitDate: new Date(),
          status: "CLOSED",
          realizedPnL: netPnl,
        },
      });

      return NextResponse.json({ success: true, pnl: netPnl });
    }

    if (path === "holdings") {
      // DEDUP BEFORE CREATE — MONEY-1236. This path had NO dedup at all, so a
      // repeat manual add of a symbol the user already held collided with
      // `@@unique([userId, broker, brokerUserId, symbol, exchange])` — an index
      // verified LIVE on prod — and threw E11000. There is no P2002 handler, so
      // the caller got a generic failure with nothing saying why.
      //
      // Measured 2026-08-21: ZERO duplicate groups among the 16 absent-`broker`
      // holdings. The index was silently REJECTING these writes, not letting
      // duplicates through — so the symptom was "adding fails", not "I see two
      // rows", which is why it never looked like a dedup bug.
      //
      // VALIDATE FIRST. `body` comes from `request.json().catch(() => ({}))`
      // with no schema, and repairing the dedup above opened the MERGE branch —
      // so an unvalidated `NaN` no longer produces a bad NEW row, it folds into
      // an EXISTING one and destroys its cost basis. `parseManualHoldingInput`
      // carries the full reasoning and the bounds.
      //
      // The where-clause, the validation and the arithmetic are genuinely
      // shared with `addManualHoldingAction` — both import them from
      // `holdings-dedup-logic`, and a meta-test asserts that both still do.
      const parsedInput = parseManualHoldingInput(body);
      if (!parsedInput.ok) {
        return NextResponse.json({ error: parsedInput.error }, { status: 400 });
      }
      const input = parsedInput.value;
      const addInvested = input.quantity * input.averagePrice;

      const existingManual = await prisma.holding.findFirst({
        where: manualHoldingWhere(user.id, input.symbol, input.exchange),
      });

      if (existingManual) {
        const merged = mergeManualHolding(
          existingManual,
          input.quantity,
          addInvested,
          input.currentPrice
        );
        const updated = await prisma.holding.update({
          where: { id: existingManual.id },
          data: { ...merged, lastUpdated: new Date() },
        });
        return NextResponse.json(updated);
      }

      const holding = await prisma.holding.create({
        data: {
          userId: user.id,
          symbol: input.symbol,
          name:
            typeof body.name === "string" && body.name.trim()
              ? body.name.trim()
              : input.symbol,
          sector:
            typeof body.sector === "string" && body.sector.trim()
              ? body.sector.trim()
              : "Other",
          exchange: input.exchange,
          ...newManualHoldingValues(input),
          brokerName:
            typeof body.brokerName === "string" && body.brokerName.trim()
              ? body.brokerName.trim()
              : "manual",
        },
      });
      return NextResponse.json(holding);
    }

    if (path === "mutualfunds") {
      const fund = await prisma.mutualFund.create({
        data: {
          userId: user.id,
          schemeName: body.schemeName,
          schemeCode: body.schemeCode || null,
          amcName: body.amcName || null,
          folioNumber: body.folioNumber || `MF${Date.now()}`,
          category: body.category || "Equity",
          units: parseFloat(body.units),
          averageNav: parseFloat(body.averageNav),
          currentNav: parseFloat(body.currentNav || body.averageNav),
          investedAmount: parseFloat(body.units) * parseFloat(body.averageNav),
          currentValue:
            parseFloat(body.units) *
            parseFloat(body.currentNav || body.averageNav),
          unrealizedGain:
            parseFloat(body.units) *
            (parseFloat(body.currentNav || body.averageNav) -
              parseFloat(body.averageNav)),
          xirr: body.xirr || 0,
          sipActive: body.sipActive || false,
          sipAmount: body.sipAmount ? parseFloat(body.sipAmount) : null,
          sipDate: body.sipDate ? parseInt(body.sipDate) : null,
          brokerName: body.brokerName || "manual",
        },
      });
      return NextResponse.json(fund);
    }

    if (
      path === "chat" ||
      path === "tutor/chat" ||
      path === "analysis/chat" ||
      path === "fire/chat"
    ) {
      const { message } = body;
      // Mock AI response for now - will integrate with Emergent LLM in Phase 3
      const responses = [
        `That's a great question about trading! Based on market analysis, I'd suggest focusing on risk management and position sizing.`,
        `Looking at the current market conditions, diversification across sectors would be a prudent strategy.`,
        `For your portfolio, consider maintaining a balance between growth stocks and value stocks.`,
        `Technical analysis suggests waiting for confirmation of support levels before entering new positions.`,
        `Based on historical patterns, this setup shows potential. However, always use stop-losses to manage risk.`,
      ];
      const response = responses[Math.floor(Math.random() * responses.length)];
      return NextResponse.json({ response });
    }

    if (path === "sync/manual") {
      return NextResponse.json({
        success: true,
        message: "Data synced successfully",
      });
    }

    return NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    logger.error({ error, method: "POST" }, "API Error");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// PATCH Handler
export async function PATCH(request: NextRequest) {
  try {
    const { userId, isDemo } = await getUserId(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (isDemo) {
      return NextResponse.json({
        success: false,
        message: "Demo mode: Modification not available",
      });
    }

    const { pathname } = new URL(request.url);
    const pathParts = splitPathParts(pathname);
    const body = await request.json();

    const user = await getOrCreateUser(userId);
    if (!user)
      return NextResponse.json({ error: "User not found" }, { status: 404 });

    if (pathParts[2] === "trades" && pathParts[3]) {
      const tradeId = pathParts[3];
      const sanitizedBody = sanitizeUpdateBody(body, TRADE_UPDATABLE_FIELDS);

      const trade = await prisma.trade.updateMany({
        where: { id: tradeId, userId: user.id },
        data: sanitizedBody,
      });

      return NextResponse.json({ success: true, updated: trade.count });
    }

    if (pathParts[2] === "holdings" && pathParts[3]) {
      const holdingId = pathParts[3];
      const sanitizedBody = sanitizeUpdateBody(body, HOLDING_UPDATABLE_FIELDS);

      const holding = await prisma.holding.updateMany({
        where: { id: holdingId, userId: user.id },
        data: sanitizedBody,
      });

      return NextResponse.json({ success: true, updated: holding.count });
    }

    if (pathParts[2] === "mutualfunds" && pathParts[3]) {
      const fundId = pathParts[3];
      const sanitizedBody = sanitizeUpdateBody(body, MF_UPDATABLE_FIELDS);

      const fund = await prisma.mutualFund.updateMany({
        where: { id: fundId, userId: user.id },
        data: sanitizedBody,
      });

      return NextResponse.json({ success: true, updated: fund.count });
    }

    return NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    logger.error({ error, method: "PATCH" }, "API Error");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// DELETE Handler
export async function DELETE(request: NextRequest) {
  try {
    const { userId, isDemo } = await getUserId(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (isDemo) {
      return NextResponse.json({
        success: false,
        message: "Demo mode: Deletion not available",
      });
    }

    const { pathname } = new URL(request.url);
    const pathParts = splitPathParts(pathname);

    const user = await getOrCreateUser(userId);
    if (!user)
      return NextResponse.json({ error: "User not found" }, { status: 404 });

    if (pathParts[2] === "trades" && pathParts[3]) {
      const tradeId = pathParts[3];

      await prisma.trade.deleteMany({
        where: { id: tradeId, userId: user.id },
      });

      return NextResponse.json({ success: true });
    }

    if (pathParts[2] === "holdings" && pathParts[3]) {
      const holdingId = pathParts[3];

      await prisma.holding.deleteMany({
        where: { id: holdingId, userId: user.id },
      });

      return NextResponse.json({ success: true });
    }

    if (pathParts[2] === "mutualfunds" && pathParts[3]) {
      const fundId = pathParts[3];

      await prisma.mutualFund.deleteMany({
        where: { id: fundId, userId: user.id },
      });

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    logger.error({ error, method: "DELETE" }, "API Error");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
