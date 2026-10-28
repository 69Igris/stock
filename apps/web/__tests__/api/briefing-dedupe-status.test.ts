/**
 * MONEY-1238 / MONEY-1236 — a FAILED briefing must not withhold a paid feature
 * for 24h, and must not re-queue without a ceiling either.
 *
 * ## Two defects, in opposite directions
 *
 * ORIGINAL: the Clerk `session.created` handler deduped on
 * `{userId, createdAt >= now-24h}` with NO status clause, so ANY row inside the
 * window counted as "we already have one" — including a briefing that failed
 * and produced nothing. The dashboard popup — a PREMIUM/ULTIMATE feature — then
 * stayed dark for a day, with a row in the table that looks like a reason.
 *
 * FIRST FIX: excluding FAILED from the query outright removed the only bound on
 * re-queueing. A deterministic failure then re-queued on EVERY `session.created`
 * — three devices = three rows x five Pub/Sub delivery attempts each, repeating
 * on every subsequent login, forever. That is worse than the bug it replaced.
 *
 * ## What this file pins — the WIRE, not the rule
 *
 * The rule now lives in `shouldQueueBriefing` and is covered behaviourally in
 * `__tests__/api/clerk-webhook.test.ts` against the real export: cooldown,
 * per-day cap, standing-status precedence, newest-failure ordering.
 *
 * What CANNOT be seen from there is whether the route feeds it the right rows.
 * If the read still filtered by status, the decider would never SEE a FAILED
 * row, the cooldown and the cap could never engage, and every behavioural test
 * would still pass — the decider would simply be judging an empty list. That
 * silent-decapitation shape is exactly this ticket family's theme, so it is
 * asserted here, at the call site.
 *
 * Source: apps/web/app/api/webhooks/clerk/route.ts
 *       + apps/web/app/api/webhooks/clerk/clerk-webhook-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  shouldQueueBriefing,
  BRIEFING_STANDING_STATUSES,
} from "../../app/api/webhooks/clerk/clerk-webhook-logic";

/** LINE comments first, then BLOCK — MONEY-1143. */
// apps/web tests transpile to CJS, so `import.meta.dirname` is undefined here.
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SRC = readFileSync(
  path.join(REPO_ROOT, "apps/web/app/api/webhooks/clerk/route.ts"),
  "utf8"
);
const CODE = SRC.replace(/^[^\S\r\n]*\/\/.*$/gm, "").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
);

/**
 * The dedupe read's `where` object, delimited by BRACE MATCHING.
 *
 * An earlier version bounded it with `indexOf("},")`, which stops at the end of
 * the NESTED `createdAt: { gte: ... }` and truncates the object before the rest
 * appears — so every assertion failed against correct source. A bound can be
 * wrong by being too tight as easily as too loose; matching braces is the only
 * version that cannot be either.
 */
function dedupeWhere(): string {
  const at = CODE.indexOf("prisma.loginBriefing.findMany");
  assert.notEqual(at, -1, "could not find the dedupe read — has it moved?");
  const open = CODE.indexOf("where: {", at);
  assert.notEqual(open, -1, "the dedupe read has no `where`");
  const start = CODE.indexOf("{", open);
  let depth = 0;
  for (let k = start; k < CODE.length; k++) {
    if (CODE[k] === "{") depth++;
    else if (CODE[k] === "}") {
      depth--;
      if (depth === 0) return CODE.slice(start, k + 1);
    }
  }
  assert.fail("unterminated `where` clause");
}

/**
 * The body of `handleSessionCreated`, brace-matched.
 *
 * The absence checks below MUST be bounded to this function. Scanning the whole
 * route file flags `route.ts:151`'s entirely unrelated
 * `status: { in: ["PENDING", "PROCESSING", "LOCKED"] }` — a different model, a
 * different decision. An unbounded structural match is wrong in the noisy
 * direction, and a guard that cries wolf is a guard that gets deleted.
 */
function sessionHandlerBody(): string {
  const at = CODE.indexOf("async function handleSessionCreated");
  assert.notEqual(at, -1, "handleSessionCreated has moved or been renamed");
  const start = CODE.indexOf("{", CODE.indexOf(")", at));
  let depth = 0;
  for (let k = start; k < CODE.length; k++) {
    if (CODE[k] === "{") depth++;
    else if (CODE[k] === "}") {
      depth--;
      if (depth === 0) return CODE.slice(start, k + 1);
    }
  }
  assert.fail("unterminated handleSessionCreated body");
}

describe("MONEY-1236 — the route feeds the decider EVERY row in the window", () => {
  it("the read is NOT filtered by status", () => {
    // THE DECAPITATION CHECK. A status filter here would hide FAILED rows from
    // `shouldQueueBriefing`, so the cooldown and the per-day cap could never
    // fire — and every behavioural test would still pass, because the decider
    // would be correctly judging a list that never contains a failure.
    assert.doesNotMatch(
      dedupeWhere(),
      /status:/,
      "filtering by status here blinds the decider to the rows it exists to bound"
    );
  });

  it("the 24h window is still applied", () => {
    // Without this, dropping the window entirely would satisfy the assertion
    // above while making the dedupe useless.
    assert.match(dedupeWhere(), /createdAt:\s*\{\s*gte:/);
  });

  it("the read is scoped to the one user", () => {
    assert.match(dedupeWhere(), /userId:/);
  });

  it("the route DELEGATES the decision — it does not re-implement it", () => {
    const body = sessionHandlerBody();
    assert.match(
      body,
      /shouldQueueBriefing\(/,
      "the bounded-retry rule must come from the tested helper"
    );
    assert.match(
      body,
      /if\s*\(\s*!\s*\w+\.queue\s*\)/,
      "the route must actually branch on the decision it asked for"
    );
  });

  it("[absence] no inline status list survives in the briefing handler", () => {
    assert.doesNotMatch(
      sessionHandlerBody(),
      /status:\s*\{\s*in:\s*\[/,
      "a second copy of the standing-status list is how gate and writer drift"
    );
  });

  it("[meta] the bound actually contains the query it is scoping", () => {
    // A bound that matched nothing would make both absence checks vacuous —
    // they would pass because the text is missing, not because the wire is
    // right. This is the falsifiable ceiling for the two assertions above.
    const body = sessionHandlerBody();
    assert.match(body, /prisma\.loginBriefing\.findMany/);
    assert.ok(
      body.length < CODE.length,
      "the bound must be narrower than the whole file"
    );
  });
});

describe("MONEY-1238 — the standing-status rule itself", () => {
  const NOW = new Date("2026-08-22T10:00:00.000Z");
  const ago = (m: number) => new Date(NOW.getTime() - m * 60 * 1000);

  it("FAILED is NOT among the statuses that hold off a new briefing", () => {
    assert.ok(
      !(BRIEFING_STANDING_STATUSES as readonly string[]).includes("FAILED"),
      `FAILED must not stand; got [${BRIEFING_STANDING_STATUSES.join(", ")}]`
    );
  });

  it("every OTHER status still holds off — including SKIPPED", () => {
    // The control. Excluding too much is the opposite failure: re-queueing on
    // every login for a user with no holdings (SKIPPED), or racing one that is
    // still PROCESSING.
    for (const s of ["QUEUED", "PROCESSING", "COMPLETED", "SKIPPED"]) {
      assert.ok(
        (BRIEFING_STANDING_STATUSES as readonly string[]).includes(s),
        `${s} is a real reason to hold off and must stay in the list`
      );
      assert.equal(
        shouldQueueBriefing([{ status: s, createdAt: ago(30) }], NOW).queue,
        false
      );
    }
  });

  it("uses a POSITIVE list, never a negation", () => {
    // `{ not: "FAILED" }` reads correctly and is wrong on Mongo the moment the
    // field is ever absent — the trap this repo has hit five times. The list is
    // a literal array here, so a negation cannot creep back in.
    assert.ok(Array.isArray(BRIEFING_STANDING_STATUSES));
    assert.doesNotMatch(sessionHandlerBody(), /status:\s*\{\s*not:/);
  });

  it("an UNKNOWN status does not silently stand", () => {
    // A status the list has never heard of must not hold off a briefing by
    // accident — the positive list is what makes that true.
    const d = shouldQueueBriefing(
      [{ status: "SOME_NEW_STATE", createdAt: ago(5) }],
      NOW
    );
    assert.equal(d.queue, true);
  });
});
