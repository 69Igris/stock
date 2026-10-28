/**
 * Calculator suite - pure financial math (MONEY-208).
 *
 * Every calculator here is dependency-free. They live in `packages/core`
 * so the same primitive can be unit-tested under `node:test` AND called
 * from server actions (mf-calc.ts) AND used in client components without
 * boundary issues.
 *
 * Naming convention:
 *   - SIP (recurring monthly contributions)
 *   - Lumpsum (one-time investment)
 *   - StepUp (SIP that grows X% per year)
 *   - EMI (loan payment + amortisation)
 *   - FD (fixed deposit, frequency-based compounding)
 *   - RD (recurring deposit, monthly compounding)
 *   - NPS (retirement, with corpus → annuity split)
 *   - Goal (back-solve monthly SIP given target corpus)
 *   - InflationAdj (real-return adjusted SIP)
 *   - SWP (systematic withdrawal)
 *   - XIRR (Newton's method on irregular cashflows)
 *
 * All percentage inputs are decimal-form (12 = 12%, NOT 0.12). All
 * money is in rupees. All durations are in years unless suffixed
 * `Months`.
 */

export * from "./sip";
export * from "./lumpsum";
export * from "./cagr";
export * from "./step-up";
export * from "./emi";
export * from "./fd";
export * from "./rd";
export * from "./nps";
export * from "./goal";
export * from "./inflation";
export * from "./swp";
export * from "./xirr";
export * from "./income-tax";
