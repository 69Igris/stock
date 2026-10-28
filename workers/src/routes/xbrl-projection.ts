import { Hono } from "hono";
import { getMessageId, parsePubSubMessage } from "../lib/message";
import {
  processXbrlProjection,
  countUnprojectedFilings,
  type XbrlProjectionMessage,
} from "../processors/xbrl-projection";

export const xbrlProjectionRoute = new Hono();

xbrlProjectionRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    console.log(`Processing XBRL projection (message: ${getMessageId(body)})`);

    // DECODE THE ENVELOPE — MONEY-1235. Over Pub/Sub the request body is
    // `{message: {data: "<base64>", messageId}}`, NOT the payload: the
    // subscription is created without `--push-no-wrapper`
    // (`workers/scripts/setup-pubsub.sh`), so reading fields straight off
    // `body` yields `undefined` for every one of them.
    //
    // This route read the raw body, and 49 of the 60 routes in this directory
    // do not. The consequences were silent and total:
    //
    //   published {"periodTypes":["ANNUAL"]}  ->  periodTypes undefined -> BOTH buckets
    //   published {"symbols":[...],"limit":200} -> whole universe at limit 500
    //   published {"createMissing":true}      ->  false; no CREATE, ever
    //
    // So the scheduler's ANNUAL scoping was inert, and the runbook's "scoped
    // pilot" would have executed as an UNSCOPED ARMED whole-universe write
    // against the one table with no `source` in its unique key — while the
    // operator, finding no created rows, read it as "the pilot found nothing".
    //
    // `parsePubSubMessage` falls back to the body itself when it is not an
    // envelope, so local dev and manual curl keep working unchanged.
    const raw = (parsePubSubMessage<Record<string, unknown>>(body) ??
      {}) as Record<string, unknown>;
    const msg: XbrlProjectionMessage = {
      // `apply` is read but can only NARROW — see the processor header. A
      // message cannot arm a run the environment has not armed.
      apply: typeof raw.apply === "boolean" ? raw.apply : undefined,
      limit:
        typeof raw.limit === "number" && Number.isFinite(raw.limit)
          ? raw.limit
          : undefined,
      symbols: Array.isArray(raw.symbols)
        ? raw.symbols.filter((s): s is string => typeof s === "string")
        : undefined,
      // Both of these used to be dropped right here. `periodTypes` was declared
      // on the message type and forwarded by nobody; `createMissing` had no
      // field at all, so the writer's documented "separate, opt-in step" was
      // unreachable and no production run has ever created a row (MONEY-1235).
      periodTypes: Array.isArray(raw.periodTypes)
        ? raw.periodTypes.filter(
            (t): t is "ANNUAL" | "QUARTERLY" =>
              t === "ANNUAL" || t === "QUARTERLY",
          )
        : undefined,
      createMissing: raw.createMissing === true,
    };

    const result = await processXbrlProjection(msg);

    // A run that selected nothing says WHY rather than returning a bare zero.
    // "0 filings" is ambiguous between "everything is projected" and "the
    // selector is broken", and that ambiguity is the whole MONEY-1220 defect
    // class — a job that reports success while writing nothing.
    if (result.selected === 0) {
      const pending = await countUnprojectedFilings();
      console.log(
        `[xbrl-projection] selected 0 — ${pending} filing(s) still ` +
          `unprojected. ${pending === 0 ? "Nothing to do." : "Check the selector."}`,
      );
    }

    return c.json({ success: true, ...result });
  } catch (error) {
    console.error("XBRL projection failed:", error);
    // 500 so Pub/Sub redelivers. Safe: the write is an upsert keyed on the
    // period tuple, so a redelivery re-writes identical rows, and `projectedAt`
    // is only stamped for filings that reached a decision.
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "unknown",
      },
      500,
    );
  }
});
