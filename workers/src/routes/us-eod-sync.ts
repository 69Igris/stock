/**
 * US EOD Sync Worker Route — MONEY-980 (tasks 6 + 7).
 *
 * Consumes `us-eod-sync-${ENV}` and drives the nightly Tiingo US price
 * backbone: EOD bars, mutual-fund NAVs, the derived corporate-actions delta,
 * and the session's USDINR rate.
 *
 * ## Why this ACKs 200 even on a throw
 *
 * `xbrl-sync` established the rule that the response code is chosen by failure
 * CLASS rather than by `!ok`. Here every class argues for an ACK:
 *
 *   - A Tiingo ENTITLEMENT or TOKEN 403 is deterministic. Five redeliveries
 *     collect the identical 403 and page nobody sooner.
 *   - A RATE LIMIT is the one failure where retrying is actively harmful: the
 *     budget is per run, so a redelivery re-arms the breaker straight back into
 *     the wall (MONEY-853).
 *   - A transient per-symbol failure is already absorbed inside the processor
 *     and healed for free by the trailing window on the next run — which is
 *     what the window is for.
 *
 * And a redelivery is not cheap here the way it is for a DB-only job: it spends
 * a second copy of an hourly quota that Tiingo reports nothing about. The
 * freshness monitor, not Pub/Sub's retry, is what notices a dead job.
 */

import { Hono } from "hono";
import { getMessageId, parsePubSubMessage } from "../lib/message";
import type { UsEodSyncMessage } from "@usemoney/types/pubsub";
import { processUsEodSync } from "../processors/us-eod-sync";

export const usEodSyncRoute = new Hono();

usEodSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    console.log(`Processing us-eod-sync (message: ${getMessageId(body)})`);

    // DECODE THE ENVELOPE. Over Pub/Sub the request body is
    // `{message: {data: "<base64>", messageId}}`, NOT the payload: the
    // subscription is created without `--push-no-wrapper`
    // (`workers/scripts/setup-pubsub.sh`), so reading fields straight off
    // `body` yields `undefined` for every one of them. `parsePubSubMessage`
    // falls back to the body itself when it is not an envelope, so local dev,
    // the pull subscriber and manual curl keep working unchanged.
    const raw = (parsePubSubMessage<Record<string, unknown>>(body) ??
      {}) as Record<string, unknown>;

    // EVERY FIELD IS READ AND NARROWED HERE, never spread.
    //
    // MONEY-1235: `createMissing` was declared on the message type, documented
    // as the opt-in for the create path, and forwarded by NOBODY — the route
    // spread the envelope instead of narrowing it, so the flag was `undefined`
    // on arrival and the documented behaviour was false in every production run
    // that ever executed. A spread also lets an unknown key through to the
    // processor's options object, where a typo'd `lookbackdays` sits silently
    // beside the real one and does nothing at all.
    const msg: UsEodSyncMessage = {
      symbols: Array.isArray(raw.symbols)
        ? raw.symbols.filter(
            (s): s is string => typeof s === "string" && s.trim() !== "",
          )
        : undefined,
      batchSize:
        typeof raw.batchSize === "number" && Number.isFinite(raw.batchSize)
          ? raw.batchSize
          : undefined,
      mfBatchSize:
        typeof raw.mfBatchSize === "number" && Number.isFinite(raw.mfBatchSize)
          ? raw.mfBatchSize
          : undefined,
      lookbackDays:
        typeof raw.lookbackDays === "number" &&
        Number.isFinite(raw.lookbackDays)
          ? raw.lookbackDays
          : undefined,
      // STRICT `=== true`. A JSON string `"false"` must NOT switch the FX leg
      // off: `Boolean("false")` is `true`, and the whole arming discipline in
      // this repo rests on never letting a truthiness check stand in for a
      // value check (XBRL_PROJECTION_APPLY, DOC_FINANCIALS_APPLY).
      skipFx: raw.skipFx === true,
      // Sanitised again inside the processor (`normalizeChainDepth` clamps to
      // MAX_CHAIN_DEPTH, so a forged large value ENDS the chain). Narrowed here
      // as well so a string `"3"` never reaches it — the depth is the
      // termination proof and it must be a number the whole way down.
      chainDepth:
        typeof raw.chainDepth === "number" && Number.isFinite(raw.chainDepth)
          ? raw.chainDepth
          : undefined,
      chainStartedAt:
        typeof raw.chainStartedAt === "number" &&
        Number.isFinite(raw.chainStartedAt)
          ? raw.chainStartedAt
          : undefined,
    };

    const result = await processUsEodSync(msg);

    // A run that wrote nothing says WHY rather than returning a bare zero.
    // "0 written" without a reason is exactly the silence the job-outcome
    // metric exists to replace, and this job has FOUR legs — a total of zero
    // could be any one of them.
    if (!result.ok) {
      console.error(`[us-eod-sync] UNHEALTHY: ${result.reason}`);
    }

    return c.json({ success: true, ...result }, 200);
  } catch (error) {
    // 200: see the header. Retrying spends a second copy of an unobservable
    // quota, and every failure class here is either deterministic or made worse
    // by a retry. The processor handles per-symbol errors internally and the
    // trailing window heals a lost run.
    console.error("US EOD sync failed:", error);
    return c.json({ success: true, recovered: true }, 200);
  }
});
