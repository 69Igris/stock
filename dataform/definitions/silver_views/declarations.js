/**
 * The silver tables this project reads. MONEY-1506 (data-platform B4).
 *
 * ## DECLARATIONS, NOT PASS-THROUGH VIEWS
 *
 * The B4 brief names this directory `silver_views/`. A view that only renames a
 * silver table is a second name for one thing with no transformation in it —
 * it adds a place for a column list to drift out of step and buys nothing, so
 * what lives here is the DECLARATION Dataform needs to build its dependency
 * graph and nothing else. The moment a real silver→silver transform exists it
 * belongs here beside them.
 *
 * ## A .js FILE RATHER THAN THREE .sqlx ONES
 *
 * The dataset name carries the environment suffix, which has to be COMPUTED
 * from `vars.env` (see includes/datasets.js). In a plain .js definition that is
 * ordinary JavaScript; three sqlx config blocks would each restate the same
 * expression, which is the one-fact-many-spellings shape this repo keeps paying
 * for.
 *
 * These tables are created by `packages/lake/ddl/002_silver_price_bars.sql`
 * (MONEY-1496) and `003_silver_identity.sql` (MONEY-1498), and written by the
 * B2 / B2-IN loaders. Dataform never creates or writes them — silver is
 * somebody else's contract.
 */
// `datasets` is the GLOBAL Dataform injects for `includes/datasets.js` — the
// documented way to reach an include, and the only one that works identically
// in a .js definition and in a .sqlx config block.
declare({ schema: datasets.silver(), name: "price_bar_d1" });
declare({ schema: datasets.silver(), name: "corporate_action" });
declare({ schema: datasets.silver(), name: "listing" });
// MONEY-1596 (C5a) — read by gold.event_return_outcome. `instrument_event` is
// 008_silver_instrument_event.sql (C1); `index_eod` is
// 006_silver_derivatives_in.sql (B2-IN), the NIFTY 50 benchmark.
declare({ schema: datasets.silver(), name: "instrument_event" });
declare({ schema: datasets.silver(), name: "index_eod" });
