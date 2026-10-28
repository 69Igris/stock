/**
 * Mock Data Generator for Broker Integrations
 * Provides realistic test data when real broker APIs are not available
 */

import type {
  HoldingData,
  PositionData,
  OrderData,
  TradeData,
  MutualFundData,
} from "@usemoney/types";

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

/**
 * The mock stock universe symbols (derived from STOCKS). Exported so tests can
 * validate generated mock holdings/positions against the real symbol set
 * without duplicating the list.
 */
export const MOCK_STOCK_SYMBOLS: readonly string[] = STOCKS.map(
  (s) => s.symbol,
);

const MUTUAL_FUNDS = [
  { name: "HDFC Top 100 Fund", isin: "INF179KA1GR8", nav: 825.5 },
  { name: "SBI Bluechip Fund", isin: "INF200K01RQ0", nav: 72.35 },
  { name: "ICICI Pru Technology Fund", isin: "INF109K01BM5", nav: 158.25 },
  { name: "Axis Long Term Equity Fund", isin: "INF846K01EW2", nav: 68.5 },
  { name: "Mirae Asset Large Cap Fund", isin: "INF769K01BI6", nav: 85.75 },
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

/**
 * Generate mock holdings data
 */
export function generateMockHoldings(count: number = 8): HoldingData[] {
  const selectedStocks = [...STOCKS]
    .sort(() => Math.random() - 0.5)
    .slice(0, count);

  return selectedStocks.map((stock) => {
    const quantity = randomInt(10, 200);
    // Round prices to the emitted 2dp FIRST, then derive every value from the
    // rounded prices, so pnl === currentValue - investedValue holds for exactly
    // the prices in the output. Deriving pnl from UNrounded prices while
    // emitting rounded ones drifted ~1-2 for large quantities and intermittently
    // flaked the "should calculate pnl correctly" assertion.
    const averagePrice = parseFloat(
      (stock.price * randomBetween(0.85, 1.0)).toFixed(2),
    );
    const lastPrice = parseFloat(
      (stock.price * randomBetween(0.98, 1.05)).toFixed(2),
    );
    const closePrice = parseFloat(
      (stock.price * randomBetween(0.99, 1.01)).toFixed(2),
    );
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
      averagePrice,
      lastPrice,
      closePrice,
      pnl: parseFloat(pnl.toFixed(2)),
      pnlPercentage: parseFloat(pnlPercentage.toFixed(2)),
      product: "CNC",
      dayChange: parseFloat(dayChange.toFixed(2)),
      dayChangePerc: parseFloat(dayChangePerc.toFixed(2)),
    };
  });
}

/**
 * Generate mock positions data
 */
export function generateMockPositions(count: number = 4): PositionData[] {
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

/**
 * Generate mock orders data
 */
export function generateMockOrders(count: number = 10): OrderData[] {
  const statuses = ["COMPLETE", "PENDING", "CANCELLED", "REJECTED"] as const;
  const orderTypes = ["MARKET", "LIMIT", "SL", "SL-M"] as const;
  const selectedStocks = [...STOCKS]
    .sort(() => Math.random() - 0.5)
    .slice(0, count);

  return selectedStocks.map((stock, i) => {
    const isBuy = Math.random() > 0.5;
    const qty = randomInt(10, 100);
    const status = statuses[i % statuses.length]!;
    const filledQty =
      status === "COMPLETE"
        ? qty
        : status === "PENDING"
          ? randomInt(0, qty)
          : 0;
    const orderTypeIndex = randomInt(0, orderTypes.length);
    const orderType = orderTypes[orderTypeIndex] ?? "MARKET";
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

/**
 * Generate mock trades data
 */
export function generateMockTrades(count: number = 15): TradeData[] {
  const selectedStocks = [...STOCKS]
    .sort(() => Math.random() - 0.5)
    .slice(0, count);

  return selectedStocks.map((stock) => {
    const isBuy = Math.random() > 0.5;
    const qty = randomInt(10, 100);
    const price = parseFloat(
      (stock.price * randomBetween(0.98, 1.02)).toFixed(2),
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

/**
 * Generate mock mutual funds data
 */
export function generateMockMutualFunds(count: number = 5): MutualFundData[] {
  const selectedFunds = [...MUTUAL_FUNDS].slice(0, count);

  return selectedFunds.map((fund, i) => {
    const units = parseFloat(randomBetween(100, 1000).toFixed(3));
    const averageNav = parseFloat(
      (fund.nav * randomBetween(0.85, 0.95)).toFixed(2),
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

/**
 * Check if mock mode should be used (no real API keys configured)
 */
export function shouldUseMockData(broker: string): boolean {
  const brokerEnvKeys: Record<string, string[]> = {
    ZERODHA: ["ZERODHA_API_KEY", "ZERODHA_API_SECRET"],
    UPSTOX: ["UPSTOX_API_KEY", "UPSTOX_API_SECRET"],
    FYERS: ["FYERS_APP_ID", "FYERS_SECRET_KEY"],
    DHAN: ["DHAN_CLIENT_ID", "DHAN_API_KEY"],
    ANGEL_ONE: ["ANGEL_API_KEY", "ANGEL_CLIENT_CODE"],
    GROWW: ["GROWW_API_KEY"],
    ICICI: ["ICICI_API_KEY", "ICICI_SECRET_KEY"],
    HDFC: ["HDFC_API_KEY", "HDFC_SECRET_KEY"],
    INTERACTIVE_BROKERS: [
      "INTERACTIVE_BROKERS_CLIENT_ID",
      "INTERACTIVE_BROKERS_CLIENT_SECRET",
    ],
  };

  const keys = brokerEnvKeys[broker] || [];
  return keys.some((key) => !process.env[key]);
}
