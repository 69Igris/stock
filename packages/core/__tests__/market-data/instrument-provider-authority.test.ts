/**
 * Which fields a provider may overwrite on an EXISTING row (MONEY-1093).
 *
 * This guards a bug that produced no error and no wrong value — just data that
 * never moved. `instrument-sync` runs nightly at 22:00 IST; `bhavcopy-sync` at
 * 21:00 IST on weekdays. Zerodha's `mapToUpsert` emitted `series` from Kite's
 * `instrument_type` column — the literal string "EQ" for every cash instrument,
 * bonds included — so one hour after the price feed wrote the real exchange
 * series, the instrument sync stamped it back. `instrumentType` was worse: a
 * deliberate DEBT/REIT re-classification reverted to EQUITY within 24h.
 *
 * The whole MONEY-1093 pipeline treats those two fields as durable state, so
 * without this split none of it survives a single night.
 *
 * The last group is the important one. On MONEY-1092 a fix was shipped that
 * looked right and was inert, because the unit was tested and the CALL SITE was
 * not — the narrowed payload has to actually reach the `update:` clause.
 *
 * Sources:
 *   packages/core/src/market-data/instruments/zerodha-instruments.ts
 *   packages/core/src/market-data/instruments/instrument-sync.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

/**
 * Repo root, by walking up from cwd to `yarn.lock`. Works from any cwd and
 * under any module target — unlike a cwd-relative path (breaks when the suite
 * runs from the repo root) or `import.meta.dirname` (undefined under some
 * workspaces' module targets).
 *
 * ANCHORED ON `yarn.lock`, NOT `turbo.json` (MONEY-1198). Turborepo 2.x
 * supports PACKAGE CONFIGURATIONS — a `turbo.json` inside a package that
 * overrides tasks for it — so `turbo.json` is not a repo-root marker at all,
 * merely a file that usually happens to appear only at the root. The moment
 * `packages/core/turbo.json` was added (to stop test-only edits busting the
 * build cache) this walk stopped one directory in, and every path below
 * resolved against `packages/core`.
 *
 * It failed SILENTLY and in the worst direction: the old fallback returned
 * `process.cwd()` on a miss, so `readFileSync` of a now-wrong path yielded `""`
 * and the assertions compared against an empty string — reporting "the call
 * site does not use the composed payload" when the real answer was "this suite
 * could not find the file". A structural test that cannot find its subject must
 * FAIL LOUDLY, never quietly assert about nothing.
 *
 * `yarn.lock` is unshadowable in a Yarn workspace: exactly one exists, at the
 * root, by definition of a single-lockfile workspace.
 */
function repoRoot(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "yarn.lock"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(
    "repoRoot(): walked up 8 levels from " +
      process.cwd() +
      " without finding yarn.lock. Refusing to fall back to cwd — that would " +
      "make every path below resolve to an empty read and turn this suite " +
      "into one that asserts about nothing.",
  );
}

/**
 * Read a repo-relative source file, returning "" rather than throwing.
 *
 * This matters more than it looks. A throw inside a `describe` callback is
 * reported by node as a DROPPED SUITE with `fail 0` and exit 0 — so a path
 * mistake deletes the guard silently instead of failing it. The first version of
 * this file threw from the repo root and quietly ran 7 cases instead of 10,
 * green. An empty string plus an explicit assertion fails loudly instead.
 */
function readRepoFile(...parts: string[]): string {
  const full = join(repoRoot(), ...parts);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

/**
 * Extract the body of a `key: { ... }` object literal by brace matching.
 *
 * A prefix-anchored regex is not enough here. The bug this file guards is
 * restored by APPENDING `series: upsertData.series` after the spread — and the
 * source already appends `yahooSymbol` in exactly that position, so appending is
 * the established pattern in this block. Only reading the whole literal can see
 * it. Returns null if the key is absent, so callers can assert "did it move?"
 * rather than silently matching nothing.
 */
function objectLiteralBody(src: string, key: string): string | null {
  const at = src.indexOf(`${key}:`);
  if (at === -1) return null;
  const open = src.indexOf("{", at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

import { ZerodhaInstrumentProvider } from "../../src/market-data/instruments/zerodha-instruments";
import {
  composeUpdatePayload,
  judgeDeactivationSweep,
  DEACTIVATION_FLOOR,
} from "../../src/market-data/instruments/instrument-sync";
import { NseMasterInstrumentProvider } from "../../src/market-data/instruments/nse-master-instruments";
import type { RawInstrument } from "../../src/market-data/instruments/types";

const provider = new ZerodhaInstrumentProvider();

/** A cash-equity row as Kite hands it over: series is the stamped "EQ". */
function cashRow(overrides: Partial<RawInstrument> = {}): RawInstrument {
  return {
    symbol: "885PFL31",
    exchange: "NSE",
    name: "8.85% PIRAMAL FINANCE 2031",
    tradingSymbol: "885PFL31",
    instrumentType: "EQUITY",
    series: "EQ",
    lotSize: 1,
    tickSize: 0.01,
    zerodhaToken: 12345,
    ...overrides,
  } as RawInstrument;
}

describe("Zerodha CREATE payload is unchanged", () => {
  it("still writes series and instrumentType on a brand-new row", () => {
    // On a fresh row a guess beats nothing — there is no better value to lose.
    const created = provider.mapToUpsert(cashRow());
    assert.equal(created.series, "EQ");
    assert.equal(created.instrumentType, "EQUITY");
  });

  it("still omits isin, which Kite genuinely does not carry", () => {
    // The pre-existing precedent this change generalises.
    assert.equal(provider.mapToUpsert(cashRow()).isin, undefined);
  });
});

describe("Zerodha UPDATE payload drops what Kite does not source", () => {
  it("NEVER sends series", () => {
    // Kite's `instrument_type` column is not the exchange settlement series.
    // The bhavcopy and the NSE master files are; this must not outrank them.
    const upd = provider.mapToUpdate(cashRow());
    assert.ok(
      !("series" in upd),
      "series must be absent from the key set, not merely undefined — " +
        "Prisma only preserves the other writer's value for an ABSENT key",
    );
  });

  it('drops instrumentType when it is the generic "EQUITY" fallback', () => {
    // INSTRUMENT_TYPE_MAP returns "EQUITY" for anything unrecognised, so here
    // "EQUITY" means "no evidence", not "is an equity".
    assert.ok(!("instrumentType" in provider.mapToUpdate(cashRow())));
  });

  it("writes NO instrumentType on an existing row, even a positive match", () => {
    // This used to keep a positively-identified type, reasoning that a positive
    // match is evidence. It caused a live nightly OSCILLATION: a row the audited
    // script had typed DEBT, whose Kite NAME matches isETF or
    // classifyTrustInstrument, was flipped to ETF/REIT at 22:00 and flipped back
    // by the next `reclassify --apply`. Nothing is lost — the bhavcopy backfill
    // types ETFs too, guarded so it only moves a row OFF the stamped default.
    for (const t of ["ETF", "REIT", "INVIT", "FUTURES", "OPTIONS", "INDEX"]) {
      assert.ok(
        !(
          "instrumentType" in
          provider.mapToUpdate(cashRow({ instrumentType: t }))
        ),
        `${t} must not be written to an existing row`,
      );
    }
  });

  it("keeps every field Kite IS authoritative for", () => {
    // The narrowing must be surgical: this provider is the only source of the
    // broker token, trading symbol and lot/tick sizes.
    const upd = provider.mapToUpdate(cashRow());
    assert.equal(upd.zerodhaToken, 12345);
    assert.equal(upd.tradingSymbol, "885PFL31");
    assert.equal(upd.lotSize, 1);
    assert.equal(upd.tickSize, 0.01);
    assert.equal(upd.isActive, true);
  });

  it("a DEBT row survives a sync — the actual regression", () => {
    // End-to-end statement of the bug: nothing in the update payload can move
    // a row that has been classified DEBT back to EQUITY.
    const upd = provider.mapToUpdate(cashRow());
    assert.ok(!("instrumentType" in upd));
    assert.ok(!("series" in upd));
  });
});

describe("the COMPOSED update payload — a real assertion, not a regex", () => {
  // The previous guard matched field NAMES inside the source's object literal.
  // Appending `...upsertData` after the narrowed spread — the pre-fix code,
  // restoring MONEY-1093 in full — kept it green, because the literal still had
  // no `series:` token in it. The invariant was never about syntax; it is about
  // the RESULT: whatever a provider narrows away must not reappear.
  // Constructed LAZILY, inside each case.
  //
  // These three lines used to run in the DESCRIBE BODY, and node reports a throw
  // there as a dropped suite: `fail 0`, exit 0. Making `mapToUpsert` throw on its
  // first call took this file from 16 cases to 11 with `yarn test` still green —
  // silently deleting the strongest assertion on this ticket. Inside an `it`, the
  // same throw is a FAILURE.
  const fixture = () => {
    const zerodha = new ZerodhaInstrumentProvider();
    const raw = cashRow();
    return { zerodha, raw, upsertData: zerodha.mapToUpsert(raw) };
  };

  it("omits series and instrumentType for a narrowing provider", () => {
    const { zerodha, raw, upsertData } = fixture();
    const out = composeUpdatePayload(zerodha, raw, upsertData, "885PFL31.NS");
    assert.ok(!("series" in out), "series must not reach an existing row");
    assert.ok(!("instrumentType" in out), "generic EQUITY must not be written");
  });

  it("keeps the fields the provider IS authoritative for", () => {
    const { zerodha, raw, upsertData } = fixture();
    const out = composeUpdatePayload(zerodha, raw, upsertData, "885PFL31.NS");
    assert.equal(out.zerodhaToken, 12345);
    assert.equal(out.tradingSymbol, "885PFL31");
    assert.equal(out.yahooSymbol, "885PFL31.NS");
  });

  it("composes to a payload with NO instrumentType at all", () => {
    // Keeping a positively-identified type caused a nightly oscillation against
    // the audited repair script — see the note on mapToUpdate.
    const { zerodha } = fixture();
    const etf = cashRow({ instrumentType: "ETF" });
    const out = composeUpdatePayload(
      zerodha,
      etf,
      zerodha.mapToUpsert(etf),
      "X.NS",
    );
    assert.ok(!("instrumentType" in out), "no type on an existing row");
    assert.ok(!("series" in out), "no series either");
  });

  it("falls back to the full payload for a provider that does NOT narrow", () => {
    const { raw, upsertData } = fixture();
    const plain = {
      name: "no-narrowing",
      fetchInstruments: async () => [],
      mapToUpsert: () => upsertData,
    };
    const out = composeUpdatePayload(plain, raw, upsertData, "X.NS");
    assert.equal(out.series, "EQ", "back-compat: unchanged behaviour");
  });

  it("the yahooSymbol override cannot be shadowed by the provider", () => {
    const { zerodha, raw, upsertData } = fixture();
    const out = composeUpdatePayload(zerodha, raw, upsertData, "OVERRIDE.NS");
    assert.equal(out.yahooSymbol, "OVERRIDE.NS");
  });
});

describe("the NSE master provider narrows too", () => {
  // It was the one automatic writer left without a mapToUpdate, so via the
  // `?? upsertData` fallback it wrote instrumentType onto existing rows every
  // night — a value asserted from FILE MEMBERSHIP, not from the row. Harmless
  // only because NSE_MASTER_SERIES filters the parse to five cash-equity
  // series: an unasserted property of an external CSV, in a different file.
  const nse = new NseMasterInstrumentProvider();
  const row = {
    symbol: "RELIANCE",
    exchange: "NSE",
    name: "Reliance Industries",
    instrumentType: "EQUITY",
    series: "EQ",
    isin: "INE002A01018",
    lotSize: 1,
  } as RawInstrument;

  it("implements mapToUpdate at all", () => {
    assert.equal(
      typeof nse.mapToUpdate,
      "function",
      "without it the orchestrator falls back to the full upsert payload",
    );
  });

  it("does NOT write instrumentType on an existing row", () => {
    assert.ok(!("instrumentType" in nse.mapToUpdate!(row)));
  });

  it("DOES still write series — the master files are authoritative for it", () => {
    assert.equal(nse.mapToUpdate!(row).series, "EQ");
  });

  it("still writes instrumentType on a NEW row", () => {
    assert.equal(nse.mapToUpsert(row).instrumentType, "EQUITY");
  });
});

describe("the CALL SITE actually uses the composed payload", () => {
  /**
   * The behavioural tests above prove `composeUpdatePayload` narrows correctly.
   * They say nothing about whether `syncInstruments` CALLS it — and this file's
   * own header records why that matters: "a fix was shipped that looked right and
   * was inert, because the unit was tested and the CALL SITE was not."
   *
   * Round 3 of this ticket replaced a source-text guard with the pure-function
   * tests and deleted the call-site check along with it, leaving `readRepoFile`
   * and `objectLiteralBody` defined, documented and never called. Restoring
   * `update: { ...upsertData, yahooSymbol }` at the call site — MONEY-1093 in
   * full, `series: "EQ"` and `instrumentType: "EQUITY"` stamped onto every
   * existing row nightly — left all 16 cases here and all 830 in this package
   * green.
   *
   * So a source scan is the right tool for this ONE question, and it reads
   * COMMENT-STRIPPED source: three sibling guards on this branch were defeated by
   * quoting the required token in an adjacent comment.
   */
  const stripComments = (src: string) =>
    src.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");

  const syncSrc = stripComments(
    readRepoFile(
      "packages",
      "core",
      "src",
      "market-data",
      "instruments",
      "instrument-sync.ts",
    ),
  );

  it("found the orchestrator", () => {
    // Liveness: `readRepoFile` returns "" rather than throwing, so without this
    // a wrong path would make every assertion below vacuous — and a throw in a
    // describe body is a dropped suite (fail 0, exit 0) anyway.
    assert.ok(
      syncSrc.length > 2000,
      "instrument-sync.ts not found or unexpectedly small — did it move? " +
        "NOTE: the live orchestrator is packages/core/.../instrument-sync.ts, " +
        "NOT workers/src/processors/instrument-sync.ts (a review round mis-cited " +
        "the worker, which only enqueues).",
    );
    assert.ok(syncSrc.includes("composeUpdatePayload"));
  });

  /**
   * The argument object of `prisma.instrumentMapping.upsert({ ... })`.
   *
   * Anchored on the CALL, not on an `upsert:` property — there is no such
   * property, so `objectLiteralBody(src, "upsert")` returned null and the
   * assertion reported "no upsert literal found" instead of checking anything.
   * `objectLiteralBody` is still used below for the nested `where:` sanity check,
   * which does exist as a property.
   */
  function upsertArgs(src: string): string | null {
    const at = src.indexOf("instrumentMapping.upsert(");
    if (at === -1) return null;
    const open = src.indexOf("{", at);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) return src.slice(open + 1, i);
      }
    }
    return null;
  }

  /**
   * The `update:` clause's value, extracted by depth tracking.
   *
   * A `/update:([\s\S]*?),\s*create:/` regex assumed `update` precedes
   * `create`; in this source `create:` comes FIRST (line ~281 vs ~296), so the
   * regex matched nothing and the assertion reported "no update clause" rather
   * than checking one. Key order is not something a guard should depend on.
   */
  function updateClause(argsBody: string): string | null {
    const at = argsBody.search(/\bupdate\s*:/);
    if (at === -1) return null;
    const start = argsBody.indexOf(":", at) + 1;
    let depth = 0;
    for (let i = start; i < argsBody.length; i++) {
      const c = argsBody[i];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
      else if (c === "," && depth === 0) return argsBody.slice(start, i);
    }
    return argsBody.slice(start);
  }

  it("passes composeUpdatePayload's RESULT as the update clause", () => {
    const body = upsertArgs(syncSrc);
    assert.ok(body, "no instrumentMapping.upsert({...}) call found");
    assert.ok(
      objectLiteralBody(body!, "symbol_exchange"),
      "the upsert should still key on symbol_exchange",
    );
    const update = updateClause(body!);
    assert.ok(update, "no `update:` clause inside the upsert literal");
    assert.match(
      update!,
      /^\s*composeUpdatePayload\s*\(/,
      "the update clause must BE the composed payload. Building it inline — " +
        "even as `{ ...composeUpdatePayload(...) }` plus extra fields — is how " +
        "the narrowing was bypassed while every unit test stayed green.",
    );
  });

  it("does not spread the raw upsert payload into the update clause", () => {
    // The specific pre-fix shape, and the one an editor would most plausibly
    // reintroduce: the source already appends `yahooSymbol` in that position, so
    // appending is the established local pattern.
    const body = upsertArgs(syncSrc) ?? "";
    const update = updateClause(body);
    assert.doesNotMatch(
      update ?? "",
      /\.\.\.\s*upsertData/,
      "`...upsertData` in the update clause restores MONEY-1093 in full",
    );
  });
});

/**
 * MONEY-1263 — the deactivation sweep refuses to run away.
 *
 * `deactivateStaleInstruments` flips every active row a provider did not
 * return. Correct when the provider answered; catastrophic when it did not.
 * The case that made this real: running the US master WITHOUT
 * `options.exchanges` computes the still-active set from US symbols only and
 * deactivates all ~20,804 Indian rows — no error, `COMPLETED` sync log, and
 * every surface reading `isActive: true` goes blank.
 *
 * Refusal beats deactivate-and-alert because the sweep is not reversible:
 * undoing it means knowing which rows THIS run flipped, and once `isActive` is
 * false that set no longer exists.
 */
describe("deactivation sweep circuit breaker (MONEY-1263)", () => {
  it("REFUSES the scope-bug shape: the whole Indian universe at once", () => {
    const v = judgeDeactivationSweep({
      candidates: 20_804,
      activePopulation: 20_804,
    });
    assert.equal(v.proceed, false);
    assert.match(v.reason ?? "", /options\.exchanges/);
  });

  it("REFUSES a provider that returned nothing", () => {
    // Every row stale, so every row is a candidate.
    const v = judgeDeactivationSweep({
      candidates: 13_008,
      activePopulation: 13_008,
    });
    assert.equal(v.proceed, false);
  });

  it("ALLOWS a real delisting day — a handful against tens of thousands", () => {
    assert.equal(
      judgeDeactivationSweep({ candidates: 12, activePopulation: 23_738 })
        .proceed,
      true,
    );
  });

  it("ALLOWS a large-but-proportionate sweep under the ceiling", () => {
    // 2,000 of 23,738 is 8.4% — under 10%, so a genuine bulk delisting or a
    // series reclassification still goes through.
    assert.equal(
      judgeDeactivationSweep({ candidates: 2_000, activePopulation: 23_738 })
        .proceed,
      true,
    );
  });

  it("REFUSES just above the ceiling", () => {
    // 2,400 of 23,738 is 10.1%.
    assert.equal(
      judgeDeactivationSweep({ candidates: 2_400, activePopulation: 23_738 })
        .proceed,
      false,
    );
  });

  it("the FLOOR keeps small populations usable", () => {
    // 2 of 5 is 40% and entirely ordinary in a fixture or a tiny venue.
    // Proportion says nothing useful below the floor.
    assert.equal(
      judgeDeactivationSweep({ candidates: 2, activePopulation: 5 }).proceed,
      true,
    );
    assert.equal(
      judgeDeactivationSweep({
        candidates: DEACTIVATION_FLOOR - 1,
        activePopulation: DEACTIVATION_FLOOR,
      }).proceed,
      true,
    );
  });

  it("a zero population with candidates is refused, not divided by", () => {
    const v = judgeDeactivationSweep({ candidates: 100, activePopulation: 0 });
    assert.equal(v.proceed, false);
    assert.match(v.reason ?? "", /cannot be true/);
  });

  it("nothing to do is always allowed", () => {
    assert.equal(
      judgeDeactivationSweep({ candidates: 0, activePopulation: 0 }).proceed,
      true,
    );
  });
});
