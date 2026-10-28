// ─────────────────────────────────────────────────────────────────────────
// UseMoney mobile v2 · shared demo dataset + formatters (single source of truth)
// ─────────────────────────────────────────────────────────────────────────

// Indian digit grouping: 17,24,180
function inr(n, dec = 0) {
  const neg = n < 0; n = Math.abs(n);
  let s = n.toFixed(dec), [i, d] = s.split(".");
  let last3 = i.slice(-3), rest = i.slice(0, -3);
  if (rest) last3 = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
  return (neg ? "-" : "") + last3 + (d ? "." + d : "");
}
var money = (n, dec = 0) => (n < 0 ? "-₹" : "₹") + inr(Math.abs(n), dec);
var signMoney = (n, dec = 0) => (n >= 0 ? "+₹" : "-₹") + inr(Math.abs(n), dec);
var pct = (x, dec = 1) => (x >= 0 ? "+" : "") + x.toFixed(dec) + "%";
var compactINR = (n) => {
  const a = Math.abs(n);
  if (a >= 1e7) return (n < 0 ? "-" : "") + "₹" + (a / 1e7).toFixed(a >= 1e9 ? 0 : 1) + " Cr";
  if (a >= 1e5) return (n < 0 ? "-" : "") + "₹" + (a / 1e5).toFixed(1) + "L";
  if (a >= 1e3) return (n < 0 ? "-" : "") + "₹" + (a / 1e3).toFixed(1) + "k";
  return money(n);
};

// seeded random-walk series generator (ends exactly at `last`)
function genSeries(seed, n, drift, vol, last) {
  let x = seed, out = [], v = 100;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  for (let i = 0; i < n; i++) { v = v * (1 + drift + (rnd() - 0.5) * vol); out.push(v); }
  const k = last / out[out.length - 1];
  return out.map(y => +(y * k).toFixed(2));
}

// ── User ────────────────────────────────────────────────────────────────────
var USER = { name: "Rahul", full: "Rahul Verma", email: "rahul.verma@gmail.com", phone: "+91 98200 44xxx", since: "Mar 2025", plan: "free", credits: 2, creditsMax: 5 };

// ── Brokers ─────────────────────────────────────────────────────────────────
var BROKER_META = {
  zerodha: { name: "Zerodha", logo: "assets/brokers/zerodha.png", color: "#387ed1" },
  groww:   { name: "Groww", logo: "assets/brokers/groww.png", color: "#00d09c" },
  upstox:  { name: "Upstox", logo: "assets/brokers/upstox.png", color: "#5a2d81" },
  angel:   { name: "Angel One", logo: "assets/brokers/angel.png", color: "#f26522" },
  dhan:    { name: "Dhan", logo: "assets/brokers/dhan.png", color: "#02a86b" },
  fyers:   { name: "Fyers", logo: "assets/brokers/fyers.png", color: "#2d9bf0" },
  hdfc:    { name: "HDFC Sky", logo: "assets/brokers/hdfc.png", color: "#004c8f" },
  icici:   { name: "ICICI Direct", logo: "assets/brokers/icici.png", color: "#b02a30" },
};
// connected state is mutable app state; this is the seed
var BROKERS_SEED = [
  { id: "zerodha", state: "connected", lastSync: "09:31 am", holdings: 6, trades: 214 },
  { id: "groww", state: "connected", lastSync: "09:31 am", holdings: 5, trades: 96 },
  { id: "upstox", state: "expired", lastSync: "Jul 14", holdings: 2, trades: 41 },
];

// ── Stock database ──────────────────────────────────────────────────────────
var STOCKS = {
  RELIANCE:   { name: "Reliance Industries", sector: "Energy", ltp: 2942.60, chg: 1.21, o: 2908, h: 2951, l: 2902, wk52h: 3024, wk52l: 2221, mcap: "19.9L Cr", pe: 28.4, pb: 2.4, roe: 9.2, de: 0.44, divy: 0.34, eps: 103.6, beta: 1.02, about: "India's largest conglomerate — O2C, retail, Jio and new energy." },
  INFY:       { name: "Infosys", sector: "IT", ltp: 1610.40, chg: -0.42, o: 1622, h: 1628, l: 1604, wk52h: 2007, wk52l: 1358, mcap: "6.7L Cr", pe: 24.3, pb: 7.1, roe: 31.8, de: 0.09, divy: 2.85, eps: 66.2, beta: 0.88, about: "Global IT services & consulting; second-largest Indian IT exporter." },
  HDFCBANK:   { name: "HDFC Bank", sector: "Financials", ltp: 1690.10, chg: 0.31, o: 1684, h: 1697, l: 1679, wk52h: 1794, wk52l: 1363, mcap: "12.9L Cr", pe: 18.6, pb: 2.6, roe: 14.5, de: 0, divy: 1.15, eps: 90.9, beta: 0.96, about: "India's largest private-sector bank by assets and market cap." },
  TCS:        { name: "Tata Consultancy Services", sector: "IT", ltp: 3895.20, chg: 0.84, o: 3860, h: 3908, l: 3851, wk52h: 4592, wk52l: 3311, mcap: "14.1L Cr", pe: 27.1, pb: 12.9, roe: 46.9, de: 0.08, divy: 1.87, eps: 143.7, beta: 0.82, about: "Tata group IT flagship; largest Indian company by market cap in IT." },
  ITC:        { name: "ITC", sector: "FMCG", ltp: 462.30, chg: 0.52, o: 459, h: 464, l: 458, wk52h: 528, wk52l: 399, mcap: "5.8L Cr", pe: 27.8, pb: 7.3, roe: 27.4, de: 0, divy: 2.96, eps: 16.6, beta: 0.74, about: "FMCG, hotels, paperboards & agri — cigarettes cash cow funding the rest." },
  TATAMOTORS: { name: "Tata Motors", sector: "Auto", ltp: 682.90, chg: -1.62, o: 695, h: 697, l: 680, wk52h: 1179, wk52l: 656, mcap: "2.5L Cr", pe: 8.9, pb: 2.1, roe: 28.1, de: 1.16, divy: 0.44, eps: 76.7, beta: 1.42, about: "JLR + India CV/PV. Cyclical, leveraged to global lux demand." },
  BAJFINANCE: { name: "Bajaj Finance", sector: "Financials", ltp: 7284.00, chg: 2.08, o: 7150, h: 7311, l: 7144, wk52h: 7830, wk52l: 6188, mcap: "4.5L Cr", pe: 32.6, pb: 5.9, roe: 20.5, de: 3.8, divy: 0.49, eps: 223.4, beta: 1.18, about: "India's largest consumer NBFC — 8.8 Cr customers, AUM ₹3.5L Cr." },
  SBIN:       { name: "State Bank of India", sector: "Financials", ltp: 802.45, chg: 0.94, o: 796, h: 806, l: 793, wk52h: 912, wk52l: 680, mcap: "7.2L Cr", pe: 10.2, pb: 1.6, roe: 17.3, de: 0, divy: 1.71, eps: 78.7, beta: 1.12, about: "India's largest bank — 48 Cr customers, a fourth of all deposits." },
  DIXON:      { name: "Dixon Technologies", sector: "Manufacturing", ltp: 14120.00, chg: 3.24, o: 13710, h: 14180, l: 13688, wk52h: 15464, wk52l: 8020, mcap: "84,720 Cr", pe: 118.2, pb: 32.4, roe: 27.8, de: 0.21, divy: 0.04, eps: 119.5, beta: 1.31, about: "Electronics manufacturing (EMS) — phones, TVs, wearables for global brands." },
  ZOMATO:     { name: "Eternal (Zomato)", sector: "New age", ltp: 246.70, chg: -2.14, o: 252, h: 253, l: 245, wk52h: 305, wk52l: 146, mcap: "2.4L Cr", pe: 284.1, pb: 8.2, roe: 3.1, de: 0.02, divy: 0, eps: 0.87, beta: 1.48, about: "Food delivery + Blinkit quick-commerce. Profit young, growth heavy." },
  HAL:        { name: "Hindustan Aeronautics", sector: "Defence", ltp: 4486.20, chg: 1.84, o: 4410, h: 4502, l: 4398, wk52h: 5675, wk52l: 3046, mcap: "3.0L Cr", pe: 34.8, pb: 9.6, roe: 28.9, de: 0, divy: 0.78, eps: 128.9, beta: 1.09, about: "State-owned aerospace & defence — fighter jets, helicopters, engines." },
  IRCTC:      { name: "IRCTC", sector: "Travel", ltp: 812.30, chg: -0.62, o: 818, h: 821, l: 808, wk52h: 1059, wk52l: 656, mcap: "64,984 Cr", pe: 52.1, pb: 17.8, roe: 38.4, de: 0, divy: 0.86, eps: 15.6, beta: 0.92, about: "Railways ticketing & catering monopoly; asset-light cash machine." },
  HINDUNILVR: { name: "Hindustan Unilever", sector: "FMCG", ltp: 2384.50, chg: 0.28, o: 2378, h: 2394, l: 2371, wk52h: 3035, wk52l: 2136, mcap: "5.6L Cr", pe: 54.2, pb: 11.1, roe: 20.1, de: 0, divy: 1.78, eps: 44.0, beta: 0.58, about: "India's FMCG bellwether — Surf, Dove, Lux, Horlicks." },
  ASIANPAINT: { name: "Asian Paints", sector: "Consumer", ltp: 2246.80, chg: -1.12, o: 2270, h: 2274, l: 2238, wk52h: 3394, wk52l: 2124, mcap: "2.2L Cr", pe: 48.9, pb: 11.8, roe: 24.6, de: 0.08, divy: 1.48, eps: 45.9, beta: 0.76, about: "Paint market leader under siege from Birla Opus entry." },
  WIPRO:      { name: "Wipro", sector: "IT", ltp: 486.20, chg: 0.41, o: 484, h: 489, l: 482, wk52h: 580, wk52l: 385, mcap: "2.5L Cr", pe: 20.8, pb: 3.4, roe: 16.4, de: 0.14, divy: 2.06, eps: 23.4, beta: 0.91, about: "IT services #4 — consulting-heavy book, Capco integration." },
  ADANIENT:   { name: "Adani Enterprises", sector: "Conglomerate", ltp: 3124.60, chg: 2.86, o: 3040, h: 3141, l: 3032, wk52h: 3743, wk52l: 2025, mcap: "3.6L Cr", pe: 62.4, pb: 6.8, roe: 11.2, de: 1.28, divy: 0.04, eps: 50.1, beta: 1.62, about: "Adani group incubator — airports, mining, new energy, data centres." },
  LT:         { name: "Larsen & Toubro", sector: "Infra", ltp: 3648.90, chg: 1.24, o: 3610, h: 3661, l: 3598, wk52h: 3964, wk52l: 3175, mcap: "5.0L Cr", pe: 33.4, pb: 5.2, roe: 15.9, de: 1.02, divy: 0.92, eps: 109.2, beta: 1.08, about: "India's largest E&C — infra capex proxy, defence & IT arms." },
  MARUTI:     { name: "Maruti Suzuki", sector: "Auto", ltp: 12480.00, chg: 0.68, o: 12400, h: 12530, l: 12366, wk52h: 13680, wk52l: 10725, mcap: "3.9L Cr", pe: 26.2, pb: 4.4, roe: 17.1, de: 0.01, divy: 1.01, eps: 476.3, beta: 0.88, about: "Every second car sold in India. SUV pivot + hybrid bet." },
  SUNPHARMA:  { name: "Sun Pharma", sector: "Pharma", ltp: 1684.20, chg: -0.34, o: 1690, h: 1696, l: 1678, wk52h: 1960, wk52l: 1377, mcap: "4.0L Cr", pe: 35.1, pb: 5.6, roe: 16.8, de: 0.03, divy: 0.89, eps: 48.0, beta: 0.71, about: "India's largest pharma — specialty US portfolio led by Ilumya." },
};
Object.keys(STOCKS).forEach((s, i) => {
  const st = STOCKS[s];
  st.sym = s;
  st.series = {
    "1D": genSeries(7 + i, 40, st.chg / 4000, 0.004, st.ltp),
    "1W": genSeries(11 + i, 30, st.chg / 900, 0.01, st.ltp),
    "1M": genSeries(23 + i, 30, 0.001, 0.02, st.ltp),
    "1Y": genSeries(41 + i, 52, 0.003, 0.045, st.ltp),
    "5Y": genSeries(67 + i, 60, 0.008, 0.07, st.ltp),
  };
});

// ── Holdings (equity) ───────────────────────────────────────────────────────
var HOLDINGS = [
  { sym: "RELIANCE", qty: 48, avg: 2410, brokers: { zerodha: 30, groww: 18 } },
  { sym: "INFY", qty: 120, avg: 1482, brokers: { zerodha: 80, groww: 40 } },
  { sym: "HDFCBANK", qty: 60, avg: 1741, brokers: { zerodha: 60 } },
  { sym: "TCS", qty: 32, avg: 3524, brokers: { groww: 20, upstox: 12 } },
  { sym: "ITC", qty: 300, avg: 410, brokers: { zerodha: 180, groww: 120 } },
  { sym: "TATAMOTORS", qty: 90, avg: 718, brokers: { zerodha: 90 } },
  { sym: "BAJFINANCE", qty: 14, avg: 6120, brokers: { groww: 14 } },
  { sym: "SBIN", qty: 110, avg: 612, brokers: { zerodha: 70, upstox: 40 } },
  { sym: "DIXON", qty: 6, avg: 11450, brokers: { groww: 6 } },
  { sym: "ZOMATO", qty: 320, avg: 182, brokers: { zerodha: 320 } },
].map(h => {
  const st = STOCKS[h.sym];
  const val = +(h.qty * st.ltp).toFixed(0), inv = h.qty * h.avg;
  return { ...h, name: st.name, sector: st.sector, ltp: st.ltp, dayChg: st.chg, val, inv, pnl: val - inv, pnlPct: +((val - inv) / inv * 100).toFixed(1), dayPnl: +(val * st.chg / 100).toFixed(0) };
});

// ── Mutual funds ────────────────────────────────────────────────────────────
var MFS = {
  PPFCF: { id: "PPFCF", name: "Parag Parikh Flexi Cap", cat: "Flexi cap · Direct G", nav: 85.94, navChg: 0.62, ret1: 24.8, ret3: 18.2, ret5: 22.1, exp: 0.63, aum: "₹84,120 Cr", risk: "Very high", overlap: 18, held: { units: 3309.2, inv: 240000, sip: 10000 } },
  UTINIFTY: { id: "UTINIFTY", name: "UTI Nifty 50 Index", cat: "Index · Direct G", nav: 164.02, navChg: 0.41, ret1: 11.2, ret3: 13.8, ret5: 15.9, exp: 0.17, aum: "₹19,480 Cr", risk: "Very high", overlap: 64, held: { units: 1199.85, inv: 172000, sip: 8000 } },
  HDFCLIQ: { id: "HDFCLIQ", name: "HDFC Liquid Fund", cat: "Liquid · Direct G", nav: 5124.6, navChg: 0.02, ret1: 7.3, ret3: 6.4, ret5: 5.6, exp: 0.2, aum: "₹62,340 Cr", risk: "Low", overlap: 0, held: { units: 25.05, inv: 125000, sip: 0 } },
  QUANTSC: { id: "QUANTSC", name: "Quant Small Cap", cat: "Small cap · Direct G", nav: 262.4, navChg: -0.84, ret1: 18.9, ret3: 28.4, ret5: 34.2, exp: 0.64, aum: "₹26,220 Cr", risk: "Very high", overlap: 4 },
  MOMIDCAP: { id: "MOMIDCAP", name: "Motilal Oswal Midcap", cat: "Mid cap · Direct G", nav: 104.86, navChg: 1.12, ret1: 32.4, ret3: 31.1, ret5: 28.9, exp: 0.58, aum: "₹18,604 Cr", risk: "Very high", overlap: 8 },
};
var MF_HELD = ["PPFCF", "UTINIFTY", "HDFCLIQ"].map(id => {
  const f = MFS[id], val = +(f.held.units * f.nav).toFixed(0);
  return { ...f, val, inv: f.held.inv, pnl: val - f.held.inv, pnlPct: +((val - f.held.inv) / f.held.inv * 100).toFixed(1) };
});

// ── Portfolio totals ────────────────────────────────────────────────────────
var EQ_VAL = HOLDINGS.reduce((a, h) => a + h.val, 0);
var MF_VAL = MF_HELD.reduce((a, f) => a + f.val, 0);
var PORTFOLIO = {
  total: EQ_VAL + MF_VAL,
  eq: EQ_VAL, mf: MF_VAL,
  inv: HOLDINGS.reduce((a, h) => a + h.inv, 0) + MF_HELD.reduce((a, f) => a + f.inv, 0),
  dayPnl: HOLDINGS.reduce((a, h) => a + h.dayPnl, 0) + 2140,
  xirr: 16.4,
  series: genSeries(5, 60, 0.0028, 0.018, EQ_VAL + MF_VAL),
};
PORTFOLIO.pnl = PORTFOLIO.total - PORTFOLIO.inv;
PORTFOLIO.pnlPct = +(PORTFOLIO.pnl / PORTFOLIO.inv * 100).toFixed(1);
PORTFOLIO.dayPct = +(PORTFOLIO.dayPnl / PORTFOLIO.total * 100).toFixed(2);

// ── Positions (F&O / intraday) ──────────────────────────────────────────────
var POSITIONS = [
  { id: 1, sym: "NIFTY 24 JUL 24800 CE", kind: "OPT · NFO", side: "BUY", qty: 75, avg: 118.4, ltp: 156.2, broker: "zerodha", product: "NRML" },
  { id: 2, sym: "TATAMOTORS 31 JUL FUT", kind: "FUT · NFO", side: "SELL", qty: 550, avg: 695.0, ltp: 682.9, broker: "zerodha", product: "NRML" },
  { id: 3, sym: "BANKNIFTY 24 JUL 52300 PE", kind: "OPT · NFO", side: "BUY", qty: 30, avg: 210.0, ltp: 168.4, broker: "groww", product: "NRML" },
].map(p => ({ ...p, mtm: +((p.side === "BUY" ? 1 : -1) * (p.ltp - p.avg) * p.qty).toFixed(0) }));

// ── Tradebook (FIFO pairs) ──────────────────────────────────────────────────
var TRADES = [
  { id: "t1", sym: "HAL", qty: 12, buy: 3820, sell: 4486.2, bDate: "12 Feb 2026", sDate: "14 Jul 2026", broker: "zerodha", term: "ST", charges: 118 },
  { id: "t2", sym: "IRCTC", qty: 40, buy: 918, sell: 812.3, bDate: "03 Jan 2026", sDate: "08 Jul 2026", broker: "groww", term: "ST", charges: 96 },
  { id: "t3", sym: "WIPRO", qty: 100, buy: 402, sell: 486.2, bDate: "22 Apr 2025", sDate: "26 Jun 2026", broker: "zerodha", term: "LT", charges: 132 },
  { id: "t4", sym: "ZOMATO", qty: 150, buy: 148, sell: 271.4, bDate: "18 Mar 2025", sDate: "19 Jun 2026", broker: "zerodha", term: "LT", charges: 104 },
  { id: "t5", sym: "MARUTI", qty: 4, buy: 11840, sell: 12480, bDate: "02 Jun 2026", sDate: "12 Jun 2026", broker: "upstox", term: "ST", charges: 88 },
  { id: "t6", sym: "SUNPHARMA", qty: 30, buy: 1512, sell: 1684.2, bDate: "11 Nov 2024", sDate: "02 Jun 2026", broker: "groww", term: "LT", charges: 92 },
  { id: "t7", sym: "ADANIENT", qty: 10, buy: 3390, sell: 3124.6, bDate: "04 May 2026", sDate: "21 May 2026", broker: "zerodha", term: "ST", charges: 76 },
  { id: "t8", sym: "LT", qty: 15, buy: 3212, sell: 3648.9, bDate: "09 Sep 2024", sDate: "15 May 2026", broker: "zerodha", term: "LT", charges: 110 },
].map(t => ({ ...t, pnl: +((t.sell - t.buy) * t.qty - t.charges).toFixed(0) }));

// ── Indices & market ────────────────────────────────────────────────────────
var INDICES = [
  { sym: "NIFTY 50", v: 24812.4, chg: 0.42, series: genSeries(3, 40, 0.0002, 0.003, 24812.4) },
  { sym: "SENSEX", v: 81420.6, chg: 0.36, series: genSeries(9, 40, 0.0002, 0.003, 81420.6) },
  { sym: "BANKNIFTY", v: 52180.2, chg: 0.21, series: genSeries(13, 40, 0.0001, 0.004, 52180.2) },
  { sym: "NIFTY IT", v: 38940.8, chg: -0.28, series: genSeries(17, 40, -0.0002, 0.004, 38940.8) },
  { sym: "MIDCAP 100", v: 57318.5, chg: 1.08, series: genSeries(21, 40, 0.0004, 0.004, 57318.5) },
  { sym: "INDIA VIX", v: 13.42, chg: -4.2, series: genSeries(29, 40, -0.001, 0.02, 13.42) },
];
var MOVERS = {
  gainers: ["DIXON", "ADANIENT", "BAJFINANCE", "HAL", "LT"],
  losers: ["ZOMATO", "TATAMOTORS", "ASIANPAINT", "IRCTC", "SUNPHARMA"],
};
var FII_DII = { fii: -1243, dii: 1892, date: "Fri, 18 Jul" };
var SECTORS = [
  { id: "financials", name: "Financials", chg: 0.85, w: 32, top: ["HDFCBANK", "SBIN", "BAJFINANCE"], line: "Rate-cut hopes lift lenders; PSU banks lead." },
  { id: "it", name: "IT", chg: -0.45, w: 13, top: ["TCS", "INFY", "WIPRO"], line: "Soft guidance season; deal wins slow." },
  { id: "energy", name: "Energy", chg: 0.62, w: 11, top: ["RELIANCE"], line: "Crude cooling; refining margins steady." },
  { id: "auto", name: "Auto", chg: -0.88, w: 8, top: ["TATAMOTORS", "MARUTI"], line: "JLR tariff drag; festive inventory builds." },
  { id: "fmcg", name: "FMCG", chg: 0.34, w: 8, top: ["ITC", "HINDUNILVR"], line: "Rural demand green shoots, monsoon on track." },
  { id: "pharma", name: "Pharma", chg: -0.22, w: 6, top: ["SUNPHARMA"], line: "US pricing stable; specialty ramps." },
  { id: "defence", name: "Defence", chg: 1.94, w: 4, top: ["HAL"], line: "Order-book records; export push." },
  { id: "infra", name: "Infra", chg: 1.12, w: 5, top: ["LT"], line: "Capex cycle intact; monsoon slows execution." },
];

// ── News & events ───────────────────────────────────────────────────────────
var NEWS = [
  { id: 1, sym: "INFY", tag: "EARNINGS", src: "Mint", time: "2h", title: "Infosys guides FY27 revenue at 3-5% cc growth; margin band held", held: true },
  { id: 2, sym: "RELIANCE", tag: "CORPORATE", src: "ET", time: "4h", title: "Reliance retail arm files DRHP confidentially — IPO by FY27", held: true },
  { id: 3, sym: null, tag: "MACRO", src: "BS", time: "6h", title: "CPI eases to 3.1% in June; rate-cut odds for August MPC rise" },
  { id: 4, sym: "TATAMOTORS", tag: "SECTOR", src: "Moneycontrol", time: "9h", title: "JLR flags $1.6B tariff hit; Tata Motors trims capex guidance", held: true },
  { id: 5, sym: "HAL", tag: "ORDERS", src: "Mint", time: "1d", title: "HAL signs ₹62,000 Cr deal for 97 Tejas Mk1A jets" },
  { id: 6, sym: null, tag: "FLOWS", src: "NSE", time: "1d", title: "FIIs net sellers 6th straight session; DIIs absorb ₹1,890 Cr" },
  { id: 7, sym: "ZOMATO", tag: "RESULTS", src: "ET", time: "2d", title: "Blinkit turns EBITDA positive a quarter early; food GOV +14%", held: true },
];
var EVENTS = [
  { d: "Jul 22", sym: "HDFCBANK", kind: "Earnings", note: "Q1 FY27 results", held: true },
  { d: "Jul 24", sym: "BAJFINANCE", kind: "Earnings", note: "Q1 FY27 results", held: true },
  { d: "Jul 25", sym: "ITC", kind: "Dividend", note: "₹7.50/sh ex-date", held: true },
  { d: "Jul 29", sym: "TCS", kind: "Buyback", note: "Record date — ₹4,150/sh", held: true },
  { d: "Aug 06", sym: null, kind: "Macro", note: "RBI MPC rate decision" },
];

// ── Screener presets ────────────────────────────────────────────────────────
var SCANS = [
  { id: "quality", name: "Quality compounders", desc: "ROE > 20 · low debt · 5Y sales growth", count: 42, syms: ["TCS", "HINDUNILVR", "ITC", "HAL", "IRCTC", "DIXON"] },
  { id: "value", name: "Cheap vs history", desc: "PE below 5Y median · positive earnings", count: 28, syms: ["INFY", "HDFCBANK", "SBIN", "TATAMOTORS", "WIPRO"] },
  { id: "momentum", name: "Momentum leaders", desc: "Above 50 & 200 DMA · RSI 55-70", count: 35, syms: ["DIXON", "ADANIENT", "BAJFINANCE", "LT", "HAL"] },
  { id: "dividend", name: "Dividend payers", desc: "Yield > 2% · 5Y payout consistency", count: 19, syms: ["ITC", "INFY", "WIPRO"] },
  { id: "52wk", name: "Near 52-week lows", desc: "Within 8% of 52W low · mcap > 10k Cr", count: 12, syms: ["TATAMOTORS", "ASIANPAINT", "ZOMATO"] },
  { id: "smallcap", name: "Smallcap breakouts", desc: "Volume 3× avg · new 3M high", count: 23, syms: ["DIXON", "IRCTC"] },
];

// ── Watchlists (seed) ───────────────────────────────────────────────────────
var WATCHLISTS_SEED = [
  { id: "core", name: "Core watch", syms: ["HAL", "HINDUNILVR", "LT", "ASIANPAINT"] },
  { id: "newage", name: "New age", syms: ["ZOMATO", "DIXON", "IRCTC"] },
];

// ── Notifications ───────────────────────────────────────────────────────────
var NOTIFS = [
  { id: 1, icon: "refresh", kind: "SYNC", title: "Morning sync complete", sub: "3 brokers · 12 holdings reconciled · 09:31 am", time: "2h", unread: true },
  { id: 2, icon: "alert", kind: "BROKER", title: "Upstox token expired", sub: "Reconnect to keep TCS & SBIN lots fresh", time: "3h", unread: true, go: "brokers" },
  { id: 3, icon: "flame", kind: "ROAST", title: "Your roast is ready", sub: "Score 62/100 — \"solid core, lazy cash\"", time: "1d", go: "roast" },
  { id: 4, icon: "sparkles", kind: "RESEARCH", title: "Deep research finished", sub: "INFY — hold thesis intact, margin watch", time: "2d", go: "sagereport" },
  { id: 5, icon: "calendar", kind: "EVENT", title: "HDFCBANK results on Jul 22", sub: "You hold 60 shares across 1 broker", time: "2d" },
  { id: 6, icon: "zap", kind: "CREDITS", title: "Monthly credits refreshed", sub: "5 free credits added to your account", time: "6d" },
];

// ── Sage ────────────────────────────────────────────────────────────────────
var SAGE_SUGGESTIONS = [
  "Should I book profit on RELIANCE?",
  "Why is my portfolio down today?",
  "How concentrated am I in financials?",
  "What's my LTCG bill if I sell INFY now?",
];
var SAGE_HISTORY = [
  { id: "c1", title: "Book profit on RELIANCE?", when: "Today", n: 6 },
  { id: "c2", title: "IT sector exposure check", when: "Yesterday", n: 4 },
  { id: "c3", title: "Deep research: INFY", when: "Jul 17", n: 2, research: true },
  { id: "c4", title: "Tax harvest before March", when: "Jul 12", n: 9 },
  { id: "c5", title: "Compare HDFCBANK vs SBIN", when: "Jul 08", n: 5 },
];
var RESEARCH_REPORT = {
  sym: "INFY", title: "Infosys — hold thesis intact, watch the margin band", verdict: "HOLD", conviction: 71,
  cost: 2, duration: "1m 42s", date: "Today, 10:12 am",
  summary: "You hold 120 shares at ₹1,482 avg (+8.7%). The FY27 guide of 3-5% cc growth is conservative but credible; margin band held at 20-22%. At 24.3× — below its 5-year median of 27× — downside looks limited. LTCG clock: 84 of your 120 shares cross the 12-month line on Aug 3.",
  sections: [
    { h: "Business & moat", body: "Second-largest Indian IT exporter; 85% repeat revenue, top-25 clients avg 11-year tenure. GenAI bookings doubled H/H to $380M TCV — small but the fastest-growing line.", srcs: ["Q1 FY27 earnings call", "Annual report FY26"] },
    { h: "Valuation", body: "24.3× forward PE vs 27× 5-year median and TCS at 27.1×. Dividend yield 2.85% with an 85% payout policy gives a floor. EV/EBITDA 15.8× is bottom-quartile for the sector.", srcs: ["NSE quote data", "Screener fundamentals"] },
    { h: "Risks", body: "US BFSI discretionary spend still soft; H1-B fee changes add ~40bps cost risk. A miss below the 20% margin floor would break the thesis.", srcs: ["Mgmt commentary Q1", "Sector note — Mint, Jul 18"] },
    { h: "Your position", body: "INFY is 11.2% of your equity — 2nd largest. Combined IT weight 18.4% vs NIFTY's 13%. If trimming, the 36 shares bought Feb 2026 stay STCG until Feb 2027; selling those first costs ₹4,120 more in tax.", srcs: ["Your tradebook (FIFO)", "Tax engine"] },
  ],
  sources: 14,
};
var SAGE_CANNED = {
  default: { a: "Looking at your book: you're up ₹14,380 today (+0.84%), driven by BAJFINANCE +2.1% and DIXON +3.2%. INFY is the drag at -0.4%. Your IT weight is 18.4% — above index. Want me to break down any of these?", chips: ["IT exposure detail", "What should I trim?"], srcs: ["Your holdings · 3 brokers", "NSE live quotes"] },
  reliance: { a: "You hold 48 sh at avg ₹2,410 — now ₹2,942, +22.1%. PE is 28.4×, above its 5-yr median of 24×. 30 of 48 shares turn long-term on Sep 12 — booking now costs ₹8,940 extra STCG. If you're trimming, waiting 8 weeks saves real money.", chips: ["Show the tax math", "Set a reminder"], srcs: ["Your tradebook (FIFO)", "NSE quote", "Tax engine"] },
  down: { a: "Your portfolio isn't down — it's up ₹14,380 today. The feeling probably comes from ZOMATO -2.1% and TATAMOTORS -1.6%, your two most volatile names. Net, gains in financials more than offset both.", chips: ["Volatility by holding", "Why is ZOMATO down?"], srcs: ["Your holdings", "NSE live quotes"] },
  fin: { a: "Financials are 26.4% of your equity — HDFCBANK ₹1.01L, SBIN ₹88k, BAJFINANCE ₹1.02L. That's overweight vs NIFTY's 32% but concentrated in 3 names. Correlation between them ran 0.81 last quarter — they fall together.", chips: ["Run a risk report", "Suggest diversifiers"], srcs: ["Your holdings", "Correlation engine"] },
  ltcg: { a: "Selling all 120 INFY today: 84 shares are long-term (gain ₹9,140 — LTCG 12.5% past the ₹1.25L exemption you've partly used) and 36 are short-term (gain ₹2,180 at 20%). Total tax ≈ ₹1,580 now; ₹436 if you wait till Aug 3 when all lots go LT.", chips: ["Wait — remind me Aug 3", "Full tax report"], srcs: ["Your tradebook (FIFO)", "Tax engine FY26"] },
};

// ── Roast ───────────────────────────────────────────────────────────────────
var ROAST = {
  score: 62, delta: "+4 vs last roast", tag: "NOT A HIT-PIECE. JUST REAL.",
  line: "Solid core, but you're crowded in financials and sitting on lazy cash.",
  cards: [
    { kind: "bad", icon: "alert", title: "Over-concentrated in financials", body: "26.4% of equity in 3 lenders that move together (corr 0.81). One bad MPC day hurts. Trim toward your 20% target." },
    { kind: "good", icon: "check", title: "Costs are low", body: "Blended expense 0.31% — better than 78% of UseMoney users. Direct plans everywhere. Keep it." },
    { kind: "ugly", icon: "flame", title: "Idle cash drag", body: "₹1.28L in a liquid fund for 40+ days while your SIPs paused. That's ₹1,580/yr of return left on the table vs your index fund." },
    { kind: "good", icon: "check", title: "Winners held, losers cut", body: "Disposition ratio 0.8 — you actually let winners run (ZOMATO +36%). Rare. Most people do the opposite." },
  ],
  holdings: [
    { sym: "ZOMATO", heat: "spicy", line: "36% up and you haven't touched it. Discipline or forgetfulness — either way it worked." },
    { sym: "TATAMOTORS", heat: "burn", line: "Down 4.9% with a tariff cloud. You've watched it drift for 3 months. Decide something." },
    { sym: "HDFCLIQ", heat: "mild", line: "A liquid fund is not a strategy. Deploy it or admit it's your emergency fund." },
    { sym: "DIXON", heat: "spicy", line: "118× PE. Great story — just know you're paying for the sequel and the trilogy." },
  ],
  stats: { holdings: 13, brokers: 3, overlap: "18% MF-stock overlap", xirr: "16.4% XIRR vs 11.2% NIFTY" },
};

// ── Plans ───────────────────────────────────────────────────────────────────
var PLANS = [
  { id: "free", name: "Free", price: 0, tagline: "forever", credits: 5, feats: ["Unlimited broker sync", "Holdings, tradebook, positions", "Free Sage chat", "5 research credits / mo", "1 roast / mo"] },
  { id: "pro", name: "PRO", price: 249, tagline: "per month", credits: 50, pop: true, feats: ["Everything in Free", "50 research credits / mo", "Unlimited roasts", "Risk & tax reports", "Screener + alerts", "Priority sync"] },
  { id: "premium", name: "Premium", price: 1499, tagline: "per month", credits: 250, feats: ["Everything in PRO", "250 credits / mo", "Deep research on demand", "Analyst board (soon)", "CSV exports, API access"] },
  { id: "ultimate", name: "Ultimate", price: 4999, tagline: "per month", credits: 999, feats: ["Everything in Premium", "Unmetered research", "Dedicated support", "Early features"] },
];

// ── Tax & risk ──────────────────────────────────────────────────────────────
var TAX = {
  fy: "FY 2026-27", stcg: 20580, ltcg: 61120, exemptLeft: 63880, taxDue: 4116, chargesYtd: 816,
  breakdown: [
    { label: "Short-term gains", v: 20580, note: "20% slab · ₹4,116 tax" },
    { label: "Long-term gains", v: 61120, note: "Within ₹1.25L exemption — ₹0 tax" },
    { label: "Exemption headroom", v: 63880, note: "LTCG you can still book tax-free" },
  ],
  harvest: [
    { sym: "TATAMOTORS", unreal: -3159, save: 632, note: "Book loss, offset STCG, re-enter after 1 day" },
    { sym: "HDFCBANK", unreal: -3054, save: 611, note: "Loss offsets short-term gains 1:1" },
  ],
};
var RISK = {
  var95: 24800, beta: 1.08, vol: 14.2, maxDD: -18.4, sharpe: 1.21,
  conc: [{ label: "Top 3 holdings", v: "26.4%" }, { label: "Financials weight", v: "26.4%" }, { label: "Single stock max", v: "11.2% (INFY)" }],
  corr: [["HDFCBANK", "SBIN", 0.81], ["TCS", "INFY", 0.77], ["RELIANCE", "NIFTY", 0.64]],
};

// ── FIRE defaults ───────────────────────────────────────────────────────────
var FIRE_DEF = { age: 29, retire: 45, corpus: PORTFOLIO.total, sip: 45000, expense: 60000, ret: 12, inflation: 6, swr: 3.5 };

// ── Import (CSV) sample ─────────────────────────────────────────────────────
var IMPORT_PREVIEW = {
  file: "zerodha_tradebook_FY26.csv", rows: 214, cols: ["symbol", "trade_date", "trade_type", "quantity", "price", "order_id"],
  sample: [
    ["RELIANCE", "2026-02-12", "buy", "18", "2384.20", "26021200041"],
    ["INFY", "2026-02-18", "buy", "40", "1512.00", "26021800112"],
    ["HAL", "2026-07-14", "sell", "12", "4486.20", "26071400218"],
  ],
  mapped: { symbol: "Symbol", trade_date: "Trade date", trade_type: "Buy / Sell", quantity: "Quantity", price: "Price", order_id: "Order ID" },
  result: { imported: 206, dupes: 8, pairs: 42, span: "Apr 2025 – Jul 2026" },
};

Object.assign(window, {
  inr, money, signMoney, pct, compactINR, genSeries,
  USER, BROKER_META, BROKERS_SEED, STOCKS, HOLDINGS, MFS, MF_HELD, PORTFOLIO, POSITIONS, TRADES,
  INDICES, MOVERS, FII_DII, SECTORS, NEWS, EVENTS, SCANS, WATCHLISTS_SEED, NOTIFS,
  SAGE_SUGGESTIONS, SAGE_HISTORY, RESEARCH_REPORT, SAGE_CANNED, ROAST, PLANS, TAX, RISK, FIRE_DEF, IMPORT_PREVIEW,
});
