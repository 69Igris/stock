// =============================================================================
// Centralized Demo Data
// =============================================================================
// All demo data for the UseMoney platform. Data is consistent across pages:
// - Same stocks across holdings, trades, positions
// - Brokers: Zerodha (primary, AB1234/ZH1234), Groww (secondary, GR5678), Dhan (tertiary, DH9012)
// - ~11L total portfolio value
// - P&L numbers are consistent and add up
// =============================================================================

// ---------------------------------------------------------------------------
// 1. Dashboard Stats
// ---------------------------------------------------------------------------

export const demoDashboardStats = {
  portfolio: {
    totalValue: 1093670,
    totalPnL: 54882.5,
    pnlPercentage: "5.28",
    holdingsValue: 850000,
    holdingsInvested: 807500,
    holdingsPnL: 42500,
    mfValue: 193670,
    mfInvested: 183990,
    mfPnL: 9680,
    openPositionsValue: 50000,
    openPositionsPnL: 2702.5,
  },
  trading: {
    totalRealizedPnL: 15156.25,
    totalTrades: 7,
    todaysPnL: 2580.25,
    todaysTrades: 2,
    winRate: 80,
    winners: 4,
    losers: 1,
    bestTrade: { symbol: "NIFTY25JAN", pnl: 9980 },
    worstTrade: { symbol: "INFY", pnl: -2663.75 },
  },
  charts: {
    dailyPnL: Array.from({ length: 30 }, (_, i) => {
      const date = new Date();
      date.setDate(date.getDate() - (29 - i));
      const pnl = Math.random() * 8000 - 2000;
      return {
        date: date.toISOString().split("T")[0],
        pnl,
        cumulativePnL: pnl * (i + 1) * 0.1,
      };
    }),
  },
  recentTrades: [
    {
      id: "demo-5",
      symbol: "NIFTY25JAN",
      exchange: "NFO",
      tradeType: "BUY",
      quantity: 50,
      price: 24250,
      realizedPnL: 9980,
      tradeDate: new Date("2024-12-18"),
    },
    {
      id: "demo-7",
      symbol: "TATAMOTORS",
      exchange: "NSE",
      tradeType: "BUY",
      quantity: 100,
      price: 785.5,
      realizedPnL: 2655,
      tradeDate: new Date("2024-12-10"),
    },
    {
      id: "demo-1",
      symbol: "RELIANCE",
      exchange: "NSE",
      tradeType: "BUY",
      quantity: 50,
      price: 2450.75,
      realizedPnL: 3442.5,
      tradeDate: new Date("2024-12-15"),
    },
    {
      id: "demo-2",
      symbol: "TCS",
      exchange: "NSE",
      tradeType: "BUY",
      quantity: 25,
      price: 3850,
      realizedPnL: 1742.5,
      tradeDate: new Date("2024-12-16"),
    },
    {
      id: "demo-3",
      symbol: "INFY",
      exchange: "NSE",
      tradeType: "BUY",
      quantity: 75,
      price: 1520.25,
      realizedPnL: -2663.75,
      tradeDate: new Date("2024-12-17"),
    },
  ],
};

// ---------------------------------------------------------------------------
// 2. Holdings
// ---------------------------------------------------------------------------

export const demoHoldings = [
  {
    id: "hold-1",
    symbol: "RELIANCE",
    name: "Reliance Industries",
    sector: "Energy",
    exchange: "NSE",
    quantity: 100,
    t1Quantity: 0,
    averagePrice: 2380.5,
    currentPrice: 2520.75,
    investedValue: 238050,
    currentValue: 252075,
    unrealizedPnL: 14025,
    pnlPercentage: 5.89,
    broker: "ZERODHA",
    brokerUserId: "AB1234",
    brokerName: "zerodha",
    brokerDisplayName: "ZERODHA",
    purchaseDate: "2024-01-15",
  },
  {
    id: "hold-2",
    symbol: "TCS",
    name: "Tata Consultancy",
    sector: "IT",
    exchange: "NSE",
    quantity: 50,
    t1Quantity: 0,
    averagePrice: 3750.0,
    currentPrice: 3920.5,
    investedValue: 187500,
    currentValue: 196025,
    unrealizedPnL: 8525,
    pnlPercentage: 4.55,
    broker: "GROWW",
    brokerUserId: "GR5678",
    brokerName: "groww",
    brokerDisplayName: "GROWW",
    purchaseDate: "2024-02-10",
  },
  {
    id: "hold-3",
    symbol: "INFY",
    name: "Infosys",
    sector: "IT",
    exchange: "NSE",
    quantity: 150,
    t1Quantity: 0,
    averagePrice: 1480.25,
    currentPrice: 1520.0,
    investedValue: 222037.5,
    currentValue: 228000,
    unrealizedPnL: 5962.5,
    pnlPercentage: 2.69,
    broker: "ZERODHA",
    brokerUserId: "AB1234",
    brokerName: "zerodha",
    brokerDisplayName: "ZERODHA",
    purchaseDate: "2024-03-05",
  },
  {
    id: "hold-4",
    symbol: "HDFCBANK",
    name: "HDFC Bank",
    sector: "Banking",
    exchange: "NSE",
    quantity: 80,
    t1Quantity: 0,
    averagePrice: 1620.0,
    currentPrice: 1680.5,
    investedValue: 129600,
    currentValue: 134440,
    unrealizedPnL: 4840,
    pnlPercentage: 3.73,
    broker: "DHAN",
    brokerUserId: "DH9012",
    brokerName: "dhan",
    brokerDisplayName: "DHAN",
    purchaseDate: "2024-04-20",
  },
  {
    id: "hold-5",
    symbol: "TATAMOTORS",
    name: "Tata Motors",
    sector: "Automobile",
    exchange: "NSE",
    quantity: 200,
    t1Quantity: 0,
    averagePrice: 720.0,
    currentPrice: 785.5,
    investedValue: 144000,
    currentValue: 157100,
    unrealizedPnL: 13100,
    pnlPercentage: 9.1,
    broker: "ZERODHA",
    brokerUserId: "AB1234",
    brokerName: "zerodha",
    brokerDisplayName: "ZERODHA",
    purchaseDate: "2024-05-12",
  },
  {
    id: "hold-6",
    symbol: "ICICIBANK",
    name: "ICICI Bank",
    sector: "Banking",
    exchange: "NSE",
    quantity: 120,
    t1Quantity: 0,
    averagePrice: 980.0,
    currentPrice: 1050.25,
    investedValue: 117600,
    currentValue: 126030,
    unrealizedPnL: 8430,
    pnlPercentage: 7.17,
    broker: "GROWW",
    brokerUserId: "GR5678",
    brokerName: "groww",
    brokerDisplayName: "GROWW",
    purchaseDate: "2024-06-08",
  },
];

// ---------------------------------------------------------------------------
// 3. Positions
// ---------------------------------------------------------------------------

export const demoPositions = [
  {
    id: "demo-4",
    userId: "demo",
    symbol: "HDFCBANK",
    exchange: "NSE",
    segment: "EQUITY",
    tradeType: "BUY",
    positionType: "LONG",
    orderType: "MARKET",
    productType: "CNC",
    quantity: 40,
    price: 1680.5,
    exitPrice: null,
    tradeValue: 67220,
    brokerage: 20,
    taxes: 0,
    realizedPnL: null,
    status: "OPEN",
    tradeDate: new Date("2024-12-18"),
    exitDate: null,
    broker: "DHAN",
    brokerUserId: "DH9012",
    brokerName: "dhan",
    tags: [] as string[],
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    entryPrice: 1680.5,
    currentPrice: 1715.25,
    unrealizedPnL: 1390,
  },
  {
    id: "demo-6",
    userId: "demo",
    symbol: "ICICIBANK",
    exchange: "NSE",
    segment: "EQUITY",
    tradeType: "SELL",
    positionType: "SHORT",
    orderType: "MARKET",
    productType: "MIS",
    quantity: 100,
    price: 1050.0,
    exitPrice: null,
    tradeValue: 105000,
    brokerage: 20,
    taxes: 0,
    realizedPnL: null,
    status: "OPEN",
    tradeDate: new Date("2024-12-19"),
    exitDate: null,
    broker: "GROWW",
    brokerUserId: "GR5678",
    brokerName: "groww",
    tags: [] as string[],
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    entryPrice: 1050.0,
    currentPrice: 1042.5,
    unrealizedPnL: 750,
  },
];

// ---------------------------------------------------------------------------
// 4. Trades
// ---------------------------------------------------------------------------

export const demoTrades = [
  {
    id: "demo-1",
    userId: "demo",
    symbol: "RELIANCE",
    exchange: "NSE",
    segment: "EQUITY",
    tradeType: "BUY",
    positionType: "LONG",
    orderType: "MARKET",
    productType: "CNC",
    quantity: 50,
    price: 2450.75,
    exitPrice: 2520.0,
    tradeValue: 122537.5,
    brokerage: 20,
    taxes: 0,
    realizedPnL: 3442.5,
    status: "CLOSED",
    tradeDate: new Date("2024-12-15"),
    exitDate: new Date("2024-12-16"),
    broker: "ZERODHA",
    brokerUserId: "ZH1234",
    brokerName: "zerodha",
    tags: ["momentum"],
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "demo-2",
    userId: "demo",
    symbol: "TCS",
    exchange: "NSE",
    segment: "EQUITY",
    tradeType: "BUY",
    positionType: "LONG",
    orderType: "LIMIT",
    productType: "CNC",
    quantity: 25,
    price: 3850.0,
    exitPrice: 3920.5,
    tradeValue: 96250,
    brokerage: 20,
    taxes: 0,
    realizedPnL: 1742.5,
    status: "CLOSED",
    tradeDate: new Date("2024-12-16"),
    exitDate: new Date("2024-12-17"),
    broker: "GROWW",
    brokerUserId: "GR5678",
    brokerName: "groww",
    tags: [] as string[],
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "demo-3",
    userId: "demo",
    symbol: "INFY",
    exchange: "NSE",
    segment: "EQUITY",
    tradeType: "BUY",
    positionType: "LONG",
    orderType: "MARKET",
    productType: "CNC",
    quantity: 75,
    price: 1520.25,
    exitPrice: 1485.0,
    tradeValue: 114018.75,
    brokerage: 20,
    taxes: 0,
    realizedPnL: -2663.75,
    status: "CLOSED",
    tradeDate: new Date("2024-12-17"),
    exitDate: new Date("2024-12-18"),
    broker: "ZERODHA",
    brokerUserId: "ZH1234",
    brokerName: "zerodha",
    tags: [] as string[],
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "demo-4",
    userId: "demo",
    symbol: "HDFCBANK",
    exchange: "NSE",
    segment: "EQUITY",
    tradeType: "BUY",
    positionType: "LONG",
    orderType: "MARKET",
    productType: "CNC",
    quantity: 40,
    price: 1680.5,
    exitPrice: null,
    tradeValue: 67220,
    brokerage: 20,
    taxes: 0,
    realizedPnL: null,
    status: "OPEN",
    tradeDate: new Date("2024-12-18"),
    exitDate: null,
    broker: "DHAN",
    brokerUserId: "DH9012",
    brokerName: "dhan",
    tags: [] as string[],
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "demo-5",
    userId: "demo",
    symbol: "NIFTY25JAN",
    exchange: "NFO",
    segment: "FUTURES",
    tradeType: "BUY",
    positionType: "LONG",
    orderType: "LIMIT",
    productType: "NRML",
    quantity: 50,
    price: 24250.0,
    exitPrice: 24450.0,
    tradeValue: 1212500,
    brokerage: 20,
    taxes: 0,
    realizedPnL: 9980.0,
    status: "CLOSED",
    tradeDate: new Date("2024-12-18"),
    exitDate: new Date("2024-12-19"),
    broker: "ZERODHA",
    brokerUserId: "ZH1234",
    brokerName: "zerodha",
    tags: ["index"],
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "demo-6",
    userId: "demo",
    symbol: "ICICIBANK",
    exchange: "NSE",
    segment: "EQUITY",
    tradeType: "SELL",
    positionType: "SHORT",
    orderType: "MARKET",
    productType: "MIS",
    quantity: 100,
    price: 1050.0,
    exitPrice: null,
    tradeValue: 105000,
    brokerage: 20,
    taxes: 0,
    realizedPnL: null,
    status: "OPEN",
    tradeDate: new Date("2024-12-19"),
    exitDate: null,
    broker: "GROWW",
    brokerUserId: "GR5678",
    brokerName: "groww",
    tags: [] as string[],
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "demo-7",
    userId: "demo",
    symbol: "TATAMOTORS",
    exchange: "NSE",
    segment: "EQUITY",
    tradeType: "BUY",
    positionType: "LONG",
    orderType: "LIMIT",
    productType: "CNC",
    quantity: 100,
    price: 785.5,
    exitPrice: 812.25,
    tradeValue: 78550,
    brokerage: 20,
    taxes: 0,
    realizedPnL: 2655.0,
    status: "CLOSED",
    tradeDate: new Date("2024-12-10"),
    exitDate: new Date("2024-12-12"),
    broker: "ZERODHA",
    brokerUserId: "ZH1234",
    brokerName: "zerodha",
    tags: [] as string[],
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

// ---------------------------------------------------------------------------
// 5. Mutual Funds
// ---------------------------------------------------------------------------

export const demoMutualFunds = [
  {
    id: "mf-1",
    userId: "demo",
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
    broker: "GROWW",
    brokerUserId: "GR5678",
    lastUpdated: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "mf-2",
    userId: "demo",
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
    broker: "GROWW",
    brokerUserId: "GR5678",
    lastUpdated: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "mf-3",
    userId: "demo",
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
    broker: "ZERODHA",
    brokerUserId: "AB1234",
    lastUpdated: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

// ---------------------------------------------------------------------------
// 6. Paper Trading Positions + Summary
// ---------------------------------------------------------------------------

export const demoPaperPositions = [
  {
    id: "paper-1",
    userId: "demo",
    portfolioId: null,
    symbol: "RELIANCE",
    name: "Reliance Industries Ltd",
    assetType: "STOCK",
    segment: "EQUITY",
    exchange: "NSE",
    positionType: "LONG",
    side: "LONG",
    quantity: 50,
    lotSize: null,
    averagePrice: 2450,
    investedValue: 122500,
    currentPrice: 2580,
    currentValue: 129000,
    unrealizedPnL: 6500,
    pnlPercentage: 5.3,
    dayPnl: 250,
    strikePrice: null,
    optionType: null,
    expiryDate: null,
    schemeName: null,
    units: null,
    nav: null,
    niftyAtEntry: 22500,
    benchmarkPnL: 4900,
    alpha: 1600,
    stopLoss: 2300,
    target: 2800,
    strategy: "Swing Trading",
    status: "OPEN",
    exitPrice: null,
    exitDate: null,
    realizedPnL: null,
    notes: "Long term investment",
    tags: ["bluechip"],
    entryDate: new Date("2024-10-15"),
    createdAt: new Date("2024-10-15"),
    updatedAt: new Date(),
  },
  {
    id: "paper-2",
    userId: "demo",
    portfolioId: null,
    symbol: "NIFTY25JAN24000CE",
    name: "NIFTY 24000 CE",
    assetType: "FNO_OPTIONS",
    segment: "OPTIONS",
    exchange: "NFO",
    positionType: "LONG",
    side: "BUY",
    quantity: 1,
    lotSize: 25,
    averagePrice: 350,
    investedValue: 8750,
    currentPrice: 420,
    currentValue: 10500,
    unrealizedPnL: 1750,
    pnlPercentage: 20,
    dayPnl: -50,
    strikePrice: 24000,
    optionType: "CE",
    expiryDate: new Date("2025-01-30"),
    schemeName: null,
    units: null,
    nav: null,
    niftyAtEntry: 23500,
    benchmarkPnL: 372,
    alpha: 1378,
    stopLoss: null,
    target: null,
    strategy: "Options Scalping",
    status: "OPEN",
    exitPrice: null,
    exitDate: null,
    realizedPnL: null,
    notes: "Bullish bet",
    tags: ["options", "index"],
    entryDate: new Date("2024-12-01"),
    createdAt: new Date("2024-12-01"),
    updatedAt: new Date(),
  },
  {
    id: "paper-3",
    userId: "demo",
    portfolioId: null,
    symbol: "PARAG PARIKH FLEXI CAP",
    name: "Parag Parikh Flexi Cap Fund",
    assetType: "MF",
    segment: "EQUITY",
    exchange: "MF",
    positionType: "LONG",
    side: "LONG",
    quantity: 1,
    lotSize: null,
    averagePrice: 65.5,
    investedValue: 50000,
    currentPrice: 68.25,
    currentValue: 52099,
    unrealizedPnL: 2099,
    pnlPercentage: 4.2,
    dayPnl: 100,
    strikePrice: null,
    optionType: null,
    expiryDate: null,
    schemeName: "Parag Parikh Flexi Cap Fund - Direct Growth",
    units: 763.36,
    nav: 68.25,
    niftyAtEntry: 22000,
    benchmarkPnL: 2273,
    alpha: -174,
    stopLoss: null,
    target: null,
    strategy: null,
    status: "OPEN",
    exitPrice: null,
    exitDate: null,
    realizedPnL: null,
    notes: "SIP investment",
    tags: ["mf", "flexicap"],
    entryDate: new Date("2024-06-15"),
    createdAt: new Date("2024-06-15"),
    updatedAt: new Date(),
  },
];

export const demoPaperSummary = {
  totalInvested: 181250,
  totalCurrent: 191599,
  totalPnL: 10349,
  pnlPercentage: 5.71,
  totalPositions: 3,
  stockPositions: 1,
  fnoPositions: 1,
  mfPositions: 1,
  benchmarkPnL: 7545,
  alpha: 2804,
};

export const demoPaperPerformance = {
  totalTrades: 5,
  closedTrades: 2,
  winners: 2,
  losers: 0,
  winRate: 100,
  totalRealizedPnL: 15000,
  totalBenchmarkPnL: 8000,
  totalAlpha: 7000,
  bestTrade: { symbol: "TATA STEEL", pnl: 12000 },
  worstTrade: { symbol: "INFY", pnl: 3000 },
};

// ---------------------------------------------------------------------------
// 7. FIRE Scenarios
// ---------------------------------------------------------------------------

export const demoScenarios = [
  {
    id: "demo-1",
    userId: "demo",
    name: "Default Scenario",
    description: "My FIRE journey plan",
    currentAge: 25,
    retirementAge: 50,
    lifeExpectancy: 85,
    currentCorpus: 500000,
    monthlySavings: 75000,
    withdrawalRate: 4,
    taxRate: 30,
    salaryIncrement: 10,
    savingsIncrement: 12,
    assetClasses: [
      {
        id: "1",
        name: "Equity",
        icon: "chart-line",
        allocation: 70,
        expectedReturn: 12,
        color: "#3b82f6",
      },
      {
        id: "2",
        name: "Debt",
        icon: "landmark",
        allocation: 20,
        expectedReturn: 7,
        color: "#10b981",
      },
      {
        id: "3",
        name: "Gold",
        icon: "coins",
        allocation: 10,
        expectedReturn: 8,
        color: "#f59e0b",
      },
    ],
    expenses: [
      { id: "1", category: "Housing", amount: 25000, inflation: 5 },
      { id: "2", category: "Food & Groceries", amount: 15000, inflation: 6 },
      { id: "3", category: "Utilities", amount: 5000, inflation: 5 },
      { id: "4", category: "Transportation", amount: 8000, inflation: 5 },
      { id: "5", category: "Healthcare", amount: 5000, inflation: 8 },
      { id: "6", category: "Entertainment", amount: 7000, inflation: 4 },
    ],
    oneTimeExpenses: [
      {
        id: "1",
        name: "Children's Education",
        currentCost: 2500000,
        yearsAway: 18,
        inflation: 8,
      },
    ],
    fireNumber: 35000000,
    yearsToFire: 20,
    monthlyExpenses: 65000,
    avgInflation: 5.5,
    weightedReturn: 10.9,
    chatHistory: [] as Array<{ role: string; content: string }>,
    isDefault: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

// ---------------------------------------------------------------------------
// 8. Chat Histories
// ---------------------------------------------------------------------------

// Single clock read so timestamps meant to be equal (a single-message chat's
// createdAt/updatedAt/lastMessageAt, or the updated/lastMessage pair) are
// EXACTLY equal. Separate Date.now() reads per field drifted 1ms when the
// millisecond ticked mid-construction, intermittently flaking the
// "lastMessageAt should equal createdAt" assertion.
const DEMO_CHAT_BASE_MS = Date.now();

export const demoChatHistories = [
  {
    id: "demo-chat-1",
    userId: "demo-user-123",
    pagePath: "/dashboard",
    pageName: "StockSage",
    pageIcon: "Sparkles",
    messages: [
      {
        role: "user" as const,
        content: "What are my top performing trades this month?",
      },
      {
        role: "assistant" as const,
        content:
          "Based on your trading data, your top performing trades this month are:\n\n1. RELIANCE - Rs.3,442.50 profit (14.0% return)\n2. TCS - Rs.1,742.50 profit (1.8% return)\n\nYour overall portfolio shows a positive trend with good diversification across sectors.",
      },
    ],
    isArchived: false,
    createdAt: new Date(DEMO_CHAT_BASE_MS - 2 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(DEMO_CHAT_BASE_MS - 2 * 24 * 60 * 60 * 1000),
    lastMessageAt: new Date(DEMO_CHAT_BASE_MS - 2 * 24 * 60 * 60 * 1000),
  },
  {
    id: "demo-chat-2",
    userId: "demo-user-123",
    pagePath: "/analysis",
    pageName: "Analysis Results",
    pageIcon: "Brain",
    messages: [
      {
        role: "user" as const,
        content: "Analyze my trading patterns and suggest improvements",
      },
      {
        role: "assistant" as const,
        content:
          "Your trading analysis shows:\n\n**Strengths:**\n- Good diversification across multiple stocks\n- Consistent use of stop-loss orders\n- Strong performance in large-cap stocks\n\n**Areas for Improvement:**\n- Consider reducing position sizes in volatile stocks\n- Increase holding period for profitable trades\n- Review entry timing for better entry points\n\nWould you like me to dive deeper into any specific area?",
      },
      {
        role: "user" as const,
        content: "Tell me more about entry timing",
      },
      {
        role: "assistant" as const,
        content:
          "Based on your trade history, I notice that trades entered during market opening hours (9:15 AM - 10:00 AM) tend to perform better. Your average return for morning entries is 2.3% vs 0.8% for afternoon entries.\n\n**Recommendations:**\n1. Focus on morning entries when volatility is higher\n2. Use limit orders to get better entry prices\n3. Wait for initial volatility to settle before entering",
      },
    ],
    isArchived: false,
    createdAt: new Date(DEMO_CHAT_BASE_MS - 5 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(DEMO_CHAT_BASE_MS - 1 * 24 * 60 * 60 * 1000),
    lastMessageAt: new Date(DEMO_CHAT_BASE_MS - 1 * 24 * 60 * 60 * 1000),
  },
  {
    id: "demo-chat-3",
    userId: "demo-user-123",
    pagePath: "/tutor",
    pageName: "AI Tutor",
    pageIcon: "GraduationCap",
    messages: [
      {
        role: "user" as const,
        content: "Explain what P&L means in trading",
      },
      {
        role: "assistant" as const,
        content:
          "P&L stands for **Profit and Loss**. It's a key metric in trading that shows:\n\n**Realized P&L:** Profit or loss from closed trades\n- Calculated as: (Exit Price - Entry Price) x Quantity\n\n**Unrealized P&L:** Current profit/loss on open positions\n- Based on current market price vs your entry price\n\n**Example:**\n- Buy 10 shares at Rs.100 = Rs.1,000 invested\n- Current price Rs.110\n- Unrealized P&L = (110 - 100) x 10 = Rs.100 profit\n\nWould you like to learn about how to calculate P&L with brokerage and taxes?",
      },
    ],
    isArchived: false,
    createdAt: new Date(DEMO_CHAT_BASE_MS - 7 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(DEMO_CHAT_BASE_MS - 7 * 24 * 60 * 60 * 1000),
    lastMessageAt: new Date(DEMO_CHAT_BASE_MS - 7 * 24 * 60 * 60 * 1000),
  },
  {
    id: "demo-chat-4",
    userId: "demo-user-123",
    pagePath: "/tradebook",
    pageName: "Tradebook",
    pageIcon: "BookOpen",
    messages: [
      {
        role: "user" as const,
        content: "Show me my worst performing trade",
      },
      {
        role: "assistant" as const,
        content:
          "Your worst performing trade this month:\n\n**INFY**\n- Entry: Rs.1,520.25\n- Exit: Rs.1,485.00\n- Quantity: 75 shares\n- Loss: Rs.2,663.75 (-2.3%)\n\n**Analysis:**\nThis trade was closed prematurely during a temporary dip. The stock recovered shortly after. Consider:\n- Setting wider stop-losses for volatile stocks\n- Reviewing your exit strategy\n- Holding quality stocks longer during market corrections",
      },
    ],
    isArchived: true,
    createdAt: new Date(DEMO_CHAT_BASE_MS - 10 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(DEMO_CHAT_BASE_MS - 8 * 24 * 60 * 60 * 1000),
    lastMessageAt: new Date(DEMO_CHAT_BASE_MS - 8 * 24 * 60 * 60 * 1000),
  },
];

// ---------------------------------------------------------------------------
// 9. Tax Result
// ---------------------------------------------------------------------------

export const demoTaxResult = {
  capitalGains: {
    fy: "2025-26",
    equity: {
      stcg: { gains: 45000, losses: 12000, net: 33000, tax: 6600 },
      ltcg: {
        gains: 280000,
        losses: 15000,
        net: 265000,
        exemption: 125000,
        taxable: 140000,
        tax: 17500,
      },
    },
    fno: {
      profits: 0,
      losses: 0,
      net: 0,
      note: "No F&O trades in this period",
    },
    totalTax: 24100,
    effectiveRate: 0.0809,
    trades: [] as Array<{
      symbol: string;
      buyDate: string;
      sellDate: string;
      holdingDays: number;
      buyValue: number;
      sellValue: number;
      gain: number;
      type: "STCG" | "LTCG" | "F&O";
    }>,
  },
  harvesting: {
    opportunities: [] as Array<{
      symbol: string;
      currentValue: number;
      costBasis: number;
      unrealizedLoss: number;
      potentialTaxSaving: number;
      holdingDays: number;
      type: "STCG" | "LTCG";
    }>,
    totalPotentialSaving: 0,
    gaarWarning:
      "Tax loss harvesting must be done with genuine intent. Maintain a minimum 30-day gap before repurchasing.",
  },
  advanceTax: {
    totalEstimatedTax: 24100,
    isApplicable: true,
    installments: [
      {
        quarter: "Q1 (Jun 15)",
        dueDate: "06-15",
        cumulativePercent: 15,
        amount: 3615,
      },
      {
        quarter: "Q2 (Sep 15)",
        dueDate: "09-15",
        cumulativePercent: 45,
        amount: 10845,
      },
      {
        quarter: "Q3 (Dec 15)",
        dueDate: "12-15",
        cumulativePercent: 75,
        amount: 18075,
      },
      {
        quarter: "Q4 (Mar 15)",
        dueDate: "03-15",
        cumulativePercent: 100,
        amount: 24100,
      },
    ],
    interestU234C: 0,
  },
  itrSchedule: {
    scheduleCG: {
      s111A: {
        description: "Short Term Capital Gains (Section 111A)",
        stcgGains: 33000,
        stcgTax: 6600,
      },
      s112A: {
        description: "Long Term Capital Gains (Section 112A)",
        ltcgGains: 265000,
        exemption: 125000,
        taxable: 140000,
        ltcgTax: 17500,
      },
    },
    csvData: "",
    summary: "FY 2025-26: Total tax liability Rs.24,100",
  },
};

// ---------------------------------------------------------------------------
// 10. Risk Result
// ---------------------------------------------------------------------------

export const demoRiskResult = {
  concentration: {
    hhi: 1850,
    level: "moderate" as const,
    topHoldings: [
      { symbol: "RELIANCE", weight: 0.25, value: 500000 },
      { symbol: "TCS", weight: 0.2, value: 400000 },
      { symbol: "HDFCBANK", weight: 0.15, value: 300000 },
      { symbol: "INFY", weight: 0.12, value: 240000 },
      { symbol: "ICICIBANK", weight: 0.1, value: 200000 },
    ],
    sectorWeights: [
      { sector: "Oil & Gas", weight: 0.25, count: 1 },
      { sector: "IT", weight: 0.32, count: 2 },
      { sector: "Banking", weight: 0.25, count: 2 },
      { sector: "Others", weight: 0.18, count: 3 },
    ],
    warnings: ["RELIANCE is 25.0% of portfolio (>20%)"],
  },
  correlation: {
    matrix: [
      [1.0, 0.35, 0.42, 0.38, 0.45],
      [0.35, 1.0, 0.28, 0.82, 0.31],
      [0.42, 0.28, 1.0, 0.25, 0.78],
      [0.38, 0.82, 0.25, 1.0, 0.29],
      [0.45, 0.31, 0.78, 0.29, 1.0],
    ],
    symbols: ["RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK"],
    avgCorrelation: 0.42,
    diversificationScore: 58,
    highCorrelationPairs: [
      { symbol1: "TCS", symbol2: "INFY", correlation: 0.82 },
      { symbol1: "HDFCBANK", symbol2: "ICICIBANK", correlation: 0.78 },
    ],
  },
  var: {
    historical: { var95: 0.028, var99: 0.042, cvar95: 0.035 },
    parametric: { var95: 0.025, var99: 0.038, mean: 0.0007, stdDev: 0.015 },
    portfolioValue: 1000000,
    var95Amount: 28000,
    period: "1-day",
  },
  drawdown: {
    maxDrawdown: -0.12,
    maxDrawdownStart: "2024-09-15",
    maxDrawdownEnd: "2024-10-28",
    recoveryDays: 45,
    currentDrawdown: -0.03,
    underwaterPeriods: [
      {
        start: "2024-09-15",
        end: "2024-11-30",
        depth: -0.12,
        durationDays: 76,
      },
    ],
  },
  riskAdjustedReturns: {
    annualizedReturn: 0.185,
    annualizedVolatility: 0.148,
    sharpeRatio: 1.45,
    sortinoRatio: 1.82,
    calmarRatio: 1.54,
    riskFreeRate: 0.065,
    maxDrawdown: -0.12,
    downsideDeviation: 0.098,
  },
  rebalancing: {
    holdings: [
      {
        symbol: "RELIANCE",
        currentWeight: 0.25,
        targetWeight: 0.2,
        drift: 0.05,
        action: "sell" as const,
        amount: 100000,
      },
      {
        symbol: "TCS",
        currentWeight: 0.2,
        targetWeight: 0.2,
        drift: 0.0,
        action: "hold" as const,
        amount: 0,
      },
    ],
    totalDrift: 0.15,
    needsRebalancing: true,
    driftThreshold: 0.05,
  },
  // MONEY-407 - demo beta result so /risk strip shows "Portfolio beta"
  // for demo sessions. Numbers reflect a balanced large-cap portfolio.
  beta: {
    beta: 0.92,
    correlation: 0.86,
    observations: 248,
    portfolioVol: 0.182,
    benchmarkVol: 0.198,
  },
  // MONEY-192 - stress test scenarios applied to the demo portfolio mix.
  // Numbers reflect a ₹20L portfolio with banking + IT concentration so
  // the crash scenario hits hardest and INR-dep / rate-cut help marginally.
  stressTest: {
    portfolioValue: 2_000_000,
    computedAt: new Date().toISOString(),
    scenarios: [
      {
        id: "gfc-2008",
        label: "2008 GFC",
        description: "Global financial crisis. SENSEX −58% Jan-Oct 2008.",
        iconKey: "gfc" as const,
        date: "Sep 2008",
        duration: "6mo path",
        narrative:
          "Nifty −38%. Banking −47%. Your sector tilt amplifies. Recovery: 14mo.",
        inrDelta: -468_000,
        pct: -23.4,
        tone: "neg" as const,
      },
      {
        id: "covid-2020",
        label: "COVID crash",
        description: "Pandemic-induced lockdown selloff Feb-Mar 2020.",
        iconKey: "covid" as const,
        date: "Mar 2020",
        duration: "21 trading days",
        narrative:
          "Nifty −33% in 6 weeks. IT shielded, banking down 42%. 5mo recovery.",
        inrDelta: -384_000,
        pct: -19.2,
        tone: "neg" as const,
      },
      {
        id: "election-2024",
        label: "2024 election",
        description: "Verdict-day selloff on coalition uncertainty.",
        iconKey: "election" as const,
        date: "Jun 4",
        duration: "1-day shock",
        narrative:
          "Verdict-day sell-off. PSU −18%, banks −7%. Your defensives clipped it.",
        inrDelta: -162_000,
        pct: -8.1,
        tone: "neg" as const,
      },
      {
        id: "rate-hike-100",
        label: "Rate hike +100bp",
        description: "Hypothetical · RBI hawkish surprise.",
        iconKey: "rate" as const,
        date: "Hypothetical",
        duration: "RBI",
        narrative:
          "Rate-sensitive financials drag. Your IT + FMCG buffer holds.",
        inrDelta: -108_000,
        pct: -5.4,
        tone: "neg" as const,
      },
      {
        id: "inr-depreciation-5",
        label: "INR −5%",
        description: "Hypothetical · USD/INR. Weak rupee benefits exporters.",
        iconKey: "fx" as const,
        date: "Hypothetical",
        duration: "USD/INR",
        narrative: "Net export beneficiary. IT services and pharma re-rate up.",
        inrDelta: 42_000,
        pct: 2.1,
        tone: "pos" as const,
      },
      {
        id: "it-shock-20",
        label: "IT sector −20%",
        description: "Sector-specific stress on technology cluster.",
        iconKey: "sector" as const,
        date: "Sector-specific",
        duration: "stress",
        narrative:
          "Your IT weight takes the brunt. Banking + energy hedge partial.",
        inrDelta: -96_000,
        pct: -4.8,
        tone: "neg" as const,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// 11. Broker Connections (NEW)
// ---------------------------------------------------------------------------

export const demoBrokerConnections = [
  {
    id: "broker-1",
    userId: "demo",
    broker: "ZERODHA",
    brokerName: "zerodha",
    brokerDisplayName: "Zerodha",
    brokerUserId: "AB1234",
    status: "CONNECTED" as const,
    lastSyncedAt: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago
    holdingsCount: 3, // RELIANCE, INFY, TATAMOTORS
    positionsCount: 0,
    tradesCount: 4, // demo-1, demo-3, demo-5, demo-7
    mfCount: 1, // PPFAS
    createdAt: new Date("2024-01-10"),
    updatedAt: new Date(),
  },
  {
    id: "broker-2",
    userId: "demo",
    broker: "GROWW",
    brokerName: "groww",
    brokerDisplayName: "Groww",
    brokerUserId: "GR5678",
    status: "CONNECTED" as const,
    lastSyncedAt: new Date(Date.now() - 45 * 60 * 1000), // 45 min ago
    holdingsCount: 2, // TCS, ICICIBANK
    positionsCount: 1, // ICICIBANK short
    tradesCount: 2, // demo-2, demo-6
    mfCount: 2, // HDFC Flexi Cap, ICICI Pru Bluechip
    createdAt: new Date("2024-02-05"),
    updatedAt: new Date(),
  },
  {
    id: "broker-3",
    userId: "demo",
    broker: "DHAN",
    brokerName: "dhan",
    brokerDisplayName: "Dhan",
    brokerUserId: "DH9012",
    status: "CONNECTED" as const,
    lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
    holdingsCount: 1, // HDFCBANK
    positionsCount: 1, // HDFCBANK long
    tradesCount: 1, // demo-4
    mfCount: 0,
    createdAt: new Date("2024-04-15"),
    updatedAt: new Date(),
  },
];

// ---------------------------------------------------------------------------
// 12. Watchlists (NEW)
// ---------------------------------------------------------------------------

export const demoWatchlists = [
  {
    id: "watchlist-1",
    userId: "demo",
    name: "Bluechips",
    description: "Top large-cap stocks to track",
    color: null,
    icon: null,
    type: "STOCK",
    isDefault: true,
    order: 0,
    itemCount: 3,
    items: [
      {
        id: "wl-item-1",
        symbol: "RELIANCE",
        exchange: "NSE",
        instrumentId: null,
        sortOrder: 0,
        addedAt: new Date("2024-01-15"),
      },
      {
        id: "wl-item-2",
        symbol: "TCS",
        exchange: "NSE",
        instrumentId: null,
        sortOrder: 1,
        addedAt: new Date("2024-02-10"),
      },
      {
        id: "wl-item-3",
        symbol: "HDFCBANK",
        exchange: "NSE",
        instrumentId: null,
        sortOrder: 2,
        addedAt: new Date("2024-03-01"),
      },
    ],
    createdAt: new Date("2024-01-15"),
    updatedAt: new Date(),
  },
  {
    id: "watchlist-2",
    userId: "demo",
    name: "Growth Picks",
    description: "High-growth potential stocks",
    color: null,
    icon: null,
    type: "STOCK",
    isDefault: false,
    order: 1,
    itemCount: 3,
    items: [
      {
        id: "wl-item-4",
        symbol: "TRENT",
        exchange: "NSE",
        instrumentId: null,
        sortOrder: 0,
        addedAt: new Date("2024-05-12"),
      },
      {
        id: "wl-item-5",
        symbol: "INFY",
        exchange: "NSE",
        instrumentId: null,
        sortOrder: 1,
        addedAt: new Date("2024-03-05"),
      },
      {
        id: "wl-item-6",
        symbol: "ICICIBANK",
        exchange: "NSE",
        instrumentId: null,
        sortOrder: 2,
        addedAt: new Date("2024-06-08"),
      },
    ],
    createdAt: new Date("2024-05-12"),
    updatedAt: new Date(),
  },
];

// ---------------------------------------------------------------------------
// 13. Settings (NEW)
// ---------------------------------------------------------------------------

export const demoSettings = {
  user: {
    id: "demo",
    name: "Demo User",
    email: "demo@usemoney.ai",
    imageUrl: "",
    phone: null,
    createdAt: new Date("2024-01-01"),
  },
  subscription: {
    plan: "PRO" as const,
    status: "ACTIVE" as const,
    currentPeriodStart: new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      1
    ),
    currentPeriodEnd: new Date(
      new Date().getFullYear(),
      new Date().getMonth() + 1,
      0
    ),
    cancelAtPeriodEnd: false,
  },
  preferences: {
    defaultBroker: "ZERODHA",
    currency: "INR",
    theme: "system" as const,
    notifications: {
      email: true,
      push: false,
      tradeAlerts: true,
      priceAlerts: false,
      weeklyDigest: true,
    },
  },
  paymentHistory: [] as Array<Record<string, unknown>>,
  connectedBrokers: 3,
};

// ---------------------------------------------------------------------------
// 14. Documents (NEW)
// ---------------------------------------------------------------------------

export const demoDocuments = [
  {
    id: "doc-1",
    userId: "demo",
    name: "Zerodha Contract Note - Dec 2024",
    type: "BROKER_STATEMENT" as const,
    fileType: "pdf",
    fileSize: 245000,
    broker: "ZERODHA",
    period: "December 2024",
    uploadedAt: new Date("2024-12-20"),
    status: "PROCESSED" as const,
    summary:
      "Contract note covering 5 trades executed between Dec 10-19, 2024. Total turnover: Rs.15,31,856.25. Net realized P&L: Rs.13,414.75.",
  },
  {
    id: "doc-2",
    userId: "demo",
    name: "Tax Computation Report FY 2024-25",
    type: "TAX_REPORT" as const,
    fileType: "pdf",
    fileSize: 180000,
    broker: null,
    period: "FY 2024-25",
    uploadedAt: new Date("2025-01-05"),
    status: "PROCESSED" as const,
    summary:
      "Capital gains tax computation for FY 2024-25. STCG: Rs.33,000, LTCG: Rs.1,40,000 (taxable after exemption). Total estimated tax: Rs.24,100.",
  },
  {
    id: "doc-3",
    userId: "demo",
    name: "CAMS MF Statement - Dec 2024",
    type: "CAMS_STATEMENT" as const,
    fileType: "pdf",
    fileSize: 312000,
    broker: null,
    period: "December 2024",
    uploadedAt: new Date("2024-12-28"),
    status: "PROCESSED" as const,
    summary:
      "Consolidated Account Statement covering 3 mutual fund folios across HDFC AMC, ICICI AMC, and PPFAS AMC. Total current value: Rs.2,29,138.78. Overall gain: Rs.32,354.80.",
  },
];

// ---------------------------------------------------------------------------
// 15. Courses (NEW)
// ---------------------------------------------------------------------------

export const demoCourses = [
  {
    id: "course-1",
    slug: "stock-market-basics",
    title: "Stock Market Basics",
    description:
      "Learn the fundamentals of stock market investing - from understanding how exchanges work to reading stock quotes and placing your first trade.",
    level: "BEGINNER",
    duration: "4h 30m",
    topics: ["Exchanges", "Stock Quotes", "Order Types", "Portfolio Basics"],
    lessonCount: 12,
    enrollmentCount: 1250,
    image: null,
  },
  {
    id: "course-2",
    slug: "technical-analysis-masterclass",
    title: "Technical Analysis Masterclass",
    description:
      "Master chart patterns, candlestick formations, support/resistance levels, and popular indicators like RSI, MACD, and Bollinger Bands.",
    level: "INTERMEDIATE",
    duration: "8h 15m",
    topics: [
      "Chart Patterns",
      "Candlesticks",
      "RSI & MACD",
      "Bollinger Bands",
      "Support/Resistance",
    ],
    lessonCount: 24,
    enrollmentCount: 840,
    image: null,
  },
  {
    id: "course-3",
    slug: "options-fundamentals",
    title: "Options Fundamentals",
    description:
      "Understand options trading from scratch - calls, puts, Greeks, payoff diagrams, and basic strategies like covered calls and protective puts.",
    level: "INTERMEDIATE",
    duration: "6h 45m",
    topics: [
      "Calls & Puts",
      "Options Greeks",
      "Payoff Diagrams",
      "Covered Calls",
    ],
    lessonCount: 18,
    enrollmentCount: 620,
    image: null,
  },
  {
    id: "course-4",
    slug: "mutual-fund-investing",
    title: "Mutual Fund Investing Guide",
    description:
      "Everything you need to know about mutual funds - types, SIP vs lumpsum, expense ratios, NAV calculation, and building a diversified MF portfolio.",
    level: "BEGINNER",
    duration: "3h 20m",
    topics: ["Fund Types", "SIP vs Lumpsum", "Expense Ratios", "NAV"],
    lessonCount: 10,
    enrollmentCount: 1580,
    image: null,
  },
];

// ---------------------------------------------------------------------------
// 16. Tutor Messages (NEW)
// ---------------------------------------------------------------------------

export const demoTutorMessages = [
  {
    question: "What is a P/E ratio and how do I use it?",
    answer:
      "The **Price-to-Earnings (P/E) ratio** is one of the most widely used valuation metrics.\n\n**Formula:** P/E = Current Market Price / Earnings Per Share (EPS)\n\n**Example with RELIANCE:**\n- Current Price: Rs.2,520\n- EPS (TTM): Rs.105\n- P/E = 2520 / 105 = 24x\n\n**How to interpret:**\n- **Low P/E (< 15):** Stock may be undervalued or facing challenges\n- **Moderate P/E (15-25):** Fair valuation for large-caps\n- **High P/E (> 25):** Growth expectations priced in, or overvalued\n\n**Important:** Always compare P/E within the same sector. IT companies typically trade at higher P/E than banking stocks.\n\n**Your Portfolio Context:**\nYour HDFCBANK (P/E ~18x) trades at a discount to ICICIBANK (P/E ~22x), which could indicate relative value.",
  },
  {
    question: "How does SIP work in mutual funds?",
    answer:
      "**SIP (Systematic Investment Plan)** is a method of investing a fixed amount in mutual funds at regular intervals.\n\n**How it works:**\n1. You choose a fixed amount (e.g., Rs.5,000/month)\n2. On a set date each month, that amount auto-debits from your bank\n3. Units are purchased at the current NAV\n4. More units when NAV is low, fewer when high\n\n**Benefits of SIP:**\n- **Rupee Cost Averaging:** Reduces impact of market volatility\n- **Discipline:** Automates investing habit\n- **No timing needed:** Works well across market cycles\n- **Power of compounding:** Small amounts grow significantly over time\n\n**Your Portfolio Example:**\nYour HDFC Flexi Cap SIP of Rs.5,000/month has accumulated 1,250.45 units at an average NAV of Rs.85.50 vs current NAV of Rs.98.75 - that is a 15.5% XIRR!",
  },
  {
    question: "What is the difference between STCG and LTCG tax?",
    answer:
      "In India, capital gains tax depends on how long you held the asset:\n\n**For Equity & Equity MFs:**\n| Type | Holding Period | Tax Rate | Exemption |\n|------|---------------|----------|----------|\n| STCG | < 12 months | 20% (Sec 111A) | None |\n| LTCG | >= 12 months | 12.5% (Sec 112A) | Rs.1.25L/year |\n\n**Key Points:**\n- STT (Securities Transaction Tax) must be paid for these rates to apply\n- LTCG up to Rs.1,25,000 per year is completely tax-free\n- Losses can be set off: STCG losses against both STCG and LTCG; LTCG losses only against LTCG\n- Unabsorbed losses carry forward for 8 assessment years\n\n**Your Tax Situation:**\nBased on your trades, you have Rs.33,000 in STCG (tax: Rs.6,600) and Rs.2,65,000 in LTCG. After the Rs.1,25,000 exemption, your taxable LTCG is Rs.1,40,000 (tax: Rs.17,500). Total estimated tax: Rs.24,100.",
  },
  {
    question: "How do stop-loss orders protect my portfolio?",
    answer:
      "A **stop-loss order** automatically sells your stock when it falls to a predetermined price, limiting your downside risk.\n\n**Types of Stop-Loss:**\n\n1. **Regular Stop-Loss (SL):**\n   - Triggers a limit order at your specified price\n   - Example: Buy TATAMOTORS at Rs.785, SL at Rs.750\n   - If price hits Rs.750, a sell order is placed at Rs.750\n\n2. **Stop-Loss Market (SL-M):**\n   - Triggers a market order at trigger price\n   - Guaranteed execution but price may slip\n   - Better for volatile stocks\n\n**Best Practices:**\n- Set SL at 5-8% below entry for swing trades\n- Use ATR (Average True Range) for dynamic SL\n- Never move SL further from entry (common mistake)\n- Trail your SL upward as stock moves in your favor\n\n**Portfolio Tip:**\nYour INFY trade lost Rs.2,663.75 (-2.3%). A stop-loss at Rs.1,490 would have limited loss to Rs.2,268.75. Always set a stop-loss before entering a trade!",
  },
];

// ---------------------------------------------------------------------------
// 17. Roast History (NEW)
// ---------------------------------------------------------------------------

export const demoRoastHistory = [
  {
    id: "demo-roast-1",
    sessionId: "demo-roast-1",
    userId: "demo",
    mode: "broker",
    broker: "ZERODHA",
    assetType: "stocks",
    status: "COMPLETED" as const,
    score: 72,
    overallScore: 72,
    title: "Portfolio Health Check",
    summary:
      "Your portfolio shows decent fundamentals but needs work on diversification and risk management. The heavy IT sector tilt and concentrated positions in RELIANCE could hurt you in a sector downturn.",
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
  },
];

// ---------------------------------------------------------------------------
// 18. Roast Detail (NEW)
// ---------------------------------------------------------------------------

export const demoRoastDetail = {
  id: "demo-roast-1",
  sessionId: "demo-roast-1",
  mode: "broker",
  broker: "ZERODHA",
  assetType: "stocks",
  status: "COMPLETED" as const,
  score: 72,
  createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
  completedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
  result: {
    overallScore: 72,
    scoreBreakdown: {
      diversification: {
        score: 65,
        comment:
          "6 stocks across 2 main sectors (IT 32%, Banking 25%). Consider adding FMCG, Pharma, or Infrastructure.",
      },
      riskManagement: {
        score: 70,
        comment:
          "RELIANCE at 25% is a chunky bet. Your INFY trade lost Rs.2,664 without a stop-loss. Needs more discipline.",
      },
      stockPicking: {
        score: 78,
        comment:
          "80% win rate across 7 trades is solid. Strong picks in RELIANCE and TCS. PPFAS Flexi Cap at 18.2% XIRR is impressive.",
      },
      timing: {
        score: 75,
        comment:
          "Good momentum reads on NIFTY futures (+Rs.9,980). But sitting on unrealized gains without booking is risky.",
      },
    },
    roastHighlights: [
      {
        type: "burn" as const,
        emoji: "\uD83D\uDD25",
        title: "The RELIANCE Obsession",
        description:
          "25% in one stock? What is this, a fan club? Diversification called - it wants its portfolio back.",
      },
      {
        type: "burn" as const,
        emoji: "\uD83D\uDC80",
        title: "Stop-Loss? Never Heard of Her",
        description:
          "Your INFY trade lost Rs.2,664 because apparently stop-losses are for other people.",
      },
      {
        type: "praise" as const,
        emoji: "\uD83C\uDFC6",
        title: "NIFTY Futures Master",
        description:
          "That +Rs.9,980 on NIFTY25JAN futures shows you can read momentum. Not bad at all.",
      },
      {
        type: "praise" as const,
        emoji: "\uD83E\uDDE0",
        title: "MF Game Strong",
        description:
          "Direct growth plans, 18.2% XIRR on PPFAS Flexi Cap. Your mutual fund strategy is actually solid.",
      },
    ],
    topPerformers: [
      {
        symbol: "RELIANCE",
        pnlPercent: 14.0,
        roast:
          "Your golden goose. Don't put all your eggs in one basket though.",
      },
      {
        symbol: "TCS",
        pnlPercent: 1.8,
        roast: "Steady Eddie. IT sector doing its thing.",
      },
      {
        symbol: "NIFTY FUT",
        pnlPercent: 8.3,
        roast:
          "Nice futures play. You actually know what you're doing sometimes.",
      },
    ],
    worstPerformers: [
      {
        symbol: "INFY",
        pnlPercent: -2.3,
        roast: "Sold at the bottom. Classic retail move.",
      },
      {
        symbol: "ICICIBANK",
        pnlPercent: -0.8,
        roast: "Shorting a bank without a thesis is gambling, not trading.",
      },
    ],
    sectorAnalysis: [
      {
        sector: "IT",
        percentage: 32,
        verdict: "overweight" as const,
        comment:
          "TCS + INFY dominating. One bad earnings and you'll feel the pain.",
      },
      {
        sector: "Banking",
        percentage: 25,
        verdict: "overweight" as const,
        comment: "HDFCBANK + ICICIBANK. Rate-sensitive and correlated.",
      },
      {
        sector: "Oil & Gas",
        percentage: 25,
        verdict: "overweight" as const,
        comment: "RELIANCE alone. Single-stock concentration risk.",
      },
      {
        sector: "Auto",
        percentage: 8,
        verdict: "underweight" as const,
        comment: "Only TATAMOTORS. Could use more auto exposure.",
      },
      {
        sector: "Others",
        percentage: 10,
        verdict: "fair" as const,
        comment: "MFs provide some additional diversification.",
      },
    ],
    constructiveAdvice: [
      {
        title: "Set Stop-Losses on Every Trade",
        description:
          "Your INFY loss was avoidable. Set a 5-8% stop-loss before entering any trade. Use trailing stops to protect profits.",
      },
      {
        title: "Diversify Beyond IT and Banking",
        description:
          "57% in two sectors is risky. Add exposure to FMCG (HUL, ITC), Pharma (Sun Pharma), or Infrastructure (L&T).",
      },
      {
        title: "Book Partial Profits",
        description:
          "Your unrealized gains (Rs.54,882) dwarf realized gains (Rs.15,156). Consider booking 50% profits on big winners.",
      },
    ],
    roastNarrative:
      "Let's be real - your portfolio is like a Bollywood movie: heavy on drama, light on plot. You've got the right leading actors (RELIANCE, TCS, HDFCBANK) but the script needs work. The 25% RELIANCE concentration is giving 'all-in at the casino' vibes, and your IT sector tilt means one Infosys guidance cut could wipe out months of gains.\n\nBut here's the thing - you're actually not terrible. An 80% win rate? That's better than most mutual fund managers. Your NIFTY futures play was chef's kiss, and your MF choices show you've done your homework. PPFAS Flexi Cap at 18.2% XIRR? You clearly read someone's good advice.\n\nThe biggest issue? You don't know when to say goodbye. Sitting on Rs.54K in unrealized gains while only booking Rs.15K in profits is the trading equivalent of not closing the deal. And that INFY trade without a stop-loss? We've all been there, but let's not make it a habit.\n\nBottom line: You've got potential. Now stop treating your portfolio like a Nifty 50 index fund and actually diversify. Your future self will thank you.",
    disclaimer:
      "This roast is for entertainment and educational purposes only. It is not financial advice. Always consult a SEBI-registered financial advisor before making investment decisions.",
  } as import("@usemoney/types").StructuredRoastResult,
};

// ---------------------------------------------------------------------------
// 19. Research History (NEW)
// ---------------------------------------------------------------------------

export const demoResearchHistory = [
  {
    sessionId: "demo-research-1",
    query: "Analyze RELIANCE",
    status: "COMPLETED" as const,
    symbols: ["RELIANCE.NS"],
    qualityScore: 85,
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    report: {
      score: 78,
      recommendation: "BUY",
      content:
        "Reliance Industries remains a strong conglomerate play with leadership in refining, telecom (Jio), and retail.",
    },
  },
  {
    sessionId: "demo-research-2",
    query: "Analyze HDFCBANK",
    status: "COMPLETED" as const,
    symbols: ["HDFCBANK.NS"],
    qualityScore: 82,
    createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    report: {
      score: 82,
      recommendation: "BUY",
      content:
        "HDFC Bank continues to be the gold standard in Indian private banking. Post-merger integration is progressing well.",
    },
  },
];

// ---------------------------------------------------------------------------
// 20. Research Detail (NEW)
// ---------------------------------------------------------------------------

export const demoResearchDetail = {
  sessionId: "demo-research-1",
  report: {
    score: 78,
    recommendation: "BUY",
    confidence: 82,
    summary:
      "Reliance Industries Limited (NSE: RELIANCE) is India's largest private sector company by market capitalization, operating across energy, petrochemicals, telecommunications, retail, and digital services. Strong diversification across O2C, Jio, and Retail segments provides resilience, while new energy investments position it for long-term growth.",
    keyMetrics: [
      { label: "Revenue", value: "₹9,74,850 Cr", verdict: "Strong" },
      { label: "EBITDA Margin", value: "18.3%", verdict: "Healthy" },
      { label: "PAT Growth", value: "+12.5% YoY", verdict: "Positive" },
      { label: "P/E Ratio", value: "24x", verdict: "Fair (5Y avg: 28x)" },
      { label: "EV/EBITDA", value: "14.2x", verdict: "Reasonable" },
      { label: "ROE", value: "9.8%", verdict: "Moderate" },
    ],
    strengths: [
      "World's largest refining complex at Jamnagar with unmatched scale advantages",
      "Jio Platforms: India's #1 telecom operator with 470M+ subscribers and rising ARPU",
      "Reliance Retail: India's largest organized retailer with 18,000+ stores",
      "Strong balance sheet with ₹2.6L Cr cash and equivalents",
      "₹75,000 Cr planned investment in solar, hydrogen, and batteries positions it for energy transition",
    ],
    risks: [
      "O2C margin pressure from global energy transition and refining overcapacity",
      "Jio ARPU growth may slow as subscriber additions plateau",
      "Retail faces rising competition from quick-commerce players (Blinkit, Zepto)",
      "New energy execution risk - technology and timeline uncertainties",
      "Conglomerate discount may persist due to complex business structure",
    ],
    priceTarget: {
      current: 2520.75,
      low: 2380,
      mid: 2750,
      high: 3100,
      method: "DCF + Relative valuation",
    },
    catalysts: [
      { event: "Jio Platforms IPO", timeline: "FY26-27", impact: "High" },
      {
        event: "New Energy giga-factory commissioning",
        timeline: "H2 FY26",
        impact: "Medium",
      },
      {
        event: "Retail store expansion (25,000+ target)",
        timeline: "FY26",
        impact: "Medium",
      },
      {
        event: "5G monetization via enterprise solutions",
        timeline: "Ongoing",
        impact: "Medium",
      },
    ],
    technicals: {
      trend: "Bullish",
      support: 2450,
      resistance: 2650,
      rsi: 58.3,
    },
    sections: [
      {
        title: "Business Overview",
        type: "text",
        content:
          "Reliance Industries has transformed from an oil & gas major into a diversified conglomerate spanning digital services, organized retail, and new energy. The O2C segment contributes ~55% of revenue, Jio Platforms ~20%, and Reliance Retail ~25%. The company has been aggressively investing in future-ready businesses including solar manufacturing, green hydrogen, and battery technology.",
      },
      {
        title: "Financial Analysis",
        type: "metrics",
        content:
          "Reliance reported consolidated revenue of ₹9,74,850 Cr in FY24, up 8.2% YoY. EBITDA stood at ₹1,78,500 Cr with an 18.3% margin. Net profit grew 12.5% to ₹79,200 Cr. The balance sheet remains strong with net debt/EBITDA at 0.6x.",
        metrics: [
          {
            label: "Revenue",
            value: "₹9,74,850 Cr",
            trend: "up",
            verdict: "Strong growth",
          },
          {
            label: "EBITDA",
            value: "₹1,78,500 Cr",
            trend: "up",
            verdict: "Healthy margins",
          },
          {
            label: "Net Profit",
            value: "₹79,200 Cr",
            trend: "up",
            verdict: "+12.5% YoY",
          },
          {
            label: "Debt/EBITDA",
            value: "0.6x",
            trend: "stable",
            verdict: "Conservative",
          },
        ],
      },
      {
        title: "Valuation",
        type: "valuation",
        content:
          "At CMP of ₹2,520.75, Reliance trades at 24x P/E (below 5Y average of 28x) and 14.2x EV/EBITDA. Sum-of-the-parts valuation suggests upside potential, especially if Jio Platforms is separately listed.",
        dcf: {
          intrinsicValue: 2850,
          currentPrice: 2520.75,
          upside: 13.1,
        },
      },
    ],
    disclaimer:
      "This is a demo analysis for illustration purposes only. Not actual investment advice. Always consult a SEBI-registered advisor before making investment decisions.",
  },
  contentBlocks: [],
  qualityScore: 85,
  tokensUsed: 12500,
  symbols: ["RELIANCE.NS"],
};

export const demoResearchDetail2 = {
  sessionId: "demo-research-2",
  report: {
    score: 82,
    recommendation: "BUY",
    confidence: 85,
    summary:
      "HDFC Bank is India's largest private sector bank with a strong deposit franchise, best-in-class asset quality, and consistent earnings growth. Post-merger with HDFC Ltd, the bank has the scale and product breadth to sustain 15-18% earnings growth over the medium term.",
    keyMetrics: [
      {
        label: "Net Interest Income",
        value: "₹1,09,800 Cr",
        verdict: "Industry-leading",
      },
      { label: "NIM", value: "3.6%", verdict: "Stable" },
      { label: "GNPA", value: "1.24%", verdict: "Best-in-class" },
      { label: "ROE", value: "17.2%", verdict: "Strong" },
      { label: "P/B Ratio", value: "2.8x", verdict: "Premium justified" },
      { label: "CASA Ratio", value: "38.5%", verdict: "Healthy" },
    ],
    strengths: [
      "Largest private sector bank with ₹24L Cr+ total assets post-HDFC merger",
      "Best-in-class asset quality - GNPA at 1.24% vs industry average of 3.2%",
      "Strong digital banking platform with 9Cr+ mobile banking users",
      "Diversified loan book across retail (52%), corporate (28%), and commercial (20%)",
      "Consistent dividend payer with 20%+ payout ratio",
    ],
    risks: [
      "Post-merger integration - elevated CRR/SLR drag on NIMs in near term",
      "Retail loan growth facing competition from fintechs and small finance banks",
      "Regulatory tightening on unsecured lending may impact personal loan growth",
      "Technology disruption from UPI and BNPL reducing traditional banking revenue",
    ],
    priceTarget: {
      current: 1685.5,
      low: 1550,
      mid: 1900,
      high: 2100,
      method: "Gordon Growth Model + Relative P/B",
    },
    catalysts: [
      {
        event: "HDFC merger synergy realization",
        timeline: "FY25-26",
        impact: "High",
      },
      {
        event: "NIM normalization post CRR unwind",
        timeline: "H2 FY26",
        impact: "High",
      },
      {
        event: "Branch expansion in Tier 3-4 cities",
        timeline: "Ongoing",
        impact: "Medium",
      },
    ],
    technicals: {
      trend: "Bullish",
      support: 1620,
      resistance: 1750,
      rsi: 62.1,
    },
    sections: [
      {
        title: "Business Overview",
        type: "text",
        content:
          "HDFC Bank is India's largest private sector bank by assets, formed from the 2023 merger of HDFC Bank and HDFC Ltd. The bank operates 8,000+ branches across India with a diversified loan book spanning retail mortgages, corporate lending, commercial banking, and rural finance. Its digital platform serves 9Cr+ mobile banking users.",
      },
      {
        title: "Financial Analysis",
        type: "metrics",
        content:
          "HDFC Bank reported NII of ₹1,09,800 Cr in FY24, with a NIM of 3.6%. Gross NPA remains best-in-class at 1.24%. Return on equity stands at 17.2%, and the bank has consistently delivered 15-20% earnings growth over the past decade.",
        metrics: [
          {
            label: "NII",
            value: "₹1,09,800 Cr",
            trend: "up",
            verdict: "Industry-leading",
          },
          {
            label: "NIM",
            value: "3.6%",
            trend: "stable",
            verdict: "Stable post-merger",
          },
          {
            label: "GNPA",
            value: "1.24%",
            trend: "down",
            verdict: "Best-in-class",
          },
          {
            label: "ROE",
            value: "17.2%",
            trend: "up",
            verdict: "Strong profitability",
          },
        ],
      },
      {
        title: "Valuation",
        type: "valuation",
        content:
          "At CMP of ₹1,685.50, HDFC Bank trades at 2.8x P/B (premium to sector average of 2.0x). The premium is justified by superior asset quality and consistent earnings growth. Post-merger NIM normalization could re-rate the stock.",
        dcf: {
          intrinsicValue: 1950,
          currentPrice: 1685.5,
          upside: 15.7,
        },
      },
    ],
    disclaimer:
      "This is a demo analysis for illustration purposes only. Not actual investment advice.",
  },
  contentBlocks: [],
  qualityScore: 82,
  tokensUsed: 11800,
  symbols: ["HDFCBANK.NS"],
};

// ---------------------------------------------------------------------------
// 21. Paper Dashboard Stats (NEW)
// ---------------------------------------------------------------------------

export const demoPaperDashboardStats = {
  portfolio: {
    id: "demo-paper-portfolio",
    initialCapital: 1000000, // 10L virtual cash
    cash: 818750, // 10L - invested amount
  },
  positions: {
    open: 3,
    closed: 2,
    totalInvested: 181250,
    totalCurrentValue: 191599,
    totalPnl: 10349,
    totalPnlPercentage: 5.71,
    dayPnl: 300,
  },
  performance: {
    winRate: 100,
    totalTrades: 5,
    winners: 2,
    losers: 0,
    avgWin: 7500,
    avgLoss: 0,
    bestTrade: 12000,
    worstTrade: 3000,
  },
};

// ---------------------------------------------------------------------------
// 22. Compare Data (NEW)
// ---------------------------------------------------------------------------

export const demoCompareData = {
  funds: [
    {
      schemeCode: "MF001",
      schemeName: "HDFC Flexi Cap Fund - Direct Growth",
      amcName: "HDFC AMC",
      category: "Flexi Cap",
      nav: 98.75,
      aum: 62500, // in Cr
      expenseRatio: 0.77,
      returns: {
        "1m": 2.1,
        "3m": 5.8,
        "6m": 12.4,
        "1y": 18.5,
        "3y": 14.2,
        "5y": 16.8,
      },
      riskMetrics: {
        sharpeRatio: 1.25,
        standardDeviation: 14.8,
        beta: 0.95,
        alpha: 2.3,
      },
      holdings: {
        top5: [
          { name: "ICICI Bank", weight: 8.2 },
          { name: "HDFC Bank", weight: 7.5 },
          { name: "Reliance Industries", weight: 6.8 },
          { name: "Infosys", weight: 5.2 },
          { name: "Axis Bank", weight: 4.1 },
        ],
        equityPercent: 97.5,
        debtPercent: 0,
        cashPercent: 2.5,
      },
    },
    {
      schemeCode: "MF002",
      schemeName: "ICICI Pru Bluechip Fund - Direct Growth",
      amcName: "ICICI AMC",
      category: "Large Cap",
      nav: 82.45,
      aum: 55800, // in Cr
      expenseRatio: 0.87,
      returns: {
        "1m": 1.8,
        "3m": 4.9,
        "6m": 10.8,
        "1y": 15.2,
        "3y": 12.8,
        "5y": 15.1,
      },
      riskMetrics: {
        sharpeRatio: 1.12,
        standardDeviation: 13.2,
        beta: 0.88,
        alpha: 1.8,
      },
      holdings: {
        top5: [
          { name: "Reliance Industries", weight: 9.1 },
          { name: "HDFC Bank", weight: 8.8 },
          { name: "ICICI Bank", weight: 7.2 },
          { name: "Infosys", weight: 6.5 },
          { name: "TCS", weight: 5.8 },
        ],
        equityPercent: 98.2,
        debtPercent: 0,
        cashPercent: 1.8,
      },
    },
  ],
  navHistory: Array.from({ length: 365 }, (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() - (364 - i));
    const baseNavHDFC = 83.0 + i * 0.043 + Math.sin(i * 0.05) * 2.5;
    const baseNavICICI = 71.5 + i * 0.03 + Math.sin(i * 0.05 + 0.5) * 2.0;
    return {
      date: date.toISOString().split("T")[0] as string,
      navHDFC: Math.round(baseNavHDFC * 100) / 100,
      navICICI: Math.round(baseNavICICI * 100) / 100,
    };
  }),
};

// ---------------------------------------------------------------------------
// 23. Notifications (MONEY-392 - demo coverage for the bell icon)
// ---------------------------------------------------------------------------

export const demoNotifications = [
  {
    id: "notif-1",
    title: "RELIANCE crossed ₹2520",
    body: "Your holding hit a new 30-day high. Up 5.9% from your average price.",
    category: "price_alert" as const,
    read: false,
    createdAt: new Date(Date.now() - 1000 * 60 * 18).toISOString(),
    href: "/holdings",
  },
  {
    id: "notif-2",
    title: "Portfolio roast ready",
    body: "Your December roast is in. Score: 78/100 - see what to fix.",
    category: "roast" as const,
    read: false,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    href: "/roast",
  },
  {
    id: "notif-3",
    title: "INFY ex-dividend tomorrow",
    body: "₹18/share interim dividend. Hold by close today to qualify.",
    category: "corporate_action" as const,
    read: false,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
    href: "/stock/INFY",
  },
  {
    id: "notif-4",
    title: "Watchlist alert: TATAMOTORS",
    body: "Broke above your ₹780 trigger price.",
    category: "watchlist" as const,
    read: true,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    href: "/watchlist",
  },
  {
    id: "notif-5",
    title: "Tradebook sync complete",
    body: "Zerodha synced 12 new trades from the last 7 days.",
    category: "sync" as const,
    read: true,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 30).toISOString(),
    href: "/tradebook",
  },
  {
    id: "notif-6",
    title: "FIRE projection updated",
    body: "New SIP increase moves your FI date 7 months earlier.",
    category: "fire" as const,
    read: true,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 52).toISOString(),
    href: "/fire",
  },
];

export const demoUnreadNotificationCount = demoNotifications.filter(
  (n) => !n.read
).length;

// ---------------------------------------------------------------------------
// 24. Strategies (MONEY-392 - demo coverage for /strategies)
// ---------------------------------------------------------------------------

export const demoStrategies = [
  {
    id: "strat-1",
    name: "Nifty 50 Momentum",
    description:
      "Buys top-quartile 12-month momentum names from Nifty 50, rebalanced monthly.",
    type: "Momentum",
    risk: "Medium",
    timeframe: "Medium Term (Weeks)",
    rules: {
      entry: "12-month return > 75th percentile of Nifty 50 universe",
      exit: "Drops below 50th percentile OR 8% trailing stop",
      stopLoss: "8% trailing from peak",
    },
    overlays: ["RSI", "SMA200"],
    backtest: {
      cagr: 18.4,
      sharpe: 1.21,
      maxDrawdown: -14.8,
      winRate: 62,
      lastRunAt: new Date(Date.now() - 1000 * 60 * 60 * 36).toISOString(),
    },
    createdAt: new Date("2026-02-12").toISOString(),
  },
  {
    id: "strat-2",
    name: "Mean Reversion - Bank Nifty",
    description:
      "Buys oversold bank names (RSI < 30) and exits on RSI return to 55.",
    type: "MeanReversion",
    risk: "High",
    timeframe: "Short Term (Days)",
    rules: {
      entry: "RSI(14) < 30 AND price > SMA200",
      exit: "RSI(14) > 55 OR 5% stop loss",
      stopLoss: "5% from entry",
    },
    overlays: ["RSI", "SMA200"],
    backtest: {
      cagr: 14.2,
      sharpe: 0.95,
      maxDrawdown: -22.4,
      winRate: 58,
      lastRunAt: new Date(Date.now() - 1000 * 60 * 60 * 96).toISOString(),
    },
    createdAt: new Date("2026-03-04").toISOString(),
  },
  {
    id: "strat-3",
    name: "Quality Compounder",
    description:
      "Buy-and-hold ROE > 18 + Debt/Equity < 0.5 + 5y revenue growth > 12%.",
    type: "Trend",
    risk: "Low",
    timeframe: "Long Term (Months)",
    rules: {
      entry: "Quality screen passes + price > SMA200",
      exit: "Quality screen fails for 2 consecutive quarters",
      stopLoss: "20% drawdown from entry",
    },
    overlays: ["SMA200"],
    backtest: {
      cagr: 16.8,
      sharpe: 1.35,
      maxDrawdown: -11.5,
      winRate: 71,
      lastRunAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(),
    },
    createdAt: new Date("2026-01-22").toISOString(),
  },
];

// ---------------------------------------------------------------------------
// 25. Quizzes (MONEY-392 - demo coverage for /quizzes)
// ---------------------------------------------------------------------------

export const demoQuizzes = [
  {
    id: "quiz-1",
    topic: "Mutual Fund basics",
    difficulty: "Beginner" as const,
    questionCount: 8,
    bestScore: 7,
    attempts: 2,
    lastAttemptAt: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
    tags: ["MF", "fundamentals"],
  },
  {
    id: "quiz-2",
    topic: "Options Greeks - Delta, Gamma, Theta, Vega",
    difficulty: "Advanced" as const,
    questionCount: 10,
    bestScore: 6,
    attempts: 4,
    lastAttemptAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    tags: ["options", "F&O"],
  },
  {
    id: "quiz-3",
    topic: "Tax - LTCG vs STCG on equity",
    difficulty: "Intermediate" as const,
    questionCount: 6,
    bestScore: null,
    attempts: 0,
    lastAttemptAt: null,
    tags: ["tax", "compliance"],
  },
  {
    id: "quiz-4",
    topic: "Reading a balance sheet",
    difficulty: "Intermediate" as const,
    questionCount: 9,
    bestScore: 8,
    attempts: 1,
    lastAttemptAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
    tags: ["fundamentals", "accounting"],
  },
];

// ---------------------------------------------------------------------------
// 26. Demo allow-list for TradingView UDF (MONEY-278)
// ---------------------------------------------------------------------------
//
// When a demo session loads a chart, the UDF routes will only resolve symbols
// from this allow-list. Keeps the surface small and avoids exposing the full
// instrument table to unauthenticated traffic.

export const DEMO_CHART_SYMBOLS = new Set<string>([
  // Equities - major Nifty 50 names that have rich historical data
  "RELIANCE",
  "TCS",
  "INFY",
  "HDFCBANK",
  "ICICIBANK",
  "SBIN",
  "ITC",
  "TATAMOTORS",
  "LT",
  "ASIANPAINT",
  "BAJFINANCE",
  "MARUTI",
  "HINDUNILVR",
  "WIPRO",
  "AXISBANK",
  "KOTAKBANK",
  "BHARTIARTL",
  "ADANIENT",
  "POWERGRID",
  "NTPC",
  // Indices
  "NIFTY",
  "BANKNIFTY",
  "NIFTY50",
  "NIFTYBANK",
  "FINNIFTY",
]);

export function isDemoChartSymbol(symbol: string): boolean {
  return DEMO_CHART_SYMBOLS.has(symbol.toUpperCase());
}
