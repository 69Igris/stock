/**
 * MONEY-1235 — the analyst consensus card must not become collateral damage of
 * the ratios switchover.
 *
 * `targetPrice` and `recommendation` are the ONLY two `StockRatios` columns
 * nothing writes any more. `xbrl-ratios-daily` derives the other 26 nightly
 * from our own filings and close history and deliberately leaves these alone —
 * sell-side opinion is not in a filing and is not reproducible from a price
 * series — while Tickertape, which used to write them, now returns 403 to our
 * Cloud Run egress.
 *
 * So the target freezes and the price does not, and `upsideToTargetPct` keeps
 * computing a fresh-looking "VS LTP" from a five-month-old consensus against
 * today's LTP. That is a confident, MOVING, wrong number — strictly worse than
 * a missing one, because nothing about it looks broken. Two things follow, and
 * both are pinned here:
 *
 *  1. An AGE GATE on `fetchedAt`. Not on `dataAsOf`: that is
 *     `max(fetchedAt, ratiosDerivedAt)` and it moves every night the derive
 *     runs, so gating on it would keep a frozen March consensus on screen
 *     forever on the strength of a freshly recomputed margin.
 *  2. The attribution stops naming `data.source`. After the switchover that
 *     column reads `NSE_XBRL` on a row whose analyst fields are still
 *     Tickertape's, so "estimates aggregated by NSE_XBRL" credits the exchange's
 *     filing system with a broker's price target.
 *
 * Source: apps/web/components/stock/StockAnalystSnapshot.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Client component pulling the "use server" actions (Prisma at module scope)
// and a chat block; stub both so the real helpers can be EXECUTED.
interface ModuleLoader {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}
const loader = Module as unknown as ModuleLoader;
const originalLoad = loader._load;
loader._load = function patchedLoad(
  request: string,
  parent: unknown,
  isMain: boolean
): unknown {
  if (request.endsWith(".css")) return {};
  if (request === "@/lib/actions/stock-tabs") {
    return {
      getStockRatiosAction: async () => ({ success: true, data: null }),
    };
  }
  if (request === "@/components/chat/blocks/ChatBlock") {
    return { SEBI_SHORT: "" };
  }
  return originalLoad.call(loader, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const card = require("../../components/stock/StockAnalystSnapshot") as {
  isAnalystConsensusStale: (
    fetchedAt: string | null | undefined,
    now?: number,
    maxAgeDays?: number
  ) => boolean;
  formatAnalystAsOf: (iso: string | null | undefined) => string | null;
  ANALYST_MAX_AGE_DAYS: number;
};
const { isAnalystConsensusStale, formatAnalystAsOf, ANALYST_MAX_AGE_DAYS } =
  card;

// `financial-data-sync` was retired with `stock_financials` frozen on a March
// snapshot; the ratios row's `fetchedAt` stopped with it.
const FROZEN = "2026-03-12T21:40:00.000Z";
const NOW = Date.parse("2026-08-21T00:00:00.000Z");

const SRC = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "components",
    "stock",
    "StockAnalystSnapshot.tsx"
  ),
  "utf8"
);
// LINE comments FIRST, then BLOCK — MONEY-1143. Reversed, a `//` comment
// containing `/*` swallows every line up to the next `*/`, and since the
// assertions below are ABSENCES the swallowed code would read as a PASS.
const CODE = SRC.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("MONEY-1235 — the analyst age gate", () => {
  it("the frozen March row is still shown TODAY and suppressed from 8 Sep", () => {
    // Stated precisely rather than approximately, because "a stale March
    // consensus" is easy to assume and wrong right now: 12 Mar -> 21 Aug is 162
    // days, INSIDE the 180-day window. The gate starts biting on 8 Sep 2026 and
    // never stops, because nothing writes these two columns any more. The
    // assertion is on the RULE, with the real prod date as the worked example.
    assert.equal(isAnalystConsensusStale(FROZEN, NOW), false);
    const sept = Date.parse("2026-09-30T00:00:00.000Z");
    assert.equal(isAnalystConsensusStale(FROZEN, sept), true);
  });

  it("the boundary is exclusive: exactly 180 days is still shown", () => {
    const base = Date.UTC(2026, 0, 1);
    const day = 24 * 60 * 60 * 1000;
    const iso = new Date(base).toISOString();
    assert.equal(
      isAnalystConsensusStale(iso, base + ANALYST_MAX_AGE_DAYS * day),
      false
    );
    assert.equal(
      isAnalystConsensusStale(iso, base + (ANALYST_MAX_AGE_DAYS + 1) * day),
      true
    );
  });

  it("a MISSING or unparseable stamp counts as stale — fail CLOSED", () => {
    // `fetchedAt` is `DateTime @default(now())` and non-null in the schema, so
    // an absent value means the payload could not tell us. "We do not know how
    // old this target is" is not a licence to price it against a live LTP.
    assert.equal(isAnalystConsensusStale(null, NOW), true);
    assert.equal(isAnalystConsensusStale(undefined, NOW), true);
    assert.equal(isAnalystConsensusStale("", NOW), true);
    assert.equal(isAnalystConsensusStale("not-a-date", NOW), true);
  });

  it("a genuinely recent consensus is not suppressed", () => {
    assert.equal(
      isAnalystConsensusStale("2026-08-01T00:00:00.000Z", NOW),
      false
    );
  });

  it("formats the as-of date without Intl", () => {
    assert.equal(formatAnalystAsOf(FROZEN), "12 Mar 2026");
    assert.equal(formatAnalystAsOf(null), null);
    assert.equal(formatAnalystAsOf("nope"), null);
  });
});

describe("MONEY-1235 — the card actually applies the gate", () => {
  // The helpers above could be perfect and never called. These read the SOURCE
  // because the render itself needs a DOM this suite does not have.

  it("the early return includes the staleness condition", () => {
    assert.match(
      CODE,
      /consensusStale = isAnalystConsensusStale\(data\?\.fetchedAt\)/
    );
    assert.match(
      CODE,
      /if \(!data \|\| !hasAnything \|\| consensusStale\) return null;/
    );
  });

  it("gates on fetchedAt, NOT on the nightly-moving dataAsOf", () => {
    assert.doesNotMatch(
      CODE,
      /isAnalystConsensusStale\([^)]*dataAsOf/,
      "dataAsOf is max(fetchedAt, ratiosDerivedAt) and moves every night — " +
        "gating on it would keep a frozen consensus on screen forever"
    );
  });

  it("no longer attributes the estimates to the row's `source`", () => {
    // After the switchover `source` is NSE_XBRL on a row whose analyst fields
    // are Tickertape's. The honest substitute is the DATE, not a name.
    assert.doesNotMatch(
      CODE,
      /aggregated by \{data\.source\}/,
      "NSE_XBRL did not issue a broker price target"
    );
    assert.match(CODE, /Third-party analyst estimates/);
    assert.match(CODE, /last updated \$\{asOf\}/);
  });

  it("keeps the SEBI disclaimer — this removal must not take it with it", () => {
    assert.match(CODE, /SEBI_SHORT/);
    assert.match(CODE, /not a UseMoney\s*\n?\s*recommendation/);
  });
});
