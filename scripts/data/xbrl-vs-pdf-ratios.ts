#!/usr/bin/env tsx
/**
 * XBRL vs OUR OWN PDF PARSE — the vendor-free tie-break. MONEY-1401.
 *
 * READ-ONLY. Writes nothing, ever.
 *
 * ## Why this exists
 *
 * `xbrl-ratios-validate.ts` grades our derivation against Tickertape's
 * `stock_ratios`. That vendor is DEAD: the table is frozen on a 2026-03-21
 * snapshot, `financial-data-sync` is retired, and `api.tickertape.in` 403s our
 * production egress. So when the gate reports a disagreement — `roce`, 1,012 of
 * them, median tickertape/xbrl 2.05 — there is no one to ask. We cannot inspect
 * their formula, cannot see their inputs, and cannot get a corrected row.
 *
 * But we hold TWO INDEPENDENT DERIVATIONS OF THE SAME PRIMARY DOCUMENT:
 *
 *   `xbrl_filings`                  NSE's structured XBRL, ~2,468 symbols
 *   `document_financial_extracts`   our own PDF parse,     ~3,802 symbols
 *
 * 1,557 symbols carry both (measured prod 2026-09-13). That overlap replaces
 * screener.in as the tie-break: a vendor disagreement we can neither inspect
 * nor fix becomes a disagreement between two of our own parsers, which we can
 * do both to.
 *
 * ## THE INTERPRETATION RULE — read this before acting on the output
 *
 *   XBRL ~= PDF, and both differ from the vendor
 *       -> the two sides are measuring DIFFERENT QUANTITIES and the documents
 *          agree with us. That is a DECLARED DIVERGENCE: add `roce` to
 *          `DECLARED_DIVERGENCES` in `xbrl-ratios-validate.ts` beside
 *          `debtToEquity`, with the definitional difference written out. The
 *          bar for that map is high and stated there — the difference must be
 *          definitional, measured, and impossible to close from the documents
 *          we hold. Two independent parses of the same filing agreeing against
 *          the vendor is exactly that evidence.
 *
 *   XBRL != PDF
 *       -> OUR OWN FORMULA (or one of the two parsers) IS WRONG. Do not
 *          declare anything. Fix `deriveRatios` in `xbrl-projection.ts`, or the
 *          extraction prompt, and re-run. A declaration here would be a
 *          suppression: we would be agreeing to arm over a number our own two
 *          readings of the same page cannot reproduce.
 *
 * The failure this rule is written against is the easy one: seeing a vendor
 * disagreement, calling it "definitional", and arming. `StockRatios` is
 * `@@unique([symbol, exchange])` with no `source` in the key, so the first XBRL
 * write destroys the incumbent and the question can never be asked again in
 * that environment.
 *
 * ## ONE FORMULA, TWO INPUTS — and the one place that is not true
 *
 * Both sides run the SAME `deriveRatios`, via `extractToRatioInputs` for the
 * document cohort. That is the whole design: if the two sides used different
 * arithmetic, a disagreement would be about the arithmetic and would tell us
 * nothing about the numbers. `netMargin` and `roe` are therefore genuinely
 * parser-against-parser.
 *
 * `roce` IS NOT, and cannot be. `deriveRatios` builds EBIT as
 * `profitBeforeTax + financeCosts - exceptionalItems`, and the extraction
 * prompt asks for none of those three — `document-ratio-inputs.ts` says so in
 * its header ("`roce` and `interestCoverage` are genuinely unavailable"). So
 * the PDF side of `roce` is computed HERE, from the columns the extract does
 * carry:
 *
 *     EBIT            = operatingIncomeExOtherIncome + otherIncome
 *     capitalEmployed = totalEquity + totalDebt            (matches deriveRatios)
 *
 * That EBIT is an APPROXIMATION of the XBRL one — it is operating profit plus
 * other income, where the XBRL route is pre-tax profit plus finance costs, and
 * the two differ by exceptional items and by anything sitting between. It is
 * labelled `roce*` in the output for that reason, and a disagreement on it is
 * weaker evidence than one on `netMargin` or `roe`.
 *
 * AND IT IS THIN. Measured prod 2026-09-13: `operatingIncomeExOtherIncome` is
 * filled on 341 of 24,273 EXTRACTED ANNUAL CONSOLIDATED rows (1.4%), against
 * 22,085 for `revenueFromOperations` and 21,876 for `netIncome`. `revenue`,
 * `operatingIncome` and `ebitda` are filled on ZERO rows — dead columns. So the
 * `roce*` column will be small or empty, and THAT IS ITSELF THE FINDING: the
 * tie-break for the one ratio currently blocking the gate does not exist until
 * the extraction prompt asks for `profitBeforeTax` and `financeCosts`. An empty
 * column here is a ticket, not a pass.
 *
 * ## CLOSING equity on BOTH sides, deliberately
 *
 * `deriveRatios` is called with NO `priorYear`, so `roe` uses the CLOSING
 * balance on both sides. The AVERAGE convention exists to match the VENDOR, and
 * the vendor is not the subject here — what matters is that the two sides use
 * the same denominator as each other. The three-way vendor column below
 * therefore carries a known denominator-convention difference; it is CONTEXT
 * for the interpretation rule, not a verdict. A convention difference moves a
 * ratio by a few percent, not by 2x.
 *
 * ## Usage
 *
 *   npx tsx scripts/data/xbrl-vs-pdf-ratios.ts --env=prod
 *   npx tsx scripts/data/xbrl-vs-pdf-ratios.ts --env=prod --symbols=TCS,INFY
 *
 * `--env` resolves `DATABASE_URL_{QA|PROD}` from GCP Secret Manager exactly as
 * `scripts/ops/run-market-data-job.sh` does, and NEVER prints it.
 */

import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
// TYPE-ONLY, and that is load-bearing rather than tidy.
//
// `@usemoney/core/market-data` is a barrel that reaches `@usemoney/database`
// as a VALUE through ten modules, and that package builds its PrismaClient at
// MODULE scope from `process.env.DATABASE_URL`. ESM evaluates every static
// import before any statement in this file's body, so a value import here
// would construct a client pointed at whatever the shell exported — BEFORE
// `--env` has been read. `ops-script-db-target.test.ts` is the guard for that
// class; a `import type` is erased at compile time and cannot construct
// anything, so the functions are pulled in by `await import(...)` inside
// `main()` instead, after the target is resolved.
//
// This script also builds its OWN client from the resolved URL rather than
// using the shared one, which removes the ambiguity entirely: there is no
// path by which a read here can come from a database `--env` did not name.
import type { XbrlFinancials } from "@usemoney/core/market-data";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

const ENV = (arg("env") ?? "").toLowerCase();
const SYMBOLS = (arg("symbols") ?? "")
  .split(",")
  .map((x) => x.trim().toUpperCase())
  .filter(Boolean);
const SHOW_WORST = 10;

const GCP_PROJECT = "stock-book-483718";

const log = {
  info: (...a: unknown[]) => console.log("[xbrl-vs-pdf]", ...a),
  warn: (...a: unknown[]) => console.warn("[xbrl-vs-pdf]", ...a),
};

/**
 * The connection string, from Secret Manager. NEVER printed, not even masked —
 * this script has no reason to show it and every reason not to.
 *
 * `execFileSync` rather than a shell string: the env name is interpolated into
 * the secret id, and a shell here would make that an injection point for a
 * command-line argument.
 */
function resolveDatabaseUrl(env: string): string {
  const url = execFileSync(
    "gcloud",
    [
      "secrets",
      "versions",
      "access",
      "latest",
      `--secret=DATABASE_URL_${env.toUpperCase()}`,
      `--project=${GCP_PROJECT}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  if (!url) throw new Error(`empty DATABASE_URL_${env.toUpperCase()}`);
  return url;
}

const RATIOS = ["roce", "roe", "netMargin"] as const;
type RatioKey = (typeof RATIOS)[number];

interface Pair {
  symbol: string;
  periodEnd: Date;
  ratio: RatioKey;
  xbrl: number;
  pdf: number;
  /** |xbrl - pdf| / |pdf|. */
  relDiff: number;
  vendor: number | null;
}

/** Finite-only. Everything else is absence — never a zero. */
function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * `roce` from the extract's own columns — see the header for why this cannot
 * route through `deriveRatios` and what it approximates.
 *
 * Capital employed matches `deriveRatios` exactly (equity + borrowings, and a
 * missing borrowings leg refuses rather than silently becoming ROE). The
 * numerator does not, and cannot.
 */
function roceFromExtract(row: {
  operatingIncomeExOtherIncome: number | null;
  otherIncome: number | null;
  totalEquity: number | null;
  totalDebt: number | null;
}): number | undefined {
  const op = finite(row.operatingIncomeExOtherIncome);
  const other = finite(row.otherIncome);
  const equity = finite(row.totalEquity);
  const debt = finite(row.totalDebt);
  if (op === undefined || equity === undefined || debt === undefined) {
    return undefined;
  }
  const capitalEmployed = equity + debt;
  if (capitalEmployed <= 0) return undefined;
  // `otherIncome` absent means the statement did not separate it, not that it
  // was zero — but EBIT without it is still an EBIT, just a narrower one. Kept
  // as 0 rather than refusing, and the `roce*` label carries the caveat.
  return ((op + (other ?? 0)) / capitalEmployed) * 100;
}

/** p50 of a list. Empty -> null. */
function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

async function main(): Promise<void> {
  if (ENV !== "qa" && ENV !== "prod") {
    log.warn("usage: --env={qa|prod} [--symbols=A,B]");
    process.exitCode = 1;
    return;
  }
  const prisma = new PrismaClient({
    datasources: { db: { url: resolveDatabaseUrl(ENV) } },
  });
  const {
    deriveRatios,
    extractToRatioInputs,
    selectAnnualExtractsByPeriod,
    selectFilingForPeriod,
  } = await import("@usemoney/core/market-data");

  log.info(`READ-ONLY. env=${ENV}. Nothing will be written.`);

  try {
    // ── OUR TWO READINGS OF THE SAME DOCUMENT ────────────────────────────
    //
    // CONSOLIDATED only, on both sides. A company files both bases and they
    // differ by a MULTIPLE for any holding company (360ONE FY2025 totalAssets:
    // 19,768 Cr consolidated against 7,332 Cr standalone), so a cross-basis
    // pair would report a parser disagreement that is really a scope
    // disagreement — the MONEY-1346 shape.
    const filings = await prisma.xbrlFiling.findMany({
      where: {
        periodType: "ANNUAL",
        cumulative: false,
        basis: "CONSOLIDATED",
        ...(SYMBOLS.length ? { symbol: { in: SYMBOLS } } : {}),
      },
      select: {
        symbol: true,
        periodEnd: true,
        basis: true,
        facts: true,
        coverage: true,
        // `selectFilingForPeriod`'s tie-break is basis -> coverage -> filedAt
        // -> sourceUrl and is documented as needing to be a TOTAL order.
        // Fetching a prefix leaves ties falling back to query order.
        filedAt: true,
        sourceUrl: true,
      },
    });

    const extracts = await prisma.documentFinancialExtract.findMany({
      where: {
        status: "EXTRACTED",
        periodType: "ANNUAL",
        basis: "CONSOLIDATED",
        ...(SYMBOLS.length ? { symbol: { in: SYMBOLS } } : {}),
      },
      select: {
        symbol: true,
        periodEnd: true,
        periodType: true,
        basis: true,
        revenueFromOperations: true,
        otherIncome: true,
        operatingIncomeExOtherIncome: true,
        ebitdaBeforeExceptionalItems: true,
        netIncome: true,
        totalAssets: true,
        totalLiabilities: true,
        totalEquity: true,
        totalDebt: true,
        totalCash: true,
        eps: true,
        faceValue: true,
        paidUpCapital: true,
      },
    });

    const vendorRows = await prisma.stockRatios.findMany({
      select: { symbol: true, roce: true, roe: true, netMargin: true },
    });
    const vendor = new Map(vendorRows.map((v) => [v.symbol, v]));

    // Key on (symbol, periodEnd) — the SAME FISCAL YEAR, stated as a date
    // rather than as the extract's free-text `fiscalYear` label. That column is
    // documented as "A LABEL, never a sort key": "FY2025", "Q3 FY2024-25" and
    // "2024-25" all appear, and matching on it would join on spelling.
    const key = (symbol: string, periodEnd: Date): string =>
      `${symbol}\u0000${periodEnd.toISOString().slice(0, 10)}`;

    const xbrlByKey = new Map<string, (typeof filings)[number]>();
    const bySymbolPeriod = new Map<string, (typeof filings)[number][]>();
    for (const f of filings) {
      const k = key(f.symbol, f.periodEnd);
      const g = bySymbolPeriod.get(k);
      if (g) g.push(f);
      else bySymbolPeriod.set(k, [f]);
    }
    for (const [k, rows] of bySymbolPeriod) {
      // Same writer-side choice the projection makes, rather than "first seen".
      const winner = selectFilingForPeriod(rows);
      if (winner) xbrlByKey.set(k, winner);
    }

    const pdfByKey = new Map<string, (typeof extracts)[number]>();
    const extractsBySymbol = new Map<string, (typeof extracts)[number][]>();
    for (const e of extracts) {
      const g = extractsBySymbol.get(e.symbol);
      if (g) g.push(e);
      else extractsBySymbol.set(e.symbol, [e]);
    }
    for (const [symbol, rows] of extractsBySymbol) {
      // One reading per period. A single annual report legitimately yields
      // several rows (current + prior year × both bases), and this year's
      // report and next year's both carry this year's figures.
      for (const row of selectAnnualExtractsByPeriod(rows)) {
        pdfByKey.set(key(symbol, row.periodEnd), row);
      }
    }

    const overlapKeys = [...xbrlByKey.keys()].filter((k) => pdfByKey.has(k));
    const overlapSymbols = new Set(overlapKeys.map((k) => k.split("\u0000")[0]));
    log.info(
      `XBRL annual CONSOLIDATED: ${xbrlByKey.size} (symbol, year) cell(s); ` +
        `PDF extracts: ${pdfByKey.size}; OVERLAP ${overlapKeys.length} cell(s) ` +
        `across ${overlapSymbols.size} symbol(s).`,
    );
    if (overlapKeys.length === 0) {
      log.warn(
        "NO OVERLAP. That is not a pass — it means the tie-break does not " +
          "exist in this environment and the vendor disagreement stays " +
          "un-adjudicated.",
      );
      process.exitCode = 1;
      return;
    }

    // ── DERIVE BOTH SIDES ────────────────────────────────────────────────
    const pairs: Pair[] = [];
    /** Cells where a side could not produce the ratio at all, per column. */
    const missing: Record<RatioKey, { xbrl: number; pdf: number }> = {
      roce: { xbrl: 0, pdf: 0 },
      roe: { xbrl: 0, pdf: 0 },
      netMargin: { xbrl: 0, pdf: 0 },
    };

    for (const k of overlapKeys) {
      const filing = xbrlByKey.get(k)!;
      const extract = pdfByKey.get(k)!;
      const facts = filing.facts as unknown;
      if (facts === null || typeof facts !== "object") continue;

      // NO `priorYear` on either side — CLOSING equity on both. See the header.
      const x = deriveRatios(facts as XbrlFinancials);
      const p = deriveRatios(extractToRatioInputs(extract));
      const pdfRoce = roceFromExtract(extract);

      const vendorRow = vendor.get(filing.symbol);
      for (const ratio of RATIOS) {
        const xv = finite((x as Record<string, unknown>)[ratio]);
        const pv =
          ratio === "roce"
            ? pdfRoce
            : finite((p as Record<string, unknown>)[ratio]);
        if (xv === undefined) missing[ratio].xbrl++;
        if (pv === undefined) missing[ratio].pdf++;
        if (xv === undefined || pv === undefined) continue;
        pairs.push({
          symbol: filing.symbol,
          periodEnd: filing.periodEnd,
          ratio,
          xbrl: xv,
          pdf: pv,
          relDiff:
            pv === 0
              ? Number.POSITIVE_INFINITY
              : Math.abs(xv - pv) / Math.abs(pv),
          vendor:
            vendorRow === undefined
              ? null
              : (finite(
                  (vendorRow as unknown as Record<string, unknown>)[ratio],
                ) ?? null),
        });
      }
    }

    // ── REPORT ───────────────────────────────────────────────────────────
    log.info("");
    log.info("XBRL vs PDF — two parses of ONE document, ONE formula:");
    for (const ratio of RATIOS) {
      const rows = pairs.filter((r) => r.ratio === ratio);
      const label = ratio === "roce" ? "roce*" : ratio;
      if (rows.length === 0) {
        log.warn(
          `  ${label.padEnd(12)} n=0 — NO TIE-BREAK EXISTS for this column. ` +
            `Ours produced nothing on ${missing[ratio].xbrl} cell(s), the PDF ` +
            `side on ${missing[ratio].pdf}. An empty column is a finding, not ` +
            `a pass.`,
        );
        continue;
      }
      const within = (t: number) => rows.filter((r) => r.relDiff <= t).length;
      const p50 = median(
        rows.filter((r) => r.pdf !== 0).map((r) => r.xbrl / r.pdf),
      );
      log.info(
        `  ${label.padEnd(12)} n=${String(rows.length).padStart(5)}  ` +
          `agree<=1% ${String(within(0.01)).padStart(5)} ` +
          `(${((within(0.01) / rows.length) * 100).toFixed(1)}%)  ` +
          `agree<=5% ${String(within(0.05)).padStart(5)} ` +
          `(${((within(0.05) / rows.length) * 100).toFixed(1)}%)  ` +
          `p50 xbrl/pdf ${p50 === null ? "n/a" : p50.toFixed(3)}  ` +
          `[unproduced: xbrl ${missing[ratio].xbrl}, pdf ${missing[ratio].pdf}]`,
      );
    }

    // ── THE THREE-WAY ────────────────────────────────────────────────────
    //
    // Only the cells where a vendor value exists. This is the line the
    // interpretation rule is read off: if xbrl/pdf sits at ~1.0 while
    // tickertape/xbrl and tickertape/pdf BOTH sit somewhere else, the two
    // documents agree with each other and disagree with the vendor.
    log.info("");
    log.info(
      "THREE-WAY (cells with a vendor value) — the line the interpretation " +
        "rule is read off:",
    );
    for (const ratio of RATIOS) {
      const rows = pairs.filter((r) => r.ratio === ratio && r.vendor !== null);
      const label = ratio === "roce" ? "roce*" : ratio;
      if (rows.length === 0) {
        log.info(`  ${label.padEnd(12)} n=0 — no vendor value on any cell.`);
        continue;
      }
      const tx = median(
        rows.filter((r) => r.xbrl !== 0).map((r) => r.vendor! / r.xbrl),
      );
      const tp = median(
        rows.filter((r) => r.pdf !== 0).map((r) => r.vendor! / r.pdf),
      );
      const xp = median(
        rows.filter((r) => r.pdf !== 0).map((r) => r.xbrl / r.pdf),
      );
      log.info(
        `  ${label.padEnd(12)} n=${String(rows.length).padStart(5)}  ` +
          `p50 xbrl/pdf ${xp === null ? "n/a" : xp.toFixed(3)}  ` +
          `p50 tickertape/xbrl ${tx === null ? "n/a" : tx.toFixed(3)}  ` +
          `p50 tickertape/pdf ${tp === null ? "n/a" : tp.toFixed(3)}`,
      );
    }

    log.info("");
    log.info(
      `worst ${SHOW_WORST} per column (xbrl vs pdf, both values shown):`,
    );
    for (const ratio of RATIOS) {
      const rows = pairs
        .filter((r) => r.ratio === ratio)
        .sort((a, b) => b.relDiff - a.relDiff)
        .slice(0, SHOW_WORST);
      if (rows.length === 0) continue;
      log.info(`  ${ratio === "roce" ? "roce*" : ratio}:`);
      for (const r of rows) {
        log.info(
          `    ${r.symbol.padEnd(14)} ${r.periodEnd.toISOString().slice(0, 10)} ` +
            `xbrl=${r.xbrl.toFixed(3)} pdf=${r.pdf.toFixed(3)} ` +
            `(${Number.isFinite(r.relDiff) ? `${(r.relDiff * 100).toFixed(1)}% off` : "pdf=0"})` +
            (r.vendor === null ? "" : ` tickertape=${r.vendor.toFixed(3)}`),
        );
      }
    }

    log.info("");
    log.info(
      "INTERPRETATION: xbrl~=pdf AND both != vendor -> a DECLARED divergence " +
        "(add the ratio to DECLARED_DIVERGENCES in xbrl-ratios-validate.ts, " +
        "with the definitional difference written out). xbrl != pdf -> OUR " +
        "formula is wrong; fix deriveRatios, declare nothing.",
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error("[xbrl-vs-pdf] failed:", err);
  process.exitCode = 1;
});
