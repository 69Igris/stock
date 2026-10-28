/**
 * `@usemoney/lake` — the BigQuery lake. MONEY-1472 (B1), MONEY-1498 (B3).
 *
 * Import SUBPATHS, not this barrel, from application code:
 *   `@usemoney/lake/ledger-logic`    pure decisions, no I/O, safe anywhere
 *   `@usemoney/lake/ledger`          the BigQuery shell
 *   `@usemoney/lake/identity-logic`  pure security identity (SCD-2, resolveListing)
 *   `@usemoney/lake/price-bar-logic` pure silver bar mapping, both markets
 *   `@usemoney/lake/stage-logic`     pure staging keys + NDJSON encoding
 *   `@usemoney/lake/india-sink-logic` pure India replay decisions (B2-IN)
 *   `@usemoney/lake/load`            the BigQuery load shell
 *   `@usemoney/lake/events-logic`    pure Mongo -> silver row shapes (C1)
 *   `@usemoney/lake/corp-action-logic` pure Mongo -> silver corporate actions
 *
 * The barrel exists for the workspace's own tests and for scripts that want
 * both halves.
 *
 * It deliberately does NOT re-export `india-sink-logic` or `load`.
 * `india-sink-logic` and `price-bar-logic` both export a `finite` helper and a
 * row-mapping vocabulary; a `export *` of both would either collide or silently
 * shadow, and the shadowed one is whichever came second in this file — a fact
 * no call site can see. Import the subpath.
 */
export * from "./ledger-logic";
export * from "./ledger";
export * from "./identity-logic";
export * from "./events-logic";
