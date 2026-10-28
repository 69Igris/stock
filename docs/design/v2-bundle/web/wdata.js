// ─────────────────────────────────────────────────────────────────────────
// UseMoney web modules · shared demo data for Modules A–H
// ─────────────────────────────────────────────────────────────────────────

var STRATS = [
  { id: "s1", name: "RSI < 30 mean-reversion", theme: "Mean-reversion", status: "VALIDATED", cagr: 14.6, sharpe: 0.92, dsharpe: 0.78, dd: -18.2, win: 63, turn: 8.4, costs: 12480, overfit: "low", runs: 6, hold: "12d", y1: "+8.2%", desc: "Enter when 14-period RSI < 30 + above 200-DMA. Exit on RSI > 55 or +5%." },
  { id: "s2", name: "50/200 DMA crossover", theme: "Trend", status: "BACKTESTED", cagr: 18.2, sharpe: 1.12, dsharpe: 0.84, dd: -22.4, win: 58, turn: 1.8, costs: 6210, overfit: "low", runs: 3, hold: "84d", y1: "+24.8%", desc: "Long when 50-DMA crosses above 200-DMA. Classic trend follower." },
  { id: "s3", name: "12-month momentum", theme: "Momentum", status: "FORWARD", cagr: 24.1, sharpe: 1.34, dsharpe: 0.88, dd: -28.1, win: 54, turn: 6.1, costs: 18904, overfit: "medium", runs: 9, hold: "42d", y1: "+31.4%", desc: "Top decile by trailing 12m return ex-recent-month, rebalanced monthly." },
  { id: "s4", name: "My defensive flexi-cap", theme: "Custom", status: "DRAFT", cagr: null, sharpe: null, dsharpe: null, dd: null, win: null, turn: null, costs: null, overfit: null, runs: 0, hold: null, y1: null, desc: "Quality + low-vol + dividend yield > 1.5%. Excludes PSU banks. Not yet backtested." },
  { id: "s5", name: "Smallcap relative-strength", theme: "Momentum", status: "RETIRED", cagr: 28.6, sharpe: 1.04, dsharpe: 0.42, dd: -36.2, win: 48, turn: 9.2, costs: 22110, overfit: "high", runs: 11, hold: "30d", y1: "+34.4%", desc: "Retired — walk-forward broke after the 2024 regime shift." },
  { id: "s6", name: "ROIC > 18% quality", theme: "Quality", status: "BACKTESTED", cagr: 21.0, sharpe: 1.42, dsharpe: 1.02, dd: -16.8, win: 67, turn: 2.1, costs: 5320, overfit: "low", runs: 4, hold: "210d", y1: "+22.4%", desc: "Persistent ROIC > 18%, debt/equity < 0.5, FCF positive 5y." },
];
STRATS.forEach((s, i) => { s.curve = genSeries(i * 13 + 7, 14, s.cagr ? s.cagr / 900 : 0.004, 0.05, 100); });
var BT_RESULT = {
  strat: "RSI < 30 mean-reversion", period: "Apr 2019 – Jul 2026", universe: "NIFTY 100", trades: 2140,
  curve: genSeries(31, 80, 0.0035, 0.03, 284), bench: genSeries(17, 80, 0.0021, 0.022, 198),
  ddSeries: genSeries(53, 80, -0.001, 0.03, 60).map(v => -Math.abs(v % 22)),
  metrics: [["CAGR", "18.4%"], ["Sharpe", "1.31"], ["Deflated Sharpe", "0.92"], ["Max drawdown", "-14.2%"], ["Win rate", "58%"], ["Turnover", "4.2×/yr"], ["Costs paid", "₹12,480"], ["Trades", "2,140"]],
  walk: [["2019-21 train", "+16.2%"], ["2022 test", "+14.8%"], ["2022-24 train", "+19.1%"], ["2025 test", "+17.6%"], ["2026 live-ish", "+18.9%"]],
};
var PERSONAS = [
  { id: "buffett", n: "Warren Buffett", tag: "Quality moats", signal: "BULLISH", conv: 78, thesis: "Owner earnings cover the price. A 31% ROE franchise at a fair multiple — the moat is repeat revenue.", free: true },
  { id: "lynch", n: "Peter Lynch", tag: "Growth at reason", signal: "NEUTRAL", conv: 55, thesis: "PEG near 1.8 is nobody's bargain. Story intact, but I want the GenAI line to prove it's a category.", free: true },
  { id: "burry", n: "Michael Burry", tag: "Contrarian risk", signal: "BEARISH", conv: 64, thesis: "Everyone owns it, nobody questions the margin floor. H1-B costs + BFSI freeze = the crack nobody prices.", free: false },
  { id: "damodaran", n: "Aswath Damodaran", tag: "Valuation", signal: "NEUTRAL", conv: 61, thesis: "DCF lands ₹1,540-1,720. At ₹1,610 you're paying fair value — returns come from execution, not re-rating.", free: false },
  { id: "jhunjhunwala", n: "R. Jhunjhunwala", tag: "India conviction", signal: "BULLISH", conv: 71, thesis: "India's IT export machine compounds through cycles. Buy fear, hold decades, ignore quarters.", free: false },
];
var DEBATE = [
  { r: 1, who: "Buffett", side: "bull", text: "Pricing power shows in the 85% payout with no balance-sheet strain. This is a toll bridge on global IT budgets." },
  { r: 1, who: "Burry", side: "bear", text: "Toll bridges don't guide 3-5%. The margin band is a promise, not a fact — one BFSI winter breaks it." },
  { r: 2, who: "Buffett", side: "bull", text: "It held 20%+ margins through three winters since 2008. Base rates favour the franchise." },
  { r: 2, who: "Burry", side: "bear", text: "Past winters had labour arbitrage left to squeeze. That lever is gone; AI deflation cuts both ways." },
];
var SIGNALS_FEED = [
  { id: 1, strat: "RSI < 30 mean-reversion", sym: "HAL", status: "TRIGGERED", rule: "RSI(14) crossed 30 → 34.2 · above 200-DMA", at: "09:35 IST", px: 4410 },
  { id: 2, strat: "12-month momentum", sym: "LT", status: "NEW", rule: "Entered top decile by 12m-1m return on EOD rebalance", at: "Fri 16:05 IST", px: 3649 },
  { id: 3, strat: "RSI < 30 mean-reversion", sym: "ASIANPAINT", status: "NEW", rule: "RSI(14) = 28.4 < 30 · close > 200-DMA", at: "Fri 16:05 IST", px: 2247 },
  { id: 4, strat: "50/200 DMA crossover", sym: "WIPRO", status: "EXPIRED", rule: "50-DMA crossed above 200-DMA", at: "Jul 11 · unactioned 5d", px: 481 },
];
var FWDRUN = {
  strat: "12-month momentum", since: "May 12, 2026", pnl: 24.2, bench: 11.1, backtest: [16, 29],
  curve: genSeries(41, 40, 0.005, 0.028, 124.2), benchCurve: genSeries(11, 40, 0.0026, 0.02, 111.1),
  ledger: [
    { sym: "DIXON", side: "BUY", qty: 4, in: "12,180", out: "14,120", pnl: 7760, open: false },
    { sym: "ADANIENT", side: "BUY", qty: 18, in: "2,840", out: "—", pnl: 5123, open: true },
    { sym: "MARUTI", side: "BUY", qty: 5, in: "12,010", out: "12,480", pnl: 2350, open: false },
    { sym: "IRCTC", side: "BUY", qty: 60, in: "868", out: "812", pnl: -3360, open: false },
  ],
};
var US_STOCK = { sym: "AAPL", name: "Apple Inc", px: 232.14, chg: 0.86, pxInr: 19360, mcap: "$3.54T", pe: 35.2, eps: 6.59, divy: 0.44, asof: "Jul 18 close · 01:30 IST",
  insiders: [["T. Cook — CEO", "SELL 220k sh", "Jul 02"], ["L. Maestri — CFO", "SELL 85k sh", "Jun 18"], ["K. Adams — SVP", "BUY 12k sh", "Jun 05"]],
  holders13f: [["Vanguard", "8.4%"], ["BlackRock", "6.7%"], ["Berkshire Hathaway", "5.8%"], ["State Street", "3.9%"]],
};
var US_MIX = { inr: 1724169, usd: 4820, fx: 83.42, fxAsOf: "09:00 IST", usHoldings: [["AAPL", 12, 232.14], ["MSFT", 4, 448.20], ["NVDA", 10, 128.44]] };
var LRS = { limit: 250000, used: 8400, tcs: 0, fy: "FY 2026-27" };
var DNA = {
  metrics: [
    { t: "You hold losers 2.4× longer than winners", v: "Disposition ratio 2.4", ev: "from 47 paired trades", bad: true },
    { t: "Long holds are your edge", v: "Win rate 71% when held >1yr vs 42% <1mo", ev: "from 34 vs 13 pairs", bad: false },
    { t: "Financials is your best-read sector", v: "68% win rate · +₹41k realized", ev: "from 11 pairs", bad: false },
    { t: "Size drifts up after wins", v: "+38% avg position size after a 2-win streak", ev: "from 6 streaks", bad: true },
  ],
  narrative: "You're a patient investor who gets impatient at exactly the wrong moment. The data says your year-plus holds win 71% of the time — but after two wins you size up 38% and cut the next loser slowest of all. If you automate one thing, automate your exits.",
  flags: ["No revenge-trading pattern detected", "Churn well below platform median"],
};
var MEMORIES = [
  { k: "PREFERENCE", t: "Prefers long-term, low-churn investing", pin: true },
  { k: "FACT", t: "Tax regime: new · files via CA", pin: false },
  { k: "INSIGHT", t: "Watches IT sector closely (INFY, TCS)", pin: false },
  { k: "PREFERENCE", t: "Wants tax math shown before any sell discussion", pin: true },
  { k: "FACT", t: "Monthly SIP budget ~₹45,000", pin: false },
];
var MODELS_W = [
  { n: "Auto", d: "Routes by task — Flash for chat, Pro for research", x: "×1", on: true },
  { n: "Gemini 2.5 Pro", d: "Deepest reasoning, slower", x: "×1" },
  { n: "Gemini 2.5 Flash", d: "Fast answers, light tasks", x: "×0.5" },
  { n: "Claude Sonnet", d: "Founder allowlist", x: "×2", lock: true },
  { n: "GPT-5", d: "Founder allowlist", x: "×2", lock: true },
];
var API_KEYS = [
  { id: "um_live_4f2…9a1", name: "prod-portfolio-sync", scopes: ["portfolio-read", "tax"], created: "May 02", last: "2m ago", live: true },
  { id: "um_test_8c1…44e", name: "staging", scopes: ["portfolio-read"], created: "Jun 14", last: "3d ago", live: true },
  { id: "um_live_11b…07f", name: "old-integration", scopes: ["analysis"], created: "Jan 20", last: "—", live: false },
];
var MCP_TOOLS = [
  { n: "get_holdings", d: "Reconciled holdings across brokers", prov: "CONSENTED-BROKER", calls: 4812 },
  { n: "get_tax_summary", d: "FY capital gains, FIFO-paired", prov: "CONSENTED-BROKER", calls: 1206 },
  { n: "get_quote_eod", d: "EOD OHLCV, NSE bhavcopy", prov: "BHAVCOPY-DERIVED", calls: 22480 },
  { n: "compute_xirr", d: "Cashflow XIRR / CAGR", prov: "PURE-COMPUTE", calls: 3311 },
  { n: "get_us_fundamentals", d: "SEC filings extractions", prov: "EDGAR", calls: 640 },
];
var USAGE = { calls: 32449, credits: 812, series: genSeries(9, 30, 0.02, 0.12, 2110) };

function usd(n, dec = 0) { return Number(n).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }); }

Object.assign(window, { usd, STRATS, BT_RESULT, PERSONAS, DEBATE, SIGNALS_FEED, FWDRUN, US_STOCK, US_MIX, LRS, DNA, MEMORIES, MODELS_W, API_KEYS, MCP_TOOLS, USAGE });
