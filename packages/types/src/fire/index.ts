export interface FireScenario {
  id: string;
  userId: string;
  name: string;
  currentAge: number;
  retirementAge: number;
  lifeExpectancy: number;
  inflation: number;
  effectiveTaxRate: number;
  currentCorpus: number;
  monthlySavings: number;
  assetClasses: AssetClass[];
  expenses: FireExpense[];
  oneTimeExpenses: OneTimeExpense[];
  fireNumber: number;
  yearsToFire: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssetClass {
  id: string;
  name: string;
  icon: string;
  allocation: number;
  expectedReturn: number;
  color: string;
}

export interface FireExpense {
  id: string;
  category: string;
  monthly: number;
  inflation: number;
  notes?: string;
}

export interface OneTimeExpense {
  id: string;
  name: string;
  amount: number;
  year: number;
  inflation: number;
}
