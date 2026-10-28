/**
 * META TEST — a /v1 handler may not blame the client for a service failure
 * (MONEY-1182).
 *
 * ## Why this exists
 *
 * Three separate bugs on one branch, all the same shape, all found only because
 * something finally drove the endpoint:
 *
 *   MONEY-1178  PATCH /v1/notifications/:id/read   DB error → 404
 *   MONEY-1180  all four /v1 DELETEs               DB error → 404
 *   MONEY-1181  POST /v1/trades                    DB error → 400
 *
 * Each had the identical structure. A service returns
 * `ServiceResult<T> = { success: false; error: string; code?: string }`, where
 * `success: false` covers BOTH "there is no such row" and "the database
 * failed". The handler wrote:
 *
 *     if (!result.success) {
 *       return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
 *     }
 *
 * …picking one 4xx for both. That is not a cosmetic status-code nit. 4xx means
 * "your request was wrong — fix it and try again", so a client that receives it
 * STOPS RETRYING: the notification stays unread, the row stays undeleted, the
 * trade is lost and the user is told to correct data that was already correct.
 * The real failure is also invisible to monitoring, because 4xx is ordinary
 * traffic while 5xx is what alerts.
 *
 * Three instances is a pattern, not a coincidence, so it is encoded here rather
 * than left to be found a fourth time.
 *
 * ## The rule
 *
 * If a handler branches on `!x.success` and returns any 4xx from that branch,
 * it must INSPECT `x.code` somewhere in the same branch. Consulting the code is
 * what makes the choice a decision instead of a guess — a handler that reads
 * `code` and maps `INTERNAL` to 500 is fine; one that returns a bare 404
 * because that is what the route next door did is not.
 *
 * The rule deliberately does NOT demand a particular status. Some services
 * genuinely have only a not-found failure path, and a flat 404 is correct
 * there. What it demands is that the author looked.
 *
 * ## KNOWN_BLIND is a snapshot, not an endorsement
 *
 * 20 handlers predate this test. They are recorded rather than fixed here
 * because auditing each one means reading its service to learn which failures
 * are actually reachable — the work that found the three bugs above, and far
 * more than one ticket. MONEY-1183 tracks that audit.
 *
 * The list may only SHRINK. A new handler cannot be added to buy silence, and
 * an entry that starts inspecting `code` must be removed (asserted below), so
 * the audit cannot quietly stall while looking finished.
 *
 * Pure file parsing: no Hono, no app boot, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const V1 = join(import.meta.dirname, "..", "..", "src", "routes", "v1");

/** One `if (!x.success) { … }` branch that returns a 4xx. */
interface Branch {
  /** `file METHOD /path` — stable across edits that move line numbers. */
  key: string;
  /** Whether the branch consults `x.code` before choosing a status. */
  inspectsCode: boolean;
  /** Every status returned inside the branch. */
  statuses: string[];
}

/** Match `{`/`}` from just past an opening brace to find a block's end. */
function blockEnd(src: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return i;
}

function scan(): Branch[] {
  const out: Branch[] = [];
  for (const file of readdirSync(V1).sort()) {
    if (!file.endsWith(".ts") || file === "index.ts") continue;
    const src = readFileSync(join(V1, file), "utf8");

    // Route registrations, so a branch can be named by the endpoint it serves
    // rather than by a line number that moves on every edit.
    const routes: Array<[number, string, string]> = [];
    for (const m of src.matchAll(
      /\.(get|post|put|delete|patch)\(\s*"(\/[^"]*)"/g,
    )) {
      routes.push([m.index!, m[1]!.toUpperCase(), m[2]!]);
    }

    for (const m of src.matchAll(/if \(!(\w+)\.success\) \{/g)) {
      const varName = m[1]!;
      const body = src.slice(m.index!, blockEnd(src, m.index! + m[0].length));
      // `error(…), 404)` — the status argument of a c.json(…, NNN) call.
      const statuses = [...body.matchAll(/\),\s*(\d{3})\s*\)/g)].map(
        (s) => s[1]!,
      );
      if (!statuses.some((s) => s.startsWith("4"))) continue;

      const prior = routes.filter(([at]) => at < m.index!);
      const last = prior[prior.length - 1];
      out.push({
        key: `${file} ${last ? `${last[1]} ${last[2]}` : "?"}`,
        // "Did the author look?" — three shapes count, because all three are a
        // DECISION rather than a copy of the route next door:
        //   result.code                      the direct read
        //   (result as { code?: string }).code   the cast, which a literal
        //                                    `${varName}.code` search misses
        //   result.error === "…"             discriminating on the message
        //
        // The last is weaker and worth migrating to a code — a reworded message
        // silently breaks the mapping — but it is not the blind copy this guard
        // exists to catch, and flagging it sent readers to handlers that were
        // already correct (found while auditing under MONEY-1183).
        inspectsCode:
          body.includes(`${varName}.code`) ||
          /\)\s*\.code\b/.test(body) ||
          new RegExp(`${varName}\\.error\\s*===`).test(body),
        statuses,
      });
    }
  }
  return out;
}

/**
 * Handlers that answer a 4xx for an un-inspected service failure, as of
 * MONEY-1182. Snapshot only — see the header. Shrinks, never grows.
 */
const KNOWN_BLIND = new Set([
  // Account deletion is owned by a separate effort — deliberately untouched.
  "me.ts DELETE /",
]);

/**
 * Route keys that still have at least ONE blind branch.
 *
 * A handler can contain several `!x.success` branches — `me.ts DELETE /` has
 * two, and only one of them consults `code`. Aggregating by route means a
 * route counts as blind while ANY of its branches is, so fixing one of two
 * cannot retire the entry and hide the other.
 */
function blindRoutes(): Set<string> {
  const out = new Set<string>();
  for (const b of scan()) if (!b.inspectsCode) out.add(b.key);
  return out;
}

describe("MONEY-1182 — a /v1 handler must not blame the client for a service failure", () => {
  it("[meta] the scanner finds handlers, branches and both outcomes", () => {
    // A scanner that matched nothing would report a clean API and be
    // indistinguishable from a fixed one — the same false comfort the 38/38
    // family count gave.
    const branches = scan();
    assert.ok(
      branches.length >= 20,
      `found only ${branches.length} 4xx failure branches — the scanner is broken`,
    );
    assert.ok(
      branches.some((b) => b.inspectsCode),
      "no branch inspects `code` — the scanner cannot tell the two apart",
    );
    assert.ok(
      branches.some((b) => !b.inspectsCode),
      "every branch looks compliant — the scanner is not reading bodies",
    );
  });

  it("[meta] the routes fixed on this branch read as COMPLIANT", () => {
    // Ground truth in the positive direction: the four DELETEs (MONEY-1180)
    // now consult `code`, so the scanner must not flag them. If this fails,
    // the scanner is looking at the wrong text.
    const keys = new Set(scan().map((b) => b.key));
    const blind = blindRoutes();
    for (const key of [
      "paper.ts DELETE /:id",
      "research.ts DELETE /:sessionId",
      "watchlist.ts DELETE /:id",
      "watchlist.ts DELETE /:id/items/:itemId",
    ]) {
      assert.ok(keys.has(key), `${key} — expected a 4xx branch, found none`);
      assert.equal(
        blind.has(key),
        false,
        `${key} should consult result.code after MONEY-1180`,
      );
    }
  });

  it("no NEW handler answers 4xx for an un-inspected service failure", () => {
    const blind = [...blindRoutes()].filter((k) => !KNOWN_BLIND.has(k)).sort();
    assert.deepEqual(
      blind,
      [],
      "these handlers return a 4xx for a service failure without inspecting " +
        "`result.code`, so a database error is reported to the client as its " +
        "own fault and never retried — the bug behind MONEY-1178, MONEY-1180 " +
        "and MONEY-1181. Inspect the code (INTERNAL → 500), or add the route " +
        "to KNOWN_BLIND with a follow-up ticket",
    );
  });

  it("the snapshot contains nothing that now inspects `code`", () => {
    // Without this, a fixed handler keeps its exemption and the next
    // regression on it goes unreported. Aggregated by route: an entry is stale
    // only when EVERY branch under it inspects `code`, so a half-fixed handler
    // keeps its entry rather than losing the guard on its remaining branch.
    const blind = blindRoutes();
    const fixed = [...KNOWN_BLIND].filter((k) => !blind.has(k)).sort();
    assert.deepEqual(
      fixed,
      [],
      "these are listed as blind but now inspect `code` — remove them from " +
        "KNOWN_BLIND so they are protected again",
    );
  });

  it("every snapshot entry is a real handler", () => {
    // The mirror failure: an entry for a renamed or deleted route silently
    // shrinks the guard.
    const real = new Set(scan().map((b) => b.key));
    assert.deepEqual(
      [...KNOWN_BLIND].filter((k) => !real.has(k)).sort(),
      [],
      "these snapshot entries match no 4xx failure branch — the route moved " +
        "or was removed, so the entry is dead weight",
    );
  });
});
