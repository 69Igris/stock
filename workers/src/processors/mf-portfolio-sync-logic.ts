/**
 * The mf-portfolio-sync RUN VERDICT — PURE (no Prisma, no network) — MONEY-1238.
 *
 * ## The defect this closes
 *
 * The per-AMC `ok` meant PARSED, not WROTE:
 *
 *     const gotSomething = amcSheets > 0;          // page-scrape loop
 *     out.perAmc.push({ ok: gotSomething, … });
 *     out.perAmc.push({ ok: true, status: "OK" }); // template loop, uncond.
 *
 * and the run-level verdict was `out.perAmc.some((r) => r.ok)`. So every
 * workbook could download, every sheet could parse, `writeSheet` could return 0
 * for all of them, and the run reported `ok: true` with `written: 0` under a
 * 200. The one branch that already did this right was HDFC (`ok: written > 0`),
 * which is why it is the shape the whole file now uses.
 *
 * `writeSheet` returning 0 with sheets in hand is not hypothetical. It returns
 * early on `if (!schemeKey) return 0` — an empty `schemeKeyOf(schemeName)` — and
 * it skips every holding whose `instrumentName` trims to empty. A change to the
 * scheme-name normalisation, or an AMC moving the scheme name into a merged
 * cell, produces exactly this: a full parse and an empty table, reported as
 * success on the 12th AND on the 20th straggler sweep.
 *
 * ## Why `some`, not `every`, at the run level
 *
 * Seventeen houses, several of them known-flaky, and the route turns `!ok` into
 * a 500 that redelivers the WHOLE fan-out. One AMC's 404 must not cost the
 * other sixteen a retry. `some` is the deliberate choice; what MONEY-1238
 * changes is what each `ok` MEANS, not how they are combined — plus an explicit
 * `written > 0` conjunct, so the run verdict states the thing it is asserting
 * instead of inferring it.
 *
 * @see workers/src/processors/mf-portfolio-sync.ts (the only caller)
 */

/**
 * Why a parsed sheet was NOT written — MONEY-1404 C3 / MONEY-1405 D1.
 *
 * Three distinct values, never collapsed. `STALE_FILE` sends an operator to the
 * SCHEDULE or the URL (the AMC is serving an old month), `NO_AS_ON` to the
 * PARSER (the sheet's header moved), `SCALE_SUSPECT` to the DATA (a 100×
 * percent/fraction misread). One shared "skipped" would send all three to the
 * wrong place, which is the MONEY-1236 lesson about `FETCH_FAILED` standing in
 * for a parse fault.
 */
export type SheetRefusal = "STALE_FILE" | "NO_AS_ON" | "SCALE_SUSPECT";

/** The gate's answer for ONE sheet. */
export interface SheetVerdict {
  /** May this sheet's holdings be upserted? */
  write: boolean;
  /** `null` exactly when `write` is true. */
  refusal: SheetRefusal | null;
  /** Operator-facing prose naming the values that produced the refusal. */
  detail: string | null;
  /**
   * An expected column was absent. COUNTED, NOT REFUSED — the parser already
   * nulls those fields rather than defaulting them to zero, so the rows are
   * honest and incomplete rather than wrong, and refusing them would discard a
   * whole AMC over one dropped column. Orthogonal to `write`.
   */
  missingColumns: boolean;
}

/**
 * Decide whether ONE parsed sheet may be written — the gate MONEY-1238 stopped
 * one level short of.
 *
 * ## `scale-suspect` (MONEY-1404 C3)
 *
 * `checkPercentSum` computes the verdict and pushes prose into
 * `AmcSchemeSheet.anomalies`; `grep -n anomal mf-portfolio-sync.ts` returned
 * NOTHING, so every row was written whatever the verdict said. That moved the
 * defect from "computed and read by nobody" to "computed, surfaced, and read by
 * nobody one level up" — the same shape, one layer out.
 *
 * It branches on `percentSumCheck.verdict`, not on a substring of `anomalies`.
 * The field exists for exactly this ("the machine-readable half, so a caller can
 * branch on it without parsing strings"), and a prose match would break the
 * moment the message is reworded — silently, by passing everything.
 *
 * The percent SCALE genuinely differs per AMC (ICICI/Axis publish `0.0575`,
 * Kotak `5.12`) and `resolvePercentScale` already resolves that from the cell's
 * number format. This consumes the verdict; it does not second-guess the scale.
 *
 * ## The as-on gate (MONEY-1405 D1)
 *
 * A 200 is not freshness. Axis's undated URL serves a real 840 KB workbook
 * whose every sheet reads January 2022, and KFintech's per-scheme store is
 * frozen years back. Both fetch, parse and yield real holdings, so the printed
 * date is the only thing that separates them from a current file. A month
 * mismatch is `STALE_FILE` naming BOTH dates — without both, "stale" is a claim
 * the operator has to go and verify by hand.
 *
 * `uncheckable` from `checkPercentSum` deliberately does NOT refuse: it means
 * the sheet lacked an input for the comparison (no AUM line), which is an
 * absent check rather than a failed one, and refusing on it would discard every
 * scheme whose workbook omits a grand total.
 *
 * @param requestedMonth `YYYY-MM`, the month the run asked for.
 */
export function judgeSheetWrite(
  sheet: {
    readonly asOfDate: string | null;
    readonly percentSumCheck: { readonly verdict: string };
    readonly missingColumns: readonly string[];
  },
  requestedMonth: string,
): SheetVerdict {
  const missingColumns = sheet.missingColumns.length > 0;

  if (sheet.asOfDate === null) {
    return {
      write: false,
      refusal: "NO_AS_ON",
      detail:
        `no as-on date found on this sheet — requested ${requestedMonth}. ` +
        `An unreadable date is not an old one: it could be either, so the ` +
        `rows are refused rather than written on the assumption they are current`,
      missingColumns,
    };
  }

  // `YYYY-MM-DD`.slice(0, 7) — a string comparison with no Date and no
  // timezone. Trap 7 of mf-portfolio-logic: a Date built from SBI's serial
  // 46234 is the month-end date off by one east of UTC, which under a MONTH
  // comparison would refuse every 1st-of-month file as stale.
  const asOnMonth = sheet.asOfDate.slice(0, 7);
  if (asOnMonth !== requestedMonth) {
    return {
      write: false,
      refusal: "STALE_FILE",
      detail:
        `file is as on ${sheet.asOfDate} but ${requestedMonth} was ` +
        `requested — the fetch succeeded and the workbook parsed, so nothing ` +
        `upstream of this says the data is old`,
      missingColumns,
    };
  }

  if (sheet.percentSumCheck.verdict === "scale-suspect") {
    return {
      write: false,
      refusal: "SCALE_SUSPECT",
      detail:
        `the percent column disagrees with the money column on this sheet ` +
        `(see the sheet's anomalies) — every pctToNav on it is suspect`,
      missingColumns,
    };
  }

  return { write: true, refusal: null, detail: null, missingColumns };
}

/** What one AMC's attempt produced, as the verdict reads it. */
export interface AmcAttemptTotals {
  /** Scheme sheets successfully parsed out of that house's workbook(s). */
  sheets: number;
  /** Holding rows those sheets carried. */
  holdings: number;
  /** Rows `writeSheet` actually upserted. */
  written: number;
  /** Files whose download failed (per-scheme houses publish many). */
  fetchFailed?: number;
  /** Files the parser could not recognise. */
  unrecognised?: number;
  /**
   * The workbook DOWNLOADED AND PARSED — MONEY-1236.
   *
   * The direct-URL branch reaches `judgeAmcAttempt` only after a successful
   * fetch and a successful parse, but it passes neither `fetchFailed` nor
   * `unrecognised`. A workbook that parsed and yielded ZERO sheets therefore
   * fell to the final return and was reported as `"FETCH_FAILED"` — pointing an
   * operator at the network when the parser is the problem, which is the most
   * expensive kind of wrong status: it sends the investigation to the wrong
   * system entirely.
   */
  parsedOk: boolean;
  //
  // REQUIRED, not optional — MONEY-1405 (D3 step 0). It shipped optional and
  // TWO of the three call sites never passed it, so the page-scrape and HDFC
  // lanes fell through to the `: "FETCH_FAILED"` arm below. Tata therefore
  // reported `FETCH_FAILED` on a run that downloaded 1,762,746 bytes and
  // parsed them — a status naming the one subsystem that was working, on a
  // house nobody could debug because the label sent them to the network.
  //
  // A default cannot fix this. Whichever value it took would be a guess about
  // a caller that did not think about the question, and the wrong guess is
  // silent in both directions: `false` mislabels a parse failure as a fetch
  // failure, `true` mislabels a dead CDN as a bad workbook. Making it required
  // moves the omission from a runtime mislabel to a compile error.

  /**
   * Sheets {@link judgeSheetWrite} refused, by reason — MONEY-1404 / MONEY-1405.
   *
   * These are the states that previously did not exist: the house fetched,
   * parsed and produced holdings, and every one of them was refused. Without
   * them the totals fall through to `sheets > 0, written === 0` and report
   * `PARSED_BUT_NOTHING_WRITTEN`, which points at `schemeKeyOf` and the write
   * path — the wrong system entirely when the real answer is "Axis is still
   * serving January 2022".
   */
  stale?: number;
  noAsOn?: number;
  scaleSuspect?: number;
  /**
   * Sheets WRITTEN despite an absent expected column. Reported, never refused:
   * the parser nulls those fields rather than defaulting them, so the rows are
   * incomplete rather than wrong.
   */
  missingColumns?: number;
  /**
   * One refused sheet's `detail`, carried verbatim so the status can NAME the
   * disagreement (`as on 2022-01-31 … 2026-08 was requested`) instead of
   * asserting staleness and leaving the operator to go and find both dates.
   */
  refusalExample?: string;
}

/** `ok` plus the status string reported for the AMC. */
export interface AmcVerdict {
  ok: boolean;
  status: string;
}

/**
 * Classify ONE AMC attempt.
 *
 * `ok` is `written > 0` — the house rule, taken from the HDFC branch that was
 * already correct. The status strings that existed before MONEY-1238
 * (`"OK"` / `"UNRECOGNISED_WORKBOOK"` / `"FETCH_FAILED"`) are preserved
 * verbatim for the states that produced them, so nothing reading this result
 * has to relearn a vocabulary; the two NEW strings name the two states that
 * previously had no name because they were reported as success.
 */
export function judgeAmcAttempt(t: AmcAttemptTotals): AmcVerdict {
  const fetchFailed = t.fetchFailed ?? 0;
  const unrecognised = t.unrecognised ?? 0;
  const stale = t.stale ?? 0;
  const noAsOn = t.noAsOn ?? 0;
  const scaleSuspect = t.scaleSuspect ?? 0;
  const refused = stale + noAsOn + scaleSuspect;

  if (t.written > 0) {
    // A house that lost some files but stored others IS ok — Mirae publishes 97
    // workbooks a month and the 40th 404ing must not discard the other 96 — but
    // it says so, rather than reporting a bare "OK" that hides the shortfall.
    const parts: string[] = [];
    if (fetchFailed > 0) parts.push(`${fetchFailed} fetch-failed`);
    if (unrecognised > 0) parts.push(`${unrecognised} unrecognised`);
    if (stale > 0) parts.push(`${stale} stale`);
    if (noAsOn > 0) parts.push(`${noAsOn} no-as-on`);
    if (scaleSuspect > 0) parts.push(`${scaleSuspect} scale-suspect`);
    return {
      ok: true,
      status:
        // The two pre-existing counters keep their exact wording even when they
        // are the only ones set, so nothing reading OK_PARTIAL has to relearn a
        // vocabulary. The refusal counters are additive.
        fetchFailed > 0 || unrecognised > 0 || refused > 0
          ? `OK_PARTIAL (${parts.join(", ")})`
          : "OK",
    };
  }

  // BEFORE `sheets > 0`. A wholly-stale house HAS sheets and HAS holdings, so
  // without this it reports PARSED_BUT_NOTHING_WRITTEN — which names the write
  // path, and the write path is the one part that is working.
  if (refused > 0) {
    const reason: SheetRefusal =
      stale >= noAsOn && stale >= scaleSuspect
        ? "STALE_FILE"
        : noAsOn >= scaleSuspect
          ? "NO_AS_ON"
          : "SCALE_SUSPECT";
    return {
      ok: false,
      status: `${reason} (${refused} sheet(s) refused${
        t.refusalExample ? `: ${t.refusalExample}` : ""
      })`,
    };
  }

  if (t.sheets > 0) {
    // The MONEY-1238 states. Both used to report `ok: true`.
    return {
      ok: false,
      status:
        t.holdings > 0
          ? "PARSED_BUT_NOTHING_WRITTEN"
          : "PARSED_BUT_NO_HOLDINGS",
    };
  }

  return {
    ok: false,
    status:
      unrecognised > 0
        ? "UNRECOGNISED_WORKBOOK"
        : t.parsedOk
          ? // Downloaded and parsed, and produced no scheme sheets at all. The
            // network is fine; the workbook's shape is not what we expect.
            "PARSED_BUT_NO_SHEETS"
          : "FETCH_FAILED",
  };
}

/**
 * The RUN verdict.
 *
 * TWO conjuncts, and the count is deliberate. The old expression opened with
 * `out.perAmc.length > 0 &&`, and carrying that over looked like prudence: "a
 * run that attempted nothing is not a successful run". It is dead. `some()`
 * returns false for an empty array, so the floor cannot change the answer for
 * ANY input — mutation-tested, and it survived every mutation because there is
 * no input that distinguishes it.
 *
 * A conjunct that can never change a result is precisely what this ticket is
 * about one level up: an expression that reads as a guard, is counted by
 * reviewers as coverage, and protects nothing. It is removed rather than kept
 * with a test that cannot fail.
 *
 * What remains is the assertion the old code genuinely lacked — `written > 0`,
 * the run STORED something — and `some`, not `every`, because the route turns
 * `!ok` into a 500 that redelivers all seventeen houses and one AMC's 404 must
 * not cost the other sixteen a retry.
 */
export function mfPortfolioRunOk(run: {
  perAmc: ReadonlyArray<{ ok: boolean }>;
  written: number;
  /**
   * Did the caller NAME the houses? (`only` present — a chain hop or an
   * operator.) MONEY-1490.
   */
  scoped?: boolean;
}): boolean {
  if (run.written > 0 && run.perAmc.some((r) => r.ok)) return true;

  // A SCOPED run that stored nothing is NOT a retryable failure — MONEY-1490.
  //
  // This conjunct could not change any answer until `only` started working.
  // Every hop ran the whole table and stored ~22k rows, so `written > 0` was
  // true on every run this job had ever performed. Making `only` live is what
  // put a narrow tail hop — sometimes ONE house — on this path, and a tail
  // house legitimately has nothing whenever its month is not published yet.
  //
  // The cost of getting this wrong is asymmetric, and badly:
  //
  //   false 500  ->  Pub/Sub redelivers the IDENTICAL scoped message 5x (the
  //                  same houses, the same absent files, so every attempt
  //                  fails the same way), dead-letters, pages the founder —
  //                  AND `chainDeferredHouses` refuses to publish on `!ok`, so
  //                  the entire remaining tail of the month is abandoned. One
  //                  unpublished house at the head of the tail silently takes
  //                  every house behind it.
  //   false 200  ->  those houses are missed until the job's own second run.
  //                  Which is WHY it runs on the 12th AND the 20th.
  //
  // The repo has already made this exact call once, in `xbrl-sync`: "a
  // DETERMINISTIC parse failure returns 200 ... the same bytes will fail the
  // same way on every attempt". Absent files are the same shape.
  //
  // An UNSCOPED run keeps the strict rule. If the whole industry stored
  // nothing, that IS broken and a retry is the right answer.
  //
  // `perAmc.length > 0` is load-bearing and not decoration: it keeps "we
  // reached houses and they had nothing" apart from "we reached no house at
  // all", which is a selection bug and must stay loud.
  return run.scoped === true && run.perAmc.length > 0;
}
