/**
 * The exchange interlock must not starve the rotation — MONEY-1396.
 *
 * ## The defect, in three facts that are each individually correct
 *
 * 1. **The write refuses a mismatch.** `xbrl-ratios.ts` returns
 *    `exchange-mismatch` when the newest filing's exchange differs from the
 *    instrument's, because `stock_ratios` is `@@unique([symbol, exchange])` and
 *    writing an NSE filing's numbers onto a BSE key is a wrong row.
 * 2. **That cohort is almost the whole population.** Measured on prod
 *    2026-09-13: `xbrl_filings` carries `exchange: "NSE"` on all 108,073 rows,
 *    and the 2,807 instruments they resolve to are **643 NSE / 2,164 BSE**.
 *    77.1% mismatch.
 * 3. **The cohort is unstampable.** `stampCursorOnly` issues
 *    `updateMany({symbol, exchange: "BSE"})`, and all 2,135 incumbent
 *    `stock_ratios` rows are keyed to NSE instruments, so it matches zero rows
 *    and returns `"no-row"`. The file deliberately refuses to upsert a marker
 *    row — one would carry `source: "DOC_PDF"`, which outranks both vendors in
 *    `FINANCIALS_AUTHORITY`, locking every weaker source out of that symbol
 *    through the same one-way door. "No row to stamp" is the right outcome.
 *
 * Jointly: 2,164 instruments are selected, refused, left unstamped, and
 * therefore rank as never-derived FOREVER — ahead of `DEFAULT_RATIOS_LIMIT`
 * (1,000). The head of the queue is pure refusal and `[job-outcome]` reports a
 * perfectly healthy `selected=1000 written=0`.
 *
 * ## Why this file exists beside `xbrl-ratios-rotation.test.ts`
 *
 * That suite asserts `cursorUnstampable === 1` and calls it "the residual
 * starvation tax". At 77% of the population it is not residual, and its three
 * interlock cases run at `limit: 5` with ONE instrument — a scale at which a
 * starving rotation and a healthy one are indistinguishable. Starvation is a
 * property of the population against the LIMIT, so it can only be tested at
 * something like the real ratio.
 *
 * The simulation drives the REAL `rankRatiosTargets` — the actual production
 * ranker, not a reimplementation — and the real `XBRL_ARM_WHERE` predicate,
 * exported from the processor so this test cannot drift away from the query.
 *
 * MUTATION (recorded per case): drop the exchange pair from `XBRL_ARM_WHERE`
 * back to `{ xbrlFilings: { some: {} } }` and the multi-night cases go red —
 * `written` decays to 0 by night 5 and never recovers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  markerKey,
  rankRatiosTargets,
  type RatiosDerivedMarker,
  type RatiosTargetCandidate,
} from "../../src/processors/xbrl-ratios-logic";
import {
  DEFAULT_RATIOS_LIMIT,
  XBRL_ARM_WHERE,
} from "../../src/processors/xbrl-ratios";

/** Prod's shape, 2026-09-13. */
const MISMATCHED = 2164; // BSE instruments whose filings say NSE
const WRITABLE = 643; // NSE instruments whose filings say NSE

interface FakeInstrument extends RatiosTargetCandidate {
  /** The exchange its filings carry. Prod: "NSE" on all 108,073 rows. */
  filingExchange: string;
}

function population(): FakeInstrument[] {
  const out: FakeInstrument[] = [];
  // Proportionally INTERLEAVED, with the exact prod counts. Interleaving
  // matters: a cohort appended at the end is the one a truncation always drops
  // first, which would make the simulation kinder than reality rather than
  // harsher. Whichever cohort is furthest behind its own share goes next, so
  // the two are evenly mixed through the symbol ordering the ranker ties on.
  let m = 0;
  let w = 0;
  for (let i = 0; i < MISMATCHED + WRITABLE; i++) {
    const mismatched =
      w >= WRITABLE ||
      (m < MISMATCHED && (m + 1) / MISMATCHED <= (w + 1) / WRITABLE);
    if (mismatched) m++;
    else w++;
    const n = String(i).padStart(5, "0");
    out.push({
      id: `id-${n}`,
      symbol: `SYM${n}`,
      exchange: mismatched ? "BSE" : "NSE",
      filingExchange: "NSE",
    });
  }
  assert.equal(m, MISMATCHED, "premise: the fixture must match prod's counts");
  assert.equal(w, WRITABLE, "premise: the fixture must match prod's counts");
  return out;
}

/**
 * The candidate query's OR filter, evaluated in memory.
 *
 * Reads the REAL exported predicate so a change to the query is a change to
 * this test. `guarded: false` reproduces the pre-MONEY-1396 clause.
 */
function selectCandidates(
  all: readonly FakeInstrument[],
  guarded: boolean,
): RatiosTargetCandidate[] {
  if (!guarded)
    return all.map(({ id, symbol, exchange }) => ({ id, symbol, exchange }));
  const pairs = XBRL_ARM_WHERE.map((c) => ({
    instrument: c.exchange,
    filing: c.xbrlFilings.some.exchange,
  }));
  return all
    .filter((r) =>
      pairs.some(
        (p) => p.instrument === r.exchange && p.filing === r.filingExchange,
      ),
    )
    .map(({ id, symbol, exchange }) => ({ id, symbol, exchange }));
}

interface NightResult {
  selected: number;
  written: number;
  exchangeMismatch: number;
  cursorUnstampable: number;
}

/**
 * One armed night: select, rank, then process.
 *
 * A writable instrument is written AND stamped. A mismatched one is refused at
 * the write and CANNOT be stamped — which is the whole defect, so the
 * simulation must model it rather than quietly stamping everything.
 */
function runNight(
  all: readonly FakeInstrument[],
  markers: Map<string, Date>,
  guarded: boolean,
  night: number,
  limit: number = DEFAULT_RATIOS_LIMIT,
  wrote?: Set<string>,
): NightResult {
  const candidates = selectCandidates(all, guarded);
  const markerRows: RatiosDerivedMarker[] = [...markers].map(([k, d]) => {
    const [symbol, exchange] = k.split("\u0000");
    return { symbol: symbol!, exchange: exchange!, ratiosDerivedAt: d };
  });

  const targets = rankRatiosTargets(candidates, markerRows, limit);

  let written = 0;
  let exchangeMismatch = 0;
  let cursorUnstampable = 0;
  for (const t of targets) {
    const row = all.find((r) => r.id === t.id)!;
    if (row.exchange !== row.filingExchange) {
      exchangeMismatch++;
      cursorUnstampable++; // no stock_ratios row on (symbol, BSE) to update
      continue;
    }
    written++;
    wrote?.add(row.symbol);
    markers.set(
      markerKey(row.symbol, row.exchange),
      new Date(Date.UTC(2026, 0, night)),
    );
  }
  return {
    selected: targets.length,
    written,
    exchangeMismatch,
    cursorUnstampable,
  };
}

function simulate(guarded: boolean, nights: number): NightResult[] {
  const all = population();
  const markers = new Map<string, Date>();
  const out: NightResult[] = [];
  for (let n = 1; n <= nights; n++)
    out.push(runNight(all, markers, guarded, n));
  return out;
}

describe("MONEY-1396 — the premise", () => {
  it("the mismatched cohort really is larger than the nightly limit", () => {
    // If this stops holding, starvation is no longer possible and every case
    // below is testing nothing.
    assert.ok(
      MISMATCHED > DEFAULT_RATIOS_LIMIT,
      `starvation needs ${MISMATCHED} > ${DEFAULT_RATIOS_LIMIT}`,
    );
  });

  it("the guard removes exactly the mismatched cohort, and nothing else", () => {
    const all = population();
    assert.equal(selectCandidates(all, false).length, MISMATCHED + WRITABLE);
    assert.equal(selectCandidates(all, true).length, WRITABLE);
  });
});

describe("WITHOUT the guard, the rotation starves", () => {
  it("writes a little, then nothing, for ever", () => {
    const nights = simulate(false, 8);

    assert.ok(
      nights[0]!.written > 0,
      "night 1 writes something — which is why this was invisible",
    );

    // The signature of the defect: writes decay to zero while the job keeps
    // reporting a full selection.
    const last = nights[nights.length - 1]!;
    assert.equal(last.written, 0, "writes must have stopped");
    assert.equal(
      last.selected,
      DEFAULT_RATIOS_LIMIT,
      "…while the job still reports a FULL batch — `selected=1000 written=0`",
    );
    assert.equal(
      last.exchangeMismatch,
      DEFAULT_RATIOS_LIMIT,
      "every slot spent on a row it was about to refuse",
    );

    const total = nights.reduce((n, r) => n + r.written, 0);
    assert.ok(
      total < WRITABLE,
      `starved: only ${total} of ${WRITABLE} writable instruments ever written`,
    );
  });
});

describe("WITH the guard, the rotation completes and keeps rotating", () => {
  it("never spends a slot on a row it will refuse", () => {
    // MUT: drop the exchange pair from XBRL_ARM_WHERE -> mismatches appear.
    for (const night of simulate(true, 8)) {
      assert.equal(night.exchangeMismatch, 0);
      assert.equal(
        night.cursorUnstampable,
        0,
        "an unstampable row must never be SELECTED — not merely counted",
      );
    }
  });

  it("writes every writable instrument, and keeps writing after that", () => {
    // MUT: drop the exchange pair -> night 5 writes 0 and this goes red.
    const nights = simulate(true, 8);

    const firstNight = nights[0]!;
    assert.equal(
      firstNight.written,
      WRITABLE,
      "the whole writable population fits inside one night's limit",
    );

    for (const [i, night] of nights.entries()) {
      assert.ok(
        night.written > 0,
        `night ${i + 1} wrote nothing — the rotation stalled`,
      );
    }
  });

  it("rotates rather than re-writing the same head", () => {
    // ── THIS CASE USED TO BE ARITHMETIC, NOT A PROPERTY — MONEY-1401 ────────
    //
    // It ran at `DEFAULT_RATIOS_LIMIT` (1,000) against `WRITABLE` (643). Every
    // candidate therefore fits in every night's batch, so "every marker
    // advanced" was true of ANY ranking — including no ranking at all.
    // Verified by mutation on 2026-09-13: replacing `rankRatiosTargets`'
    // entire body with `candidates.slice(0, limit)` — MONEY-1211 restored
    // verbatim — left this case GREEN.
    //
    // Rotation is only OBSERVABLE when the population exceeds the batch, so the
    // simulation is run at a limit that binds. The property is then the real
    // one: night 2 must reach instruments night 1 could not, and a fixed number
    // of nights must cover the whole population.
    //
    // MUT: `rankRatiosTargets` -> `candidates.slice(0, limit)` and the coverage
    // assertion goes red at ROTATION_LIMIT instead of WRITABLE.
    const ROTATION_LIMIT = 200;
    assert.ok(
      ROTATION_LIMIT < WRITABLE,
      `a rotation is invisible unless the limit binds: ` +
        `${ROTATION_LIMIT} < ${WRITABLE}`,
    );
    const nights = Math.ceil(WRITABLE / ROTATION_LIMIT);

    const all = population();
    const markers = new Map<string, Date>();
    const everWritten = new Set<string>();

    const firstNight = new Set<string>();
    runNight(all, markers, true, 1, ROTATION_LIMIT, firstNight);
    for (const s of firstNight) everWritten.add(s);
    assert.equal(firstNight.size, ROTATION_LIMIT, "night 1 fills its batch");

    const secondNight = new Set<string>();
    runNight(all, markers, true, 2, ROTATION_LIMIT, secondNight);
    for (const s of secondNight) everWritten.add(s);
    const repeats = [...secondNight].filter((sym) => firstNight.has(sym));
    assert.equal(
      repeats.length,
      0,
      `night 2 re-wrote ${repeats.length} of night 1's symbols — a stale-first ` +
        `cursor must move the whole batch to the back of the queue`,
    );

    for (let n = 3; n <= nights; n++) {
      const seen = new Set<string>();
      runNight(all, markers, true, n, ROTATION_LIMIT, seen);
      for (const s of seen) everWritten.add(s);
    }
    assert.equal(
      everWritten.size,
      WRITABLE,
      `${nights} night(s) at ${ROTATION_LIMIT} must reach all ${WRITABLE} ` +
        `writable instruments; a head-of-queue squat reaches ` +
        `${ROTATION_LIMIT} of them for ever (MONEY-1211)`,
    );
  });
});
