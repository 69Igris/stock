/**
 * MONEY-1060 (RC3/RC4) — fetch_peer_companies DB-first fallback + source-down
 * signalling.
 *
 * The peer chain (NSE → Tickertape → Screener) now has a 4th tier: the synced
 * `StockPeers` row (via `getOrFetchPeers`). And a provider that THROWS (source
 * unreachable) — vs one that returns `[]` — is recorded so a total miss reports
 * `metadata.sourceError`, letting the synthesizer tell "source down" from a
 * genuine "no peers" gap.
 *
 * These tests import the REAL exported `runPeerFallbackChain` and `mapDbPeers`
 * (de-shadow: the SAME code `execute` runs) and inject fake providers — no
 * network, no database. The pre-existing ordering/flagging contract is covered
 * by apps/web/__tests__/research/peer-fallback-chain.test.ts; here we cover the
 * new DB tier + error capture.
 *
 * Source under test: packages/research/src/tools/fetch-peer-companies.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runPeerFallbackChain,
  mapDbPeers,
  type PeerChainProvider,
} from "../src/tools/fetch-peer-companies";
import type { NsePeerData } from "../src/types";

const samplePeer: NsePeerData = {
  symbol: "ONGC",
  companyName: "Oil & Natural Gas",
  pe: 8.2,
  pb: 1.1,
  marketCap: 250000,
};

const provider = (
  source: PeerChainProvider["source"],
  data: NsePeerData[] | null,
): PeerChainProvider => ({ source, fetch: async () => data });

const throwing = (
  source: PeerChainProvider["source"],
  message: string,
): PeerChainProvider => ({
  source,
  fetch: async () => {
    throw new Error(message);
  },
});

describe("mapDbPeers — StockPeers (Tickertape shape) → NsePeerData", () => {
  it("returns null for null/empty input", () => {
    assert.equal(mapDbPeers(null), null);
    assert.equal(mapDbPeers([]), null);
  });

  it("maps ticker→symbol / name→companyName and the numeric metrics", () => {
    const out = mapDbPeers([
      { ticker: "INFY", name: "Infosys", pe: 24, pb: 8, marketCap: 700000 },
    ]);
    assert.ok(out);
    assert.equal(out!.length, 1);
    assert.deepEqual(out![0], {
      symbol: "INFY",
      companyName: "Infosys",
      pe: 24,
      pb: 8,
      marketCap: 700000,
      sectorPe: undefined,
    });
  });

  it("accepts the symbol/companyName aliases and drops rows with no symbol", () => {
    const out = mapDbPeers([
      { symbol: "WIPRO", companyName: "Wipro", pe: 20 },
      { name: "No Ticker Row" },
    ]);
    assert.ok(out);
    assert.equal(out!.length, 1);
    assert.equal(out![0]!.symbol, "WIPRO");
    assert.equal(out![0]!.pb, 0); // absent numerics default to 0
  });
});

describe("runPeerFallbackChain — DB tier + source-down capture (RC3/RC4)", () => {
  it("RC3: falls back to the DB tier when all live tiers are empty", async () => {
    const r = await runPeerFallbackChain(
      [
        provider("nse", null),
        provider("tickertape", null),
        provider("screener", null),
        provider("db", [samplePeer]),
      ],
      "RELIANCE",
    );
    assert.equal(r.success, true);
    assert.equal(r.metadata.source, "db");
    assert.equal(r.metadata.fallback, true);
    assert.equal(r.data?.length, 1);
  });

  it("recovers (success, no sourceError) when a live tier throws but a later tier has data", async () => {
    const r = await runPeerFallbackChain(
      [
        throwing("nse", "NSE blocked"),
        provider("tickertape", null),
        provider("db", [samplePeer]),
      ],
      "RELIANCE",
    );
    assert.equal(r.success, true);
    assert.equal(r.metadata.source, "db");
    // On success we only report the winning source, not the earlier failures.
    assert.equal(r.metadata.sourceError, undefined);
  });

  it("RC4: a thrown provider + all empty → success:false WITH metadata.sourceError", async () => {
    const r = await runPeerFallbackChain(
      [
        throwing("nse", "NSE blocked"),
        provider("tickertape", null),
        provider("screener", null),
        provider("db", null),
      ],
      "OBSCURE",
    );
    assert.equal(r.success, false);
    assert.match(r.error ?? "", /NSE, Tickertape, Screener/);
    assert.match(r.metadata.sourceError ?? "", /nse: NSE blocked/);
  });

  it("genuine gap: all providers return empty (no throw) → success:false, NO sourceError", async () => {
    const r = await runPeerFallbackChain(
      [
        provider("nse", null),
        provider("tickertape", []),
        provider("screener", null),
        provider("db", null),
      ],
      "OBSCURE",
    );
    assert.equal(r.success, false);
    assert.equal(r.metadata.sourceError, undefined);
    assert.equal(r.metadata.source, undefined);
  });
});
