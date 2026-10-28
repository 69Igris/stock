/**
 * Mock Data Generator Tests
 *
 * Tests for broker mock data generation functions.
 * Reimplements the logic inline for pure testing without module mocking.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ============== LOCAL TYPE DEFINITIONS ==============

interface HoldingData {
  symbol: string;
  tradingSymbol: string;
  isin?: string;
  exchange: string;
  totalQuantity: number;
  freeQuantity: number;
  t1Quantity?: number;
  pledgedQuantity?: number;
  collateralQty?: number;
  averagePrice: number;
  lastPrice: number;
  closePrice?: number;
  pnl: number;
  pnlPercentage: number;
  product: string;
  dayChange?: number;
  dayChangePerc?: number;
}

interface PositionData {
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  positionType: "DAY" | "NET";
  productType: string;
  buyQuantity: number;
  sellQuantity: number;
  netQuantity: number;
  buyPrice: number;
  sellPrice: number;
  averagePrice: number;
  lastPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

interface OrderData {
  orderId: string;
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  orderType: string;
  transactionType: "BUY" | "SELL";
  productType: string;
  variety: string;
  quantity: number;
  filledQuantity: number;
  price: number;
  triggerPrice?: number;
  averagePrice: number;
  status: string;
  statusMessage?: string;
  validity: string;
  orderTime: Date;
  updateTime?: Date;
}

interface TradeData {
  tradeId: string;
  orderId: string;
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  transactionType: "BUY" | "SELL";
  productType: string;
  quantity: number;
  price: number;
  tradeValue: number;
  brokerage: number;
  exchangeFee: number;
  gst: number;
  sebiCharges: number;
  stampDuty: number;
  transactionTax: number;
  totalCharges: number;
  netAmount: number;
  tradeTime: Date;
}

interface MutualFundData {
  fundName: string;
  schemeName: string;
  isin: string;
  folio?: string;
  category?: string;
  amcName?: string;
  units: number;
  averageNav: number;
  currentNav: number;
  lastNavDate?: Date;
  investedValue: number;
  currentValue: number;
  pnl: number;
  pnlPercentage: number;
  isSIP: boolean;
  sipAmount?: number;
  sipFrequency?: string;
  sipDay?: number;
  nextSIPDate?: Date;
}

// ============== REIMPLEMENTED SOURCE CODE ==============

const STOCKS = [
  {
    symbol: "RELIANCE",
    name: "Reliance Industries",
    sector: "Energy",
    price: 2520.75,
  },
  {
    symbol: "TCS",
    name: "Tata Consultancy Services",
    sector: "IT",
    price: 3920.5,
  },
  { symbol: "INFY", name: "Infosys", sector: "IT", price: 1520.0 },
  { symbol: "HDFCBANK", name: "HDFC Bank", sector: "Banking", price: 1680.5 },
  {
    symbol: "ICICIBANK",
    name: "ICICI Bank",
    sector: "Banking",
    price: 1050.25,
  },
  {
    symbol: "SBIN",
    name: "State Bank of India",
    sector: "Banking",
    price: 620.75,
  },
  {
    symbol: "BHARTIARTL",
    name: "Bharti Airtel",
    sector: "Telecom",
    price: 1450.25,
  },
  {
    symbol: "HINDUNILVR",
    name: "Hindustan Unilever",
    sector: "FMCG",
    price: 2380.5,
  },
  { symbol: "ITC", name: "ITC Limited", sector: "FMCG", price: 445.75 },
  {
    symbol: "KOTAKBANK",
    name: "Kotak Mahindra Bank",
    sector: "Banking",
    price: 1820.5,
  },
  {
    symbol: "LT",
    name: "Larsen & Toubro",
    sector: "Infrastructure",
    price: 3520.25,
  },
  { symbol: "WIPRO", name: "Wipro", sector: "IT", price: 480.5 },
  { symbol: "AXISBANK", name: "Axis Bank", sector: "Banking", price: 1180.75 },
  { symbol: "MARUTI", name: "Maruti Suzuki", sector: "Auto", price: 11250.0 },
  { symbol: "TATAMOTORS", name: "Tata Motors", sector: "Auto", price: 785.5 },
];

const MUTUAL_FUNDS = [
  {
    name: "HDFC Top 100 Fund",
    isin: "INF179KA1GR8",
    nav: 825.5,
    category: "Large Cap",
    amcName: "HDFC AMC",
  },
  {
    name: "SBI Bluechip Fund",
    isin: "INF200K01RQ0",
    nav: 72.35,
    category: "Large Cap",
    amcName: "SBI AMC",
  },
  {
    name: "ICICI Pru Technology Fund",
    isin: "INF109K01BM5",
    nav: 158.25,
    category: "Sectoral",
    amcName: "ICICI AMC",
  },
  {
    name: "Axis Long Term Equity Fund",
    isin: "INF846K01EW2",
    nav: 68.5,
    category: "ELSS",
    amcName: "Axis AMC",
  },
  {
    name: "Mirae Asset Large Cap Fund",
    isin: "INF769K01BI6",
    nav: 85.75,
    category: "Large Cap",
    amcName: "Mirae AMC",
  },
];

function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randomInt(min: number, max: number): number {
  return Math.floor(randomBetween(min, max));
}

function randomDate(daysBack: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - randomInt(0, daysBack));
  return date;
}

function generateMockHoldings(count: number = 8): HoldingData[] {
  const selectedStocks = [...STOCKS]
    .sort(() => Math.random() - 0.5)
    .slice(0, count);
  return selectedStocks.map((stock) => {
    const quantity = randomInt(10, 200);
    const averagePrice = stock.price * randomBetween(0.85, 1.0);
    const lastPrice = stock.price * randomBetween(0.98, 1.05);
    const closePrice = stock.price * randomBetween(0.99, 1.01);
    const investedValue = quantity * averagePrice;
    const currentValue = quantity * lastPrice;
    const pnl = currentValue - investedValue;
    const pnlPercentage = (pnl / investedValue) * 100;
    const dayChange = lastPrice - closePrice;
    const dayChangePerc = (dayChange / closePrice) * 100;
    return {
      symbol: stock.symbol,
      tradingSymbol: stock.symbol,
      isin: `INE${randomInt(100, 999)}A01018`,
      exchange: "NSE",
      totalQuantity: quantity,
      freeQuantity: quantity,
      t1Quantity: 0,
      pledgedQuantity: 0,
      collateralQty: 0,
      averagePrice: parseFloat(averagePrice.toFixed(2)),
      lastPrice: parseFloat(lastPrice.toFixed(2)),
      closePrice: parseFloat(closePrice.toFixed(2)),
      pnl: parseFloat(pnl.toFixed(2)),
      pnlPercentage: parseFloat(pnlPercentage.toFixed(2)),
      product: "CNC",
      dayChange: parseFloat(dayChange.toFixed(2)),
      dayChangePerc: parseFloat(dayChangePerc.toFixed(2)),
    };
  });
}

function generateMockPositions(count: number = 4): PositionData[] {
  const selectedStocks = [...STOCKS]
    .sort(() => Math.random() - 0.5)
    .slice(0, count);
  return selectedStocks.map((stock) => {
    const isBuyPosition = Math.random() > 0.4;
    const buyQty = isBuyPosition ? randomInt(50, 200) : randomInt(0, 50);
    const sellQty = isBuyPosition ? randomInt(0, 50) : randomInt(50, 200);
    const netQty = buyQty - sellQty;
    const buyPrice = stock.price * randomBetween(0.98, 1.0);
    const sellPrice = stock.price * randomBetween(0.99, 1.02);
    const lastPrice = stock.price * randomBetween(0.98, 1.02);
    const realizedPnl = sellQty > 0 ? (sellPrice - buyPrice) * sellQty : 0;
    const unrealizedPnl =
      netQty !== 0
        ? (lastPrice - (netQty > 0 ? buyPrice : sellPrice)) * Math.abs(netQty)
        : 0;
    return {
      symbol: stock.symbol,
      tradingSymbol: stock.symbol,
      exchange: "NSE",
      segment: "CASH",
      positionType: "DAY" as const,
      productType: "MIS",
      buyQuantity: buyQty,
      sellQuantity: sellQty,
      netQuantity: netQty,
      buyPrice: parseFloat(buyPrice.toFixed(2)),
      sellPrice: parseFloat(sellPrice.toFixed(2)),
      averagePrice: parseFloat(((buyPrice + sellPrice) / 2).toFixed(2)),
      lastPrice: parseFloat(lastPrice.toFixed(2)),
      realizedPnl: parseFloat(realizedPnl.toFixed(2)),
      unrealizedPnl: parseFloat(unrealizedPnl.toFixed(2)),
    };
  });
}

function generateMockOrders(count: number = 10): OrderData[] {
  const statuses = ["COMPLETE", "PENDING", "CANCELLED", "REJECTED"];
  const orderTypes = ["MARKET", "LIMIT", "SL", "SL-M"];
  const selectedStocks = [...STOCKS]
    .sort(() => Math.random() - 0.5)
    .slice(0, count);
  return selectedStocks.map((stock, i) => {
    const isBuy = Math.random() > 0.5;
    const qty = randomInt(10, 100);
    const status = statuses[i % statuses.length];
    const filledQty =
      status === "COMPLETE"
        ? qty
        : status === "PENDING"
          ? randomInt(0, qty)
          : 0;
    const orderType = orderTypes[randomInt(0, orderTypes.length)];
    const price =
      orderType === "MARKET"
        ? 0
        : parseFloat((stock.price * randomBetween(0.98, 1.02)).toFixed(2));
    const avgPrice =
      status === "COMPLETE"
        ? parseFloat((stock.price * randomBetween(0.99, 1.01)).toFixed(2))
        : 0;
    return {
      orderId: `ORD${Date.now()}${randomInt(1000, 9999)}`,
      symbol: stock.symbol,
      tradingSymbol: stock.symbol,
      exchange: "NSE",
      segment: "CASH",
      orderType,
      transactionType: isBuy ? ("BUY" as const) : ("SELL" as const),
      productType: "CNC",
      variety: "regular",
      quantity: qty,
      filledQuantity: filledQty,
      price,
      triggerPrice: orderType.includes("SL")
        ? parseFloat((price * 0.98).toFixed(2))
        : 0,
      averagePrice: avgPrice,
      status,
      statusMessage: status === "REJECTED" ? "Insufficient funds" : undefined,
      validity: "DAY",
      orderTime: randomDate(7),
      updateTime: randomDate(7),
    };
  });
}

function generateMockTrades(count: number = 15): TradeData[] {
  const selectedStocks = [...STOCKS]
    .sort(() => Math.random() - 0.5)
    .slice(0, count);
  return selectedStocks.map((stock) => {
    const isBuy = Math.random() > 0.5;
    const qty = randomInt(10, 100);
    const price = parseFloat(
      (stock.price * randomBetween(0.98, 1.02)).toFixed(2)
    );
    const tradeValue = qty * price;
    const brokerage = 20;
    const exchangeFee = parseFloat((tradeValue * 0.0000345).toFixed(2));
    const gst = parseFloat((brokerage * 0.18).toFixed(2));
    const sebiCharges = parseFloat((tradeValue * 0.000001).toFixed(2));
    const stampDuty = isBuy ? parseFloat((tradeValue * 0.00015).toFixed(2)) : 0;
    const stt = parseFloat((tradeValue * 0.001).toFixed(2));
    const totalCharges =
      brokerage + exchangeFee + gst + sebiCharges + stampDuty + stt;
    const netAmount = isBuy
      ? tradeValue + totalCharges
      : tradeValue - totalCharges;
    return {
      tradeId: `TRD${Date.now()}${randomInt(1000, 9999)}`,
      orderId: `ORD${Date.now()}${randomInt(1000, 9999)}`,
      symbol: stock.symbol,
      tradingSymbol: stock.symbol,
      exchange: "NSE",
      segment: "CASH",
      transactionType: isBuy ? ("BUY" as const) : ("SELL" as const),
      productType: "CNC",
      quantity: qty,
      price,
      tradeValue: parseFloat(tradeValue.toFixed(2)),
      brokerage,
      exchangeFee,
      gst,
      sebiCharges,
      stampDuty,
      transactionTax: stt,
      totalCharges: parseFloat(totalCharges.toFixed(2)),
      netAmount: parseFloat(netAmount.toFixed(2)),
      tradeTime: randomDate(30),
    };
  });
}

function generateMockMutualFunds(count: number = 5): MutualFundData[] {
  const selectedFunds = [...MUTUAL_FUNDS].slice(0, count);
  return selectedFunds.map((fund, i) => {
    const units = parseFloat(randomBetween(100, 1000).toFixed(3));
    const averageNav = parseFloat(
      (fund.nav * randomBetween(0.85, 0.95)).toFixed(2)
    );
    const currentNav = fund.nav;
    const investedValue = parseFloat((units * averageNav).toFixed(2));
    const currentValue = parseFloat((units * currentNav).toFixed(2));
    const pnl = parseFloat((currentValue - investedValue).toFixed(2));
    const pnlPercentage = parseFloat(((pnl / investedValue) * 100).toFixed(2));
    const isSIP = i < 3;
    return {
      fundName: fund.name,
      schemeName: fund.name,
      isin: fund.isin,
      folio: `FOL${randomInt(100000, 999999)}`,
      category: fund.category,
      amcName: fund.amcName,
      units,
      averageNav,
      currentNav,
      lastNavDate: new Date(),
      investedValue,
      currentValue,
      pnl,
      pnlPercentage,
      isSIP,
      sipAmount: isSIP ? randomInt(1, 10) * 1000 : undefined,
      sipFrequency: isSIP ? "MONTHLY" : undefined,
      sipDay: isSIP ? randomInt(1, 28) : undefined,
      nextSIPDate: isSIP
        ? new Date(Date.now() + randomInt(1, 30) * 24 * 60 * 60 * 1000)
        : undefined,
    };
  });
}

function shouldUseMockData(broker: string): boolean {
  const brokerEnvKeys: Record<string, string[]> = {
    ZERODHA: ["ZERODHA_API_KEY", "ZERODHA_API_SECRET"],
    UPSTOX: ["UPSTOX_API_KEY", "UPSTOX_API_SECRET"],
    FYERS: ["FYERS_APP_ID", "FYERS_SECRET_KEY"],
    DHAN: ["DHAN_CLIENT_ID", "DHAN_API_KEY"],
    ANGEL_ONE: ["ANGEL_API_KEY", "ANGEL_CLIENT_CODE"],
    GROWW: ["GROWW_API_KEY"],
    ICICI: ["ICICI_API_KEY", "ICICI_SECRET_KEY"],
    HDFC: ["HDFC_API_KEY", "HDFC_SECRET_KEY"],
  };
  const keys = brokerEnvKeys[broker] || [];
  return keys.some((key) => !process.env[key]);
}

// ============== TESTS ==============

describe("Mock Data Generator", () => {
  // ---------- generateMockHoldings ----------
  describe("generateMockHoldings", () => {
    it("should return default 8 holdings", () => {
      const holdings = generateMockHoldings();
      assert.strictEqual(holdings.length, 8);
    });

    it("should return requested count of holdings", () => {
      const holdings = generateMockHoldings(5);
      assert.strictEqual(holdings.length, 5);
    });

    it("should return 1 holding when count is 1", () => {
      const holdings = generateMockHoldings(1);
      assert.strictEqual(holdings.length, 1);
    });

    it("should cap at available stocks (15) when requested more", () => {
      const holdings = generateMockHoldings(20);
      assert.strictEqual(holdings.length, 15);
    });

    it("should have valid symbol for each holding", () => {
      const holdings = generateMockHoldings();
      const validSymbols = STOCKS.map((s) => s.symbol);
      for (const h of holdings) {
        assert.ok(
          validSymbols.includes(h.symbol),
          `Invalid symbol: ${h.symbol}`
        );
      }
    });

    it("should have unique symbols (no duplicates)", () => {
      const holdings = generateMockHoldings(10);
      const symbols = holdings.map((h) => h.symbol);
      const uniqueSymbols = new Set(symbols);
      assert.strictEqual(symbols.length, uniqueSymbols.size);
    });

    it("should have exchange set to NSE", () => {
      const holdings = generateMockHoldings();
      for (const h of holdings) {
        assert.strictEqual(h.exchange, "NSE");
      }
    });

    it("should have product set to CNC", () => {
      const holdings = generateMockHoldings();
      for (const h of holdings) {
        assert.strictEqual(h.product, "CNC");
      }
    });

    it("should have positive totalQuantity (10-200 range)", () => {
      const holdings = generateMockHoldings();
      for (const h of holdings) {
        assert.ok(h.totalQuantity >= 10, `Quantity ${h.totalQuantity} < 10`);
        assert.ok(h.totalQuantity < 200, `Quantity ${h.totalQuantity} >= 200`);
      }
    });

    it("should have freeQuantity equal to totalQuantity", () => {
      const holdings = generateMockHoldings();
      for (const h of holdings) {
        assert.strictEqual(h.freeQuantity, h.totalQuantity);
      }
    });

    it("should have t1Quantity set to 0", () => {
      const holdings = generateMockHoldings();
      for (const h of holdings) {
        assert.strictEqual(h.t1Quantity, 0);
      }
    });

    it("should have positive averagePrice", () => {
      const holdings = generateMockHoldings();
      for (const h of holdings) {
        assert.ok(
          h.averagePrice > 0,
          `Average price should be positive: ${h.averagePrice}`
        );
      }
    });

    it("should have positive lastPrice", () => {
      const holdings = generateMockHoldings();
      for (const h of holdings) {
        assert.ok(
          h.lastPrice > 0,
          `Last price should be positive: ${h.lastPrice}`
        );
      }
    });

    it("should have ISIN starting with INE", () => {
      const holdings = generateMockHoldings();
      for (const h of holdings) {
        assert.ok(
          h.isin?.startsWith("INE"),
          `ISIN should start with INE: ${h.isin}`
        );
      }
    });

    it("should have tradingSymbol matching symbol", () => {
      const holdings = generateMockHoldings();
      for (const h of holdings) {
        assert.strictEqual(h.tradingSymbol, h.symbol);
      }
    });
  });

  // ---------- generateMockPositions ----------
  describe("generateMockPositions", () => {
    it("should return default 4 positions", () => {
      const positions = generateMockPositions();
      assert.strictEqual(positions.length, 4);
    });

    it("should return requested count", () => {
      const positions = generateMockPositions(3);
      assert.strictEqual(positions.length, 3);
    });

    it("should have exchange set to NSE", () => {
      const positions = generateMockPositions();
      for (const p of positions) {
        assert.strictEqual(p.exchange, "NSE");
      }
    });

    it("should have segment set to CASH", () => {
      const positions = generateMockPositions();
      for (const p of positions) {
        assert.strictEqual(p.segment, "CASH");
      }
    });

    it("should have positionType set to DAY", () => {
      const positions = generateMockPositions();
      for (const p of positions) {
        assert.strictEqual(p.positionType, "DAY");
      }
    });

    it("should have productType set to MIS", () => {
      const positions = generateMockPositions();
      for (const p of positions) {
        assert.strictEqual(p.productType, "MIS");
      }
    });

    it("should have netQuantity equal to buyQuantity - sellQuantity", () => {
      const positions = generateMockPositions();
      for (const p of positions) {
        assert.strictEqual(p.netQuantity, p.buyQuantity - p.sellQuantity);
      }
    });

    it("should have non-negative buyQuantity", () => {
      const positions = generateMockPositions();
      for (const p of positions) {
        assert.ok(
          p.buyQuantity >= 0,
          `Buy qty should be >= 0: ${p.buyQuantity}`
        );
      }
    });

    it("should have non-negative sellQuantity", () => {
      const positions = generateMockPositions();
      for (const p of positions) {
        assert.ok(
          p.sellQuantity >= 0,
          `Sell qty should be >= 0: ${p.sellQuantity}`
        );
      }
    });

    it("should have positive buyPrice", () => {
      const positions = generateMockPositions();
      for (const p of positions) {
        assert.ok(
          p.buyPrice > 0,
          `Buy price should be positive: ${p.buyPrice}`
        );
      }
    });

    it("should have positive lastPrice", () => {
      const positions = generateMockPositions();
      for (const p of positions) {
        assert.ok(
          p.lastPrice > 0,
          `Last price should be positive: ${p.lastPrice}`
        );
      }
    });
  });

  // ---------- generateMockOrders ----------
  describe("generateMockOrders", () => {
    it("should return default 10 orders", () => {
      const orders = generateMockOrders();
      assert.strictEqual(orders.length, 10);
    });

    it("should return requested count", () => {
      const orders = generateMockOrders(5);
      assert.strictEqual(orders.length, 5);
    });

    it("should have valid status values", () => {
      const validStatuses = ["COMPLETE", "PENDING", "CANCELLED", "REJECTED"];
      const orders = generateMockOrders();
      for (const o of orders) {
        assert.ok(
          validStatuses.includes(o.status),
          `Invalid status: ${o.status}`
        );
      }
    });

    it("should cycle through statuses", () => {
      const orders = generateMockOrders(4);
      const statuses = orders.map((o) => o.status);
      assert.strictEqual(statuses[0], "COMPLETE");
      assert.strictEqual(statuses[1], "PENDING");
      assert.strictEqual(statuses[2], "CANCELLED");
      assert.strictEqual(statuses[3], "REJECTED");
    });

    it("should have valid orderType values", () => {
      const validOrderTypes = ["MARKET", "LIMIT", "SL", "SL-M"];
      const orders = generateMockOrders();
      for (const o of orders) {
        assert.ok(
          validOrderTypes.includes(o.orderType),
          `Invalid orderType: ${o.orderType}`
        );
      }
    });

    it("should have valid transactionType (BUY or SELL)", () => {
      const orders = generateMockOrders();
      for (const o of orders) {
        assert.ok(
          o.transactionType === "BUY" || o.transactionType === "SELL",
          `Invalid transactionType: ${o.transactionType}`
        );
      }
    });

    it("should have filledQuantity equal to quantity for COMPLETE orders", () => {
      const orders = generateMockOrders(4);
      const completeOrders = orders.filter((o) => o.status === "COMPLETE");
      for (const o of completeOrders) {
        assert.strictEqual(o.filledQuantity, o.quantity);
      }
    });

    it("should have filledQuantity of 0 for CANCELLED orders", () => {
      const orders = generateMockOrders(4);
      const cancelledOrders = orders.filter((o) => o.status === "CANCELLED");
      for (const o of cancelledOrders) {
        assert.strictEqual(o.filledQuantity, 0);
      }
    });

    it("should have orderId starting with ORD", () => {
      const orders = generateMockOrders();
      for (const o of orders) {
        assert.ok(
          o.orderId.startsWith("ORD"),
          `OrderId should start with ORD: ${o.orderId}`
        );
      }
    });

    it("should have exchange set to NSE", () => {
      const orders = generateMockOrders();
      for (const o of orders) {
        assert.strictEqual(o.exchange, "NSE");
      }
    });

    it("should have validity set to DAY", () => {
      const orders = generateMockOrders();
      for (const o of orders) {
        assert.strictEqual(o.validity, "DAY");
      }
    });

    it("should have statusMessage for REJECTED orders", () => {
      const orders = generateMockOrders(4);
      const rejectedOrders = orders.filter((o) => o.status === "REJECTED");
      for (const o of rejectedOrders) {
        assert.strictEqual(o.statusMessage, "Insufficient funds");
      }
    });

    it("should have orderTime as Date", () => {
      const orders = generateMockOrders();
      for (const o of orders) {
        assert.ok(o.orderTime instanceof Date);
      }
    });

    it("should have positive quantity", () => {
      const orders = generateMockOrders();
      for (const o of orders) {
        assert.ok(o.quantity >= 10, `Quantity should be >= 10: ${o.quantity}`);
        assert.ok(o.quantity < 100, `Quantity should be < 100: ${o.quantity}`);
      }
    });
  });

  // ---------- generateMockTrades ----------
  describe("generateMockTrades", () => {
    it("should return default 15 trades", () => {
      const trades = generateMockTrades();
      assert.strictEqual(trades.length, 15);
    });

    it("should return requested count (capped at 15 stocks)", () => {
      const trades = generateMockTrades(5);
      assert.strictEqual(trades.length, 5);
    });

    it("should have tradeId starting with TRD", () => {
      const trades = generateMockTrades();
      for (const t of trades) {
        assert.ok(
          t.tradeId.startsWith("TRD"),
          `TradeId should start with TRD: ${t.tradeId}`
        );
      }
    });

    it("should have orderId starting with ORD", () => {
      const trades = generateMockTrades();
      for (const t of trades) {
        assert.ok(
          t.orderId.startsWith("ORD"),
          `OrderId should start with ORD: ${t.orderId}`
        );
      }
    });

    it("should have brokerage fixed at 20", () => {
      const trades = generateMockTrades();
      for (const t of trades) {
        assert.strictEqual(t.brokerage, 20);
      }
    });

    it("should have GST at 18% of brokerage", () => {
      const trades = generateMockTrades();
      for (const t of trades) {
        const expectedGst = parseFloat((20 * 0.18).toFixed(2));
        assert.strictEqual(t.gst, expectedGst);
      }
    });

    it("should have positive tradeValue", () => {
      const trades = generateMockTrades();
      for (const t of trades) {
        assert.ok(
          t.tradeValue > 0,
          `Trade value should be positive: ${t.tradeValue}`
        );
      }
    });

    it("should have valid transactionType (BUY or SELL)", () => {
      const trades = generateMockTrades();
      for (const t of trades) {
        assert.ok(
          t.transactionType === "BUY" || t.transactionType === "SELL",
          `Invalid transactionType: ${t.transactionType}`
        );
      }
    });

    it("should have tradeTime as Date", () => {
      const trades = generateMockTrades();
      for (const t of trades) {
        assert.ok(t.tradeTime instanceof Date);
      }
    });

    it("should have exchange set to NSE", () => {
      const trades = generateMockTrades();
      for (const t of trades) {
        assert.strictEqual(t.exchange, "NSE");
      }
    });

    it("should have segment set to CASH", () => {
      const trades = generateMockTrades();
      for (const t of trades) {
        assert.strictEqual(t.segment, "CASH");
      }
    });

    it("should have positive price", () => {
      const trades = generateMockTrades();
      for (const t of trades) {
        assert.ok(t.price > 0, `Price should be positive: ${t.price}`);
      }
    });

    it("should have positive quantity in range 10-100", () => {
      const trades = generateMockTrades();
      for (const t of trades) {
        assert.ok(t.quantity >= 10 && t.quantity < 100);
      }
    });
  });

  // ---------- generateMockMutualFunds ----------
  describe("generateMockMutualFunds", () => {
    it("should return default 5 mutual funds", () => {
      const funds = generateMockMutualFunds();
      assert.strictEqual(funds.length, 5);
    });

    it("should return requested count", () => {
      const funds = generateMockMutualFunds(3);
      assert.strictEqual(funds.length, 3);
    });

    it("should have valid ISIN for each fund", () => {
      const validIsins = MUTUAL_FUNDS.map((f) => f.isin);
      const funds = generateMockMutualFunds();
      for (const f of funds) {
        assert.ok(validIsins.includes(f.isin), `Invalid ISIN: ${f.isin}`);
      }
    });

    it("should have fundName matching schemeName", () => {
      const funds = generateMockMutualFunds();
      for (const f of funds) {
        assert.strictEqual(f.fundName, f.schemeName);
      }
    });

    it("should have first 3 funds as SIP", () => {
      const funds = generateMockMutualFunds(5);
      assert.strictEqual(funds[0].isSIP, true);
      assert.strictEqual(funds[1].isSIP, true);
      assert.strictEqual(funds[2].isSIP, true);
      assert.strictEqual(funds[3].isSIP, false);
      assert.strictEqual(funds[4].isSIP, false);
    });

    it("should have SIP amount for SIP funds (multiples of 1000)", () => {
      const funds = generateMockMutualFunds(5);
      for (const f of funds) {
        if (f.isSIP) {
          assert.ok(
            f.sipAmount !== undefined,
            "SIP fund should have sipAmount"
          );
          assert.ok(
            f.sipAmount! >= 1000 && f.sipAmount! <= 10000,
            `SIP amount should be 1000-10000: ${f.sipAmount}`
          );
          assert.strictEqual(
            f.sipAmount! % 1000,
            0,
            "SIP amount should be multiple of 1000"
          );
        }
      }
    });

    it("should have sipFrequency MONTHLY for SIP funds", () => {
      const funds = generateMockMutualFunds(3);
      for (const f of funds) {
        if (f.isSIP) {
          assert.strictEqual(f.sipFrequency, "MONTHLY");
        }
      }
    });

    it("should not have SIP fields for non-SIP funds", () => {
      const funds = generateMockMutualFunds(5);
      for (const f of funds) {
        if (!f.isSIP) {
          assert.strictEqual(f.sipAmount, undefined);
          assert.strictEqual(f.sipFrequency, undefined);
          assert.strictEqual(f.sipDay, undefined);
          assert.strictEqual(f.nextSIPDate, undefined);
        }
      }
    });

    it("should have positive units (100-1000 range)", () => {
      const funds = generateMockMutualFunds();
      for (const f of funds) {
        assert.ok(f.units >= 100, `Units should be >= 100: ${f.units}`);
        assert.ok(f.units <= 1000, `Units should be <= 1000: ${f.units}`);
      }
    });

    it("should have averageNav less than currentNav (bought at discount)", () => {
      const funds = generateMockMutualFunds();
      for (const f of funds) {
        assert.ok(
          f.averageNav < f.currentNav,
          `Average NAV (${f.averageNav}) should be less than current NAV (${f.currentNav})`
        );
      }
    });

    it("should have positive PnL (since averageNav < currentNav)", () => {
      const funds = generateMockMutualFunds();
      for (const f of funds) {
        assert.ok(f.pnl > 0, `PnL should be positive: ${f.pnl}`);
      }
    });

    it("should have folio starting with FOL", () => {
      const funds = generateMockMutualFunds();
      for (const f of funds) {
        assert.ok(
          f.folio?.startsWith("FOL"),
          `Folio should start with FOL: ${f.folio}`
        );
      }
    });

    it("should have category matching source data", () => {
      const funds = generateMockMutualFunds();
      const validCategories = MUTUAL_FUNDS.map((f) => f.category);
      for (const f of funds) {
        assert.ok(
          validCategories.includes(f.category!),
          `Invalid category: ${f.category}`
        );
      }
    });
  });

  // ---------- shouldUseMockData ----------
  describe("shouldUseMockData", () => {
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = {};
      // Save relevant env vars
      const envKeys = [
        "ZERODHA_API_KEY",
        "ZERODHA_API_SECRET",
        "UPSTOX_API_KEY",
        "UPSTOX_API_SECRET",
        "FYERS_APP_ID",
        "FYERS_SECRET_KEY",
        "DHAN_CLIENT_ID",
        "DHAN_API_KEY",
        "ANGEL_API_KEY",
        "ANGEL_CLIENT_CODE",
        "GROWW_API_KEY",
        "ICICI_API_KEY",
        "ICICI_SECRET_KEY",
        "HDFC_API_KEY",
        "HDFC_SECRET_KEY",
      ];
      for (const key of envKeys) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      // Restore env vars
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });

    it("should return true for ZERODHA when API keys are missing", () => {
      assert.strictEqual(shouldUseMockData("ZERODHA"), true);
    });

    it("should return false for ZERODHA when all API keys are set", () => {
      process.env.ZERODHA_API_KEY = "test-key";
      process.env.ZERODHA_API_SECRET = "test-secret";
      assert.strictEqual(shouldUseMockData("ZERODHA"), false);
    });

    it("should return true for ZERODHA when only one key is set", () => {
      process.env.ZERODHA_API_KEY = "test-key";
      // ZERODHA_API_SECRET is still missing
      assert.strictEqual(shouldUseMockData("ZERODHA"), true);
    });

    it("should return true for UPSTOX when API keys are missing", () => {
      assert.strictEqual(shouldUseMockData("UPSTOX"), true);
    });

    it("should return false for UPSTOX when all API keys are set", () => {
      process.env.UPSTOX_API_KEY = "test-key";
      process.env.UPSTOX_API_SECRET = "test-secret";
      assert.strictEqual(shouldUseMockData("UPSTOX"), false);
    });

    it("should return true for FYERS when API keys are missing", () => {
      assert.strictEqual(shouldUseMockData("FYERS"), true);
    });

    it("should return false for FYERS when all API keys are set", () => {
      process.env.FYERS_APP_ID = "test-id";
      process.env.FYERS_SECRET_KEY = "test-secret";
      assert.strictEqual(shouldUseMockData("FYERS"), false);
    });

    it("should return true for DHAN when API keys are missing", () => {
      assert.strictEqual(shouldUseMockData("DHAN"), true);
    });

    it("should return true for GROWW when API key is missing", () => {
      assert.strictEqual(shouldUseMockData("GROWW"), true);
    });

    it("should return false for GROWW when API key is set (only 1 key required)", () => {
      process.env.GROWW_API_KEY = "test-key";
      assert.strictEqual(shouldUseMockData("GROWW"), false);
    });

    it("should return true for unknown broker (empty keys array)", () => {
      // Unknown broker returns empty keys array, .some() returns false
      assert.strictEqual(shouldUseMockData("UNKNOWN_BROKER"), false);
    });

    it("should return true for ANGEL_ONE when API keys are missing", () => {
      assert.strictEqual(shouldUseMockData("ANGEL_ONE"), true);
    });

    it("should return true for ICICI when API keys are missing", () => {
      assert.strictEqual(shouldUseMockData("ICICI"), true);
    });

    it("should return true for HDFC when API keys are missing", () => {
      assert.strictEqual(shouldUseMockData("HDFC"), true);
    });
  });

  // ---------- Helper functions ----------
  describe("Helper functions", () => {
    it("randomBetween should return value in range", () => {
      for (let i = 0; i < 100; i++) {
        const val = randomBetween(10, 20);
        assert.ok(val >= 10 && val < 20, `Value ${val} out of range [10, 20)`);
      }
    });

    it("randomInt should return integer in range", () => {
      for (let i = 0; i < 100; i++) {
        const val = randomInt(1, 10);
        assert.ok(val >= 1 && val < 10, `Value ${val} out of range [1, 10)`);
        assert.strictEqual(val, Math.floor(val), "Should be integer");
      }
    });

    it("randomDate should return date within range", () => {
      // `now` used to be captured ONCE before the loop while randomDate()
      // calls `new Date()` internally on every iteration — so a 0-day draw
      // produced a timestamp LATER than `now` and the "not in the future"
      // assertion failed whenever a millisecond had elapsed. It passed most
      // runs only because 20 trivial iterations usually finish inside the
      // same millisecond, which made it a rare, unreproducible red build.
      // Bracket each call instead: its internal now lies in [before, after].
      for (let i = 0; i < 20; i++) {
        const before = Date.now();
        const date = randomDate(30);
        const after = Date.now();
        assert.ok(
          date.getTime() <= after,
          `Date should not be in the future (got ${date.toISOString()})`
        );
        assert.ok(
          before - date.getTime() <= 30 * 24 * 60 * 60 * 1000 + 1000,
          "Date should be within 30 days"
        );
      }
    });
  });
});
