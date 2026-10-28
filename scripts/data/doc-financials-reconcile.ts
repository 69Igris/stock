/**
 * Document-derived financials vs the incumbent — MONEY-1255.
 *
 * The sibling of `scripts/data/xbrl-reconcile.ts`, one source further down the
 * authority order, and it answers the same question with the same vocabulary:
 * "is what a model read off a PDF good enough to write into `stock_financials`,
 * and if not, exactly where does it disagree?"
 *
 * READ-ONLY by default. With `--apply` it writes ONE column —
 * `DocumentFinancialExtract.reconcileVerdict` — and nothing else, ever.
 *
 * ## Why this has to run BEFORE the write, not after
 *
 * `StockFinancials` is `@@unique([symbol, exchange, statementType, periodType,
 * period])` — no `source` in the key. Two sources describing one period are ONE
 * ROW, so the moment anything writes a period the previous value for it is gone
 * and there is nothing left to compare against. The projection
 * (`workers/src/processors/document-financials-projection.ts`) therefore refuses
 * an extract this script has not graded (`requireGraded`, default TRUE), which
 * makes `--apply` here the interlock rather than a convenience.
 *
 * ## The verdict ladder, and why it is not a match percentage
 *
 * A single "87% match" cannot be acted on. The five ways two financial figures
 * differ need five different responses:
 *
 *   MATCH            within tolerance — rounding, ₹ lakh vs ₹ crore precision
 *   SCALE_MISMATCH   off by a power of ten. A UNITS bug on one side, and for
 *                    this source the most likely place for one: the extract
 *                    records what scale the DOCUMENT declared (`scaleLabel`)
 *                    and what factor was applied (`scaleFactor`), and getting
 *                    that wrong is a whole-document error. BLOCKS.
 *   SIGN_MISMATCH    opposite signs. Also systematic, also BLOCKS — see
 *                    `DOC_DECLARED_CONVENTIONS`, which names the one place a
 *                    convention difference is expected (`capitalExpenditure`)
 *                    so the block is actionable rather than alarming.
 *   DISAGREEMENT     materially different, not explained by scale or sign. The
 *                    only one a rate threshold is appropriate for.
 *   INCOMPARABLE     one side has no value. NOT a disagreement.
 *
 * The judgement lives in `@usemoney/core/market-data` (pure, unit-tested); this
 * script is the I/O harness that feeds it. `judgeSwitchoverReadiness` and
 * `judgeFieldGateOutcome` are the SAME functions the XBRL gate uses, with the
 * SAME defaults and no threshold overrides.
 *
 * ## INCOMPARABLE is the shruggable verdict, so it is BROKEN DOWN BY CAUSE
 *
 * It has hidden two broken pipes before (MONEY-1234), and it is outside the
 * disagreement rate BY DESIGN (MONEY-1196), so a field can read
 * `comparable 40 of 900` with nothing anywhere saying what the other 860 were.
 * Every field line therefore prints the split:
 *
 *   OURS_BLANK    the incumbent has a value and we do not — a coverage GAP,
 *                 and the pairs where ARMING WOULD NULL A POPULATED CELL.
 *   THEIRS_BLANK  we have a value and the incumbent does not — a coverage WIN,
 *                 which is the entire point of this pipeline.
 *   BOTH_BLANK    neither side has anything. Not a gap in either direction, and
 *                 counted apart precisely so it cannot inflate the first.
 *
 * ## THE CEILING — the failure mode this report is designed against
 *
 * A reconcile that compares ZERO rows and prints "no disagreements" is the
 * shape this repo keeps rediscovering. One count cannot tell those apart; three
 * nested ones can, and `judgeDocCeiling` asserts a floor over them:
 *
 *   examined   every (extract, field) pair looked at
 *   joinable   those where an incumbent ROW existed at all. Zero here, with a
 *              non-zero `examined`, is the signature of a period-LABEL bug —
 *              we addressed rows that do not exist under the name we derived,
 *              which would make EVERY write a CREATE. Asserting the innocent
 *              reading requires `--expect-no-incumbents`, explicitly.
 *   comparable those where BOTH sides carried a finite value. The only base a
 *              rate may use.
 *
 * The run exits 1 when the ceiling check fails, so "0 disagreements over 0
 * comparisons" cannot be reported as success.
 *
 * ## A gate must grade what the WRITER writes
 *
 * The field list is DERIVED from `DOC_ALL_FIELDS` — the same constant
 * `docOwnedFields()` gives the writer — and the Prisma `select` is derived from
 * that list rather than hand-maintained. The bug being designed out is
 * documented at `FIELDS` in `xbrl-reconcile.ts`: a hardcoded six-column select
 * made `totalDebt` read `comparable 0 of 4516` while the table held 9,861
 * vendor values for it, and a zero that means "we never asked" is
 * indistinguishable in a report from a zero that means "nothing to compare".
 *
 * `revenue` is graded as the DERIVED total (`revenueFromOperations +
 * otherIncome`), never as the extract's raw column, because that is what the
 * writer writes. `docReadField` is the one function both use.
 *
 * Usage:
 *   npx tsx scripts/data/doc-financials-reconcile.ts                 # read-only
 *   npx tsx scripts/data/doc-financials-reconcile.ts --symbols=TCS,INFY
 *   npx tsx scripts/data/doc-financials-reconcile.ts --limit=200 --verbose
 *   npx tsx scripts/data/doc-financials-reconcile.ts --apply         # writes verdicts
 *
 * Prefer the wrapper so DATABASE_URL comes from Secret Manager:
 *   ./scripts/ops/run-market-data-job.sh docfinrecon prod [--apply]
 *
 * THE WRAPPER MUST DECLARE `APPLY_FLAG="--apply"` FOR THIS JOB. It CONSUMES
 * `--apply` and re-emits only `$APPLY_FLAG`, so a job with an empty declaration
 * SWALLOWS the flag: the run reads everything, reports what it would change,
 * writes nothing, and exits 0. That is not hypothetical — it cost 41,924 rows
 * read, 24,165 reported changed and NOTHING written, in 54 minutes, fail-safe
 * and silent. This script cannot see a flag the wrapper ate, so the only
 * defences are that declaration and the MODE line printed below, which says
 * DRY-RUN in exactly the case a swallowed flag produces.
 */

import prisma from "@usemoney/database";
import { judgeFieldGateOutcome, judgeSwitchoverReadiness, periodLabel } from "@usemoney/core/market-data";
import {
  docOwnedFields,
  docReadField,
  emptyFieldCensus,
  foldComparison,
  gradeExtract,
  judgeDocCeiling,
  projectDocumentExtract,
  rollUpVerdict,
  selectExtractForPeriod,
  DOC_ALL_FIELDS,
  DOC_BLOCKING_VERDICTS,
  DOC_DECLARED_CONVENTIONS,
  DOC_MIN_COMPARABLE,
  DOC_SOURCE,
  DOC_UNOWNED_VENDOR_COLUMNS,
  describeDocAuthorityState,
  docAuthorityState,
  type DocFieldCensus,
  type DocFieldComparison,
  type DocFinancialsField,
  type DocIncumbentRow,
  type DocStatementType,
  type DocumentExtractReading,
} from "@usemoney/core/market-data/document-financials-projection";
import type { ReconcileVerdict } from "@usemoney/core/market-data";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

const VERBOSE = argv.includes("--verbose");
const APPLY = argv.includes("--apply");
const EXPECT_NO_INCUMBENTS = argv.includes("--expect-no-incumbents");
const LIMIT = Number(arg("limit") ?? 0) || 0;
const MIN_COMPARABLE = Number(arg("min-comparable") ?? 0) || DOC_MIN_COMPARABLE;
const SYMBOLS = (arg("symbols") ?? "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

/**
 * Is this a NARROWED run?
 *
 * The comparable FLOOR is a statement about the FULL population. A
 * `--symbols=TCS` run legitimately produces four comparable pairs, and exiting
 * 1 on that would make the scoped pilot the runbook asks for permanently red —
 * with no field actually blocked. Scoped runs still print every number and
 * still block on scale/sign; they just do not fail the floor.
 */
const RUN_IS_SCOPED = LIMIT > 0 || SYMBOLS.length > 0;

const log = {
  info: (...a: unknown[]) => console.log("[doc-financials-reconcile]", ...a),
  warn: (...a: unknown[]) => console.warn("[doc-financials-reconcile]", ...a),
  error: (...a: unknown[]) => console.error("[doc-financials-reconcile]", ...a),
};

/**
 * The fields graded — DERIVED from what the WRITER owns, never restated.
 *
 * See the header. A column added to `DOC_ALL_FIELDS` is graded from that commit
 * with no second edit to remember, and a column the incumbent cannot back reads
 * `UNVERIFIABLE` rather than passing quietly, because `judgeFieldGateOutcome`
 * refuses a vacuous READY.
 */
const FIELDS: readonly DocFinancialsField[] = DOC_ALL_FIELDS;

const STATEMENTS: readonly DocStatementType[] = [
  "INCOME",
  "BALANCE_SHEET",
  "CASH_FLOW",
];

/** The `stock_financials` join key, exactly as the writer addresses it. */
function incumbentKey(
  symbol: string,
  exchange: string,
  statementType: string,
  periodType: string,
  period: string,
): string {
  return [symbol, exchange, statementType, periodType, period].join("\u0000");
}

async function main(): Promise<void> {
  // ── The MODE line, printed FIRST ────────────────────────────────────
  //
  // Not decoration. The wrapper CONSUMES `--apply` and re-emits only its
  // per-job `APPLY_FLAG`, so an operator who typed `--apply` against a job with
  // an empty declaration gets a run this script cannot distinguish from a
  // deliberate dry run. This line is what makes that visible at the top of the
  // log instead of at the bottom of a 54-minute one.
  log.info(
    APPLY
      ? `MODE: APPLY — will write DocumentFinancialExtract.reconcileVerdict. ` +
          `NOTHING ELSE IS EVER WRITTEN by this script.`
      : `MODE: DRY-RUN (read-only). No verdict will be persisted. If you ` +
          `passed --apply through scripts/ops/run-market-data-job.sh, its ` +
          `APPLY_FLAG for this job must be declared as "--apply" or the flag ` +
          `is swallowed and this run silently writes nothing.`,
  );
  log.info(`AUTHORITY: ${describeDocAuthorityState(docAuthorityState())}`);

  // A batch counted in ROWS over a table where one logical unit occupies
  // SEVERAL rows returns fewer distinct units than asked for — MONEY-1207. One
  // period legitimately has two extract rows (CONSOLIDATED + STANDALONE), so an
  // odd `--limit` guarantees a page that ends mid-period.
  if (LIMIT > 0 && LIMIT % 2 !== 0) {
    log.warn(
      `--limit=${LIMIT} is ODD. One period occupies up to TWO extract rows ` +
        `(both bases), so an odd page can cut between them and hand the period ` +
        `to the loser. Use an even limit.`,
    );
  }

  const extracts = (await prisma.documentFinancialExtract.findMany({
    where: {
      // FAILED and FAILED_VALIDATION rows are not readings; grading them would
      // put parse failures into a disagreement rate.
      status: "EXTRACTED",
      ...(SYMBOLS.length > 0 ? { symbol: { in: SYMBOLS } } : {}),
    },
    // SYMBOL-MAJOR, and that is not cosmetic. With `--limit`, a page ordered
    // purely by `periodEnd` can cut BETWEEN a STANDALONE extract and the
    // CONSOLIDATED sibling that supersedes it, handing the period to the loser.
    // Ordering by symbol first means a truncated page can only cut inside ONE
    // symbol. The writer orders the same way; the gate has to match the writer
    // or it is not measuring it.
    orderBy: [
      { symbol: "asc" },
      { periodEnd: "desc" },
      { basis: "asc" },
      { id: "asc" },
    ],
    ...(LIMIT ? { take: LIMIT } : {}),
    select: {
      id: true,
      documentId: true,
      instrumentId: true,
      symbol: true,
      exchange: true,
      fiscalYear: true,
      periodEnd: true,
      periodType: true,
      basis: true,
      status: true,
      reconcileVerdict: true,
      model: true,
      promptVersion: true,
      confidence: true,
      scaleLabel: true,
      scaleFactor: true,
      extractedAt: true,
      // DERIVED from FIELDS — never hand-maintained. See the header: the more
      // dangerous copy of a field list is the one inside a `select`, because a
      // field missing from it comes back `undefined`, which the comparison
      // reads as "the source has no value here" and reports as INCOMPARABLE.
      //
      // `revenue` is selected because it is in `DOC_ALL_FIELDS`, and is then
      // never read directly: `docReadField` derives it. Selecting it costs
      // nothing and keeps this expression a pure function of the field list.
      ...Object.fromEntries(FIELDS.map((f) => [f, true])),
      // The two COMPONENTS of the derived `revenue`. `otherIncome` is already
      // in FIELDS; `revenueFromOperations` is too. Named here only so a future
      // reader can see that the derivation's inputs are covered by the same
      // expression rather than by luck.
      revenueFromOperations: true,
      otherIncome: true,
    },
  })) as unknown as DocumentExtractReading[];

  if (extracts.length === 0) {
    // A zero here is NOT a clean bill of health. "0 disagreements" is exactly
    // what a successful reconciliation also prints, so this exits 1.
    log.error(
      `NO document_financial_extracts rows matched (status EXTRACTED` +
        `${SYMBOLS.length ? `, symbols ${SYMBOLS.join(",")}` : ""}). This is ` +
        `NOT a passing reconciliation — it means there is nothing to ` +
        `reconcile. Run the extraction job first.`,
    );
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  // ── One period, one row ─────────────────────────────────────────────
  //
  // `document_financial_extracts` is keyed (documentId, periodEnd, periodType,
  // basis), so a period legitimately has several rows: both bases, and one per
  // document that mentioned the period. `StockFinancials` has room for exactly
  // one, so grading all of them would compare rows against an incumbent they
  // will never replace — the MONEY-1232 defect, where 40.4% of the XBRL
  // population was doing precisely that. `selectExtractForPeriod` is the SAME
  // function the writer uses.
  //
  // `periodLabel` is IMPORTED, not redefined. This script produces the evidence
  // and the writer performs the write, and both address a `StockFinancials` row
  // by the same derived label; two copies means a fix to one silently changes
  // which rows the other looks at, and nothing would error.
  const groups = new Map<string, DocumentExtractReading[]>();
  const targetOf = new Map<string, { periodType: string; period: string }>();
  for (const e of extracts) {
    const periodType = e.periodType === "QUARTERLY" ? "QUARTERLY" : "ANNUAL";
    const period = periodLabel(e.periodEnd, periodType);
    targetOf.set(e.id, { periodType, period });
    const key = incumbentKey(e.symbol, e.exchange, "", periodType, period);
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }
  const winners = [...groups.values()]
    .map((rows) => selectExtractForPeriod(rows))
    .filter((e): e is DocumentExtractReading => e !== null);
  const superseded = extracts.length - winners.length;

  log.info(
    `grading ${winners.length} period(s) from ${extracts.length} extract(s)` +
      (superseded > 0
        ? ` — ${superseded} sibling(s) superseded (CONSOLIDATED beats ` +
          `STANDALONE, then confidence, then coverage), matching what the ` +
          `projection would actually persist`
        : ""),
  );

  // ── The incumbents, in ONE batched pass per 200 symbols ─────────────
  //
  // NOT a `findFirst` per period. One lookup per period is the N+1 that made
  // the XBRL gate un-runnable — measured at 6h20m elapsed, 0.0% CPU, killed
  // unfinished — and a gate that cannot be re-run after every fix is its own
  // kind of failure.
  const wantedSymbols = [...new Set(winners.map((w) => w.symbol))];
  const incumbents = new Map<string, DocIncumbentRow>();
  const CHUNK = 200;
  for (let i = 0; i < wantedSymbols.length; i += CHUNK) {
    const rows = await prisma.stockFinancials.findMany({
      where: {
        symbol: { in: wantedSymbols.slice(i, i + CHUNK) },
        statementType: { in: [...STATEMENTS] },
      },
      select: {
        symbol: true,
        exchange: true,
        period: true,
        periodType: true,
        statementType: true,
        source: true,
        fetchedAt: true,
        basis: true,
        // DERIVED from FIELDS. See the header and the extract select above.
        ...Object.fromEntries(FIELDS.map((f) => [f, true])),
      },
    });
    for (const r of rows) {
      incumbents.set(
        incumbentKey(
          r.symbol,
          r.exchange,
          r.statementType,
          r.periodType,
          r.period,
        ),
        r as unknown as DocIncumbentRow,
      );
    }
  }
  log.info(
    `loaded ${incumbents.size} incumbent row(s) for ${wantedSymbols.length} ` +
      `symbol(s) in ${Math.ceil(wantedSymbols.length / CHUNK)} quer(ies)`,
  );

  // ── Grade ───────────────────────────────────────────────────────────
  const census = new Map<string, DocFieldCensus>();
  for (const f of FIELDS) {
    const st = STATEMENTS.find((s) => docOwnedFields(s).includes(f));
    census.set(f, emptyFieldCensus(f, st ?? "INCOME"));
  }
  const verdictsByField = new Map<string, ReconcileVerdict[]>(
    FIELDS.map((f) => [f, []]),
  );
  /** The row-level roll-up per extract — what `--apply` persists. */
  const rollUps = new Map<string, ReconcileVerdict>();
  /** Roll-up distribution, which is the population the PROJECTION will gate on. */
  const rollUpCounts = new Map<ReconcileVerdict, number>();
  /** Periods where NO incumbent row exists for ANY statement — pure creates. */
  let periodsWithNoIncumbentAtAll = 0;
  /** Statements the extract could not fill at all — nothing to write. */
  let emptyStatements = 0;
  const examples: string[] = [];
  /** Sample of the pairs where arming would NULL a populated incumbent. */
  const nulling: string[] = [];

  for (const w of winners) {
    const target = targetOf.get(w.id);
    if (!target) continue;

    // EXPLICIT per-statement entries — `null` means "the row does not exist",
    // and an ABSENT key makes `gradeExtract` throw. That distinction is the
    // whole MONEY-1250 lesson: a caller that forgot to fetch a statement would
    // otherwise have every one of its columns graded against `undefined` and
    // reported as "the incumbent has no value".
    const rows: Partial<Record<DocStatementType, DocIncumbentRow | null>> = {};
    let anyRow = false;
    for (const st of STATEMENTS) {
      const row =
        incumbents.get(
          incumbentKey(w.symbol, w.exchange, st, target.periodType, target.period),
        ) ?? null;
      rows[st] = row;
      if (row) anyRow = true;
    }
    if (!anyRow) periodsWithNoIncumbentAtAll++;

    // Statements with nothing sourced are counted rather than silently absent:
    // an extract that filled no owned column produces no write, and "0 written"
    // must never be inferable only from a subtraction.
    emptyStatements += STATEMENTS.length - projectDocumentExtract(w).length;

    const comparisons: DocFieldComparison[] = gradeExtract(w, rows);
    for (const c of comparisons) {
      const cen = census.get(c.field);
      if (!cen) continue;
      foldComparison(cen, c, rows[c.statementType] !== null);
      verdictsByField.get(c.field)?.push(c.verdict);
      if (
        c.wouldNullIncumbent &&
        nulling.length < 40 &&
        // Only where the write would actually LAND. An owned column we cannot
        // fill is a null the writer WILL assert, so this is a trade to accept
        // before the one-way door rather than discover behind it.
        rows[c.statementType] !== null
      ) {
        nulling.push(
          `${w.symbol} ${target.periodType} ${target.period} ${c.field}: ` +
            `incumbent ${String(c.theirs)} -> NULL`,
        );
      }
      if (
        VERBOSE &&
        examples.length < 60 &&
        (c.verdict === "DISAGREEMENT" ||
          c.verdict === "SCALE_MISMATCH" ||
          c.verdict === "SIGN_MISMATCH")
      ) {
        examples.push(
          `${c.verdict} ${w.symbol} ${target.periodType} ${target.period} ` +
            `${c.field}: ours=${String(c.ours)} theirs=${String(c.theirs)}` +
            (c.scaleFactor ? ` factor=${c.scaleFactor}` : "") +
            (c.relativeDiff !== undefined
              ? ` rel=${(c.relativeDiff * 100).toFixed(1)}%`
              : ""),
        );
      }
    }

    const roll = rollUpVerdict(comparisons);
    rollUps.set(w.id, roll);
    rollUpCounts.set(roll, (rollUpCounts.get(roll) ?? 0) + 1);
  }

  // ── THE CEILING, checked before ANY field verdict is believed ───────
  const ceiling = judgeDocCeiling({
    extracts: winners.length,
    census: [...census.values()],
    minComparable: MIN_COMPARABLE,
    expectNoIncumbents: EXPECT_NO_INCUMBENTS,
  });
  log.info(
    `CEILING: comparable ${ceiling.comparable} of joinable ${ceiling.joinable} ` +
      `of examined ${ceiling.examined}, over ${ceiling.extracts} winner ` +
      `extract(s) — ${ceiling.verdict}: ${ceiling.reason}`,
  );
  log.info(
    `${periodsWithNoIncumbentAtAll} of ${winners.length} winner period(s) have ` +
      `NO incumbent row for any statement — every write for those is a CREATE, ` +
      `which is both the point of this pipeline and the exact signature of a ` +
      `period-label join bug. ${emptyStatements} statement(s) had no owned ` +
      `column sourced and would be written by nothing.`,
  );

  // ── The declarations, printed VERBATIM ──────────────────────────────
  //
  // Never restated. A declaration whose reasoning lives only in a commit
  // message is indistinguishable from a suppression six months later.
  log.info(
    `UNOWNED VENDOR COLUMNS — ${DOC_SOURCE} never writes these, so they are ` +
      `neither graded nor at risk:`,
  );
  for (const [col, why] of Object.entries(DOC_UNOWNED_VENDOR_COLUMNS)) {
    log.info(`  ${col}: ${why}`);
  }
  log.info(`DECLARED CONVENTIONS — read every verdict below against these:`);
  for (const [col, why] of Object.entries(DOC_DECLARED_CONVENTIONS)) {
    log.info(`  ${col}: ${why}`);
  }

  // ── The ladder, per field ───────────────────────────────────────────
  let anyBlocked = false;
  const outcomes: Array<{ field: string; verdict: string }> = [];
  for (const field of FIELDS) {
    const cen = census.get(field);
    if (!cen) continue;
    const verdicts = verdictsByField.get(field) ?? [];
    const readiness = judgeSwitchoverReadiness(verdicts);
    // COUNTED, never inferred from `incomparable` — which cannot say which side
    // was empty. `comparable` pairs both had a value; `oursBlank` pairs are the
    // ones where THEY had a value and we did not.
    const incumbentValuesSeen = cen.comparable + cen.oursBlank;
    const outcome = judgeFieldGateOutcome({
      ready: readiness.ready,
      comparable: cen.comparable,
      incomparable: cen.incomparable,
      incumbentValuesSeen,
      // No field here carries a DeclaredDivergence. `DOC_DECLARED_CONVENTIONS`
      // is a different instrument: it explains a verdict, it does not exempt a
      // field from having one. Passing `true` for a convention would turn an
      // explanation into a suppression, which is the one thing the declaration
      // machinery must never become.
      declared: false,
    });
    if (outcome.blocks) anyBlocked = true;
    outcomes.push({ field, verdict: outcome.verdict });

    const rate =
      cen.comparable > 0
        ? ((cen.disagreements / cen.comparable) * 100).toFixed(1)
        : "n/a";
    log.info(
      `${outcome.verdict.padEnd(12)} ${field.padEnd(30)} ` +
        `comparable ${cen.comparable} of joinable ${cen.joinable} of examined ` +
        `${cen.examined} | matched ${cen.matched} disagree ${cen.disagreements} ` +
        `(${rate}%) scale ${cen.scaleMismatches} sign ${cen.signMismatches} | ` +
        `INCOMPARABLE ${cen.incomparable} = ours-blank ${cen.oursBlank} ` +
        `(coverage GAP; arming NULLs ${cen.wouldNullIncumbent} populated cell(s)) ` +
        `+ theirs-blank ${cen.theirsBlank} (coverage WIN) ` +
        `+ both-blank ${cen.bothBlank} | ${readiness.reason}`,
    );
  }

  if (VERBOSE && examples.length > 0) {
    log.info(`examples (max 60):`);
    for (const e of examples) log.info(`  ${e}`);
  }

  // ── INCUMBENT-NULLING, printed UNCONDITIONALLY including the zero ───
  //
  // These pairs score INCOMPARABLE, which is outside the disagreement rate BY
  // DESIGN, so the ladder structurally cannot see the loss. It is a trade to
  // accept before the one-way door, not a defect, and it does not block — but
  // it must be counted rather than inferred.
  const nullingTotal = [...census.values()].reduce(
    (n, c) => n + c.wouldNullIncumbent,
    0,
  );
  log.info(
    `INCUMBENT-NULLING: arming would replace ${nullingTotal} populated ` +
      `incumbent value(s) with NULL across all fields` +
      (nulling.length > 0 ? ` — sample:` : `.`),
  );
  for (const n of nulling) log.info(`  ${n}`);

  // ── The roll-up distribution — what the PROJECTION will gate on ─────
  log.info(
    `ROLL-UP (DocumentFinancialExtract.reconcileVerdict), the value the ` +
      `projection reads: ` +
      [...rollUpCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(
          ([v, n]) =>
            `${v} ${n}${DOC_BLOCKING_VERDICTS.has(v) ? " (BLOCKS the write)" : ""}`,
        )
        .join(", "),
  );
  const writable = [...rollUps.values()].filter(
    (v) => !DOC_BLOCKING_VERDICTS.has(v),
  ).length;
  log.info(
    `${writable} of ${rollUps.size} winner extract(s) carry a NON-BLOCKING ` +
      `roll-up and would be eligible for the projection.`,
  );

  // ── Persist the verdicts, if and only if asked ──────────────────────
  let verdictsWritten = 0;
  if (APPLY && rollUps.size > 0) {
    // Grouped by VERDICT so this is at most five `updateMany` calls rather than
    // one `update` per row. The COUNT IS READ BACK: an `updateMany` that
    // silently matched zero rows is otherwise indistinguishable from one that
    // moved the whole page, and the run would report success either way — the
    // MONEY-1238 lesson, applied to the one write this script performs.
    const byVerdict = new Map<ReconcileVerdict, string[]>();
    for (const [id, v] of rollUps) {
      const list = byVerdict.get(v);
      if (list) list.push(id);
      else byVerdict.set(v, [id]);
    }
    for (const [verdict, ids] of byVerdict) {
      for (let i = 0; i < ids.length; i += 500) {
        const slice = ids.slice(i, i + 500);
        const res = await prisma.documentFinancialExtract.updateMany({
          where: { id: { in: slice } },
          data: { reconcileVerdict: verdict },
        });
        verdictsWritten += res.count;
        if (res.count < slice.length) {
          log.warn(
            `verdict write matched FEWER rows than it named ` +
              `(${res.count} of ${slice.length} for ${verdict}) — those ` +
              `extracts stay ungraded and the projection will refuse them`,
          );
        }
      }
    }
    log.info(
      `wrote reconcileVerdict on ${verdictsWritten} of ${rollUps.size} winner ` +
        `extract(s). Superseded siblings are deliberately NOT graded: they will ` +
        `never be written, so a verdict on them would be evidence about a row ` +
        `that does not exist.`,
    );
  } else if (!APPLY) {
    log.info(
      `wrote 0 verdicts because --apply was not seen. ${rollUps.size} extract(s) ` +
        `WOULD have been graded. If you passed --apply, check that ` +
        `scripts/ops/run-market-data-job.sh declares APPLY_FLAG="--apply" for ` +
        `this job — it consumes the flag and re-emits only its own declaration.`,
    );
  }

  // ── Verdict ─────────────────────────────────────────────────────────
  const ceilingFailed =
    ceiling.verdict !== "OK" &&
    // A scoped run may legitimately sit under the floor; it may NOT legitimately
    // find zero extracts or a broken join, so only BELOW_FLOOR is forgiven.
    !(RUN_IS_SCOPED && ceiling.verdict === "BELOW_FLOOR");
  if (RUN_IS_SCOPED && ceiling.verdict === "BELOW_FLOOR") {
    log.warn(
      `SCOPED RUN — under the comparable floor (${ceiling.comparable} < ` +
        `${ceiling.floor}) and NOT failed for it. A scoped run cannot ` +
        `authorise anything; re-run unscoped before arming.`,
    );
  }

  const blockedFields = outcomes
    .filter((o) => o.verdict === "BLOCKED")
    .map((o) => o.field);
  const unverifiable = outcomes
    .filter((o) => o.verdict === "UNVERIFIABLE")
    .map((o) => o.field);

  log.info(
    ceilingFailed
      ? `VERDICT: NO USABLE EVIDENCE — ${ceiling.reason}. Nothing below this ` +
          `line should be read as agreement; "0 disagreements" over 0 ` +
          `comparisons is what a broken pipe prints too.`
      : anyBlocked
        ? `VERDICT: NOT ready. ${blockedFields.length} field(s) BLOCKED ` +
            `(${blockedFields.join(", ")}). Surviving scale and sign errors are ` +
            `systematic — one occurrence implies a whole class of periods is ` +
            `wrong — so fix them, do not average them away. ${nullingTotal} ` +
            `populated incumbent value(s) would be NULLED by arming and no rate ` +
            `above reflects them.`
        : `VERDICT: every graded field is READY or UNVERIFIABLE over ` +
            `${ceiling.comparable} comparable pair(s). ` +
            (unverifiable.length > 0
              ? `${unverifiable.length} field(s) are UNVERIFIABLE ` +
                `(${unverifiable.join(", ")}) — the incumbent has NO value ` +
                `anywhere for them, so there is nothing to compare and nothing ` +
                `for the write to destroy. That is a NON-CLAIM, not agreement. `
              : ``) +
            `${nullingTotal} populated incumbent value(s) would be NULLED by ` +
            `arming; those pairs are INCOMPARABLE and no rate above reflects ` +
            `them. Arming is ${DOC_SOURCE === "DOC_PDF" ? "DOC_FINANCIALS_APPLY" : "?"}, ` +
            `and it is a separate, deliberate act.`,
  );

  if (ceilingFailed || anyBlocked) process.exitCode = 1;

  await prisma.$disconnect();
}

main().catch(async (err) => {
  log.error("FAILED", err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
