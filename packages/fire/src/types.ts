export interface AssetClass {
  id: string;
  name: string;
  icon: string;
  allocation: number;
  expectedReturn: number;
  color: string;
}

export interface MonthlyExpense {
  id: string;
  category: string;
  amount: number;
  inflation: number;
}

export interface OneTimeExpense {
  id: string;
  name: string;
  currentCost: number;
  yearsAway: number;
  inflation: number;
}

export interface ProjectionData {
  year: number;
  age: number;
  corpus: number;
  fireNumber: number;
  savings: number;
  expenses: number;
  // Retirement spending the withdrawal-rate cap could NOT fund this year
  // (0 when fully funded). > 0 marks an unsustainable year.
  shortfall?: number;
}

export interface SavedScenario {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const defaultAssetClasses: AssetClass[] = [
  {
    id: "1",
    name: "Equity",
    icon: "📈",
    allocation: 60,
    expectedReturn: 12,
    color: "#3b82f6",
  },
  {
    id: "2",
    name: "Cash",
    icon: "💵",
    allocation: 5,
    expectedReturn: 4,
    color: "#22c55e",
  },
  {
    id: "3",
    name: "Gold",
    icon: "🪙",
    allocation: 10,
    expectedReturn: 8,
    color: "#f59e0b",
  },
  {
    id: "4",
    name: "Fixed Deposits",
    icon: "🏦",
    allocation: 15,
    expectedReturn: 7,
    color: "#10b981",
  },
  {
    id: "5",
    name: "Real Estate",
    icon: "🏠",
    allocation: 10,
    expectedReturn: 9,
    color: "#8b5cf6",
  },
];

const defaultExpenses: MonthlyExpense[] = [
  { id: "1", category: "Housing", amount: 25000, inflation: 5 },
  { id: "2", category: "Healthcare", amount: 8000, inflation: 8 },
  { id: "3", category: "Transportation", amount: 6000, inflation: 5 },
  { id: "4", category: "Food & Groceries", amount: 15000, inflation: 6 },
  { id: "5", category: "Utilities", amount: 4000, inflation: 5 },
  { id: "6", category: "Entertainment", amount: 5000, inflation: 4 },
  { id: "7", category: "Personal Care", amount: 3000, inflation: 5 },
  { id: "8", category: "Miscellaneous", amount: 4000, inflation: 6 },
];

export const defaultOneTimeExpenses: OneTimeExpense[] = [
  {
    id: "1",
    name: "Children's Education",
    currentCost: 2000000,
    yearsAway: 18,
    inflation: 8,
  },
];

export function getDefaultMonthlyExpenses(): MonthlyExpense[] {
  return defaultExpenses.map((exp) => ({
    ...exp,
    id: `${exp.id}-${Date.now()}-${Math.random()}`,
  }));
}

export function formatLakhs(value: number): string {
  if (value >= 10000000) return `₹${(value / 10000000).toFixed(2)} Cr`;
  if (value >= 100000) return `₹${(value / 100000).toFixed(2)} L`;
  return `₹${value.toLocaleString("en-IN")}`;
}

export function calculateFutureValue(
  currentCost: number,
  years: number,
  inflation: number,
): number {
  return currentCost * Math.pow(1 + inflation / 100, years);
}
