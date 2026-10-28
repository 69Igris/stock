import { z } from "zod";

export const MonthlyExpenseSchema = z.object({
  id: z.string(),
  category: z.string().min(1, "Category is required"),
  amount: z
    .number()
    .min(0, "Amount must be non-negative")
    .finite("Amount must be a finite number"),
  inflation: z.number().min(0).max(30).default(6),
});

export const OneTimeExpenseSchema = z.object({
  id: z.string(),
  name: z.string().min(1, "Name is required"),
  currentCost: z
    .number()
    .positive("Cost must be positive")
    .finite("Cost must be a finite number"),
  yearsAway: z.number().min(1).max(50),
  inflation: z.number().min(0).max(30).default(7),
});

export const FireParametersSchema = z
  .object({
    currentAge: z
      .number()
      .min(18, "Current age must be at least 18")
      .max(80, "Current age must be at most 80"),
    retirementAge: z
      .number()
      .min(30, "Retirement age must be at least 30")
      .max(90, "Retirement age must be at most 90"),
    lifeExpectancy: z
      .number()
      .min(60, "Life expectancy must be at least 60")
      .max(150, "Life expectancy must be at most 150"),
    currentCorpus: z
      .number()
      .min(0, "Current corpus must be non-negative")
      .finite("Current corpus must be a finite number"),
    monthlySavings: z
      .number()
      .min(0, "Monthly savings must be non-negative")
      .finite("Monthly savings must be a finite number"),
    withdrawalRate: z
      .number()
      .min(1, "Withdrawal rate must be at least 1%")
      .max(25, "Withdrawal rate must be at most 25%"),
    taxRate: z
      .number()
      .min(0, "Tax rate must be non-negative")
      .max(100, "Tax rate must be at most 100%")
      .default(30),
    salaryIncrement: z
      .number()
      .min(0, "Salary increment must be non-negative")
      .max(100, "Salary increment must be at most 100%"),
    savingsIncrement: z
      .number()
      .min(0, "Savings increment must be non-negative")
      .max(100, "Savings increment must be at most 100%"),
  })
  .refine((data) => data.retirementAge >= data.currentAge, {
    message: "Retirement age must be greater than or equal to current age",
    path: ["retirementAge"],
  });

export type FireParametersInput = z.infer<typeof FireParametersSchema>;

export const FireScenarioSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    currentAge: z.number().min(18).max(80),
    retirementAge: z.number().min(30).max(90),
    lifeExpectancy: z.number().min(60).max(150),
    currentCorpus: z.number().min(0).finite(),
    monthlySavings: z.number().min(0).finite(),
    withdrawalRate: z.number().min(1).max(25).default(4),
    taxRate: z.number().min(0).max(100).default(30),
    salaryIncrement: z.number().min(0).max(100).default(10).optional(),
    savingsIncrement: z.number().min(0).max(100).default(12).optional(),
    assetClasses: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        icon: z.string(),
        allocation: z.number().min(0).max(100),
        expectedReturn: z.number().min(-20).max(50),
        color: z.string(),
      }),
    ),
    expenses: z.array(MonthlyExpenseSchema),
    oneTimeExpenses: z.array(OneTimeExpenseSchema),
  })
  .refine((data) => data.retirementAge >= data.currentAge, {
    message: "Retirement age must be greater than or equal to current age",
    path: ["retirementAge"],
  });

export type FireScenarioInput = z.infer<typeof FireScenarioSchema>;
