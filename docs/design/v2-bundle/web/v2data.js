// UseMoney v2 · shared data for Core Surfaces (screener rows, scans, dashboard)
// Loaded after app/data.js (genSeries) and web/wdata.js
(function () {
  const ROWS_IN = [
    { sym: "TCS", name: "Tata Consultancy", sector: "IT", px: 4128, chg: 0.6, mcap: "14,93,000", pe: 27.1, roe: 46.2, de: "0.02", score: 92 },
    { sym: "HDFCBANK", name: "HDFC Bank", sector: "Financials", px: 1712, chg: 1.1, mcap: "13,02,000", pe: 19.2, roe: 17.1, de: "—", score: 88 },
    { sym: "HAL", name: "Hindustan Aeronautics", sector: "Defence", px: 4410, chg: 2.1, mcap: "2,95,000", pe: 31.2, roe: 26.9, de: "0.01", score: 90 },
    { sym: "INFY", name: "Infosys", sector: "IT", px: 1610, chg: 0.4, mcap: "6,68,000", pe: 24.3, roe: 31.8, de: "0.01", score: 85 },
    { sym: "DIXON", name: "Dixon Technologies", sector: "Electronics", px: 14120, chg: 1.8, mcap: "84,000", pe: 128.4, roe: 24.2, de: "0.31", score: 83 },
    { sym: "LT", name: "Larsen & Toubro", sector: "Infra", px: 3649, chg: 0.9, mcap: "5,01,000", pe: 33.4, roe: 14.8, de: "1.02", score: 81 },
    { sym: "RELIANCE", name: "Reliance Industries", sector: "Energy", px: 3041, chg: -0.3, mcap: "20,58,000", pe: 24.8, roe: 9.8, de: "0.44", score: 78 },
    { sym: "ITC", name: "ITC", sector: "FMCG", px: 468, chg: 0.2, mcap: "5,85,000", pe: 26.0, roe: 28.4, de: "0.00", score: 74 },
    { sym: "SUNPHARMA", name: "Sun Pharma", sector: "Pharma", px: 1698, chg: 0.7, mcap: "4,07,000", pe: 34.6, roe: 16.8, de: "0.03", score: 72 },
    { sym: "TITAN", name: "Titan Company", sector: "Consumer", px: 3388, chg: 0.5, mcap: "3,00,000", pe: 88.2, roe: 32.1, de: "0.28", score: 66 },
    { sym: "ASIANPAINT", name: "Asian Paints", sector: "Paints", px: 2247, chg: -1.2, mcap: "2,15,000", pe: 48.9, roe: 27.1, de: "0.08", score: 61 },
    { sym: "WIPRO", name: "Wipro", sector: "IT", px: 481, chg: -0.6, mcap: "2,51,000", pe: 19.8, roe: 14.2, de: "0.15", score: 58 },
  ];
  const ROWS_US = [
    { sym: "AAPL", name: "Apple Inc", sector: "Technology", px: 232.14, chg: 0.9, mcap: "$3.54T", pe: 35.2, roe: 147.0, filed: "10-K · Nov 01", score: 84 },
    { sym: "MSFT", name: "Microsoft", sector: "Technology", px: 448.2, chg: 0.5, mcap: "$3.33T", pe: 38.4, roe: 38.5, filed: "10-K · Jul 30", score: 86 },
    { sym: "NVDA", name: "NVIDIA", sector: "Semiconductors", px: 128.44, chg: 2.4, mcap: "$3.16T", pe: 63.1, roe: 91.5, filed: "10-Q · May 28", score: 71 },
    { sym: "GOOGL", name: "Alphabet", sector: "Communication", px: 186.32, chg: 0.3, mcap: "$2.29T", pe: 27.4, roe: 30.9, filed: "10-Q · Apr 25", score: 82 },
    { sym: "BRK.B", name: "Berkshire Hathaway", sector: "Financials", px: 448.9, chg: -0.1, mcap: "$968B", pe: 12.8, roe: 11.2, filed: "10-K · Feb 24", score: 77 },
    { sym: "XOM", name: "Exxon Mobil", sector: "Energy", px: 118.41, chg: -0.8, mcap: "$522B", pe: 13.9, roe: 16.4, filed: "10-K · Feb 26", score: 63 },
    { sym: "COST", name: "Costco", sector: "Staples", px: 892.15, chg: 0.4, mcap: "$396B", pe: 52.1, roe: 31.9, filed: "10-K · Oct 09", score: 69 },
    { sym: "JNJ", name: "Johnson & Johnson", sector: "Healthcare", px: 152.6, chg: 0.2, mcap: "$367B", pe: 22.4, roe: 24.8, filed: "10-K · Feb 13", score: 74 },
  ];
  const SCANS = [
    { id: "momo", name: "Momentum breakouts", src: "ENGINE", plain: "Stocks pushing to new highs with real buying behind them", rules: ["Close ≥ 98% of 52w high", "Volume > 2× 20d avg", "Mcap > ₹10,000 Cr"], total: 14, syms: ["HAL", "DIXON", "LT", "TITAN", "SUNPHARMA"] },
    { id: "value", name: "Undervalued large caps", src: "ENGINE", plain: "Steady large companies at fair prices", rules: ["Mcap > ₹50,000 Cr", "PE < sector median", "ROE > 12%", "D/E < 0.6"], total: 9, syms: ["HDFCBANK", "INFY", "ITC", "SUNPHARMA"] },
    { id: "gcross", name: "Golden crossover watch", src: "CHARTINK", plain: "50-day average crossing above the 200-day", rules: ["50-DMA crossed above 200-DMA (last 5d)"], total: 6, syms: ["WIPRO", "LT", "ITC"], degraded: true },
    { id: "rsiq", name: "RSI oversold quality", src: "CHARTINK", plain: "Good businesses at short-term lows", rules: ["RSI(14) < 32", "ROE > 15%"], total: 4, syms: ["ASIANPAINT", "WIPRO"] },
    { id: "strat1", name: "RSI < 30 mean-reversion", src: "STRATEGY", plain: "Current matches of your tracked strategy", rules: ["RSI(14) < 30", "Close > 200-DMA"], total: 3, syms: ["ASIANPAINT"], stratId: "s1" },
    { id: "mydiv", name: "My dividend compounders", src: "YOURS", plain: "Your saved screen", rules: ["Div yield > 1.5%", "10y div growth > 8%", "Payout < 60%"], total: 7, syms: ["ITC", "INFY", "TCS", "SUNPHARMA"] },
    { id: "insider", name: "Insider accumulation", src: "ENGINE", plain: "Promoter & insider buying clusters", rules: [], total: null, gate: "PREMIUM", syms: [] },
    { id: "panic", name: "Panic dip buys", src: "ENGINE", plain: "Quality names down hard in a week", rules: ["5d return < −8%", "ROE > 15%"], total: 0, syms: [] },
  ];
  const CHIPS_IN = ["Large cap", "Mid cap", "Small cap", "PE < 20", "ROE > 15%", "Near 52w high", "Div > 2%"];
  const CHIPS_US = ["Mega cap", "Profitable", "PE < 25", "Dividend payers", "Near 52w high"];
  const AI_DEMO = { phrase: "undervalued large caps", chips: ["Mcap > ₹50,000 Cr", "PE < 20", "ROE > 12%"], syms: ["HDFCBANK", "INFY", "ITC", "RELIANCE"] };
  const MF = [
    { name: "Parag Parikh Flexi Cap", cat: "Flexi cap", r5: 22.4, aum: "₹84,412 Cr", ter: "0.63%" },
    { name: "HDFC Flexi Cap", cat: "Flexi cap", r5: 24.1, aum: "₹66,304 Cr", ter: "0.77%" },
    { name: "Quant Small Cap", cat: "Small cap", r5: 34.8, aum: "₹26,331 Cr", ter: "0.64%", risk: "Very high" },
    { name: "SBI Contra", cat: "Contra", r5: 26.2, aum: "₹41,907 Cr", ter: "0.59%" },
    { name: "ICICI Pru Bluechip", cat: "Large cap", r5: 18.9, aum: "₹63,938 Cr", ter: "0.86%" },
    { name: "HDFC Mid-Cap Opportunities", cat: "Mid cap", r5: 28.4, aum: "₹75,296 Cr", ter: "0.72%" },
  ];
  const ETF = [
    { sym: "NIFTYBEES", name: "Nippon NIFTY 50 ETF", px: 278.4, ter: "0.04%", trk: "NIFTY 50" },
    { sym: "JUNIORBEES", name: "Nippon Next 50 ETF", px: 712.2, ter: "0.17%", trk: "NIFTY Next 50" },
    { sym: "BANKBEES", name: "Nippon Bank ETF", px: 528.6, ter: "0.19%", trk: "NIFTY Bank" },
    { sym: "GOLDBEES", name: "Nippon Gold ETF", px: 68.9, ter: "0.79%", trk: "Gold" },
    { sym: "MON100", name: "Motilal NASDAQ 100", px: 178.3, ter: "0.58%", trk: "NASDAQ 100" },
  ];
  const DASH = {
    netWorth: "₹17,24,180", day: "+₹4,120", dayPct: "+0.24%", invested: "₹14,88,900", ret: "+₹2,35,280", retPct: "+15.8%",
    xirr: "16.8%", beta: "0.92", dd: "−11.2%", cash: "₹38,000",
    exposure: [["Financials", 28], ["IT", 24], ["Energy", 12], ["FMCG", 9], ["Pharma", 8], ["Other", 19]],
    holdings: [
      { sym: "INFY", qty: 120, px: "1,610", val: "₹1,93,200", pl: 18.4 },
      { sym: "TCS", qty: 24, px: "4,128", val: "₹99,072", pl: 12.1 },
      { sym: "HDFCBANK", qty: 85, px: "1,712", val: "₹1,45,520", pl: 9.2 },
      { sym: "ITC", qty: 400, px: "468", val: "₹1,87,200", pl: 22.8 },
      { sym: "HAL", qty: 30, px: "4,410", val: "₹1,32,300", pl: 64.2 },
      { sym: "NIFTYBEES", qty: 200, px: "278", val: "₹55,680", pl: 11.0 },
    ],
    you1y: "+15.8%", nifty1y: "+11.1%",
    tax: { stcg: "₹12,400", ltcg: "₹48,200", harvest: "Sell 60 WIPRO to book −₹3,360 and offset STCG", due: "Advance tax · Sep 15" },
    insights: ["HAL is up 64% since you bought — now 7.7% of your portfolio", "3 holdings report earnings this week (TCS on Wed)", "SIP of ₹45,000 executed Jul 05 across 3 funds"],
    watchlist: [["LT", "+0.9%", "MOMENTUM ENTRY"], ["ASIANPAINT", "−1.2%", "RSI 28.4"], ["WIPRO", "−0.6%", "GOLDEN CROSS"], ["DIXON", "+1.8%", ""]],
    alerts: ["HAL crossed your ₹4,400 target", "RSI signal on ASIANPAINT (scan: RSI oversold quality)", "Backtest finished: ROIC > 18% quality"],
    roast: { score: "6.8/10", line: "Solid core — but HAL is doing all the lifting and you know it." },
    fire: { pct: 34, target: "₹5.2 Cr", by: "2043" },
    nextAction: { t: "Set up your first SIP", d: "You have ₹38,000 sitting idle. A monthly SIP into an index fund is the simplest next step.", cta: "Show me how" },
    prompts: {
      beginner: ["Is my money doing okay?", "What should I do with ₹10,000?", "Explain my portfolio simply"],
      intermediate: ["What changed in my portfolio this week?", "Any tax I should harvest?", "Compare my returns to NIFTY"],
      advanced: ["Drawdown attribution by holding", "Rolling 12m XIRR vs NIFTY TRI", "Concentration risk check"],
    },
  };
  window.V2 = { ROWS_IN, ROWS_US, SCANS, CHIPS_IN, CHIPS_US, AI_DEMO, MF, ETF, DASH };
})();
