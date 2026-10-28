/**
 * MOVED to `@usemoney/core/market-data/udf/symbols-logic` (MONEY-1466 / A1).
 *
 * `apps/market-data` serves the same UDF contract from Cloud Run, so the
 * resolver has to live somewhere both apps can import. This file stays as a
 * re-export rather than being deleted: ten `apps/web/__tests__` files import
 * this path, and rewriting them would be churn with no behaviour attached — the
 * point of the move is ONE implementation, not one import path.
 */
export * from "@usemoney/core/market-data/udf/symbols-logic";
