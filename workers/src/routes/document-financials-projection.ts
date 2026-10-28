import { Hono } from "hono";
import { getMessageId, parsePubSubMessage } from "../lib/message";
import {
  countPendingExtracts,
  processDocumentFinancialsProjection,
  type DocFinancialsProjectionMessage,
} from "../processors/document-financials-projection";

export const documentFinancialsProjectionRoute = new Hono();

documentFinancialsProjectionRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    console.log(
      `Processing document-financials projection (message: ${getMessageId(body)})`,
    );

    // DECODE THE ENVELOPE. Over Pub/Sub the request body is
    // `{message: {data: "<base64>", messageId}}`, NOT the payload: the
    // subscription is created without `--push-no-wrapper`
    // (`workers/scripts/setup-pubsub.sh`), so reading fields straight off
    // `body` yields `undefined` for every one of them.
    //
    // 49 of the 60 routes in this directory get this right and the XBRL
    // projection route did not, with consequences that were silent and total:
    // the scheduler's period scoping was inert, `createMissing:true` was false
    // on arrival so no CREATE ever happened, and a payload asking for a scoped
    // pilot would have executed as an UNSCOPED whole-universe run — while the
    // operator, finding no created rows, read it as "the pilot found nothing".
    //
    // `parsePubSubMessage` falls back to the body itself when it is not an
    // envelope, so local dev and manual curl keep working unchanged.
    const raw = (parsePubSubMessage<Record<string, unknown>>(body) ??
      {}) as Record<string, unknown>;

    // Every field is read and NARROWED here rather than spread. A spread would
    // let an unknown key through to the writer's options object, where a typo'd
    // `createmissing` sits silently beside the real one and does nothing.
    const msg: DocFinancialsProjectionMessage = {
      // `apply` is read but can only NARROW — see the processor header. A
      // message cannot arm a run the environment has not armed.
      apply: typeof raw.apply === "boolean" ? raw.apply : undefined,
      limit:
        typeof raw.limit === "number" && Number.isFinite(raw.limit)
          ? raw.limit
          : undefined,
      maxPages:
        typeof raw.maxPages === "number" && Number.isFinite(raw.maxPages)
          ? raw.maxPages
          : undefined,
      symbols: Array.isArray(raw.symbols)
        ? raw.symbols.filter((s): s is string => typeof s === "string")
        : undefined,
      periodTypes: Array.isArray(raw.periodTypes)
        ? raw.periodTypes.filter(
            (t): t is "ANNUAL" | "QUARTERLY" =>
              t === "ANNUAL" || t === "QUARTERLY",
          )
        : undefined,
      // STRICT `=== true`. A JSON string `"true"` must NOT arm the create path:
      // `Boolean("false")` is `true`, and the whole arming discipline in this
      // pipeline rests on never letting a truthiness check stand in for a value
      // check.
      createMissing: raw.createMissing === true,
      afterSymbol:
        typeof raw.afterSymbol === "string" && raw.afterSymbol.trim() !== ""
          ? raw.afterSymbol
          : undefined,
    };

    const result = await processDocumentFinancialsProjection(msg);

    // A run that selected nothing says WHY rather than returning a bare zero.
    // "0 selected" is ambiguous between "everything is projected" and "the
    // selector is broken", and that ambiguity is the whole MONEY-1220 defect
    // class — a job that reports success while writing nothing.
    if (result.selected === 0) {
      const pending = await countPendingExtracts();
      console.log(
        `[document-financials-projection] selected 0 — ${pending} extract(s) ` +
          `still unprojected. ` +
          `${pending === 0 ? "Nothing to do." : "Check the selector."}`,
      );
    }

    return c.json({ success: true, ...result });
  } catch (error) {
    console.error("Document-financials projection failed:", error);
    // 500 so Pub/Sub redelivers. Safe: the write is keyed on the period tuple,
    // so a redelivery re-writes identical rows, and `projectedAt` is stamped
    // only for extracts that reached a decision.
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "unknown",
      },
      500,
    );
  }
});
