/**
 * Gemini PDF financials extractor — MONEY-1255.
 *
 * Reads filed annual-report / results PDFs out of GCS, hands each to a
 * Flash-tier Gemini model under a constrained JSON schema, normalises the
 * figures to CRORES, validates them against our own arithmetic, and writes one
 * `DocumentFinancialExtract` row per (period, basis).
 *
 * ## Scope: this lane EXTRACTS. It does not project.
 *
 * Nothing here writes `stock_financials`. That table has no `source` in its
 * unique key, so the first write for a period ERASES the value it replaced and
 * there is nothing left to reconcile against — which is why the raw reading
 * lands in its own table first and the projection is a separate, gated step.
 * `DOC_FINANCIALS_APPLY` (compared against the LITERAL string `"true"`, never
 * `Boolean()`, since `Boolean("false")` is `true`) will gate THAT step. It is
 * deliberately not consulted here: writing `document_financial_extracts` is
 * always safe, because its unique key carries `documentId` AND `basis`, so a
 * write never destroys a value it cannot reproduce.
 *
 * ## Two things this job is shaped by
 *
 *   1. **`parseStatus` is ABSENT on all ~43,105 pre-existing rows.** A Mongo
 *      `db push` creates indexes, never fields, so `{ parseStatus: "PENDING" }`
 *      matches zero of them and the failure is invisible — "nothing to parse"
 *      and "the whole backlog is unreachable" print the same line. See
 *      `PENDING_OR_ABSENT_PARSE_STATUS`.
 *   2. **The 600s Pub/Sub ack deadline.** Overrunning it REDELIVERS the
 *      message, so a second copy of the job runs concurrently on the same page
 *      — here that means paying twice for every model call. The run is bounded
 *      by a wall clock (`RUN_TIME_BUDGET_MS`), not a count, and continues by
 *      SELF-CHAINING under a depth bound that does not consult the database.
 */

import prisma, { Prisma } from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { getPubSubClient } from "@usemoney/pubsub/client";
import { getTopicName } from "@usemoney/types/pubsub";
import {
  buildDocumentFinancialsPrompt,
  mapDocumentFinancials,
} from "@usemoney/core/market-data/document-financials-logic";

import { downloadFromGCS } from "../lib/gcs";
import { parsePdfFinancials } from "../lib/gemini-pdf";
// The gs:// builder is IMPORTED rather than re-derived. It pins the bucket to
// GCP_STORAGE_BUCKET and rejects a key that carries its own scheme, an absolute
// path, a `..` segment or a control character — a rule that must not exist in
// two places, which is the exact lesson `doc-mime.ts` was written to encode.
import { buildGcsUri } from "./stock-document-extract-logic";
// MONEY-1314 — these two moved to a shared module so this lane and the new
// ingest lane cannot drift about what a reading is. Same key, same table.
import { markParseStatus, upsertExtract } from "./doc-extract-persist";
import {
  buildClaimWhere,
  buildParseQuery,
  PARSE_SCAN_CAP,
  selectBreadthFirst,
  buildPhaseQuery,
  canPhaseOnCoveredSymbols,
  describeCohortProgress,
  isWithinRunBudget,
  normalizeChainDepth,
  resolveDocumentParseStatus,
  phasesToRun,
  shouldChainAnotherBatch,
  tallyReasons,
  DEFAULT_PARSE_BATCH_SIZE,
  MAX_CHAIN_DEPTH,
  PARSE_ORDER_BY,
  RUN_TIME_BUDGET_MS,
  STOCK_DOCUMENT_PARSE_TOPIC,
  type ParsePhase,
  type PhaseProgress,
  type StockDocumentParseMessage,
} from "./stock-document-parse-logic";
import { llmWorkflow } from "@usemoney/datadog/llmobs";

const logger = {
  info: (...args: unknown[]) => console.log("[stock-doc-parse]", ...args),
  warn: (...args: unknown[]) => console.warn("[stock-doc-parse]", ...args),
  error: (...args: unknown[]) => console.error("[stock-doc-parse]", ...args),
};

/**
 * Entry point for the `doc-parse` job. The body lives in `runStockDocumentParse`; this wrapper
 * exists only to tag every model call underneath it with
 * `ml_app: doc-ingest` (MONEY-1380).
 *
 * Tagging here rather than at the call sites works because dd-trace resolves an
 * LLM span's `ml_app` from its nearest LLMObs parent, so calls several packages
 * deep inherit it without knowing this file exists.
 */
export async function processStockDocumentParse(
  message: StockDocumentParseMessage,
): Promise<void> {
  return llmWorkflow("doc-ingest", "doc-parse", () =>
    runStockDocumentParse(message),
  );
}

async function runStockDocumentParse(
  message: StockDocumentParseMessage,
): Promise<void> {
  const {
    symbols,
    docTypes,
    force = false,
    batchSize = DEFAULT_PARSE_BATCH_SIZE,
    model: modelOverride,
  } = message;
  const chainDepth = normalizeChainDepth(message.chainDepth);
  const startedAt = Date.now();

  logger.info(
    `Starting document financials parse (force: ${force}, batch: ${batchSize}, ` +
      `chainDepth: ${chainDepth}/${MAX_CHAIN_DEPTH}, budget: ${RUN_TIME_BUDGET_MS}ms, ` +
      `symbols: ${symbols?.join(",") || "all"}, docTypes: ${docTypes?.join(",") || "default"})`,
  );

  const base = buildParseQuery({ symbols, docTypes, force });

  // WHICH COMPANY GETS READ FIRST. 298 symbols have no financials at all and
  // 1,373 already do; for the first group a parse is the ONLY source, for the
  // second it is a second opinion. Ordering the no-data cohort first turns a
  // 131-night wait into 29 for the companies that today show an empty tab. See
  // PARSE_PHASES for why this is an ORDERING key and not an eligibility filter.
  const covered = await fetchCoveredSymbols();
  const phases = phasesToRun(
    canPhaseOnCoveredSymbols(covered.symbols) ? covered.symbols.length : 0,
  );

  const documents: Array<PhasedDocument> = [];
  const phaseSelected = new Map<ParsePhase, number>();

  // MONEY-1259 — BREADTH before DEPTH inside each phase. The pick cannot be an
  // `orderBy`: `period` is free text ("2024", "FY2024-25", "Q1-2026" in one
  // column), so fiscal-year order only exists in JavaScript. Scan the narrow
  // projection, choose in memory, then read the full rows for the chosen ids.
  const served = await fetchServedSymbols();

  for (const phase of phases) {
    const room = batchSize - documents.length;
    if (room <= 0) break;

    const scan = await prisma.stockDocument.findMany({
      where: buildPhaseQuery(base, covered.symbols, phase),
      select: { id: true, symbol: true, period: true, fetchedAt: true },
      // `fetchedAt` ASC still orders WITHIN the phase — the rotation marker is
      // untouched. It now orders the SCAN, and therefore the fill that follows
      // the breadth pass, so a run that needs no breadth behaves as before.
      orderBy: PARSE_ORDER_BY,
      take: PARSE_SCAN_CAP,
    });

    const chosenIds = selectBreadthFirst(scan, served, room);
    if (chosenIds.length === 0) {
      phaseSelected.set(phase, 0);
      continue;
    }

    const rows = await prisma.stockDocument.findMany({
      where: { id: { in: chosenIds } },
      select: {
        id: true,
        instrumentId: true,
        symbol: true,
        exchange: true,
        gcsPath: true,
        mimeType: true,
        docType: true,
        period: true,
        title: true,
      },
    });

    // `in` does not preserve argument order, and the order IS the feature here
    // — restore it rather than letting Mongo's natural order silently undo the
    // breadth pass.
    const byId = new Map(rows.map((r) => [r.id, r]));
    const page = chosenIds
      .map((id) => byId.get(id))
      .filter((r): r is (typeof rows)[number] => r !== undefined);

    phaseSelected.set(phase, page.length);
    for (const doc of page) documents.push({ ...doc, phase });
  }

  /**
   * Rows this run took on. Named once rather than read off `documents.length`
   * at four call sites, because it is also the `selected` half of the
   * zero-write monitor's condition and that number has to mean ONE thing.
   */
  const selected = documents.length;
  /** Documents that reached PARSED. The `written` half of the same condition. */
  let parsed = 0;
  let failed = 0;
  let failedValidation = 0;
  let unsupported = 0;
  /** Extract ROWS persisted. A different unit from `parsed` — see below. */
  let rowsWritten = 0;
  /** Model calls that failed at the transport layer, in CALLS not rows. */
  let transportFailures = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  /**
   * Documents that actually LEFT the pending set — the PROCESSING flip landed.
   *
   * This, not `parsed + failed`, is the self-chain's progress signal. A
   * document whose very first update throws stays PENDING and would be
   * re-selected by the identical next query; chaining on a run where that
   * happened to EVERY document is the runaway-poll shape.
   */
  let leftPending = 0;
  let stoppedOnBudget = false;
  const dropTally: string[] = [];
  /** PARSED documents per cohort — the half of the summary that is free. */
  const phaseParsed = new Map<ParsePhase, number>();

  try {
    if (selected === 0) {
      logger.info("No pending financial-statement PDFs to parse");
      return;
    }

    logger.info(`Found ${selected} documents to parse (oldest first)`);

    for (const doc of documents) {
      // The 600s ack deadline is the binding constraint and it is a TIME, so it
      // is enforced with a clock rather than a count. Checked BETWEEN
      // documents, so the true wall is `budget + one document` — the headroom
      // arithmetic on RUN_TIME_BUDGET_MS pays for exactly that, and the 180s
      // client-side timeout in `gemini-pdf.ts` is what bounds it.
      if (!isWithinRunBudget(startedAt, Date.now())) {
        stoppedOnBudget = true;
        logger.info(
          `Run budget reached after ${Date.now() - startedAt}ms — stopping at ` +
            `${parsed + failed + failedValidation + unsupported}/${selected}; ` +
            "the rest stay pending and the chained follow-up takes them.",
        );
        break;
      }

      const label = `${doc.symbol} (${doc.docType}/${doc.period})`;

      try {
        // The moment the row leaves the pending set — and therefore the moment
        // progress becomes true for the chain decision.
        //
        // MONEY-1259: `updateMany` + a guard, not a bare `update`. With four
        // triggers a day two runs can overlap, and an unguarded claim lets both
        // pay for the same model call — the extract `@@unique` dedupes the
        // ROWS, never the SPEND. `count === 0` means a concurrent run took this
        // document; that is an ordinary outcome, so skip it without counting it
        // as progress. See `buildClaimWhere` for why the guard is derived from
        // the selection arms and is NOT a `notIn`.
        const claim = await prisma.stockDocument.updateMany({
          where: buildClaimWhere(doc.id, force) as never,
          data: { parseStatus: "PROCESSING" },
        });
        if (claim.count === 0) {
          logger.info(`Claimed by a concurrent run, skipping: ${label}`);
          continue;
        }
        leftPending++;

        let bytes: Buffer;
        try {
          bytes = await downloadFromGCS(doc.gcsPath);
        } catch (downloadErr) {
          logger.warn(
            `GCS object missing for ${label}: ${errText(downloadErr)}`,
          );
          await markParseStatus(doc.id, "FAILED");
          failed++;
          continue;
        }

        // Both transports are offered. The Developer API uploads the bytes via
        // the Files API; the Vertex fallback reads the gs:// object directly
        // and never uploads. `buildGcsUri` throws on an unsafe key, which is a
        // per-document failure and not a reason to lose the batch — hence the
        // try/catch rather than a hoisted call.
        let gcsUri: string | null = null;
        try {
          gcsUri = buildGcsUri(doc.gcsPath);
        } catch {
          gcsUri = null;
        }

        const result = await parsePdfFinancials({
          bytes,
          gcsUri,
          mimeType: doc.mimeType || "application/pdf",
          prompt: buildDocumentFinancialsPrompt({
            symbol: doc.symbol,
            docType: doc.docType,
            period: doc.period,
            title: doc.title,
          }),
          label,
          modelOverride,
        });

        promptTokens += result.usage.promptTokens;
        outputTokens += result.usage.candidatesTokens;
        if (
          result.failure === "CALL_FAILED" ||
          result.failure === "UNCONFIGURED"
        ) {
          transportFailures++;
        }

        const mapped = result.ok
          ? mapDocumentFinancials(result.data)
          : { rows: [], dropped: [], periodsReturned: 0 };

        // Persist EVERY mapped row, EXTRACTED and FAILED_VALIDATION alike. A
        // wrong answer that is recorded is a prompt signal; a wrong answer that
        // is dropped is nothing. Rows that could not be dated at all never
        // reach here — `periodEnd` is required and both readers sort on it, so
        // an undated row would render in the wrong position, which is worse
        // than absent.
        let extractedRows = 0;
        let invalidRows = 0;
        for (const { row, verdict } of mapped.rows) {
          try {
            await upsertExtract({
              documentId: doc.id,
              instrumentId: doc.instrumentId,
              symbol: doc.symbol,
              exchange: doc.exchange,
              model: result.model,
              row,
              verdict,
            });
            rowsWritten++;
            if (verdict.status === "EXTRACTED") extractedRows++;
            else invalidRows++;
          } catch (writeErr) {
            logger.error(
              `Failed to write extract for ${label} ${row.basis} ` +
                `${row.periodEnd.toISOString().slice(0, 10)}: ${errText(writeErr)}`,
            );
          }
        }
        dropTally.push(...mapped.dropped);

        const outcome = resolveDocumentParseStatus({
          callFailure: result.failure,
          periodsReturned: mapped.periodsReturned,
          extractedRows,
          invalidRows,
          droppedReasons: mapped.dropped,
        });

        await markParseStatus(
          doc.id,
          outcome.status,
          outcome.status === "PARSED" ? new Date() : null,
        );

        switch (outcome.status) {
          case "PARSED":
            parsed++;
            phaseParsed.set(doc.phase, (phaseParsed.get(doc.phase) ?? 0) + 1);
            break;
          case "UNSUPPORTED":
            unsupported++;
            break;
          case "FAILED_VALIDATION":
            failedValidation++;
            break;
          default:
            failed++;
        }

        logger.info(
          `${label} -> ${outcome.status} (${extractedRows} extracted, ` +
            `${invalidRows} invalid, ${mapped.periodsReturned} periods returned)` +
            (outcome.reason ? ` — ${outcome.reason}` : ""),
        );
      } catch (err) {
        failed++;
        logger.error(`Failed to parse ${label}: ${errText(err)}`);
        // Best-effort flip so a transient PROCESSING row does not stick.
        try {
          await markParseStatus(doc.id, "FAILED");
        } catch {
          // ignore — the row stays PROCESSING and a later forced run re-takes it
        }
      }
    }

    logger.info(
      `Parse complete: ${parsed} parsed, ${failedValidation} failed validation, ` +
        `${failed} failed, ${unsupported} unsupported, ${rowsWritten} extract rows, ` +
        `promptTokens=${promptTokens} outputTokens=${outputTokens}` +
        (stoppedOnBudget ? " (budget-truncated)" : "") +
        (dropTally.length > 0 ? ` — dropped: ${tallyReasons(dropTally)}` : ""),
    );
  } finally {
    // Reported from a `finally` so EVERY exit reaches it — including the
    // zero-documents early return. `notify_no_data` means a monitor over a job
    // that emits nothing sits in NO DATA, and once this backlog drains an empty
    // queue is the NORMAL nightly state. Zero/zero is not a weaker signal: the
    // alert is `selected - written > 0`, which is 0 for a genuinely idle run
    // and positive for a run that found work and produced nothing.
    //
    // `written` counts DOCUMENTS that reached PARSED, matching the unit of
    // `selected`. Extract ROWS are a different unit and are reported in the log
    // line above rather than smuggled into a document counter.
    // The cohort line is ALWAYS attached, not only on a zero-write run. Which
    // cohort is draining is otherwise a database query, and the handover from
    // the no-data cohort to the validation cohort — phase 1 selecting 0 —
    // looks identical to a stalled job in every other signal.
    const cohortLine = describeCohortProgress({
      phases: await summarisePhases({
        base,
        covered,
        phaseSelected,
        phaseParsed,
      }),
      coveredSymbolCount: covered.symbols.length,
      degraded: covered.degraded,
    });

    reportJobOutcome({
      job: "stock-document-parse",
      selected,
      written: parsed,
      failed: failed + failedValidation + unsupported,
      transportFailures,
      skippedReason:
        selected > 0 && parsed === 0
          ? // The required-reading explanation comes FIRST — the cohort context
            // is useful, but it is not why nothing was written.
            `0 of ${selected} documents parsed ` +
            `(${failed} failed, ${failedValidation} failed validation, ` +
            `${unsupported} unsupported); ${cohortLine}`
          : cohortLine,
    });

    await chainAnotherBatch({
      message,
      chainDepth,
      selected,
      batchSize,
      leftPending,
      force,
    });
  }
}

/** A selected document plus the cohort it was drawn from. */
type PhasedDocument = {
  id: string;
  instrumentId: string;
  symbol: string;
  exchange: string;
  gcsPath: string;
  mimeType: string;
  docType: string;
  period: string;
  title: string | null;
  phase: ParsePhase;
};

/** The covered-symbol set, and whether we actually got it. */
interface CoveredSymbols {
  symbols: string[];
  /** True when the lookup FAILED and the run fell back to plain FIFO. */
  degraded: boolean;
}

/**
 * Symbols that already have at least one row in `stock_financials`.
 *
 * A native `distinct` rather than Prisma's: Prisma's Mongo connector
 * de-duplicates in the client, so `distinct: ["symbol"]` would stream all
 * ~32,000 rows back to fetch ~1,373 strings. The raw command is served by
 * `@@index([symbol, exchange])` and returns only the values.
 *
 * ## The failure direction is deliberate
 *
 * On ANY failure this returns an EMPTY set with `degraded: true`, and the run
 * then walks a single un-phased FIFO pass over the whole eligible queue. That
 * is slower to deliver for the no-data cohort but it is COMPLETE and CORRECT —
 * every document is still selected exactly once. The alternative failure
 * directions are both worse: throwing loses the whole batch to a bookkeeping
 * query, and treating a failed lookup as "nothing is covered but we are fine"
 * would hide the degradation. It is reported in the job-outcome reason, so a
 * silent permanent fallback is not one of the outcomes.
 *
 * Matched on `symbol` alone, not `(symbol, exchange)`. That is a deliberate
 * over-match: a symbol covered on one exchange but not the other lands in the
 * validation cohort rather than the no-data cohort, i.e. it is served LATER.
 * Erring that way keeps the no-data cohort a set we are confident about; the
 * opposite error would put already-covered companies at the front of the queue,
 * which is the thing this ordering exists to avoid.
 */
/**
 * Symbols that already hold at least one extract row — MONEY-1259.
 *
 * The "served" set for {@link selectBreadthFirst}. A symbol is served once ANY
 * extract row exists for it, `FAILED_VALIDATION` included: that document
 * consumed the symbol's first turn, and the breadth pass exists to reach
 * symbols with NOTHING.
 *
 * Degrades to an EMPTY set, never to a throw. An empty served set makes every
 * symbol look unserved, so the breadth pass simply picks each symbol's latest
 * document — which is the behaviour this change is for. Erring that way is
 * safe; the opposite error (treating a symbol as served when it is not) would
 * push a company with no financials to the back of the queue, which is exactly
 * what the ordering exists to prevent.
 *
 * `distinct` over `symbol` rather than a `findMany` + map: the collection holds
 * one row per (document, period, basis), so the raw rows outnumber the symbols
 * by more than an order of magnitude.
 */
async function fetchServedSymbols(): Promise<Set<string>> {
  try {
    const res = (await prisma.$runCommandRaw({
      distinct: "document_financial_extracts",
      key: "symbol",
    } as unknown as Prisma.InputJsonObject)) as { values?: unknown } | null;

    const values = Array.isArray(res?.values) ? res.values : null;
    if (!values) {
      logger.warn(
        "distinct(document_financial_extracts.symbol) returned no `values` — " +
          "every symbol treated as unserved (breadth pass still correct)",
      );
      return new Set<string>();
    }

    const symbols = values.filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    logger.info(
      `${symbols.length} symbol(s) already have an extract — they parse DEEPER only ` +
        "after every unserved symbol has its latest period",
    );
    return new Set(symbols);
  } catch (err) {
    logger.warn(
      `Served-symbol lookup failed, treating all as unserved: ${errText(err)}`,
    );
    return new Set<string>();
  }
}

async function fetchCoveredSymbols(): Promise<CoveredSymbols> {
  try {
    const res = (await prisma.$runCommandRaw({
      distinct: "stock_financials",
      key: "symbol",
    } as unknown as Prisma.InputJsonObject)) as { values?: unknown } | null;

    const values = Array.isArray(res?.values) ? res.values : null;
    if (!values) {
      logger.warn(
        "distinct(stock_financials.symbol) returned no `values` — falling back to plain FIFO",
      );
      return { symbols: [], degraded: true };
    }

    const symbols = values.filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    logger.info(
      `${symbols.length} symbol(s) already have financials — they parse SECOND`,
    );
    return { symbols, degraded: false };
  } catch (err) {
    logger.warn(
      `Covered-symbol lookup failed, falling back to plain FIFO: ${errText(err)}`,
    );
    return { symbols: [], degraded: true };
  }
}

/**
 * Per-phase selected / parsed / remaining for the run summary.
 *
 * `remaining` is BEST EFFORT and null on failure — it is the one number here
 * that costs a query, and a summary line is never worth failing a run that
 * parsed documents. Null prints as "?" rather than as 0, because "we did not
 * count" and "there are none left" are opposite facts and the second one is the
 * signal an operator is watching for.
 */
async function summarisePhases(input: {
  base: Record<string, unknown>;
  covered: CoveredSymbols;
  phaseSelected: Map<ParsePhase, number>;
  phaseParsed: Map<ParsePhase, number>;
}): Promise<PhaseProgress[]> {
  const { base, covered, phaseSelected, phaseParsed } = input;
  const phases = phasesToRun(
    canPhaseOnCoveredSymbols(covered.symbols) ? covered.symbols.length : 0,
  );

  const out: PhaseProgress[] = [];
  for (const phase of phases) {
    let remaining: number | null = null;
    try {
      remaining = await prisma.stockDocument.count({
        where: buildPhaseQuery(base, covered.symbols, phase),
      });
    } catch (err) {
      logger.warn(`Phase ${phase} remaining-count failed: ${errText(err)}`);
    }
    out.push({
      phase,
      selected: phaseSelected.get(phase) ?? 0,
      parsed: phaseParsed.get(phase) ?? 0,
      remaining,
    });
  }
  return out;
}

/**
 * Publish the NEXT link of the drain chain.
 *
 * ## Why a chain rather than a bigger batch
 *
 * The run is bounded by a 600s ack deadline (Pub/Sub's maximum, not a setting)
 * and per-document cost is a whole-PDF model call whose latency scales with
 * page count and is not ours to hold still. A bigger `take` does not buy more
 * work — the wall clock stops the loop either way — it only enlarges a
 * findMany whose extra rows are never reached. `workers/CLAUDE.md` says it
 * plainly: raising a batch is not the way to catch up, and self-chaining is the
 * preferred lever.
 *
 * ## Why this terminates
 *
 * `shouldChainAnotherBatch` refuses once `chainDepth + 1` reaches
 * MAX_CHAIN_DEPTH, and every published message carries `chainDepth + 1`. That
 * bound is a pure function of a number on the message: it consults no database,
 * no clock and no queue state, so it holds even if every other signal is wrong
 * or forged. The other three conditions (queue drained, nothing left pending,
 * `force`) can only stop the chain SOONER, so none of them can break the bound.
 * `stock-document-parse-logic.test.ts` drives the decision in a loop against an
 * adversarial "always more work, always progress" environment and asserts the
 * loop ends.
 *
 * Never throws: a failed chain must leave a successful parse run successful.
 * The cost of a dropped link is one delayed batch.
 */
async function chainAnotherBatch(opts: {
  message: StockDocumentParseMessage;
  chainDepth: number;
  selected: number;
  batchSize: number;
  leftPending: number;
  force: boolean;
}): Promise<void> {
  const { message, chainDepth, selected, batchSize, leftPending, force } = opts;

  if (
    !shouldChainAnotherBatch({
      selected,
      batchSize,
      chainDepth,
      leftPending,
      force,
    })
  ) {
    logger.info(
      `Not chaining (depth ${chainDepth}/${MAX_CHAIN_DEPTH}, selected ${selected}/${batchSize}, ` +
        `leftPending ${leftPending}, force ${force})`,
    );
    return;
  }

  try {
    const pubsub = getPubSubClient();
    const topic = pubsub.topic(getTopicName(STOCK_DOCUMENT_PARSE_TOPIC));
    // The follow-up inherits the ORIGINAL scope (symbols / docTypes / model /
    // batchSize) so a targeted run stays targeted. Only the depth moves.
    const next: StockDocumentParseMessage = {
      ...message,
      batchSize,
      chainDepth: chainDepth + 1,
    };
    await topic.publishMessage({ json: next });
    logger.info(
      `Chained stock-document-parse batch ${chainDepth + 1}/${MAX_CHAIN_DEPTH}`,
    );
  } catch (err) {
    logger.warn(`Failed to chain the next parse batch: ${errText(err)}`);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
