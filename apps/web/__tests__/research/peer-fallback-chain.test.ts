/**
 * Peer fallback chain - B5 fix in MONEY-218-followup.
 *
 * The fetch_peer_companies tool chains: NSE → Tickertape → Screener.in.
 * RELIANCE was returning empty in production because both NSE (IP-blocked)
 * and Tickertape (HTTP 200 with an empty `peers` array) failed in tandem.
 *
 * De-shadowed (MONEY-620 / task 185): the previous version reimplemented the
 * chain (`runPeerChain`) inline. The ordering/flagging is now extracted into
 * the REAL exported `runPeerFallbackChain`, which the tool's `execute` calls
 * directly. This file imports and asserts that real symbol, so a regression
 * in the production chain would fail the test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runPeerFallbackChain,
  type PeerChainProvider,
} from "@usemoney/research/tools/fetch-peer-companies";
import type { NsePeerData } from "@usemoney/research";

const samplePeer: NsePeerData = {
  symbol: "ONGC",
  companyName: "Oil & Natural Gas",
  pe: 8.2,
  pb: 1.1,
  marketCap: 250000,
};

const provider = (
  source: PeerChainProvider["source"],
  data: NsePeerData[] | null
): PeerChainProvider => ({ source, fetch: async () => data });

describe("peer fallback chain - B5 (MONEY-218-followup), real runPeerFallbackChain", () => {
  it("returns NSE result when NSE succeeds", async () => {
    const r = await runPeerFallbackChain(
      [
        provider("nse", [samplePeer]),
        provider("tickertape", null),
        provider("screener", null),
      ],
      "RELIANCE"
    );
    assert.equal(r.success, true);
    assert.equal(r.metadata.source, "nse");
    assert.equal(r.metadata.fallback, false);
    assert.equal(r.data?.length, 1);
  });

  it("falls back to Tickertape when NSE returns null", async () => {
    const r = await runPeerFallbackChain(
      [
        provider("nse", null),
        provider("tickertape", [samplePeer]),
        provider("screener", null),
      ],
      "RELIANCE"
    );
    assert.equal(r.success, true);
    assert.equal(r.metadata.source, "tickertape");
    assert.equal(r.metadata.fallback, true);
  });

  it("falls back to Screener when both NSE and Tickertape return null (the RELIANCE bug)", async () => {
    const r = await runPeerFallbackChain(
      [
        provider("nse", null),
        provider("tickertape", null),
        provider("screener", [samplePeer]),
      ],
      "RELIANCE"
    );
    assert.equal(r.success, true);
    assert.equal(r.metadata.source, "screener");
    assert.equal(r.metadata.fallback, true);
  });

  it("falls back to Screener when Tickertape returns an EMPTY array (200-OK-empty)", async () => {
    // The exact prod failure: Tickertape returned 200 with `peers: []`, so the
    // original code treated it as success. The chain must skip empty arrays.
    const r = await runPeerFallbackChain(
      [
        provider("nse", null),
        provider("tickertape", []),
        provider("screener", [samplePeer]),
      ],
      "RELIANCE"
    );
    assert.equal(r.success, true);
    assert.equal(r.metadata.source, "screener");
  });

  it("returns failure with explicit fallback chain in error message when ALL providers fail", async () => {
    const r = await runPeerFallbackChain(
      [
        provider("nse", null),
        provider("tickertape", null),
        provider("screener", null),
      ],
      "OBSCURE"
    );
    assert.equal(r.success, false);
    assert.match(r.error ?? "", /NSE, Tickertape, Screener/);
    assert.equal(r.metadata.source, undefined);
  });

  it("does not call later providers when an earlier one succeeds", async () => {
    let ttCalls = 0;
    let scrCalls = 0;
    await runPeerFallbackChain(
      [
        provider("nse", [samplePeer]),
        {
          source: "tickertape",
          fetch: async () => {
            ttCalls++;
            return [samplePeer];
          },
        },
        {
          source: "screener",
          fetch: async () => {
            scrCalls++;
            return [samplePeer];
          },
        },
      ],
      "TCS"
    );
    assert.equal(ttCalls, 0);
    assert.equal(scrCalls, 0);
  });
});
