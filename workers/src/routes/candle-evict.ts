/**
 * Candle eviction route — MONEY-980.
 *
 * Consumes `candle-evict-${ENV}` and drives the hot store's only deleter: a
 * `LOADED` row 30 days past its last read, and a `WINDOW` row whose year has
 * rolled out of the hot window.
 *
 * ## ONE TOPIC, TWO MESSAGE SHAPES — MONEY-1373
 *
 *   no `unit`      the row-paged chain, or — on `rule: "WINDOW_INTRADAY"` — the
 *                  PLANNER, which groups the due intraday rows into
 *                  `(symbol, timeframe)` units and publishes one leaf per unit
 *                  back onto THIS SAME topic.
 *   `unit: {...}`  a LEAF: evict that one unit, whole sessions only, one shard
 *                  read-modify-write. A leaf never chains.
 *
 * The same arrangement `us-filing-insight` uses (MONEY-1324). Unlike that lane,
 * a message naming neither is not ambiguous here — it is the ordinary chain, so
 * there is no third "ignore" outcome to get wrong.
 *
 * ## Why this ACKs 200 even on a throw
 *
 * `xbrl-sync` established the rule that the response code is chosen by failure
 * CLASS rather than by `!ok`. Here every class argues for an ACK:
 *
 *   - The job is IDEMPOTENT and BACKFILLABLE. A row that was due for eviction
 *     today is still due tomorrow — the daily scheduler is the retry, and it is
 *     a better one than Pub/Sub's, because it starts a fresh chain from skip 0
 *     rather than replaying one page.
 *   - A redelivery is actively harmful. Two copies of the same page would race
 *     over the same rows: both verify against the same shards, both call
 *     `deleteMany`, and on the WINDOW rule both read-modify-write the same GCS
 *     object — which is the one operation in this job that can LOSE data if it
 *     interleaves.
 *   - Every per-group failure is already absorbed inside the processor and
 *     resolves to KEEPING the rows, which is the safe direction by construction.
 *
 * The freshness monitor and `reportJobOutcome`, not Pub/Sub's retry, are what
 * notice a dead job.
 */

import { Hono } from "hono";
import { getMessageId, parsePubSubMessage } from "../lib/message";
import type { CandleEvictMessage } from "@usemoney/types/pubsub";
import { processCandleEvict } from "../processors/candle-evict";
import { EVICT_RULES } from "../processors/candle-evict-logic";
import { INTRADAY_TIMEFRAMES } from "@usemoney/core/market-data/candles";

export const candleEvictRoute = new Hono();

/**
 * The inbound `unit`, or null if ANY part of it is unusable.
 *
 * All-or-nothing on purpose. A `{symbol: "", timeframe: "M1"}` is truthy, so
 * forwarding it would send the processor down the leaf branch to select every
 * `symbol: ""` row in the table; returning null instead makes the message a
 * plain plan, which is the safe interpretation of a message that named no
 * usable unit.
 */
function narrowUnit(
  value: unknown,
): { symbol: string; timeframe: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const { symbol, timeframe } = value as Record<string, unknown>;
  if (typeof symbol !== "string" || symbol.trim() === "") return null;
  if (typeof timeframe !== "string") return null;
  if (!INTRADAY_TIMEFRAMES.has(timeframe)) return null;
  return { symbol, timeframe };
}

candleEvictRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    console.log(`Processing candle-evict (message: ${getMessageId(body)})`);

    // DECODE THE ENVELOPE. Over Pub/Sub the request body is
    // `{message: {data: "<base64>", messageId}}`, NOT the payload: the
    // subscription is created without `--push-no-wrapper`
    // (`workers/scripts/setup-pubsub.sh`), so reading fields straight off
    // `body` yields `undefined` for every one of them. `parsePubSubMessage`
    // falls back to the body itself when it is not an envelope, so local dev,
    // the pull subscriber and manual curl keep working unchanged.
    const raw = (parsePubSubMessage<Record<string, unknown>>(body) ??
      {}) as Record<string, unknown>;
    const unit = narrowUnit(raw.unit);

    // EVERY FIELD IS READ AND NARROWED HERE, never spread.
    //
    // MONEY-1235: `createMissing` was declared on a message type, documented as
    // the opt-in for a write path, and forwarded by NOBODY — the route spread
    // the envelope instead of narrowing it, so the flag was `undefined` on
    // arrival and the documented behaviour was false in every production run
    // that ever executed. A spread also lets an unknown key through to the
    // processor's options object, where a typo'd `skiprows` sits silently
    // beside the real one and does nothing at all.
    const msg: CandleEvictMessage = {
      // STRICT `=== false`, and ONLY `false` is carried. `apply` narrows and
      // can never arm (see `resolveEvictApply`), so a truthy value must not be
      // forwarded as `true` — that would put "arm the deletes" inside a Pub/Sub
      // payload. `Boolean("false")` is `true`, which is precisely the inversion
      // the whole arming discipline in this repo exists to refuse.
      ...(raw.apply === false ? { apply: false as const } : {}),
      // DERIVED from `EVICT_RULES`, never a second hand-written list.
      //
      // This narrowing used to spell the rules out, and MONEY-1373 is what that
      // costs: adding `WINDOW_INTRADAY` to `EVICT_RULES` and to the message
      // type would still have left THIS line dropping it, `resolveRuleScope`
      // would have fallen back to `EVICT_RULES[0]`, and the intraday chain link
      // would have silently re-run `LOADED` while `judgeEvictRun` reported `ok`
      // because rows were deleted. A rule that never runs, on a schedule that
      // never fails — the MONEY-1211 shape. Reading the array means the next
      // rule is covered on the day it is declared.
      ...(typeof raw.rule === "string" &&
      (EVICT_RULES as readonly string[]).includes(raw.rule)
        ? { rule: raw.rule as CandleEvictMessage["rule"] }
        : {}),
      // WHO chose the rule, which is not the same question as WHICH rule.
      // Every chained link carries `rule`, so without this field arriving
      // intact the processor reads link 1 as operator-scoped and the chain
      // never reaches the second rule. Narrowed to a real boolean: a string
      // `"false"` is truthy, and this is a field whose false value is the one
      // that keeps the chain moving.
      ...(typeof raw.ruleScoped === "boolean"
        ? { ruleScoped: raw.ruleScoped }
        : {}),
      ...(typeof raw.skipRows === "number" && Number.isFinite(raw.skipRows)
        ? { skipRows: raw.skipRows }
        : {}),
      ...(typeof raw.batchSize === "number" && Number.isFinite(raw.batchSize)
        ? { batchSize: raw.batchSize }
        : {}),
      // Sanitised again inside the processor (`normalizeChainDepth` clamps to
      // MAX_CHAIN_DEPTH, so a forged large value ENDS the chain). Narrowed here
      // as well so a string `"3"` never reaches it — the depth is the
      // termination proof and it must be a number the whole way down.
      ...(typeof raw.chainDepth === "number" && Number.isFinite(raw.chainDepth)
        ? { chainDepth: raw.chainDepth }
        : {}),
      // THE LEAF SHAPE — MONEY-1373. Narrowed field by field, like everything
      // above, and OMITTED ENTIRELY when any part of it fails: a half-formed
      // `unit` reaching the processor would be truthy, so the run would take
      // the leaf branch and select on `symbol: undefined`.
      //
      // `timeframe` must be one this rule governs. A leaf naming `D1` is
      // DROPPED rather than run, and dropping it is safe precisely because the
      // whole object goes: with no `unit`, the message is an ordinary
      // `WINDOW_INTRADAY` PLAN, which selects the intraday population and
      // publishes real leaves. The D1 population is 20.16M rows over 14,098
      // symbols and one "unit" of it is a decade of a symbol's history — a
      // single message that would read every daily shard the symbol has.
      //
      // `INTRADAY_TIMEFRAMES` is core's own set, the same one `buildEvictWhere`
      // and `resolveCandleDestination` read. Hand-listing it here is the defect
      // this route already shipped once with `rule` (see above): a timeframe
      // added to the set and missed here is silently dropped, and a dropped
      // field is not an error.
      ...(unit ? { unit } : {}),
    };

    const result = await processCandleEvict(msg);

    // A run that deleted nothing says WHY rather than returning a bare zero.
    // "0 deleted" without a reason is exactly the silence the job-outcome
    // metric exists to replace — and on THIS job a zero is the normal, healthy
    // steady state most nights, so the reason is the only thing that separates
    // it from a broken one.
    if (!result.ok) {
      console.error(`[candle-evict] UNHEALTHY: ${result.reason}`);
    }

    return c.json({ success: true, ...result }, 200);
  } catch (error) {
    // 200: see the header. A redelivery would race the first copy over the same
    // rows and the same GCS objects; the daily scheduler is the retry.
    console.error("Candle eviction failed:", error);
    return c.json({ success: true, recovered: true }, 200);
  }
});
