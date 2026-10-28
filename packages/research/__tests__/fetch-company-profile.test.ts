/**
 * MONEY-1060 (RC3/RC4) — fetch_company_profile DB-first fallback.
 *
 * The tool previously hit LIVE Yahoo only. It now falls back to the synced
 * `StockProfile` row (via `getOrFetchProfile`) and, when Yahoo threw AND the DB
 * is also empty, reports success:false + metadata.sourceError (source-down)
 * instead of a silent empty-success.
 *
 * These tests import the REAL exported orchestrator `resolveCompanyProfile` and
 * the REAL `dbRowToCompanyProfile` mapper (de-shadow) and inject fake live/DB
 * fetchers — no network, no database.
 *
 * Source under test: packages/research/src/tools/fetch-company-profile.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveCompanyProfile,
  dbRowToCompanyProfile,
  fetchCompanyProfileTool,
  fetchLiveProfile,
} from "../src/tools/fetch-company-profile";
import type { CompanyProfile } from "../src/types";

// A realistic synced StockProfile row (Prisma shape).
const DB_ROW: Record<string, unknown> = {
  symbol: "RELIANCE",
  exchange: "NSE",
  name: "Reliance Industries Ltd",
  sector: "Energy",
  industry: "Oil & Gas Refining",
  description: "Reliance is a diversified conglomerate...",
  website: "https://ril.com",
  employees: 236000,
  marketCap: 1900000,
  source: "YAHOO",
};

describe("dbRowToCompanyProfile — StockProfile row → CompanyProfile", () => {
  it("returns null for a null row or a row with nothing usable", () => {
    assert.equal(dbRowToCompanyProfile("RELIANCE.NS", null), null);
    assert.equal(
      dbRowToCompanyProfile("RELIANCE.NS", { website: "https://x.com" }),
      null,
    );
  });

  it("maps the full row and carries the query symbol", () => {
    const p = dbRowToCompanyProfile("RELIANCE.NS", DB_ROW);
    assert.ok(p);
    assert.equal(p!.symbol, "RELIANCE.NS");
    assert.equal(p!.name, "Reliance Industries Ltd");
    assert.equal(p!.sector, "Energy");
    assert.equal(p!.industry, "Oil & Gas Refining");
    assert.equal(p!.website, "https://ril.com");
    assert.equal(p!.employees, 236000);
    assert.equal(p!.marketCap, 1900000);
  });

  it("fills Unknown/empty defaults when only a name is present", () => {
    const p = dbRowToCompanyProfile("XYZ.NS", { name: "XYZ Corp" });
    assert.ok(p);
    assert.equal(p!.name, "XYZ Corp");
    assert.equal(p!.sector, "Unknown");
    assert.equal(p!.industry, "Unknown");
    assert.equal(p!.description, "");
  });
});

describe("resolveCompanyProfile — live-primary, DB fallback (RC3/RC4)", () => {
  const liveProfile: CompanyProfile = {
    symbol: "RELIANCE.NS",
    name: "Reliance (live)",
    sector: "Energy",
    industry: "Refining",
    description: "live",
  };

  it("returns live data and does NOT touch the DB when live succeeds", async () => {
    let dbCalls = 0;
    const out = await resolveCompanyProfile(
      "RELIANCE.NS",
      async () => ({ data: liveProfile }),
      async () => {
        dbCalls++;
        return DB_ROW;
      },
    );
    assert.equal(out.success, true);
    assert.equal((out.data as CompanyProfile).name, "Reliance (live)");
    assert.equal(dbCalls, 0);
  });

  it("RC3: live EMPTY → serves the DB row (success:true, fallback flagged)", async () => {
    const out = await resolveCompanyProfile(
      "RELIANCE.NS",
      async () => null,
      async () => DB_ROW,
    );
    assert.equal(out.success, true);
    assert.equal((out.data as CompanyProfile).name, "Reliance Industries Ltd");
    assert.equal(out.metadata?.fallback, true);
    assert.equal(out.metadata?.dbFirst, true);
    assert.equal(out.metadata?.source, "YAHOO");
    assert.equal(out.metadata?.sourceError, undefined);
  });

  it("RC3+RC4: live THROWS but DB has the row → success:true WITH sourceError", async () => {
    const out = await resolveCompanyProfile(
      "RELIANCE.NS",
      async () => {
        throw new Error("Yahoo timeout");
      },
      async () => DB_ROW,
    );
    assert.equal(out.success, true);
    assert.match(String(out.metadata?.sourceError), /Yahoo timeout/);
  });

  it("RC4: live THROWS and DB empty → success:false with metadata.sourceError", async () => {
    const out = await resolveCompanyProfile(
      "RELIANCE.NS",
      async () => {
        throw new Error("Yahoo timeout");
      },
      async () => null,
    );
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /Yahoo timeout/);
    assert.match(String(out.metadata?.sourceError), /Yahoo timeout/);
  });

  it("live empty + DB empty → success:false, no sourceError (genuine gap)", async () => {
    const out = await resolveCompanyProfile(
      "RELIANCE.NS",
      async () => null,
      async () => null,
    );
    assert.equal(out.success, false);
    assert.equal(out.metadata, undefined);
  });
});

// ── fetchLiveProfile — REAL swallow-path wiring (MONEY-1060 fix 1) ───────────
//
// Production `yahooFetchQuoteSummary` NEVER throws (it catches internally and
// returns null) and `withExchangeFallback` swallows thrown fetches too — the
// `onError` observer is the ONLY outage signal on the real path. The fakes
// below mirror that exact shape: RETURN EMPTY + call onError, never throw.

describe("fetchLiveProfile — swallow-path onError wiring", () => {
  it("summary empty + onError reported → THROWS the captured error (outage, not gap)", async () => {
    await assert.rejects(
      fetchLiveProfile("RELIANCE.NS", async (_s, _m, opts) => {
        opts?.onError?.(new Error("Yahoo timeout"), "fetchQuoteSummary");
        return null; // swallow-shaped: null, NO throw — the real behavior
      }),
      /Yahoo timeout/,
    );
  });

  it("end-to-end: swallow-shaped outage + empty DB → success:false + metadata.sourceError", async () => {
    const out = await resolveCompanyProfile(
      "RELIANCE.NS",
      () =>
        fetchLiveProfile("RELIANCE.NS", async (_s, _m, opts) => {
          opts?.onError?.(new Error("Yahoo timeout"));
          return null;
        }),
      async () => null,
    );
    assert.equal(out.success, false);
    assert.match(String(out.metadata?.sourceError), /Yahoo timeout/);
  });

  it("summary empty with NO error → null (genuine gap, no throw)", async () => {
    const live = await fetchLiveProfile("RELIANCE.NS", async () => null);
    assert.equal(live, null);
  });

  it("summary data → mapped profile (name/sector/marketCap raw extraction)", async () => {
    const live = await fetchLiveProfile("RELIANCE.NS", async () => ({
      assetProfile: {
        sector: "Energy",
        industry: "Oil & Gas Refining",
        longBusinessSummary: "Diversified conglomerate.",
        website: "https://ril.com",
        fullTimeEmployees: 236000,
      },
      price: {
        longName: "Reliance Industries Ltd",
        marketCap: { raw: 1_900_000 },
      },
    }));
    assert.ok(live);
    const p = live!.data;
    assert.equal(p.symbol, "RELIANCE.NS");
    assert.equal(p.name, "Reliance Industries Ltd");
    assert.equal(p.sector, "Energy");
    assert.equal(p.industry, "Oil & Gas Refining");
    assert.equal(p.marketCap, 1_900_000);
    assert.equal(p.employees, 236000);
  });
});

describe("fetch_company_profile tool — schema unchanged", () => {
  it("requires a symbol", async () => {
    const out = await fetchCompanyProfileTool.execute({});
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /symbol is required/);
  });
});
