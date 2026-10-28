/**
 * Zerodha (Kite) Normalization — Pure Logic
 *
 * Pure, side-effect-free row mappers used by `ZerodhaAdapter` to convert raw
 * Kite API rows into the normalized broker data shapes. Extracted so the exact
 * mapping/derivation logic that production runs (holdings P&L %, F&O segment
 * classification, trade charge totals, MF P&L) can be unit-tested without live
 * API calls.
 *
 * `ZerodhaAdapter` imports and calls these in its fetch methods — no parallel
 * copies.
 */

import type {
  HoldingData,
  PositionData,
  OrderData,
  TradeData,
  MutualFundData,
} from "@usemoney/types";

type Row = Record<string, unknown>;

/** Exchanges that map to the F&O ("FNO") segment; everything else is CASH. */
export const FNO_EXCHANGES = ["NFO", "BFO", "CDS", "MCX"] as const;

/** Classify a Zerodha exchange into our segment buckets. */
export function zerodhaSegmentForExchange(exchange: string): "FNO" | "CASH" {
  return (FNO_EXCHANGES as readonly string[]).includes(exchange)
    ? "FNO"
    : "CASH";
}

/** Map a raw Kite holding row → HoldingData (derives free qty + P&L %). */
export function normalizeZerodhaHolding(h: Row): HoldingData {
  const quantity = h.quantity as number;
  const averagePrice = h.average_price as number;
  const lastPrice = h.last_price as number;
  return {
    symbol: h.tradingsymbol as string,
    tradingSymbol: h.tradingsymbol as string,
    isin: h.isin as string,
    exchange: h.exchange as string,
    totalQuantity: quantity,
    freeQuantity: quantity - ((h.t1_quantity as number) || 0),
    t1Quantity: (h.t1_quantity as number) || 0,
    pledgedQuantity: (h.collateral_quantity as number) || 0,
    collateralQty: (h.collateral_quantity as number) || 0,
    averagePrice,
    lastPrice,
    closePrice: h.close_price as number,
    pnl: h.pnl as number,
    pnlPercentage:
      averagePrice > 0 ? ((lastPrice - averagePrice) / averagePrice) * 100 : 0,
    product: h.product as string,
    dayChange: (h.day_change as number) || 0,
    dayChangePerc: (h.day_change_percentage as number) || 0,
  };
}

/** Map a raw Kite position row → PositionData. */
export function normalizeZerodhaPosition(
  pos: Row,
  type: "DAY" | "NET",
): PositionData {
  const exchange = pos.exchange as string;
  return {
    symbol: pos.tradingsymbol as string,
    tradingSymbol: pos.tradingsymbol as string,
    exchange,
    segment: zerodhaSegmentForExchange(exchange),
    positionType: type,
    productType: pos.product as string,
    buyQuantity: pos.buy_quantity as number,
    sellQuantity: pos.sell_quantity as number,
    netQuantity: pos.quantity as number,
    buyPrice: pos.buy_price as number,
    sellPrice: pos.sell_price as number,
    averagePrice: pos.average_price as number,
    lastPrice: pos.last_price as number,
    realizedPnl: pos.realised as number,
    unrealizedPnl: pos.unrealised as number,
    expiryDate: pos.expiry ? new Date(pos.expiry as string) : undefined,
    strikePrice: pos.strike as number,
    optionType: pos.option_type as string,
    lotSize: pos.lot_size as number,
    multiplier: pos.multiplier as number,
  };
}

/** Map a raw Kite order row → OrderData. */
export function normalizeZerodhaOrder(o: Row): OrderData {
  const exchange = o.exchange as string;
  return {
    orderId: o.order_id as string,
    symbol: o.tradingsymbol as string,
    tradingSymbol: o.tradingsymbol as string,
    exchange,
    segment: zerodhaSegmentForExchange(exchange),
    orderType: o.order_type as string,
    transactionType: o.transaction_type as "BUY" | "SELL",
    productType: o.product as string,
    variety: o.variety as string,
    quantity: o.quantity as number,
    filledQuantity: o.filled_quantity as number,
    price: o.price as number,
    triggerPrice: o.trigger_price as number,
    averagePrice: o.average_price as number,
    status: o.status as string,
    statusMessage: o.status_message as string,
    validity: o.validity as string,
    orderTime: new Date(o.order_timestamp as string),
    updateTime: o.exchange_update_timestamp
      ? new Date(o.exchange_update_timestamp as string)
      : undefined,
    exchangeTime: o.exchange_timestamp
      ? new Date(o.exchange_timestamp as string)
      : undefined,
    tag: o.tag as string,
  };
}

/** Map a raw Kite trade row → TradeData (sums all charges + signs netAmount). */
export function normalizeZerodhaTrade(t: Row): TradeData {
  const tradeValue = (t.quantity as number) * (t.average_price as number);
  const brokerage = (t.brokerage as number) || 0;
  const exchangeFee = (t.exchange_fee as number) || 0;
  const gst = (t.gst as number) || 0;
  const sebiCharges = (t.sebi_charges as number) || 0;
  const stampDuty = (t.stamp_duty as number) || 0;
  const transactionTax = (t.transaction_tax as number) || 0;
  const totalCharges =
    brokerage + exchangeFee + gst + sebiCharges + stampDuty + transactionTax;
  const exchange = t.exchange as string;

  return {
    tradeId: t.trade_id as string,
    orderId: t.order_id as string,
    symbol: t.tradingsymbol as string,
    tradingSymbol: t.tradingsymbol as string,
    exchange,
    segment: zerodhaSegmentForExchange(exchange),
    transactionType: t.transaction_type as "BUY" | "SELL",
    productType: t.product as string,
    quantity: t.quantity as number,
    price: t.average_price as number,
    tradeValue,
    brokerage,
    exchangeFee,
    gst,
    sebiCharges,
    stampDuty,
    transactionTax,
    totalCharges,
    netAmount:
      t.transaction_type === "BUY"
        ? tradeValue + totalCharges
        : tradeValue - totalCharges,
    tradeTime: new Date(t.fill_timestamp as string),
  };
}

/** Map a raw Kite MF holding row → MutualFundData (derives invested/current/P&L). */
export function normalizeZerodhaMutualFund(mf: Row): MutualFundData {
  const investedValue = (mf.quantity as number) * (mf.average_price as number);
  const currentValue = (mf.quantity as number) * (mf.last_price as number);
  const pnl = currentValue - investedValue;

  return {
    fundName: mf.fund as string,
    schemeName: mf.fund as string,
    isin: mf.tradingsymbol as string,
    folio: mf.folio as string,
    units: mf.quantity as number,
    averageNav: mf.average_price as number,
    currentNav: mf.last_price as number,
    lastNavDate: mf.last_price_date
      ? new Date(mf.last_price_date as string)
      : undefined,
    investedValue,
    currentValue,
    pnl,
    pnlPercentage: investedValue > 0 ? (pnl / investedValue) * 100 : 0,
    isSIP: false,
  };
}
