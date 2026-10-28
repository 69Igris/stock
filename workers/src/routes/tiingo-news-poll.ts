/**
 * US news poller route — MONEY-1309.
 *
 * Consumes `tiingo-news-poll-${ENV}` and drives the article-level US news
 * store. SUPERSEDES leg (f) of `us-eod-sync`, which rode a Tue-Sat market cron
 * and therefore could not run at all on a Sunday or Monday IST — see the
 * processor's header for the measured lag.
 *
 * ## Why this ACKs 200 even on a throw
 *
 * Same rule as `us-eod-sync`: the response code is chosen by failure CLASS, not
 * by `!ok`. Here the cadence settles it even more firmly than entitlement does.
 *
 *   - A Tiingo ENTITLEMENT or TOKEN 403 is deterministic. Five redeliveries
 *     collect the identical 403 and page nobody sooner.
 *   - A RATE LIMIT is the failure where retrying is actively harmful: a
 *     redelivery re-arms the breaker straight back into the wall (MONEY-853).
 *   - EVERY OTHER FAILURE IS HEALED BY THE NEXT TICK, 120 SECONDS LATER. The
 *     cursor is never advanced past the OLDEST row a run failed to store, and
 *     not at all when the offset walk stopped short, so a run that failed
 *     anywhere leaves every unstored article inside the next poll's window.
 *     Pub/Sub's redelivery would arrive sooner but do nothing the schedule
 *     does not already do — while spending a second copy of a paid quota that
 *     reports nothing about itself.
 *
 *     This bullet used to say "the cursor advances only to rows that were
 *     actually written", which was true and NOT sufficient: the feed is
 *     newest-first across days and the request window is day-granular, so a
 *     partial run stamped the newest day and the older ones fell outside every
 *     future window. See `safeCursorAdvance`.
 *
 * A dead job is caught by the freshness monitor on `crawlDate` and by
 * `UsNewsCursor.lastRunAt`, not by Pub/Sub's retry.
 *
 * ## The topic, the schedule and this mount are all in the tree
 *
 *   packages/types/src/pubsub.ts        TIINGO_NEWS_POLL: "tiingo-news-poll"
 *   scripts/ops/setup-scheduler.sh      "tiingo-news-poll|*\/2 * * * *|…" (PROD_ONLY)
 *   workers/scripts/setup-pubsub.sh     the topic + push subscription
 *   workers/src/index.ts                app.route("/jobs/tiingo-news-poll", …)
 *   workers/src/lib/pull-subscriber.ts  the local-dev pull mapping
 *
 * The constant and the cron could not be half-landed in either order:
 * `topic-publisher-coverage` fails a DECLARED topic that nothing publishes to
 * (the MONEY-1205 dead-topic shape) AND a SCHEDULER entry whose `TOPIC_BASE` is
 * not declared. Provisioning them in the cloud is still a founder step
 * (`setup-infra.sh prod`), and a direct POST to `/jobs/tiingo-news-poll` is how
 * that step verifies a real run before a cron that fires 720 times a day.
 *
 * THE MOUNT PATH MUST EQUAL THE TOPIC BASE NAME (`tiingo-news-poll`), or the
 * push subscription points at nothing: Cloud Run answers 404, the subscription
 * dead-letters after five attempts, and every provisioning check still passes
 * because each one is for a different artefact (MONEY-1257).
 */

import { Hono } from "hono";
import { getMessageId, parsePubSubMessage } from "../lib/message";
import type { TiingoNewsPollMessage } from "@usemoney/types/pubsub";
import { processTiingoNewsPoll } from "../processors/tiingo-news-poll";

export const tiingoNewsPollRoute = new Hono();

tiingoNewsPollRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    console.log(`Processing tiingo-news-poll (message: ${getMessageId(body)})`);

    // DECODE THE ENVELOPE. Over Pub/Sub the request body is
    // `{message: {data: "<base64>", messageId}}`, NOT the payload: the
    // subscription is created without `--push-no-wrapper`, so reading fields
    // straight off `body` yields `undefined` for every one of them.
    // `parsePubSubMessage` falls back to the body itself when it is not an
    // envelope, so local dev, the pull subscriber and manual curl all work.
    const raw = (parsePubSubMessage<Record<string, unknown>>(body) ??
      {}) as Record<string, unknown>;

    // EVERY FIELD IS READ AND NARROWED HERE, never spread. A spread lets an
    // unknown key through to the processor's options object, where a typo'd
    // `overlapms` sits silently beside the real one and does nothing at all —
    // and it is how MONEY-1235's `createMissing` was documented as supported
    // while being `undefined` in every production run that ever executed.
    //
    // Both fields are re-validated downstream (`fetchWindow` clamps the limit
    // to Tiingo's measured ceiling), so this narrowing is the first of two
    // gates rather than the only one.
    //
    // NOTE what THIS gate does not do: `Number.isFinite(0)` is true, so a
    // literal `overlapMs: 0` is forwarded verbatim. That is deliberate — the
    // overlap rule belongs to `planNewsCursor`, which is where it is tested —
    // but it means the downstream guard is the ONLY one, and it read
    // `overlapMs >= 0` for a release: zero was accepted, `windowStart ===
    // lastCrawl`, and at a UTC-midnight boundary the previous day was never
    // re-asked. It is `> 0` now. Do not "simplify" it back, and do not add a
    // second copy of the rule here — one rule stated twice is how a
    // `mimeType` exact-match and a substring test came to disagree
    // (MONEY-1255).
    const msg: TiingoNewsPollMessage = {
      overlapMs:
        typeof raw.overlapMs === "number" && Number.isFinite(raw.overlapMs)
          ? raw.overlapMs
          : undefined,
      limit:
        typeof raw.limit === "number" && Number.isFinite(raw.limit)
          ? raw.limit
          : undefined,
    };

    const result = await processTiingoNewsPoll(msg);

    // A run that wrote nothing says WHY rather than returning a bare zero. A
    // quiet two minutes is the COMMON case here and is not a fault, so `ok`
    // stays true for it — a floor rejection, a refusal, a rate limit, a blind
    // master lookup or an INCOMPLETE WINDOW flips it. That last one was absent
    // from the expression entirely: a run that fetched half a window, wrote
    // half of that and left the rest behind reported `ok: true` with
    // `selected === written` and `failed: 0`, which is precisely why the loss
    // it caused was silent.
    if (!result.ok) {
      console.error(`[tiingo-news-poll] UNHEALTHY: ${result.reason}`);
    }

    return c.json({ success: true, ...result }, 200);
  } catch (error) {
    // 200: see the header. The next tick is 120 seconds away and the cursor did
    // not move, so a redelivery buys nothing and costs a second copy of an
    // unobservable paid quota.
    console.error("Tiingo news poll failed:", error);
    return c.json({ success: true, recovered: true }, 200);
  }
});
