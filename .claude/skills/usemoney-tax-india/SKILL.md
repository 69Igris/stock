---
name: usemoney-tax-india
description:
  "Build Indian tax compliance and capital gains analysis features for UseMoney.
  Use this skill when working on STCG/LTCG calculations, grandfathering rules,
  ITR P&L statements, TDS tracking, wash sale handling, or any India-specific
  tax features for stock market investments. Also trigger when the user mentions
  'tax report', 'capital gains', 'ITR', 'Section 111A', 'Section 112A', or 'tax
  harvesting'."
---

# UseMoney Indian Tax Compliance Agent

Build tax analysis and compliance features specifically for Indian stock market
investors. India has unique tax rules for equity investments that UseMoney needs
to handle correctly - this skill covers the complete tax landscape.

## India Capital Gains Tax Rules (AY 2025-26)

Understanding these rules is essential because they drive every computation in
this agent. Getting them wrong means incorrect tax liability for users.

### Equity Shares (Listed, STT Paid)

| Holding Period  | Classification | Tax Rate                          | Section |
| --------------- | -------------- | --------------------------------- | ------- |
| Up to 12 months | STCG           | 20%                               | 111A    |
| Over 12 months  | LTCG           | 12.5% (above INR 1.25L exemption) | 112A    |

The 12-month boundary is from **buy date to sell date** (not settlement date).
For FIFO-paired trades, use the entry trade date.

### Equity Mutual Funds

| Holding Period  | Classification | Tax Rate                |
| --------------- | -------------- | ----------------------- |
| Up to 12 months | STCG           | 20%                     |
| Over 12 months  | LTCG           | 12.5% (above INR 1.25L) |

### F&O (Futures & Options)

F&O income is treated as **business income** - not capital gains. It is taxed at
slab rates. UseMoney should flag F&O separately and not mix it with equity
capital gains.

### Grandfathering Rule (Section 112A)

For shares acquired **before January 31, 2018**, the cost of acquisition is the
**higher of**:

1. Actual purchase price
2. Fair Market Value (FMV) as on Jan 31, 2018 (highest traded price on that
   date)

This reduces LTCG for long-held stocks. The FMV cap is the actual selling price
(cannot inflate cost above sell price).

```
If FMV > Sell Price then Cost = Sell Price (no gain, no loss)
If FMV > Actual Cost then Cost = FMV
If FMV < Actual Cost then Cost = Actual Cost
```

---

## New Tools to Build

### 1. `compute_capital_gains_tax`

**Category**: `computation`

**Purpose**: Calculate STCG and LTCG from paired trades.

**Inputs**:

```typescript
{
  pairedTrades: Array<{
    symbol: string;
    buyDate: string;          // ISO date
    sellDate: string;
    buyPrice: number;
    sellPrice: number;
    quantity: number;
    exchange: "NSE" | "BSE";
    segment: "EQUITY" | "FNO" | "MF";
  }>;
  financialYear: string;       // "2025-26"
  grandfatheringFMV?: Record<string, number>;  // symbol -> FMV on Jan 31, 2018
}
```

**Outputs**:

```typescript
{
  stcg: {
    totalGain: number;
    totalLoss: number;
    netGain: number;
    taxableAmount: number;
    taxLiability: number;     // 20% of net gain
    trades: TaxTrade[];
  };
  ltcg: {
    totalGain: number;
    totalLoss: number;
    netGain: number;
    exemption: number;        // INR 1,25,000
    taxableAmount: number;    // net gain - exemption
    taxLiability: number;     // 12.5% of taxable
    grandfatheredTrades: TaxTrade[];
    trades: TaxTrade[];
  };
  fno: {
    totalPnL: number;
    note: "Taxed as business income at slab rates";
  };
  totalTaxLiability: number;
  summary: string;
}
```

**Implementation notes**:

- Use UseMoney's FIFO-paired `PairedTradeView` as input
- Apply grandfathering only for buy dates before 2018-01-31
- Set-off rules: STCG loss can offset STCG gain. LTCG loss can offset LTCG gain.
  STCG loss can also offset LTCG gain, but NOT vice versa.
- Carry forward: Unabsorbed capital losses carry forward for 8 years

### 2. `compute_tax_harvesting`

**Category**: `computation`

**Purpose**: Identify tax-loss harvesting opportunities - selling losing
positions to offset gains.

**Inputs**:

```typescript
{
  holdings: Array<{
    symbol: string;
    buyDate: string;
    quantity: number;
    avgPrice: number;
    currentPrice: number;
  }>;
  realizedGains: {
    stcg: number;
    ltcg: number;
  }
  financialYear: string;
}
```

**Outputs**:

```typescript
{
  harvestingOpportunities: Array<{
    symbol: string;
    unrealizedLoss: number;
    holdingPeriod: "short" | "long";
    offsetType: "STCG" | "LTCG";
    potentialTaxSaving: number;
    recommendation: string;
  }>;
  totalPotentialSaving: number;
  warnings: string[];
}
```

**Implementation notes**: India has no explicit wash sale rule like the US, but
the tax department can invoke GAAR (General Anti-Avoidance Rules) for obvious
tax-avoidance transactions. Warn users about this.

### 3. `generate_itr_schedule`

**Category**: `synthesis`

**Purpose**: Generate a formatted P&L statement matching ITR Schedule CG format.

**Inputs**:

```typescript
{
  capitalGains: CapitalGainsResult;
  assessmentYear: string;
}
```

**Outputs**:

```typescript
{
  scheduleCG: {
    sectionA: { stcg111A: number; stcgOther: number; };
    sectionB: { ltcg112A: number; ltcgExemption: number; ltcgTaxable: number; };
    setOff: { stcgSetOff: number; ltcgSetOff: number; };
    carryForward: { stcgLoss: number; ltcgLoss: number; yearsRemaining: number; };
  };
  downloadableCSV: string;
  notes: string[];
}
```

### 4. `compute_advance_tax`

**Category**: `computation`

**Purpose**: Calculate advance tax liability and due dates for capital gains.

**Outputs**:

```typescript
{
  totalTaxLiability: number;
  tdsCredit: number;
  advanceTaxDue: number;
  installments: Array<{
    dueDate: string; // "15 Jun", "15 Sep", "15 Dec", "15 Mar"
    percentageDue: number; // 15%, 45%, 75%, 100%
    amountDue: number;
  }>;
  interestOnDelay: number; // Section 234C
}
```

---

## New Research Skill: `tax-analysis`

```typescript
export const taxAnalysisSkill: ResearchSkill = {
  name: "tax-analysis",
  description:
    "Calculate capital gains tax, generate ITR schedules, and find tax-saving opportunities",
  triggers: [
    /\b(tax|capital\s*gains?|stcg|ltcg|itr)\b/i,
    /\b(tax\s*harvest|tax\s*loss|tax\s*sav)\b/i,
    /\bhow\s*much\s*tax\b/i,
    /\bsection\s*(111a|112a)\b/i,
  ],
  requiredParams: ["pairedTrades"],
  optionalParams: ["financialYear", "grandfatheringFMV"],
};
```

**Execution plan**:

```
1. compute_capital_gains_tax          - from paired trades
2. compute_tax_harvesting             - from holdings + realized gains [1]
3. compute_advance_tax                - from estimated gains [1]
4. generate_itr_schedule              - from capital gains [1]
5. synthesize_report (tax-focused)    - depends on [1-4]
```

---

## Data Integration

### From Existing UseMoney Data

- **PairedTradeView**: FIFO-paired buy/sell trades (the core input for tax
  calculation)
- **Holdings**: Current unrealized positions (for tax harvesting)
- **Trades**: Complete order book with timestamps and prices
- **Mutual Funds**: MF redemptions for capital gains

### Grandfathering FMV Data

For the grandfathering rule, you need Jan 31, 2018 prices. Options:

1. **NSE historical data API** - fetch closing prices for that date
2. **Static lookup table** - pre-compute for major stocks and cache
3. **User input** - allow manual FMV entry for edge cases

---

## Frontend: Tax Report Page

Add `/tax` or `/reports/tax` route:

### Key Components

1. **Tax Summary Card** - Total STCG, LTCG, F&O P&L, total liability
2. **Gains Breakdown Table** - Each trade with holding period, gain/loss
   classification
3. **Tax Harvesting Panel** - Opportunities with potential savings
4. **ITR Export** - Download CSV matching Schedule CG format
5. **Financial Year Selector** - Switch between FY 2024-25, 2025-26, etc.
6. **Advance Tax Timeline** - Visual timeline showing installment due dates

### Indian Number Formatting

Always display amounts in Indian format using `Intl.NumberFormat('en-IN')`:

```
1,00,000    (1 lakh)
10,00,000   (10 lakh)
1,00,00,000 (1 crore)
```

---

## Important Disclaimers

Every tax output must include:

1. "This is an estimate for informational purposes only"
2. "Consult a qualified Chartered Accountant for actual tax filing"
3. "Tax laws are subject to change; verify rates for the relevant assessment
   year"

---

## Testing Strategy

Tax calculations need rigorous testing because errors directly impact users' tax
filings:

1. **Basic STCG/LTCG classification** - Verify 12-month boundary
2. **Grandfathering edge cases** - FMV > sell price, FMV < buy price, FMV
   between
3. **Set-off rules** - STCG loss offsetting LTCG, carry-forward scenarios
4. **Exemption threshold** - Exactly INR 1.25L boundary
5. **F&O separation** - F&O trades excluded from capital gains
6. **Multi-broker** - Trades from different brokers aggregated correctly
7. **Partial fills** - FIFO-split trades maintain correct holding periods

Use real-world trade data snapshots for test fixtures. Follow `node:test` +
`node:assert/strict` pattern.
