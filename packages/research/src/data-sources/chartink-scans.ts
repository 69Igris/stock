/**
 * Chartink Scan Library
 *
 * 100+ pre-built scan definitions organized by category,
 * using Chartink's query DSL syntax.
 *
 * Each scan maps to a POST body `scan_clause` for chartink.com/screener/process.
 *
 * Categories:
 *   price, volume_delivery, moving_average, momentum, macd,
 *   bollinger, candlestick, chart_pattern, supertrend, ichimoku, combined
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type ChartinkScanCategory =
  | "price"
  | "volume_delivery"
  | "moving_average"
  | "momentum"
  | "macd"
  | "bollinger"
  | "candlestick"
  | "chart_pattern"
  | "supertrend"
  | "ichimoku"
  | "combined";

export interface ChartinkScanDef {
  id: string;
  name: string;
  description: string;
  category: ChartinkScanCategory;
  query: string;
  tags: string[];
}

// ── Scan Definitions ───────────────────────────────────────────────────────

// ─── Price Scans (15) ──────────────────────────────────────────────────────

const PRICE_SCANS: ChartinkScanDef[] = [
  {
    id: "price_52w_high_breakout",
    name: "52-Week High Breakout",
    description: "Stocks making a new 52-week high today",
    category: "price",
    query: "( {cash} ( latest close >= latest max( 250, close ) ) )",
    tags: ["breakout", "52w", "high", "bullish"],
  },
  {
    id: "price_near_52w_high",
    name: "Near 52-Week High",
    description: "Stocks within 5% of their 52-week high",
    category: "price",
    query: "( {cash} ( latest close > latest max( 250, close ) * 0.95 ) )",
    tags: ["52w", "high", "near", "bullish"],
  },
  {
    id: "price_52w_low",
    name: "52-Week Low",
    description: "Stocks making a new 52-week low today",
    category: "price",
    query: "( {cash} ( latest close <= latest min( 250, close ) ) )",
    tags: ["52w", "low", "bearish", "bottom"],
  },
  {
    id: "price_near_52w_low",
    name: "Near 52-Week Low",
    description: "Stocks within 5% of their 52-week low",
    category: "price",
    query: "( {cash} ( latest close < latest min( 250, close ) * 1.05 ) )",
    tags: ["52w", "low", "near", "value"],
  },
  {
    id: "price_monthly_breakout",
    name: "Monthly Breakout (20-Day High)",
    description: "Stocks at a new 20-day high, signaling short-term breakout",
    category: "price",
    query: "( {cash} ( latest close >= latest max( 20, close ) ) )",
    tags: ["breakout", "20day", "monthly", "bullish"],
  },
  {
    id: "price_prev_day_breakout",
    name: "Previous Day High Breakout",
    description: "Stocks breaking above previous day high",
    category: "price",
    query: "( {cash} ( latest close > 1 day ago high ) )",
    tags: ["breakout", "intraday", "bullish"],
  },
  {
    id: "price_above_sma20",
    name: "Price Above SMA 20",
    description: "Stocks trading above their 20-day simple moving average",
    category: "price",
    query: "( {cash} ( latest close > latest sma( close,20 ) ) )",
    tags: ["sma", "20day", "bullish", "trend"],
  },
  {
    id: "price_below_sma20",
    name: "Price Below SMA 20",
    description: "Stocks trading below their 20-day simple moving average",
    category: "price",
    query: "( {cash} ( latest close < latest sma( close,20 ) ) )",
    tags: ["sma", "20day", "bearish", "weakness"],
  },
  {
    id: "price_above_sma50",
    name: "Price Above SMA 50",
    description: "Stocks trading above their 50-day simple moving average",
    category: "price",
    query: "( {cash} ( latest close > latest sma( close,50 ) ) )",
    tags: ["sma", "50day", "bullish", "trend"],
  },
  {
    id: "price_below_sma50",
    name: "Price Below SMA 50",
    description: "Stocks trading below their 50-day simple moving average",
    category: "price",
    query: "( {cash} ( latest close < latest sma( close,50 ) ) )",
    tags: ["sma", "50day", "bearish", "weakness"],
  },
  {
    id: "price_above_sma100",
    name: "Price Above SMA 100",
    description: "Stocks trading above their 100-day simple moving average",
    category: "price",
    query: "( {cash} ( latest close > latest sma( close,100 ) ) )",
    tags: ["sma", "100day", "bullish", "trend"],
  },
  {
    id: "price_above_sma200",
    name: "Price Above SMA 200",
    description:
      "Stocks trading above their 200-day simple moving average (long-term uptrend)",
    category: "price",
    query: "( {cash} ( latest close > latest sma( close,200 ) ) )",
    tags: ["sma", "200day", "bullish", "long-term"],
  },
  {
    id: "price_above_all_sma",
    name: "Above All Key SMAs",
    description: "Stocks above SMA 20, 50, 100, and 200 - strong uptrend",
    category: "price",
    query:
      "( {cash} ( latest close > latest sma( close,20 ) and latest close > latest sma( close,50 ) and latest close > latest sma( close,100 ) and latest close > latest sma( close,200 ) ) )",
    tags: ["sma", "all", "bullish", "strong-trend"],
  },
  {
    id: "price_below_all_sma",
    name: "Below All Key SMAs",
    description: "Stocks below SMA 20, 50, 100, and 200 - strong downtrend",
    category: "price",
    query:
      "( {cash} ( latest close < latest sma( close,20 ) and latest close < latest sma( close,50 ) and latest close < latest sma( close,100 ) and latest close < latest sma( close,200 ) ) )",
    tags: ["sma", "all", "bearish", "strong-downtrend"],
  },
  {
    id: "price_gap_up",
    name: "Price Gap Up > 2%",
    description:
      "Stocks that opened with a gap up of more than 2% from previous close",
    category: "price",
    query: "( {cash} ( latest open > 1 day ago close * 1.02 ) )",
    tags: ["gap", "up", "bullish", "momentum"],
  },
  {
    id: "price_gap_down",
    name: "Price Gap Down > 2%",
    description:
      "Stocks that opened with a gap down of more than 2% from previous close",
    category: "price",
    query: "( {cash} ( latest open < 1 day ago close * 0.98 ) )",
    tags: ["gap", "down", "bearish"],
  },
  {
    id: "price_inside_bar",
    name: "Inside Bar",
    description:
      "Today's high is below yesterday's high and today's low is above yesterday's low - consolidation pattern",
    category: "price",
    query:
      "( {cash} ( latest high < 1 day ago high and latest low > 1 day ago low ) )",
    tags: ["inside-bar", "consolidation", "pattern"],
  },
];

// ─── Volume & Delivery Scans (10) ──────────────────────────────────────────

const VOLUME_DELIVERY_SCANS: ChartinkScanDef[] = [
  {
    id: "vol_breakout",
    name: "Volume Breakout (> 2x Average)",
    description:
      "Stocks with volume more than twice their 20-day average volume",
    category: "volume_delivery",
    query: "( {cash} ( latest volume > 2 * latest sma( volume,20 ) ) )",
    tags: ["volume", "breakout", "surge", "activity"],
  },
  {
    id: "vol_climax",
    name: "Volume Climax (52-Week Highest)",
    description: "Stocks hitting their highest volume in the last 52 weeks",
    category: "volume_delivery",
    query: "( {cash} ( latest volume >= latest max( 250, volume ) ) )",
    tags: ["volume", "climax", "52w", "extreme"],
  },
  {
    id: "vol_dry_up",
    name: "Volume Dry Up (< 50% Average)",
    description:
      "Stocks with volume less than half their 20-day average - potential calm before storm",
    category: "volume_delivery",
    query: "( {cash} ( latest volume < 0.5 * latest sma( volume,20 ) ) )",
    tags: ["volume", "dry-up", "low", "consolidation"],
  },
  {
    id: "vol_delivery_70",
    name: "Delivery > 70%",
    description:
      "Stocks with delivery percentage above 70%, indicating genuine buying",
    category: "volume_delivery",
    query: '( {cash} ( latest "Delivery Percentage" > 70 ) )',
    tags: ["delivery", "high", "institutional", "genuine"],
  },
  {
    id: "vol_delivery_80",
    name: "Delivery > 80%",
    description:
      "Stocks with delivery percentage above 80%, very strong institutional interest",
    category: "volume_delivery",
    query: '( {cash} ( latest "Delivery Percentage" > 80 ) )',
    tags: ["delivery", "very-high", "institutional", "strong"],
  },
  {
    id: "vol_rising_price_rising",
    name: "Rising Volume + Rising Price",
    description: "Volume increasing with price going up - bullish confirmation",
    category: "volume_delivery",
    query:
      "( {cash} ( latest volume > 1 day ago volume and latest close > 1 day ago close and 1 day ago volume > 2 days ago volume and 1 day ago close > 2 days ago close ) )",
    tags: ["volume", "rising", "price", "bullish", "confirmation"],
  },
  {
    id: "vol_rising_price_falling",
    name: "Rising Volume + Falling Price",
    description:
      "Volume increasing but price dropping - distribution / bearish signal",
    category: "volume_delivery",
    query:
      "( {cash} ( latest volume > 1 day ago volume and latest close < 1 day ago close and 1 day ago volume > 2 days ago volume and 1 day ago close < 2 days ago close ) )",
    tags: ["volume", "rising", "price-falling", "bearish", "distribution"],
  },
  {
    id: "vol_surge_near_resistance",
    name: "Volume Surge Near Resistance",
    description:
      "High volume with price near 52-week high - potential breakout attempt",
    category: "volume_delivery",
    query:
      "( {cash} ( latest volume > 2 * latest sma( volume,20 ) and latest close > latest max( 250, close ) * 0.95 ) )",
    tags: ["volume", "surge", "resistance", "breakout"],
  },
  {
    id: "vol_obv_rising",
    name: "OBV Rising",
    description:
      "On-Balance Volume trending upward over 5 days - accumulation signal",
    category: "volume_delivery",
    query:
      "( {cash} ( latest obv > 1 day ago obv and 1 day ago obv > 2 days ago obv and 2 days ago obv > 3 days ago obv ) )",
    tags: ["obv", "rising", "accumulation", "bullish"],
  },
  {
    id: "vol_unusually_high_3d",
    name: "Unusually High Volume Last 3 Days",
    description:
      "Volume above 1.5x average for each of the last 3 days - sustained interest",
    category: "volume_delivery",
    query:
      "( {cash} ( latest volume > 1.5 * latest sma( volume,20 ) and 1 day ago volume > 1.5 * 1 day ago sma( volume,20 ) and 2 days ago volume > 1.5 * 2 days ago sma( volume,20 ) ) )",
    tags: ["volume", "high", "sustained", "3-day"],
  },
];

// ─── Moving Average Scans (15) ─────────────────────────────────────────────

const MOVING_AVERAGE_SCANS: ChartinkScanDef[] = [
  {
    id: "ma_golden_cross",
    name: "Golden Cross (SMA 50/200)",
    description:
      "SMA 50 crosses above SMA 200 - classic long-term bullish signal",
    category: "moving_average",
    query:
      "( {cash} ( latest sma( close,50 ) > latest sma( close,200 ) and 1 day ago sma( close,50 ) < 1 day ago sma( close,200 ) ) )",
    tags: ["golden-cross", "50/200", "bullish", "long-term"],
  },
  {
    id: "ma_death_cross",
    name: "Death Cross (SMA 50/200)",
    description:
      "SMA 50 crosses below SMA 200 - classic long-term bearish signal",
    category: "moving_average",
    query:
      "( {cash} ( latest sma( close,50 ) < latest sma( close,200 ) and 1 day ago sma( close,50 ) > 1 day ago sma( close,200 ) ) )",
    tags: ["death-cross", "50/200", "bearish", "long-term"],
  },
  {
    id: "ma_sma20_50_bullish",
    name: "SMA 20/50 Bullish Crossover",
    description: "SMA 20 crosses above SMA 50 - medium-term bullish signal",
    category: "moving_average",
    query:
      "( {cash} ( latest sma( close,20 ) > latest sma( close,50 ) and 1 day ago sma( close,20 ) < 1 day ago sma( close,50 ) ) )",
    tags: ["crossover", "20/50", "bullish", "medium-term"],
  },
  {
    id: "ma_sma20_50_bearish",
    name: "SMA 20/50 Bearish Crossover",
    description: "SMA 20 crosses below SMA 50 - medium-term bearish signal",
    category: "moving_average",
    query:
      "( {cash} ( latest sma( close,20 ) < latest sma( close,50 ) and 1 day ago sma( close,20 ) > 1 day ago sma( close,50 ) ) )",
    tags: ["crossover", "20/50", "bearish", "medium-term"],
  },
  {
    id: "ma_ema9_21_bullish",
    name: "EMA 9/21 Bullish Crossover",
    description: "EMA 9 crosses above EMA 21 - short-term bullish signal",
    category: "moving_average",
    query:
      "( {cash} ( latest ema( close,9 ) > latest ema( close,21 ) and 1 day ago ema( close,9 ) < 1 day ago ema( close,21 ) ) )",
    tags: ["crossover", "ema", "9/21", "bullish", "short-term"],
  },
  {
    id: "ma_ema9_21_bearish",
    name: "EMA 9/21 Bearish Crossover",
    description: "EMA 9 crosses below EMA 21 - short-term bearish signal",
    category: "moving_average",
    query:
      "( {cash} ( latest ema( close,9 ) < latest ema( close,21 ) and 1 day ago ema( close,9 ) > 1 day ago ema( close,21 ) ) )",
    tags: ["crossover", "ema", "9/21", "bearish", "short-term"],
  },
  {
    id: "ma_ema5_13_bullish",
    name: "EMA 5/13 Bullish Crossover",
    description:
      "EMA 5 crosses above EMA 13 - very short-term bullish momentum",
    category: "moving_average",
    query:
      "( {cash} ( latest ema( close,5 ) > latest ema( close,13 ) and 1 day ago ema( close,5 ) < 1 day ago ema( close,13 ) ) )",
    tags: ["crossover", "ema", "5/13", "bullish", "scalping"],
  },
  {
    id: "ma_bounce_sma200",
    name: "Price Bouncing Off SMA 200",
    description:
      "Price touched or dipped below SMA 200 recently and is now recovering above it - support bounce",
    category: "moving_average",
    query:
      "( {cash} ( latest close > latest sma( close,200 ) and 1 day ago low <= 1 day ago sma( close,200 ) ) )",
    tags: ["bounce", "sma200", "support", "bullish"],
  },
  {
    id: "ma_bounce_sma50",
    name: "Price Bouncing Off SMA 50",
    description:
      "Price touched or dipped below SMA 50 and is recovering above it",
    category: "moving_average",
    query:
      "( {cash} ( latest close > latest sma( close,50 ) and 1 day ago low <= 1 day ago sma( close,50 ) ) )",
    tags: ["bounce", "sma50", "support", "bullish"],
  },
  {
    id: "ma_weekly_sma50_support",
    name: "Weekly SMA 50 Support",
    description: "Price above weekly SMA 50 - strong long-term support",
    category: "moving_average",
    query:
      "( {cash} ( weekly latest close > weekly latest sma( close,50 ) and weekly 1 week ago low <= weekly 1 week ago sma( close,50 ) ) )",
    tags: ["weekly", "sma50", "support", "long-term"],
  },
  {
    id: "ma_ema_alignment_bullish",
    name: "All EMA Alignment Bullish",
    description:
      "EMA 9 > EMA 21 > EMA 50 > EMA 200 - perfect bullish alignment (trend paradise)",
    category: "moving_average",
    query:
      "( {cash} ( latest ema( close,9 ) > latest ema( close,21 ) and latest ema( close,21 ) > latest ema( close,50 ) and latest ema( close,50 ) > latest ema( close,200 ) ) )",
    tags: ["ema", "alignment", "bullish", "strong-trend", "all"],
  },
  {
    id: "ma_sma100_200_bullish",
    name: "SMA 100/200 Bullish Crossover",
    description: "SMA 100 crosses above SMA 200 - longer-term trend shift",
    category: "moving_average",
    query:
      "( {cash} ( latest sma( close,100 ) > latest sma( close,200 ) and 1 day ago sma( close,100 ) < 1 day ago sma( close,200 ) ) )",
    tags: ["crossover", "100/200", "bullish", "long-term"],
  },
  {
    id: "ma_price_cross_ema21_up",
    name: "Price Crossing Above EMA 21",
    description:
      "Price crosses above EMA 21 from below - short-term trend reversal",
    category: "moving_average",
    query:
      "( {cash} ( latest close > latest ema( close,21 ) and 1 day ago close < 1 day ago ema( close,21 ) ) )",
    tags: ["crossover", "ema21", "bullish", "reversal"],
  },
  {
    id: "ma_sma20_rising",
    name: "SMA 20 Rising",
    description:
      "SMA 20 trending upward for 5 consecutive days - short-term momentum",
    category: "moving_average",
    query:
      "( {cash} ( latest sma( close,20 ) > 1 day ago sma( close,20 ) and 1 day ago sma( close,20 ) > 2 days ago sma( close,20 ) and 2 days ago sma( close,20 ) > 3 days ago sma( close,20 ) and 3 days ago sma( close,20 ) > 4 days ago sma( close,20 ) ) )",
    tags: ["sma20", "rising", "bullish", "trend"],
  },
  {
    id: "ma_price_below_sma200_recovering",
    name: "Below SMA 200 But Recovering",
    description:
      "Price below SMA 200 but closing higher for 3 consecutive days - potential reversal",
    category: "moving_average",
    query:
      "( {cash} ( latest close < latest sma( close,200 ) and latest close > 1 day ago close and 1 day ago close > 2 days ago close and 2 days ago close > 3 days ago close ) )",
    tags: ["sma200", "below", "recovering", "reversal"],
  },
];

// ─── Momentum Scans (15) ───────────────────────────────────────────────────

const MOMENTUM_SCANS: ChartinkScanDef[] = [
  {
    id: "mom_rsi_oversold",
    name: "RSI Oversold (< 30)",
    description: "Stocks with RSI(14) below 30 - potentially oversold",
    category: "momentum",
    query: "( {cash} ( latest rsi( close,14 ) < 30 ) )",
    tags: ["rsi", "oversold", "reversal", "value"],
  },
  {
    id: "mom_rsi_overbought",
    name: "RSI Overbought (> 70)",
    description: "Stocks with RSI(14) above 70 - potentially overbought",
    category: "momentum",
    query: "( {cash} ( latest rsi( close,14 ) > 70 ) )",
    tags: ["rsi", "overbought", "caution"],
  },
  {
    id: "mom_rsi_bullish_divergence",
    name: "RSI Bullish Divergence (Approx)",
    description:
      "Price making lower lows but RSI making higher lows - potential bullish reversal",
    category: "momentum",
    query:
      "( {cash} ( latest close < 5 days ago close and latest rsi( close,14 ) > 5 days ago rsi( close,14 ) and latest rsi( close,14 ) < 40 ) )",
    tags: ["rsi", "divergence", "bullish", "reversal"],
  },
  {
    id: "mom_rsi_sweet_spot",
    name: "RSI in Sweet Spot (50-70)",
    description:
      "RSI between 50 and 70 - stocks in healthy uptrend momentum zone",
    category: "momentum",
    query:
      "( {cash} ( latest rsi( close,14 ) > 50 and latest rsi( close,14 ) < 70 ) )",
    tags: ["rsi", "sweet-spot", "momentum", "uptrend"],
  },
  {
    id: "mom_stoch_oversold",
    name: "Stochastic Oversold (< 20)",
    description: "Stochastic %K below 20 - oversold territory",
    category: "momentum",
    query: "( {cash} ( latest stochastic k( close,14,3 ) < 20 ) )",
    tags: ["stochastic", "oversold", "reversal"],
  },
  {
    id: "mom_stoch_overbought",
    name: "Stochastic Overbought (> 80)",
    description: "Stochastic %K above 80 - overbought territory",
    category: "momentum",
    query: "( {cash} ( latest stochastic k( close,14,3 ) > 80 ) )",
    tags: ["stochastic", "overbought", "caution"],
  },
  {
    id: "mom_adx_strong_trend",
    name: "ADX > 25 (Strong Trend)",
    description: "ADX above 25 indicating a strong directional trend",
    category: "momentum",
    query: "( {cash} ( latest adx( 14 ) > 25 ) )",
    tags: ["adx", "strong", "trend", "directional"],
  },
  {
    id: "mom_adx_very_strong",
    name: "ADX > 40 (Very Strong Trend)",
    description: "ADX above 40 indicating a very strong directional trend",
    category: "momentum",
    query: "( {cash} ( latest adx( 14 ) > 40 ) )",
    tags: ["adx", "very-strong", "trend", "extreme"],
  },
  {
    id: "mom_adx_rising_from_low",
    name: "ADX Rising From Low",
    description: "ADX recently below 15 and now above 20 - new trend emerging",
    category: "momentum",
    query: "( {cash} ( latest adx( 14 ) > 20 and 5 days ago adx( 14 ) < 15 ) )",
    tags: ["adx", "rising", "new-trend", "emerging"],
  },
  {
    id: "mom_williams_oversold",
    name: "Williams %R Oversold (< -80)",
    description: "Williams %R below -80 - oversold territory",
    category: "momentum",
    query: "( {cash} ( latest williams %r( 14 ) < -80 ) )",
    tags: ["williams", "oversold", "reversal"],
  },
  {
    id: "mom_williams_overbought",
    name: "Williams %R Overbought (> -20)",
    description: "Williams %R above -20 - overbought territory",
    category: "momentum",
    query: "( {cash} ( latest williams %r( 14 ) > -20 ) )",
    tags: ["williams", "overbought", "caution"],
  },
  {
    id: "mom_cci_oversold",
    name: "CCI Oversold (< -100)",
    description: "CCI(20) below -100 - oversold condition",
    category: "momentum",
    query: "( {cash} ( latest cci( close,20 ) < -100 ) )",
    tags: ["cci", "oversold", "reversal"],
  },
  {
    id: "mom_cci_overbought",
    name: "CCI Overbought (> 100)",
    description: "CCI(20) above 100 - overbought condition",
    category: "momentum",
    query: "( {cash} ( latest cci( close,20 ) > 100 ) )",
    tags: ["cci", "overbought", "caution"],
  },
  {
    id: "mom_momentum_score",
    name: "Momentum Score (RSI + MACD + 200DMA)",
    description:
      "Stocks with RSI > 50, MACD above signal line, and price above 200 DMA - triple momentum confirmation",
    category: "momentum",
    query:
      "( {cash} ( latest rsi( close,14 ) > 50 and latest macd( close,12,26,9 ) > latest macd signal( close,12,26,9 ) and latest close > latest sma( close,200 ) ) )",
    tags: ["momentum", "score", "combined", "bullish", "triple"],
  },
  {
    id: "mom_roc_10pct",
    name: "Rate of Change > 10% (20-Day)",
    description:
      "Price has increased more than 10% over the last 20 trading days",
    category: "momentum",
    query: "( {cash} ( latest close > 20 days ago close * 1.10 ) )",
    tags: ["roc", "rate-of-change", "momentum", "bullish"],
  },
];

// ─── MACD Scans (8) ────────────────────────────────────────────────────────

const MACD_SCANS: ChartinkScanDef[] = [
  {
    id: "macd_bullish_crossover",
    name: "MACD Bullish Crossover",
    description: "MACD line crosses above the signal line - buy signal",
    category: "macd",
    query:
      "( {cash} ( latest macd( close,12,26,9 ) > latest macd signal( close,12,26,9 ) and 1 day ago macd( close,12,26,9 ) < 1 day ago macd signal( close,12,26,9 ) ) )",
    tags: ["macd", "crossover", "bullish", "buy"],
  },
  {
    id: "macd_bearish_crossover",
    name: "MACD Bearish Crossover",
    description: "MACD line crosses below the signal line - sell signal",
    category: "macd",
    query:
      "( {cash} ( latest macd( close,12,26,9 ) < latest macd signal( close,12,26,9 ) and 1 day ago macd( close,12,26,9 ) > 1 day ago macd signal( close,12,26,9 ) ) )",
    tags: ["macd", "crossover", "bearish", "sell"],
  },
  {
    id: "macd_above_zero",
    name: "MACD Above Zero",
    description: "MACD line is positive - bullish bias",
    category: "macd",
    query: "( {cash} ( latest macd( close,12,26,9 ) > 0 ) )",
    tags: ["macd", "positive", "bullish"],
  },
  {
    id: "macd_below_zero",
    name: "MACD Below Zero",
    description: "MACD line is negative - bearish bias",
    category: "macd",
    query: "( {cash} ( latest macd( close,12,26,9 ) < 0 ) )",
    tags: ["macd", "negative", "bearish"],
  },
  {
    id: "macd_histogram_expanding",
    name: "MACD Histogram Expanding (Bullish)",
    description: "MACD histogram growing larger - increasing bullish momentum",
    category: "macd",
    query:
      "( {cash} ( latest macd histogram( close,12,26,9 ) > 1 day ago macd histogram( close,12,26,9 ) and 1 day ago macd histogram( close,12,26,9 ) > 2 days ago macd histogram( close,12,26,9 ) and latest macd histogram( close,12,26,9 ) > 0 ) )",
    tags: ["macd", "histogram", "expanding", "bullish", "momentum"],
  },
  {
    id: "macd_histogram_contracting",
    name: "MACD Histogram Contracting",
    description:
      "MACD histogram shrinking - momentum fading, potential reversal ahead",
    category: "macd",
    query:
      "( {cash} ( abs( latest macd histogram( close,12,26,9 ) ) < abs( 1 day ago macd histogram( close,12,26,9 ) ) and abs( 1 day ago macd histogram( close,12,26,9 ) ) < abs( 2 days ago macd histogram( close,12,26,9 ) ) ) )",
    tags: ["macd", "histogram", "contracting", "fading"],
  },
  {
    id: "macd_zero_cross_up",
    name: "MACD Zero Line Cross Up",
    description:
      "MACD line crosses above zero - shifting from bearish to bullish territory",
    category: "macd",
    query:
      "( {cash} ( latest macd( close,12,26,9 ) > 0 and 1 day ago macd( close,12,26,9 ) < 0 ) )",
    tags: ["macd", "zero-line", "cross", "bullish"],
  },
  {
    id: "macd_zero_cross_down",
    name: "MACD Zero Line Cross Down",
    description:
      "MACD line crosses below zero - shifting from bullish to bearish territory",
    category: "macd",
    query:
      "( {cash} ( latest macd( close,12,26,9 ) < 0 and 1 day ago macd( close,12,26,9 ) > 0 ) )",
    tags: ["macd", "zero-line", "cross", "bearish"],
  },
];

// ─── Bollinger Scans (6) ───────────────────────────────────────────────────

const BOLLINGER_SCANS: ChartinkScanDef[] = [
  {
    id: "bb_squeeze_5pct",
    name: "Bollinger Squeeze (Bandwidth < 5%)",
    description:
      "Bollinger Bands very narrow - low volatility, big move likely ahead",
    category: "bollinger",
    query:
      "( {cash} ( ( latest bollinger upper( close,20,2 ) - latest bollinger lower( close,20,2 ) ) / latest sma( close,20 ) * 100 < 5 ) )",
    tags: ["bollinger", "squeeze", "volatility", "breakout"],
  },
  {
    id: "bb_squeeze_3pct",
    name: "Bollinger Squeeze Tight (Bandwidth < 3%)",
    description:
      "Extremely tight Bollinger Bands - very low volatility, explosive move imminent",
    category: "bollinger",
    query:
      "( {cash} ( ( latest bollinger upper( close,20,2 ) - latest bollinger lower( close,20,2 ) ) / latest sma( close,20 ) * 100 < 3 ) )",
    tags: ["bollinger", "squeeze", "tight", "extreme"],
  },
  {
    id: "bb_upper_breakout",
    name: "Bollinger Upper Band Breakout",
    description:
      "Price closing above the upper Bollinger Band - strong bullish momentum",
    category: "bollinger",
    query: "( {cash} ( latest close > latest bollinger upper( close,20,2 ) ) )",
    tags: ["bollinger", "upper", "breakout", "bullish"],
  },
  {
    id: "bb_lower_breakout",
    name: "Bollinger Lower Band Breakout",
    description:
      "Price closing below the lower Bollinger Band - oversold or breakdown",
    category: "bollinger",
    query: "( {cash} ( latest close < latest bollinger lower( close,20,2 ) ) )",
    tags: ["bollinger", "lower", "breakdown", "oversold"],
  },
  {
    id: "bb_walking_upper",
    name: "Walking Upper Bollinger Band",
    description:
      "Price closing above upper band for 3+ consecutive days - strong uptrend",
    category: "bollinger",
    query:
      "( {cash} ( latest close > latest bollinger upper( close,20,2 ) and 1 day ago close > 1 day ago bollinger upper( close,20,2 ) and 2 days ago close > 2 days ago bollinger upper( close,20,2 ) ) )",
    tags: ["bollinger", "upper", "walking", "strong-trend"],
  },
  {
    id: "bb_middle_band",
    name: "Price at Middle Bollinger Band",
    description:
      "Price near the 20-day SMA (middle band) - potential support/resistance",
    category: "bollinger",
    query:
      "( {cash} ( latest close > latest sma( close,20 ) * 0.99 and latest close < latest sma( close,20 ) * 1.01 ) )",
    tags: ["bollinger", "middle", "sma20", "support"],
  },
];

// ─── Candlestick Scans (12) ────────────────────────────────────────────────

const CANDLESTICK_SCANS: ChartinkScanDef[] = [
  {
    id: "candle_bullish_engulfing",
    name: "Bullish Engulfing",
    description:
      "Large green candle fully engulfs previous red candle - strong bullish reversal signal",
    category: "candlestick",
    query:
      "( {cash} ( 1 day ago close < 1 day ago open and latest close > latest open and latest open <= 1 day ago close and latest close >= 1 day ago open ) )",
    tags: ["candlestick", "engulfing", "bullish", "reversal"],
  },
  {
    id: "candle_bearish_engulfing",
    name: "Bearish Engulfing",
    description:
      "Large red candle fully engulfs previous green candle - strong bearish reversal signal",
    category: "candlestick",
    query:
      "( {cash} ( 1 day ago close > 1 day ago open and latest close < latest open and latest open >= 1 day ago close and latest close <= 1 day ago open ) )",
    tags: ["candlestick", "engulfing", "bearish", "reversal"],
  },
  {
    id: "candle_hammer",
    name: "Hammer",
    description:
      "Small body at the top with long lower shadow (2x body) - bullish reversal at support",
    category: "candlestick",
    query:
      "( {cash} ( ( max( latest open,latest close ) - min( latest open,latest close ) ) > 0 and ( min( latest open,latest close ) - latest low ) >= 2 * ( max( latest open,latest close ) - min( latest open,latest close ) ) and ( latest high - max( latest open,latest close ) ) <= 0.3 * ( max( latest open,latest close ) - min( latest open,latest close ) ) ) )",
    tags: ["candlestick", "hammer", "bullish", "reversal", "support"],
  },
  {
    id: "candle_shooting_star",
    name: "Shooting Star",
    description:
      "Small body at the bottom with long upper shadow (2x body) - bearish reversal at resistance",
    category: "candlestick",
    query:
      "( {cash} ( ( max( latest open,latest close ) - min( latest open,latest close ) ) > 0 and ( latest high - max( latest open,latest close ) ) >= 2 * ( max( latest open,latest close ) - min( latest open,latest close ) ) and ( min( latest open,latest close ) - latest low ) <= 0.3 * ( max( latest open,latest close ) - min( latest open,latest close ) ) ) )",
    tags: ["candlestick", "shooting-star", "bearish", "reversal", "resistance"],
  },
  {
    id: "candle_doji",
    name: "Doji",
    description:
      "Open and close are nearly equal (< 0.1% body) - indecision, potential reversal",
    category: "candlestick",
    query:
      "( {cash} ( abs( latest close - latest open ) < latest close * 0.001 and ( latest high - latest low ) > 3 * abs( latest close - latest open ) ) )",
    tags: ["candlestick", "doji", "indecision", "reversal"],
  },
  {
    id: "candle_morning_star",
    name: "Morning Star",
    description:
      "Three-candle bullish reversal: big red, small body (gap down), big green (gap up)",
    category: "candlestick",
    query:
      "( {cash} ( 2 days ago close < 2 days ago open and abs( 1 day ago close - 1 day ago open ) < abs( 2 days ago close - 2 days ago open ) * 0.3 and latest close > latest open and latest close > ( 2 days ago open + 2 days ago close ) / 2 ) )",
    tags: [
      "candlestick",
      "morning-star",
      "bullish",
      "reversal",
      "three-candle",
    ],
  },
  {
    id: "candle_evening_star",
    name: "Evening Star",
    description:
      "Three-candle bearish reversal: big green, small body (gap up), big red (gap down)",
    category: "candlestick",
    query:
      "( {cash} ( 2 days ago close > 2 days ago open and abs( 1 day ago close - 1 day ago open ) < abs( 2 days ago close - 2 days ago open ) * 0.3 and latest close < latest open and latest close < ( 2 days ago open + 2 days ago close ) / 2 ) )",
    tags: [
      "candlestick",
      "evening-star",
      "bearish",
      "reversal",
      "three-candle",
    ],
  },
  {
    id: "candle_three_white_soldiers",
    name: "Three White Soldiers",
    description:
      "Three consecutive bullish candles with progressively higher closes - strong bullish continuation",
    category: "candlestick",
    query:
      "( {cash} ( latest close > latest open and 1 day ago close > 1 day ago open and 2 days ago close > 2 days ago open and latest close > 1 day ago close and 1 day ago close > 2 days ago close and latest open > 1 day ago open and 1 day ago open > 2 days ago open ) )",
    tags: ["candlestick", "three-white-soldiers", "bullish", "continuation"],
  },
  {
    id: "candle_three_black_crows",
    name: "Three Black Crows",
    description:
      "Three consecutive bearish candles with progressively lower closes - strong bearish continuation",
    category: "candlestick",
    query:
      "( {cash} ( latest close < latest open and 1 day ago close < 1 day ago open and 2 days ago close < 2 days ago open and latest close < 1 day ago close and 1 day ago close < 2 days ago close and latest open < 1 day ago open and 1 day ago open < 2 days ago open ) )",
    tags: ["candlestick", "three-black-crows", "bearish", "continuation"],
  },
  {
    id: "candle_bullish_harami",
    name: "Bullish Harami",
    description:
      "Small green candle contained within prior large red candle - potential bullish reversal",
    category: "candlestick",
    query:
      "( {cash} ( 1 day ago close < 1 day ago open and latest close > latest open and latest open > 1 day ago close and latest close < 1 day ago open and ( latest close - latest open ) < ( 1 day ago open - 1 day ago close ) * 0.5 ) )",
    tags: ["candlestick", "harami", "bullish", "reversal"],
  },
  {
    id: "candle_bearish_harami",
    name: "Bearish Harami",
    description:
      "Small red candle contained within prior large green candle - potential bearish reversal",
    category: "candlestick",
    query:
      "( {cash} ( 1 day ago close > 1 day ago open and latest close < latest open and latest open < 1 day ago close and latest close > 1 day ago open and ( latest open - latest close ) < ( 1 day ago close - 1 day ago open ) * 0.5 ) )",
    tags: ["candlestick", "harami", "bearish", "reversal"],
  },
  {
    id: "candle_marubozu",
    name: "Marubozu (Big Body, Small Wicks)",
    description:
      "Large candle body with very small wicks (< 10% of range) - strong directional conviction",
    category: "candlestick",
    query:
      "( {cash} ( abs( latest close - latest open ) > ( latest high - latest low ) * 0.9 and ( latest high - latest low ) > latest close * 0.015 ) )",
    tags: ["candlestick", "marubozu", "conviction", "strong-move"],
  },
];

// ─── SuperTrend Scans (4) ──────────────────────────────────────────────────

const SUPERTREND_SCANS: ChartinkScanDef[] = [
  {
    id: "st_buy_signal",
    name: "SuperTrend Buy Signal",
    description:
      "SuperTrend flips from sell to buy - price crosses above SuperTrend line",
    category: "supertrend",
    query:
      "( {cash} ( latest close > latest supertrend( 10,3 ) and 1 day ago close < 1 day ago supertrend( 10,3 ) ) )",
    tags: ["supertrend", "buy", "bullish", "crossover"],
  },
  {
    id: "st_sell_signal",
    name: "SuperTrend Sell Signal",
    description:
      "SuperTrend flips from buy to sell - price crosses below SuperTrend line",
    category: "supertrend",
    query:
      "( {cash} ( latest close < latest supertrend( 10,3 ) and 1 day ago close > 1 day ago supertrend( 10,3 ) ) )",
    tags: ["supertrend", "sell", "bearish", "crossover"],
  },
  {
    id: "st_bullish",
    name: "SuperTrend Bullish (Price Above)",
    description:
      "Price is currently above the SuperTrend line - uptrend in play",
    category: "supertrend",
    query: "( {cash} ( latest close > latest supertrend( 10,3 ) ) )",
    tags: ["supertrend", "bullish", "above", "uptrend"],
  },
  {
    id: "st_bearish",
    name: "SuperTrend Bearish (Price Below)",
    description:
      "Price is currently below the SuperTrend line - downtrend in play",
    category: "supertrend",
    query: "( {cash} ( latest close < latest supertrend( 10,3 ) ) )",
    tags: ["supertrend", "bearish", "below", "downtrend"],
  },
];

// ─── Ichimoku Scans (4) ────────────────────────────────────────────────────

const ICHIMOKU_SCANS: ChartinkScanDef[] = [
  {
    id: "ichi_above_cloud",
    name: "Price Above Ichimoku Cloud",
    description:
      "Price above both Senkou Span A and Senkou Span B - bullish territory",
    category: "ichimoku",
    query:
      '( {cash} ( latest close > latest "Ichimoku span a( 9,26,52,26 )" and latest close > latest "Ichimoku span b( 9,26,52,26 )" ) )',
    tags: ["ichimoku", "cloud", "above", "bullish"],
  },
  {
    id: "ichi_below_cloud",
    name: "Price Below Ichimoku Cloud",
    description:
      "Price below both Senkou Span A and Senkou Span B - bearish territory",
    category: "ichimoku",
    query:
      '( {cash} ( latest close < latest "Ichimoku span a( 9,26,52,26 )" and latest close < latest "Ichimoku span b( 9,26,52,26 )" ) )',
    tags: ["ichimoku", "cloud", "below", "bearish"],
  },
  {
    id: "ichi_tk_bullish_cross",
    name: "Tenkan/Kijun Bullish Cross",
    description:
      "Tenkan-sen crosses above Kijun-sen - bullish momentum signal in Ichimoku system",
    category: "ichimoku",
    query:
      '( {cash} ( latest "Ichimoku tenkan( 9,26,52,26 )" > latest "Ichimoku kijun( 9,26,52,26 )" and 1 day ago "Ichimoku tenkan( 9,26,52,26 )" < 1 day ago "Ichimoku kijun( 9,26,52,26 )" ) )',
    tags: ["ichimoku", "tenkan", "kijun", "bullish", "crossover"],
  },
  {
    id: "ichi_tk_bearish_cross",
    name: "Tenkan/Kijun Bearish Cross",
    description:
      "Tenkan-sen crosses below Kijun-sen - bearish momentum signal in Ichimoku system",
    category: "ichimoku",
    query:
      '( {cash} ( latest "Ichimoku tenkan( 9,26,52,26 )" < latest "Ichimoku kijun( 9,26,52,26 )" and 1 day ago "Ichimoku tenkan( 9,26,52,26 )" > 1 day ago "Ichimoku kijun( 9,26,52,26 )" ) )',
    tags: ["ichimoku", "tenkan", "kijun", "bearish", "crossover"],
  },
];

// ─── Combined / Multi-Indicator Scans (8) ──────────────────────────────────

const COMBINED_SCANS: ChartinkScanDef[] = [
  {
    id: "combo_rsi_oversold_52w_low",
    name: "RSI Oversold + Near 52W Low",
    description:
      "RSI below 30 and price within 10% of 52-week low - deep value with reversal potential",
    category: "combined",
    query:
      "( {cash} ( latest rsi( close,14 ) < 30 and latest close < latest min( 250, close ) * 1.10 ) )",
    tags: ["combined", "rsi", "oversold", "52w-low", "deep-value"],
  },
  {
    id: "combo_rsi_oversold_above_200dma",
    name: "RSI Oversold + Above 200 DMA",
    description:
      "RSI below 30 but price still above 200 DMA - pullback in a long-term uptrend",
    category: "combined",
    query:
      "( {cash} ( latest rsi( close,14 ) < 30 and latest close > latest sma( close,200 ) ) )",
    tags: ["combined", "rsi", "oversold", "200dma", "pullback", "quality"],
  },
  {
    id: "combo_volume_breakout_macd_bullish",
    name: "Volume Breakout + MACD Bullish",
    description:
      "Volume more than 2x average with MACD bullish crossover - strong confirmed breakout",
    category: "combined",
    query:
      "( {cash} ( latest volume > 2 * latest sma( volume,20 ) and latest macd( close,12,26,9 ) > latest macd signal( close,12,26,9 ) and 1 day ago macd( close,12,26,9 ) < 1 day ago macd signal( close,12,26,9 ) ) )",
    tags: ["combined", "volume", "macd", "breakout", "bullish"],
  },
  {
    id: "combo_golden_cross_volume_surge",
    name: "Golden Cross + Volume Surge",
    description:
      "SMA 50/200 golden cross with above-average volume - high conviction trend change",
    category: "combined",
    query:
      "( {cash} ( latest sma( close,50 ) > latest sma( close,200 ) and 1 day ago sma( close,50 ) < 1 day ago sma( close,200 ) and latest volume > 1.5 * latest sma( volume,20 ) ) )",
    tags: ["combined", "golden-cross", "volume", "high-conviction"],
  },
  {
    id: "combo_bb_squeeze_low_adx",
    name: "Bollinger Squeeze + Low ADX (Pre-Breakout)",
    description:
      "Bollinger Bands narrow and ADX below 20 - coiling phase, explosive breakout likely",
    category: "combined",
    query:
      "( {cash} ( ( latest bollinger upper( close,20,2 ) - latest bollinger lower( close,20,2 ) ) / latest sma( close,20 ) * 100 < 5 and latest adx( 14 ) < 20 ) )",
    tags: ["combined", "bollinger", "squeeze", "adx", "pre-breakout"],
  },
  {
    id: "combo_rsi_divergence_macd_bullish",
    name: "RSI Bullish Divergence + MACD Bullish",
    description:
      "RSI making higher lows while price makes lower lows, with MACD turning bullish - double reversal confirmation",
    category: "combined",
    query:
      "( {cash} ( latest close < 5 days ago close and latest rsi( close,14 ) > 5 days ago rsi( close,14 ) and latest rsi( close,14 ) < 40 and latest macd( close,12,26,9 ) > latest macd signal( close,12,26,9 ) ) )",
    tags: ["combined", "rsi", "divergence", "macd", "reversal"],
  },
  {
    id: "combo_above_all_sma_adx_volume",
    name: "Above All SMAs + ADX > 25 + Volume Above Average",
    description:
      "Price above all key SMAs, strong trend (ADX > 25), and volume confirmation - the perfect setup",
    category: "combined",
    query:
      "( {cash} ( latest close > latest sma( close,20 ) and latest close > latest sma( close,50 ) and latest close > latest sma( close,200 ) and latest adx( 14 ) > 25 and latest volume > latest sma( volume,20 ) ) )",
    tags: ["combined", "sma", "adx", "volume", "perfect-setup", "bullish"],
  },
  {
    id: "combo_supertrend_buy_macd_bullish",
    name: "SuperTrend Buy + MACD Bullish",
    description:
      "SuperTrend gives buy signal and MACD is above signal line - double indicator confirmation",
    category: "combined",
    query:
      "( {cash} ( latest close > latest supertrend( 10,3 ) and 1 day ago close < 1 day ago supertrend( 10,3 ) and latest macd( close,12,26,9 ) > latest macd signal( close,12,26,9 ) ) )",
    tags: ["combined", "supertrend", "macd", "bullish", "double-confirmation"],
  },
];

// ── Master Library ─────────────────────────────────────────────────────────

/**
 * Complete library of 99 Chartink scan definitions across 11 categories.
 */
export const CHARTINK_SCAN_LIBRARY: ChartinkScanDef[] = [
  ...PRICE_SCANS,
  ...VOLUME_DELIVERY_SCANS,
  ...MOVING_AVERAGE_SCANS,
  ...MOMENTUM_SCANS,
  ...MACD_SCANS,
  ...BOLLINGER_SCANS,
  ...CANDLESTICK_SCANS,
  ...SUPERTREND_SCANS,
  ...ICHIMOKU_SCANS,
  ...COMBINED_SCANS,
];

// ── Helper Functions ───────────────────────────────────────────────────────

/**
 * Look up a scan definition by its ID.
 *
 * @param id - Scan ID (e.g. "ma_golden_cross", "mom_rsi_oversold")
 * @returns The matching scan definition or undefined
 */
export function getScanById(id: string): ChartinkScanDef | undefined {
  return CHARTINK_SCAN_LIBRARY.find((s) => s.id === id);
}

/**
 * List all scan definitions, optionally filtered by category.
 *
 * @param category - If provided, only scans in this category are returned
 * @returns Array of matching scan definitions
 */
export function listScans(category?: ChartinkScanCategory): ChartinkScanDef[] {
  if (!category) return CHARTINK_SCAN_LIBRARY;
  return CHARTINK_SCAN_LIBRARY.filter((s) => s.category === category);
}

/**
 * Search scan definitions by a free-text query.
 * Matches against name, description, tags, and ID.
 *
 * @param query - Free-text search query (case-insensitive)
 * @returns Matching scan definitions, ranked by relevance (best first)
 */
export function searchScans(query: string): ChartinkScanDef[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (terms.length === 0) return CHARTINK_SCAN_LIBRARY;

  const scored = CHARTINK_SCAN_LIBRARY.map((scan) => {
    const haystack = [
      scan.id,
      scan.name,
      scan.description,
      scan.category,
      ...scan.tags,
    ]
      .join(" ")
      .toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) {
        score += 1;
        // Bonus for exact ID match
        if (scan.id.toLowerCase() === term) score += 5;
        // Bonus for tag match
        if (scan.tags.some((t) => t === term)) score += 2;
        // Bonus for name match
        if (scan.name.toLowerCase().includes(term)) score += 1;
      }
    }

    return { scan, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.scan);
}

/**
 * Get all available categories with their scan counts.
 */
export function listCategories(): Array<{
  category: ChartinkScanCategory;
  count: number;
  label: string;
}> {
  const CATEGORY_LABELS: Record<ChartinkScanCategory, string> = {
    price: "Price Action",
    volume_delivery: "Volume & Delivery",
    moving_average: "Moving Averages",
    momentum: "Momentum Oscillators",
    macd: "MACD",
    bollinger: "Bollinger Bands",
    candlestick: "Candlestick Patterns",
    chart_pattern: "Chart Patterns",
    supertrend: "SuperTrend",
    ichimoku: "Ichimoku Cloud",
    combined: "Combined / Multi-Indicator",
  };

  const counts = new Map<ChartinkScanCategory, number>();
  for (const scan of CHARTINK_SCAN_LIBRARY) {
    counts.set(scan.category, (counts.get(scan.category) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([category, count]) => ({
      category,
      count,
      label: CATEGORY_LABELS[category],
    }))
    .sort((a, b) => b.count - a.count);
}
