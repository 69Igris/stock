/**
 * `@usemoney/core/us-fundamentals` — the READ seam over the SEC EDGAR tables
 * (MONEY-979, T10).
 *
 * Import the SUBPATH, never the root barrel: `@usemoney/core` pulls in brokers,
 * payments and Gemini, and a client bundle that only wants a US income
 * statement should not carry them.
 *
 *     import { getStatements } from "@usemoney/core/us-fundamentals";
 *
 * `repository-logic` is exported alongside `repository` so a caller that
 * already has rows (a worker, a test, an ops script) can apply the same
 * decisions without a database.
 */

export * from "./types";
export * from "./repository-logic";
export * from "./repository";
export {
  buildThirteenFColdKey,
  decodeThirteenFShard,
  decodeThirteenFShardDetailed,
  encodeThirteenFShard,
  getUsColdStore,
  parseThirteenFShard,
  readThirteenFColdShard,
  serializeThirteenFShard,
  setUsColdStore,
  UsColdStoreUnavailableError,
  US_13F_COLD_PREFIX,
  US_COLD_CONTENT_TYPE,
  US_COLD_REASON_SHARD_EMPTY,
  US_COLD_REASON_SHARD_UNPARSEABLE,
  US_COLD_TIMEOUT_MS,
  type DecodedThirteenFShard,
  type UsColdHoldingsOutcome,
  type UsColdStore,
} from "./cold-holdings";
