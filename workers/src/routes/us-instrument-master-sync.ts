/**
 * US instrument MASTER sync route — MONEY-980.
 *
 * Consumes `us-instrument-master-sync-${ENV}` and reconciles `us_instruments`
 * against Tiingo's daily security master, then runs the company-name and
 * permaTicker enrichers and joins EDGAR's ticker->CIK map onto the active rows.
 *
 * ORDERING MATTERS: `us-eod-sync` selects its population out of
 * `us_instruments`, which is EMPTY until this job has run at least once. It is
 * scheduled 10:00 IST, an hour ahead of the EOD job, for that reason and for a
 * second one — the two spend the SAME metered Tiingo account, and
 * `paceTiingoRequest` is per-process module state, so two overlapping jobs on
 * different Cloud Run instances pace independently against one ceiling.
 * `US_ENRICH_MAX_CHAIN_DEPTH` is sized so this job's self-chain lands before
 * 11:00. (Was 06:30/07:00; the EOD trigger moved to 11:00 to clear the 12:00 AM
 * ET fund-NAV boundary and this one moved with it. `setup-scheduler.sh` holds
 * both crons: `0 10 * * 2-6` here, `0 11 * * 2-6` there.)
 *
 * ## The message carries a chain depth, and it must be forwarded
 *
 * The two per-symbol enrichers are paced at one metered request per row against
 * populations of 74,125 and 41,371, so a single 600s run cannot converge them.
 * The processor self-chains, and every link carries `chainDepth + 1` — that
 * number is the ONLY thing bounding the chain, so a route that parsed the
 * envelope and then dropped the field would restart every link at depth 0 and
 * publish forever. `parsePubSubMessage` is typed here for exactly that reason:
 * MONEY-1235's lesson is that a field nobody forwards is silently inert, and
 * this is the case where inert means unbounded.
 *
 * ACKs 200 on a throw, for the same reason as `us-eod-sync`: the master is a
 * single public file, so a failure is either deterministic (a shape change, a
 * withdrawn URL) or transient in a way the NEXT nightly run heals for free.
 * A redelivery would re-walk the whole reconcile to reach the identical
 * outcome. The freshness monitor is what notices a dead job, not Pub/Sub's
 * retry.
 */

import { Hono } from "hono";
import { getMessageId, parsePubSubMessage } from "../lib/message";
import {
  syncUsInstrumentMaster,
  type UsInstrumentMasterSyncMessage,
} from "../processors/us-instrument-master-sync";

export const usInstrumentMasterSyncRoute = new Hono();

usInstrumentMasterSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    // `| null` because a direct `null` JSON body (local dev, a manual curl)
    // is passed straight through by `parsePubSubMessage`, which CASTS rather
    // than validates. Typing it away would make the `?? {}` below look
    // redundant to a reader and invite its removal.
    const data = parsePubSubMessage<UsInstrumentMasterSyncMessage | null>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing US instrument master sync (message: ${messageId}, ` +
        `chainDepth: ${data?.chainDepth ?? 0})`,
    );
    // `normalizeUsChainDepth` in the processor is what makes an absent,
    // negative, fractional or forged depth safe — this call site deliberately
    // does no validation of its own, so there is one rule and not two.
    await syncUsInstrumentMaster(data ?? {});

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("US instrument master sync failed:", error);
    return c.json({ success: true, recovered: true }, 200);
  }
});
