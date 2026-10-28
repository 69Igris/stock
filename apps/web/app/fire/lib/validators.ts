import { FireParametersSchema } from "@usemoney/validation";
import { z } from "zod";

export function validateParameters(params: {
  currentAge: number;
  retirementAge: number;
  lifeExpectancy: number;
  currentCorpus: number;
  monthlySavings: number;
  withdrawalRate: number;
  taxRate: number;
  salaryIncrement: number;
  savingsIncrement: number;
}): { valid: boolean; errors: Record<string, string> } {
  try {
    FireParametersSchema.parse(params);
    return { valid: true, errors: {} };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors: Record<string, string> = {};
      error.issues.forEach((err) => {
        if (err.path[0]) {
          errors[err.path[0] as string] = err.message;
        }
      });
      return { valid: false, errors };
    }
    return { valid: false, errors: {} };
  }
}
