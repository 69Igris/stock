/**
 * MONEY-979 (T10) — the four US research tools.
 *
 * The output builders (`buildUs*Output`) are the REAL exported functions and
 * are driven with plain repository envelopes, so the payload shape and the
 * `dataGap` wording are covered with no database and no network. The registry
 * half asserts the two things that are separately easy to forget: a tool must
 * be REGISTERED to be callable, and it must be ALLOW-LISTED in
 * `skill-tool-map.ts` or the custom-skill trim silently drops it — the
 * MONEY-490 / MONEY-650 class, where `compute_beta` sat referenced by a skill
 * and unregistered for two releases.
 *
 * MUTATION-VERIFIED — each `MUTATION:` note names the edit applied, confirmed
 * RED, and reverted.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ResearchToolRegistry } from "../src/tools/registry";
import {
  buildUsFinancialsOutput,
  explainUsGap,
  normalizeUsStatementType,
  usToolMetadata,
  US_FIELDS_NOT_FILED,
  US_GAP_EXPLANATIONS,
  US_TOOL_SOURCE,
  type UsToolResult,
} from "../src/tools/fetch-us-financials";
import { buildUsInsiderOutput } from "../src/tools/fetch-us-insider-trades";
import {
  buildUs13fOutput,
  partitionHolders,
  type UsHolderDeltaLike,
} from "../src/tools/fetch-us-13f-holders";
import {
  buildUsFilingsOutput,
  resolveUsForms,
  US_FORM_PRESETS,
} from "../src/tools/fetch-us-filings";
import {
  SKILL_TOOL_ALLOWLIST,
  buildAllowedToolSet,
} from "../src/skills/skill-tool-map";
// The REASON_* constants themselves, not a transcription of them. See the
// parity describe at the bottom of this file for why a literal list here is the
// defect rather than the test.
import * as usCore from "@usemoney/core/us-fundamentals";

const US_TOOL_NAMES = [
  "fetch_us_financials",
  "fetch_us_insider_trades",
  "fetch_us_13f_holders",
  "fetch_us_filings",
] as const;

/**
 * Every `REASON_*` the repository exports, as `[exportName, wireValue]`.
 *
 * Read off the MODULE, so a reason added to `repository.ts` appears here the
 * moment it is exported. A transcribed list is what this file used to have and
 * it is the whole reason `HOLDER_SET_TRUNCATED`, `INSIDER_WINDOW_TRUNCATED` and
 * `REQUESTED_PERIOD_HAS_NO_ROWS` reached the model as "No data: <CODE>." while their
 * payloads were populated.
 */
const CORE_REASONS: Array<readonly [string, string]> = Object.entries(usCore)
  .filter(
    (entry): entry is [string, string] =>
      entry[0].startsWith("REASON_") && typeof entry[1] === "string",
  )
  .map(([name, value]) => [name, value] as const);

const CORE_REASON_VALUES = CORE_REASONS.map(([, value]) => value);

function ok<T>(rows: T[], asOf: string | null): UsToolResult<T> {
  return {
    rows,
    asOf,
    currency: "USD",
    origin: "DB",
    reason: null,
    degraded: false,
  };
}

function gap<T>(reason: string, degraded = false): UsToolResult<T> {
  return {
    rows: [],
    asOf: null,
    currency: "USD",
    origin: "NONE",
    reason,
    degraded,
  };
}

/* ════════════════════════════════════════════════════════════════════════
   1. Registry + allow-list
   ═══════════════════════════════════════════════════════════════════════ */

describe("US tools — registration and allow-listing", () => {
  const registry = new ResearchToolRegistry();

  it("all four names resolve from the registry", () => {
    // MUTATION: deleting `this.register(fetchUsFinancialsTool)` from
    // registerDefaults turned this RED. Restored.
    for (const name of US_TOOL_NAMES) {
      assert.equal(registry.has(name), true, `${name} is not registered`);
      const tool = registry.get(name);
      assert.ok(tool, `${name} did not resolve`);
      assert.equal(
        tool.name,
        name,
        "the registry key must equal the tool's own name",
      );
      assert.equal(tool.category, "data");
      assert.equal(typeof tool.execute, "function");
      assert.ok(
        tool.description.length > 20,
        `${name} needs a description a planner can read`,
      );
    }
  });

  it("none is in a skill allow-list yet, and that is deliberate", () => {
    // INVERTED from "every one appears in at least one allow-list" — MONEY-979.
    //
    // They were allow-listed across six skills, and
    // `synthesizer-prompt-required-sections.test.ts` caught what that cost:
    // the MINIMUM TASK COUNT floor is literally `tools + 2`, so one US tool on
    // `dcf-valuation` moved its floor from 8 to 9 for EVERY dcf query — Indian
    // ones included, where the tool can never fire. MONEY-1120 lowered that
    // floor precisely because a baseline unrelated to the selection pushed
    // /dcf into a 14-task plan that overran its 480s budget.
    //
    // The other half is currency: every downstream renderer prints a hardcoded
    // rupee symbol, so a USD tool inside an India-oriented skill's plan is how
    // USD reaches a rupee renderer. That is the same reason these ship as
    // separate tools rather than as a router inside `fetch_income_statement`.
    //
    // They stay REGISTERED and remain reachable on the default, non-skill path
    // (`applySkillPreferences` returns early when no skill is selected), so
    // this is a gating decision, not a disabling one. Flip it in the same
    // change that lands MONEY-982, along with the task-floor expectations.
    const listed = new Set<string>();
    for (const tools of Object.values(SKILL_TOOL_ALLOWLIST)) {
      for (const t of tools) listed.add(t);
    }
    for (const name of US_TOOL_NAMES) {
      assert.equal(
        listed.has(name),
        false,
        `${name} is allow-listed on a skill. That raises that skill's MINIMUM ` +
          `TASK COUNT by one for every query using it, including Indian ones, ` +
          `and puts USD into a plan whose renderers print rupees. Land ` +
          `MONEY-982 first.`,
      );
    }
  });

  it("the allow-list only names tools that actually exist", () => {
    // The other half of the MONEY-490 defect: a skill referencing a tool that
    // was never registered runs without it and reports nothing wrong.
    for (const name of US_TOOL_NAMES) {
      assert.equal(registry.has(name), true);
    }
    for (const [skill, tools] of Object.entries(SKILL_TOOL_ALLOWLIST)) {
      for (const t of tools) {
        if (!t.startsWith("fetch_us_")) continue;
        assert.equal(
          registry.has(t),
          true,
          `skill "${skill}" allow-lists ${t}, which is not registered`,
        );
      }
    }
  });

  it("buildAllowedToolSet does NOT surface them, while still trimming normally", () => {
    // The companion to the assertion above: the gate is real, not a no-op.
    for (const skill of [
      "fundamentals-core",
      "flows-and-positioning",
      "governance-flags",
      "catalyst-calendar",
    ] as const) {
      const allowed = buildAllowedToolSet([skill]);
      for (const name of US_TOOL_NAMES) {
        assert.equal(
          allowed.has(name),
          false,
          `${skill} surfaced ${name}; see the allow-list test above`,
        );
      }
      // ...and the skill still surfaces its OWN tools, so this is not passing
      // because `buildAllowedToolSet` returned an empty set.
      assert.ok(
        allowed.size > 0,
        `${skill} surfaced NO tools at all — the trim is broken, and the ` +
          `assertions above would pass vacuously`,
      );
    }
  });

  it("rejects a call with no symbol rather than querying for everyone", async () => {
    for (const name of [
      "fetch_us_financials",
      "fetch_us_insider_trades",
      "fetch_us_13f_holders",
    ]) {
      const out = await registry.execute(name, {});
      assert.equal(out.success, false, `${name} accepted an empty symbol`);
      assert.match(String(out.error), /symbol/i);
    }
    const filings = await registry.execute("fetch_us_filings", {});
    assert.equal(filings.success, false);
    assert.match(String(filings.error), /symbol or cik10/i);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   2. fetch_us_financials — shape, provenance, and the loud gap
   ═══════════════════════════════════════════════════════════════════════ */

describe("fetch_us_financials output", () => {
  const row = {
    period: "FY 2024",
    endDate: "2024-09-28T00:00:00.000Z",
    accession: "0000320193-24-000123",
    filedAt: "2024-11-01T00:00:00.000Z",
    form: "10-K",
    fiscalYear: 2024,
    fiscalPeriod: "FY",
    currency: "USD" as const,
    revenue: 391_035_000_000,
    netIncome: 93_736_000_000,
    operatingCashFlow: 118_254_000_000,
    capitalExpenditure: -9_447_000_000,
    totalAssets: 364_980_000_000,
  };

  it("emits `annual` — the SAME key input-bindings.ts reads by name", () => {
    const out = buildUsFinancialsOutput({
      symbol: "AAPL",
      statementType: "INCOME",
      annual: ok([row], "2024-11-01T00:00:00.000Z"),
    });
    const data = out.data as Record<string, unknown>;
    assert.equal(out.success, true);
    assert.ok(
      Array.isArray(data.annual),
      "compute tools read dep.result.annual[last].<field>",
    );
    const first = (data.annual as Array<Record<string, unknown>>)[0];
    assert.equal(first?.revenue, 391_035_000_000);
    assert.equal(first?.operatingCashFlow, 118_254_000_000);
    assert.equal(first?.capitalExpenditure, -9_447_000_000);
    assert.equal(first?.accession, "0000320193-24-000123");
    assert.equal(first?.currency, "USD");
  });

  it("names SEC_EDGAR, the row's own asOf, and USD in the metadata", () => {
    const out = buildUsFinancialsOutput({
      symbol: "AAPL",
      statementType: "INCOME",
      annual: ok([row], "2024-11-01T00:00:00.000Z"),
      asOfRequested: "2025-01-01",
    });
    const meta = out.metadata as Record<string, unknown>;
    assert.equal(meta.source, US_TOOL_SOURCE);
    assert.equal(meta.source, "SEC_EDGAR");
    assert.equal(meta.currency, "USD");
    assert.equal(meta.asOf, "2024-11-01T00:00:00.000Z");
    assert.equal(meta.asOfRequested, "2025-01-01");
    assert.equal(meta.pointInTime, true);
    assert.equal(meta.recordCount, 1);
    assert.equal(meta.dbOnly, true);
    assert.equal(
      meta.dataGap,
      undefined,
      "a non-empty result must NOT claim a gap",
    );
  });

  it("an empty result carries a dataGap that explains WHICH empty it is", () => {
    // MUTATION: dropping the `...(gap ? { dataGap: gap, reason } : {})` spread
    // from usToolMetadata turned this RED on both assertions. Restored.
    const out = buildUsFinancialsOutput({
      symbol: "RELIANCE.NS",
      statementType: "INCOME",
      annual: gap("SYMBOL_NOT_IN_US_UNIVERSE"),
    });
    const meta = out.metadata as Record<string, unknown>;
    assert.equal(out.success, true, "a gap is data, not an error");
    assert.deepEqual((out.data as Record<string, unknown>).annual, []);
    assert.equal(meta.reason, "SYMBOL_NOT_IN_US_UNIVERSE");
    assert.match(String(meta.dataGap), /no active US listing/i);
    assert.match(String(meta.dataGap), /Indian symbol/i);
  });

  it("distinguishes EVERY way a result can be empty or partial", () => {
    // DERIVED from core's constants, never from a literal list. The literal
    // four this used to iterate is exactly why three reason codes shipped with
    // no sentence: the list agreed with itself. See the parity describe below.
    const seen = new Map<string, string>();
    for (const reason of CORE_REASON_VALUES) {
      const text = explainUsGap(reason);
      assert.ok(text && text.length > 20, `${reason} has no explanation`);
      const twin = seen.get(text);
      assert.equal(
        twin,
        undefined,
        `${reason} reuses ${twin}'s wording — each reason is a DIFFERENT fact`,
      );
      seen.set(text, reason);
    }
    assert.equal(explainUsGap(null), undefined);
  });

  it("a degraded (partial) result says so in the metadata", () => {
    const out = buildUsFinancialsOutput({
      symbol: "AAPL",
      statementType: "INCOME",
      annual: {
        ...ok([row], "2024-11-01T00:00:00.000Z"),
        reason: "COLD_SHARD_READ_FAILED",
        degraded: true,
      },
    });
    const meta = out.metadata as Record<string, unknown>;
    assert.equal(meta.degraded, true);
    assert.match(String(meta.dataGap), /SUBSET/);
  });

  it("declares ebitda as not filed rather than deriving it", () => {
    const out = buildUsFinancialsOutput({
      symbol: "AAPL",
      statementType: "INCOME",
      annual: ok([row], "2024-11-01T00:00:00.000Z"),
    });
    const data = out.data as Record<string, unknown>;
    assert.deepEqual(data.notReported, [...US_FIELDS_NOT_FILED]);
    assert.deepEqual([...US_FIELDS_NOT_FILED], ["ebitda"]);
    assert.match(String(data.note), /US DOLLARS/);
  });

  it("normalises a planner's spelling of the statement name", () => {
    assert.equal(normalizeUsStatementType("income"), "INCOME");
    assert.equal(normalizeUsStatementType("Balance Sheet"), "BALANCE_SHEET");
    assert.equal(normalizeUsStatementType("cash flow"), "CASH_FLOW");
    assert.equal(normalizeUsStatementType("CASH_FLOW"), "CASH_FLOW");
    assert.equal(normalizeUsStatementType(undefined), "INCOME");
    assert.equal(normalizeUsStatementType("nonsense"), "INCOME");
  });

  it("usToolMetadata never invents an asOf out of the clock", () => {
    const meta = usToolMetadata(gap("NO_ROWS_FOR_QUERY"));
    assert.equal(
      meta.asOf,
      null,
      "a fetch time here would make a stale table look fresh",
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════
   3. fetch_us_insider_trades
   ═══════════════════════════════════════════════════════════════════════ */

describe("fetch_us_insider_trades output", () => {
  const summary = {
    windowDays: 180,
    netOpenMarketShares: -100_000,
    byClass: {
      OPEN_MARKET_SELL: {
        codes: ["S"],
        rows: 1,
        shares: -100_000,
        value: -22_000_000,
      },
      TAX_WITHHOLDING: {
        codes: ["F"],
        rows: 1,
        shares: -240_000,
        value: -52_800_000,
      },
    },
  };

  it("ships the per-class summary and a note that F is not S", () => {
    const out = buildUsInsiderOutput({
      symbol: "AAPL",
      windowDays: 180,
      result: ok(
        [{ accession: "A", transactionCode: "S" }],
        "2026-08-01T00:00:00.000Z",
      ),
      summary,
    });
    const data = out.data as Record<string, unknown>;
    assert.equal(out.success, true);
    assert.equal(
      (data.summary as Record<string, unknown>).netOpenMarketShares,
      -100_000,
    );
    assert.match(String(data.note), /code F is a tax withholding/i);
    assert.match(String(data.note), /never be summed with a code S/i);
    assert.equal(
      (data.codeLegend as Record<string, string>).F?.includes("tax"),
      true,
    );
    assert.equal(
      (data.codeLegend as Record<string, string>).S?.includes("sale"),
      true,
    );
  });

  it("an empty window is a named gap, not silence", () => {
    const out = buildUsInsiderOutput({
      symbol: "AAPL",
      windowDays: 30,
      result: gap("NO_ROWS_FOR_QUERY"),
      summary: { windowDays: 30, netOpenMarketShares: 0, byClass: {} },
    });
    const meta = out.metadata as Record<string, unknown>;
    assert.equal(meta.source, "SEC_EDGAR");
    assert.equal(meta.windowDays, 30);
    assert.match(String(meta.dataGap), /no rows matching this query/i);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   4. fetch_us_13f_holders — the exits must stay visible
   ═══════════════════════════════════════════════════════════════════════ */

function holder(over: Partial<UsHolderDeltaLike>): UsHolderDeltaLike {
  return {
    managerCik10: "M",
    managerName: "Fake Capital",
    shares: 0,
    valueUsd: 0,
    sharesDelta: 0,
    valueDelta: 0,
    isNew: false,
    isExited: false,
    // The ordinary case: one filed row, nothing summed.
    rowsAggregated: 1,
    ...over,
  };
}

describe("fetch_us_13f_holders output", () => {
  const rows: UsHolderDeltaLike[] = [
    holder({
      managerCik10: "M1",
      shares: 40_000,
      valueUsd: 9_000_000,
      sharesDelta: 2_000,
      valueDelta: 1_000_000,
    }),
    holder({
      managerCik10: "M2",
      shares: 20_000,
      valueUsd: 5_000_000,
      sharesDelta: 20_000,
      valueDelta: 5_000_000,
      isNew: true,
    }),
    holder({
      managerCik10: "SELLER",
      sharesDelta: -33_000,
      valueDelta: -7_500_000,
      isExited: true,
    }),
  ];

  it("keeps exits in their OWN array so a top-N read cannot miss the seller", () => {
    // MUTATION: changing `partitionHolders` to
    // `{ holders: [...rows], exits: [] }` turned this RED. Restored.
    const split = partitionHolders(rows);
    assert.equal(split.holders.length, 2);
    assert.equal(split.exits.length, 1);
    assert.equal(split.exits[0]?.managerCik10, "SELLER");
    assert.equal(split.exitedCount, 1);
    assert.equal(split.newCount, 1);
    assert.equal(
      split.holders.some((h) => h.isExited),
      false,
      "an exited manager must never be listed as a holder",
    );
  });

  it("nets the exits INTO the value delta — a big exit is an outflow", () => {
    const split = partitionHolders(rows);
    assert.equal(
      split.totalValueUsd,
      14_000_000,
      "held value excludes the exited position",
    );
    assert.equal(
      split.netValueDeltaUsd,
      1_000_000 + 5_000_000 - 7_500_000,
      "a net computed over held rows alone would report this quarter as an inflow",
    );
    assert.ok(split.netValueDeltaUsd < 0);
  });

  it("carries the period, USD, and a note about options rows", () => {
    const out = buildUs13fOutput({
      symbol: "AAPL",
      result: ok(rows, "2026-06-30T00:00:00.000Z"),
    });
    const data = out.data as Record<string, unknown>;
    assert.equal(data.period, "2026-06-30T00:00:00.000Z");
    assert.equal(data.currency, "USD");
    assert.match(String(data.note), /whole US dollars/i);
    assert.match(String(data.note), /Put\/Call/);
    const meta = out.metadata as Record<string, unknown>;
    assert.equal(meta.holderCount, 2);
    assert.equal(meta.exitedCount, 1);
  });

  it("a first period explains why every holder looks new", () => {
    const out = buildUs13fOutput({
      symbol: "AAPL",
      result: {
        ...ok(rows, "2026-06-30T00:00:00.000Z"),
        reason: "NO_PRIOR_13F_PERIOD",
        degraded: true,
      },
    });
    const meta = out.metadata as Record<string, unknown>;
    assert.match(String(meta.dataGap), /earliest 13F period/i);
    assert.equal(meta.degraded, true);
  });

  it("does not divide by zero on an empty result", () => {
    const split = partitionHolders([]);
    assert.equal(split.totalValueUsd, 0);
    assert.equal(split.netValueDeltaUsd, 0);
    assert.equal(Number.isNaN(split.netValueDeltaUsd), false);
    assert.equal(split.aggregatedPositions, 0);
    assert.equal(split.maxRowsAggregated, 0);
  });

  /* ── rowsAggregated: the number a reader cannot find in EDGAR ──────────── */

  it("says nothing about aggregation when every position is one filed row", () => {
    // MUTATION: changing the `if (split.maxRowsAggregated <= 1) return ""`
    // guard to `< 1` turned this RED. `rowsAggregated: 1` is the common case;
    // a permanent sentence about it is noise the model re-reads every query.
    const out = buildUs13fOutput({
      symbol: "AAPL",
      result: ok(rows, "2026-06-30T00:00:00.000Z"),
    });
    const data = out.data as Record<string, unknown>;
    assert.equal(data.aggregatedPositions, 0);
    assert.equal(data.maxRowsAggregated, 1);
    assert.equal(
      /SUM of several filed rows/.test(String(data.note)),
      false,
      "an unsummed payload must not carry the aggregation caveat",
    );
  });

  it("explains a SUMMED position, because no EDGAR row will match it", () => {
    // MUTATION: replacing the note's `describeAggregation(split)` suffix with
    // `""` turned this RED. Berkshire's Apple position is 227,917,808 shares
    // and no filed row says that — SEC splits it across TWELVE rows by
    // `otherManagers`, the largest 3,840,000. Without this the discrepancy
    // reads as a bug in our data.
    const summed: UsHolderDeltaLike[] = [
      holder({
        managerCik10: "0001067983",
        managerName: "BERKSHIRE HATHAWAY INC",
        shares: 227_917_808,
        valueUsd: 60_000_000_000,
        rowsAggregated: 12,
      }),
      holder({
        managerCik10: "M2",
        shares: 1_000,
        valueUsd: 250_000,
        rowsAggregated: 2,
      }),
      holder({ managerCik10: "M3", shares: 500, valueUsd: 125_000 }),
    ];
    const split = partitionHolders(summed);
    assert.equal(split.aggregatedPositions, 2, "M3 files one row and is not");
    assert.equal(split.maxRowsAggregated, 12);

    const out = buildUs13fOutput({
      symbol: "AAPL",
      result: ok(summed, "2026-06-30T00:00:00.000Z"),
    });
    const note = String((out.data as Record<string, unknown>).note);
    assert.match(note, /2 of these positions are the SUM/);
    assert.match(note, /largest: 12 rows/);
    assert.match(
      note,
      /NO single row in EDGAR will match/,
      "the point is that the number is unreconcilable without this",
    );
    assert.match(
      note,
      /AMENDMENT does not add to this count/,
      "a newer accession REPLACES the original — the count is rows within the " +
        "winning filing, not rows ever filed",
    );
  });

  it("counts an EXIT's aggregation too, and survives a junk rowsAggregated", () => {
    const split = partitionHolders([
      holder({ managerCik10: "SELLER", isExited: true, rowsAggregated: 5 }),
      // A repository that stopped setting the field must not produce NaN.
      { ...holder({ managerCik10: "M9" }), rowsAggregated: undefined },
    ] as UsHolderDeltaLike[]);
    assert.equal(split.aggregatedPositions, 1, "the exit is counted");
    assert.equal(split.maxRowsAggregated, 5);
    assert.equal(Number.isNaN(split.maxRowsAggregated), false);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   5. fetch_us_filings
   ═══════════════════════════════════════════════════════════════════════ */

describe("fetch_us_filings output", () => {
  it("expands a preset name into a form list", () => {
    assert.deepEqual(resolveUsForms("annual"), [...US_FORM_PRESETS.annual!]);
    assert.deepEqual(resolveUsForms("insider"), ["3", "4", "5"]);
    assert.deepEqual(resolveUsForms(""), []);
    assert.deepEqual(resolveUsForms(undefined), []);
  });

  it("the ownership preset carries BOTH 13D spellings", () => {
    // Filings before the 2024-12-18 XML mandate are `SC 13D`; after it,
    // `SCHEDULE 13D`. A filter that knows one spelling drops half the history.
    const forms = resolveUsForms("ownership");
    assert.ok(forms.includes("SC 13D"));
    assert.ok(forms.includes("SCHEDULE 13D"));
    assert.ok(forms.includes("SC 13G"));
    assert.ok(forms.includes("SCHEDULE 13G"));
  });

  it("accepts a comma list and an array, upper-casing and de-duplicating", () => {
    assert.deepEqual(resolveUsForms(" 10-k , 10-q "), ["10-K", "10-Q"]);
    assert.deepEqual(resolveUsForms(["8-k", "8-K", ""]), ["8-K"]);
  });

  it("explains that filedAt and acceptedAt are different clocks", () => {
    const out = buildUsFilingsOutput({
      symbol: "AAPL",
      cik10: null,
      forms: ["8-K"],
      result: ok(
        [
          {
            accession: "0000320193-26-000106",
            form: "8-K",
            filedAt: "2026-08-01T00:00:00.000Z",
            acceptedAt: "2026-07-31T21:53:00.000Z",
            status: "PARSED",
          },
        ],
        "2026-08-01T00:00:00.000Z",
      ),
    });
    const data = out.data as Record<string, unknown>;
    assert.match(String(data.note), /acceptedAt/);
    assert.match(String(data.note), /WITHDRAWN/);
    assert.equal((out.metadata as Record<string, unknown>).source, "SEC_EDGAR");
  });

  it("an unresolvable identity is a named gap", () => {
    const out = buildUsFilingsOutput({
      symbol: "NOCIK",
      cik10: null,
      forms: [],
      result: gap("SYMBOL_HAS_NO_SEC_CIK"),
    });
    assert.equal(out.success, true);
    assert.match(
      String((out.metadata as Record<string, unknown>).dataGap),
      /no SEC CIK/i,
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════
   6. Reason-code parity — core writes them, this package must SPEAK them
   ═══════════════════════════════════════════════════════════════════════ */

describe("US gap explanations ↔ core REASON_* parity", () => {
  it("derives the reason list from the module, not from a literal", () => {
    // The vacuity guard. Every assertion below iterates CORE_REASONS, so an
    // import that resolved to an empty namespace would make all of them pass
    // over nothing. 14 is the count at the time of writing; the floor moves UP
    // with the seam, never down.
    assert.ok(
      CORE_REASONS.length >= 14,
      `only ${CORE_REASONS.length} REASON_* constants were read off ` +
        `@usemoney/core/us-fundamentals — the import is broken and every ` +
        `parity assertion below would pass vacuously`,
    );
    assert.equal(usCore.REASON_HOLDER_SET_TRUNCATED, "HOLDER_SET_TRUNCATED");
    assert.equal(
      usCore.REASON_INSIDER_WINDOW_TRUNCATED,
      "INSIDER_WINDOW_TRUNCATED",
    );
    assert.equal(
      usCore.REASON_REQUESTED_PERIOD_EMPTY,
      "REQUESTED_PERIOD_HAS_NO_ROWS",
    );
  });

  it("every reason the repository can emit has a written sentence", () => {
    // MUTATION: deleting the `HOLDER_SET_TRUNCATED` entry from
    // US_GAP_EXPLANATIONS turned this RED, naming the constant. Restored.
    //
    // This is the assertion that was missing. All three of the reason codes
    // 635b541c added reached `usToolMetadata` and fell through to the
    // catch-all, so the model was told "No data: HOLDER_SET_TRUNCATED."
    // ALONGSIDE a populated holders array — a false sentence, and one that
    // says nothing about the derived fields that are actually unsafe.
    const unexplained = CORE_REASONS.filter(
      ([, value]) => !(value in US_GAP_EXPLANATIONS),
    );
    assert.deepEqual(
      unexplained.map(([name, value]) => `${name}=${value}`),
      [],
      "a reason with no entry in US_GAP_EXPLANATIONS reaches the model as " +
        "`No data: <CODE>.` — add a sentence saying what is actually unsafe",
    );
  });

  it("no reason falls through to the `No data:` catch-all", () => {
    // The catch-all stays in `explainUsGap` for a value from somewhere this
    // package does not know about. NOTHING the repository exports may reach it.
    for (const [name, value] of CORE_REASONS) {
      const text = String(explainUsGap(value));
      assert.equal(
        /^No data: /.test(text),
        false,
        `${name} fell through to the catch-all: ${text}`,
      );
    }
  });

  it("US_GAP_EXPLANATIONS carries no entry core can never emit", () => {
    // The other direction. A key that matches no constant is a dead sentence —
    // most likely a typo'd code, which reads as covered while the real code
    // still hits the catch-all.
    const orphans = Object.keys(US_GAP_EXPLANATIONS).filter(
      (key) => !CORE_REASON_VALUES.includes(key),
    );
    assert.deepEqual(
      orphans,
      [],
      "these keys match no exported REASON_* constant",
    );
  });

  it("a TRUNCATION never claims there is no data, and names what is unsafe", () => {
    // MUTATION: replacing the HOLDER_SET_TRUNCATED sentence with
    // "No data: HOLDER_SET_TRUNCATED." turned all three assertions for it RED.
    // Restored.
    //
    // These three ride on a POPULATED payload, which is what made the
    // catch-all's wording false rather than merely unhelpful.
    const holders = String(explainUsGap(usCore.REASON_HOLDER_SET_TRUNCATED));
    assert.equal(/no data/i.test(holders), false);
    assert.match(holders, /isNew/);
    assert.match(holders, /isExited/);
    assert.match(holders, /unsafe/i);

    const insider = String(
      explainUsGap(usCore.REASON_INSIDER_WINDOW_TRUNCATED),
    );
    assert.equal(/no data/i.test(insider), false);
    assert.match(
      insider,
      /netOpenMarketShares/,
      "the summary TOTALS are what a truncated window makes wrong",
    );
    assert.match(insider, /subset/i);

    const ambiguous = String(explainUsGap(usCore.REASON_AMBIGUOUS_AMENDMENT));
    assert.equal(/no data/i.test(ambiguous), false);
  });

  it("REQUESTED_PERIOD_HAS_NO_ROWS names BOTH ways it is reached", () => {
    // MEDIUM finding 2. The branch fires for ingestion lag AND for a caller
    // passing an offset-bearing timestamp that misses `current` by exact
    // DateTime equality. A sentence naming only the lag turns a caller bug
    // into a reassuring "not ingested yet" nobody investigates.
    const text = String(explainUsGap(usCore.REASON_REQUESTED_PERIOD_EMPTY));
    assert.match(text, /45 days/, "the ingestion-lag cause");
    assert.match(
      text,
      /exact/i,
      "the exact-timestamp-equality cause — the caller-side one",
    );
    assert.match(text, /offset|timezone/i);
    assert.match(
      text,
      /not?t?\s*(read|treat)|do NOT/i,
      "it must warn against reading this as everyone selling",
    );
  });

  it("the three reason codes 635b541c added reach the model with meaning", () => {
    // END-TO-END through the REAL tool builders, which is where the defect was
    // observed: `dataGap: "No data: HOLDER_SET_TRUNCATED."` printed next to
    // `holderCount: 1` and a populated `holders` array.
    const truncatedHolders = buildUs13fOutput({
      symbol: "AAPL",
      result: {
        ...ok(
          [
            holder({
              managerCik10: "0001067983",
              shares: 300_000_000,
              valueUsd: 60_000_000_000,
            }),
          ],
          "2026-06-30T00:00:00.000Z",
        ),
        reason: usCore.REASON_HOLDER_SET_TRUNCATED,
        degraded: true,
      },
    });
    const holderMeta = truncatedHolders.metadata as Record<string, unknown>;
    assert.equal(
      holderMeta.holderCount,
      1,
      "the payload IS populated — which is what made `No data` false",
    );
    assert.equal(/no data/i.test(String(holderMeta.dataGap)), false);
    assert.match(String(holderMeta.dataGap), /isExited/);

    const truncatedInsiders = buildUsInsiderOutput({
      symbol: "AAPL",
      windowDays: 180,
      result: {
        ...ok(
          [{ accession: "A", transactionCode: "S" }],
          "2026-08-01T00:00:00.000Z",
        ),
        reason: usCore.REASON_INSIDER_WINDOW_TRUNCATED,
        degraded: true,
      },
      summary: { windowDays: 180, netOpenMarketShares: -12_345, byClass: {} },
    });
    const insiderMeta = truncatedInsiders.metadata as Record<string, unknown>;
    assert.equal(
      (
        (truncatedInsiders.data as Record<string, unknown>).summary as Record<
          string,
          unknown
        >
      ).netOpenMarketShares,
      -12_345,
      "a signed total is shipped — `No data` next to it was a false sentence",
    );
    assert.equal(/no data/i.test(String(insiderMeta.dataGap)), false);
    assert.match(String(insiderMeta.dataGap), /netOpenMarketShares/);

    const notIngested = buildUs13fOutput({
      symbol: "AAPL",
      result: gap(usCore.REASON_REQUESTED_PERIOD_EMPTY, true),
    });
    const gapMeta = notIngested.metadata as Record<string, unknown>;
    assert.equal(gapMeta.reason, "REQUESTED_PERIOD_HAS_NO_ROWS");
    assert.equal(/^No data: /.test(String(gapMeta.dataGap)), false);
    assert.match(String(gapMeta.dataGap), /45 days/);
  });
});
