/**
 * META TEST — every mounted /v1 endpoint is driven by a contract test
 * (MONEY-1091, part 2).
 *
 * ## Why "38/38 families" was not the claim it looked like
 *
 * The contract suite references all 38 mounted `/v1` families, and that figure
 * was cited as evidence the API was covered. Enumerating per ENDPOINT instead:
 *
 *   38 families, 214 endpoints, 31 with no contract test — 86% covered
 *
 * `POST /v1/fire/:id/turn` was one of them: the newest endpoint (MONEY-1079) and
 * the one guarding a permanent-data-loss path, where a chat turn that loads a
 * different saved scenario could overwrite the scenario named in the URL. It
 * shipped with a disclosed "no automated regression test" gap and nothing forced
 * the issue, because `/v1/fire` as a family was already referenced.
 *
 * A measurement that reads 38/38 while the riskiest endpoint is untested
 * reassures without protecting. This replaces it.
 *
 * Since then `/turn`, the three remaining `/v1/fire` CRUD endpoints and the
 * four `/v1/notifications` endpoints have been covered
 * (`__tests__/routes/{fire-turn,fire-crud,notifications,delete-endpoints}-contract.test.ts`),
 * leaving **13 gaps — 94%**. The list is worked in risk order: writes and
 * deletes before reads, because a regression in a read shows up on the next
 * screen load and a regression in a delete does not show up at all.
 *
 * That ordering has already paid for itself. `PATCH /v1/notifications/:id/read`
 * was found BROKEN the moment something drove it: it answered 404 for a DB
 * error, on an endpoint whose service cannot fail for a missing row.
 *
 * ## Four things this enumerator has to get right
 *
 * Each of these was a real defect during development, and each produced either
 * phantom gaps or false comfort:
 *
 * 1. **Route paths must start with `/`.** Hono's context accessor `c.get("userId")`
 *    matches the same `.get("…")` shape as a registration and invented endpoints
 *    like `GET /v1/meuserId`.
 * 2. **Mount paths come from `index.ts`, not filenames.** `watchlist.ts` mounts
 *    at `/watchlists` and `quiz.ts` at `/quizzes`, so filename-derived families
 *    flagged URLs that do not exist while missing the ones that do.
 * 3. **`index.ts` is not a family.** Its own routes mount at `/v1`, not
 *    `/v1/index`.
 * 4. **Tests drive routes with template literals too.** 21 call sites use
 *    `app.request(\`…\${id}\`)`; ignoring them reports covered endpoints as gaps.
 *
 * Validated both directions before the allow-list below was written: every
 * flagged endpoint confirmed to have zero matching `app.request` calls, and
 * several unflagged ones confirmed to have some. `GET /v1/research` is the case
 * that proves method-awareness matters — the suite drives that exact path seven
 * times, all POST.
 *
 * Pure file parsing: no Hono, no app boot, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// `import.meta.dirname` — apps/api is ESM ("type": "module").
const API = join(import.meta.dirname, "..", "..");
const V1 = join(API, "src", "routes", "v1");

const INDEX = readFileSync(join(V1, "index.ts"), "utf8");

/** Source file → the URL prefix `index.ts` actually mounts it at. */
function mountPaths(): Map<string, string> {
  const imports = new Map<string, string>();
  for (const m of INDEX.matchAll(
    /import\s+\{?\s*(\w+)\s*\}?\s+from\s+"\.\/([\w-]+)"/g,
  )) {
    imports.set(m[1]!, m[2]!);
  }
  const out = new Map<string, string>();
  for (const m of INDEX.matchAll(
    /v1Routes\.route\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)/g,
  )) {
    const file = imports.get(m[2]!);
    if (file) out.set(file, m[1]!);
  }
  return out;
}

/** `METHOD /v1/...` for every route reachable through the v1 router. */
function registeredEndpoints(): string[] {
  const out: string[] = [];
  const add = (src: string, prefix: string) => {
    // The leading "/" is required — it is what separates a route registration
    // from `c.get("userId")`.
    for (const m of src.matchAll(
      /\.(get|post|put|delete|patch)\(\s*"(\/[^"]*)"/g,
    )) {
      const path = m[2] === "/" ? "" : m[2]!;
      out.push(`${m[1]!.toUpperCase()} /v1${prefix}${path}`);
    }
  };
  for (const [file, mount] of mountPaths()) {
    add(readFileSync(join(V1, `${file}.ts`), "utf8"), mount);
  }
  add(INDEX, ""); // index's own routes live at /v1
  return [...new Set(out)].sort();
}

/** `METHOD path` for every route the suite actually drives. */
function drivenEndpoints(): Set<string> {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules") continue;
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e.endsWith(".test.ts")) parts.push(readFileSync(full, "utf8"));
    }
  };
  walk(join(API, "__tests__"));
  const corpus = parts.join("\n");

  const out = new Set<string>();
  // Both quote styles; `${expr}` collapses to a wildcard segment.
  for (const quote of ['"', "`"]) {
    const re = new RegExp(
      `app\\.request\\(\\s*${quote}([^${quote}]+)${quote}`,
      "g",
    );
    for (const m of corpus.matchAll(re)) {
      const path =
        m[1]!
          .split("?")[0]!
          .replace(/\$\{[^}]*\}/g, "*")
          .replace(/\/+$/, "") || "/";
      const after = corpus.slice(
        m.index! + m[0].length,
        m.index! + m[0].length + 250,
      );
      const method =
        /method:\s*"(\w+)"/.exec(after)?.[1]?.toUpperCase() ?? "GET";
      out.add(`${method} ${path}`);
    }
  }
  return out;
}

/** Does any driven call reach this route? Segment-wise, `:param` and `*` wild. */
function isCovered(endpoint: string, driven: Set<string>): boolean {
  const [rMethod, rPath] = endpoint.split(" ") as [string, string];
  const rs = rPath.split("/").filter(Boolean);
  for (const d of driven) {
    const [dMethod, dPath] = d.split(" ") as [string, string];
    if (dMethod !== rMethod) continue;
    const ds = dPath.split("/").filter(Boolean);
    if (ds.length !== rs.length) continue;
    if (rs.every((s, i) => s === ds[i] || s.startsWith(":") || ds[i] === "*")) {
      return true;
    }
  }
  return false;
}

/**
 * Endpoints with no contract coverage yet.
 *
 * A snapshot, NOT an endorsement — it exists so this fails on NEW holes rather
 * than on history. The ticket is explicit that these "get their own follow-ups
 * rather than expanding this ticket". Every entry was verified to have zero
 * matching `app.request` calls before being listed.
 *
 * This list SHRINKS and never grows: an entry that gains coverage must be
 * deleted (the "nothing here is actually covered" case below enforces it), and
 * a brand-new endpoint may not be added to buy silence — it needs a contract
 * case. Fifteen entries have been retired so far: the `/v1/fire` family,
 * `/v1/notifications`, every DELETE, `POST /v1/trades` and the two
 * subscription reads. THREE of those groups turned out to be BROKEN the moment
 * something drove them, all the same way — a DB error reported as a client
 * error, so the caller stops retrying (MONEY-1178 and MONEY-1180 answered 404,
 * MONEY-1181 answered 400). What remains here is reads only: no DELETEs, no
 * POSTs, no PUTs.
 */
const KNOWN_GAPS = new Set([
  "GET /v1/brokers",
  "GET /v1/brokers/last-sync",
  "GET /v1/brokers/sync-status",
  "GET /v1/dashboard",
  "GET /v1/dashboard/portfolio",
  "GET /v1/dashboard/returns",
  "GET /v1/holdings/summary",
  "GET /v1/learning/courses/:slug",
  "GET /v1/learning/progress",
  "GET /v1/positions/closed-today",
  "GET /v1/positions/summary",
  "GET /v1/research",
  "GET /v1/research/running",
]);

/** The endpoint this ticket exists for — tracked by name, never allow-listed. */
const TICKET_ENDPOINT = "POST /v1/fire/:id/turn";

describe("MONEY-1091 — /v1 coverage measured per ENDPOINT, not per family", () => {
  it("[meta] the enumerator sees the router, the routes and the suite", () => {
    // A walker that found nothing would report zero gaps and be
    // indistinguishable from a fully covered API — the exact false comfort the
    // 38/38 family count provided.
    const mounts = mountPaths();
    assert.ok(
      mounts.size >= 35,
      `resolved only ${mounts.size} mounted families from index.ts — the ` +
        `mount parser is broken`,
    );
    const endpoints = registeredEndpoints();
    assert.ok(
      endpoints.length > 180,
      `found only ${endpoints.length} endpoints — the route parser is broken`,
    );
    assert.ok(
      drivenEndpoints().size > 200,
      "found almost no app.request calls — the suite walker is broken",
    );
    assert.ok(
      endpoints.includes(TICKET_ENDPOINT),
      `${TICKET_ENDPOINT} should be registered — did the route move?`,
    );
  });

  it("[meta] mount paths come from index.ts, not from filenames", () => {
    // The defect that produced phantom gaps: `watchlist.ts` mounts at
    // `/watchlists`, so a filename-derived family flags `/v1/watchlist`, which
    // is not a URL, while missing every real `/v1/watchlists/*` endpoint.
    const mounts = mountPaths();
    assert.equal(mounts.get("watchlist"), "/watchlists");
    assert.equal(mounts.get("quiz"), "/quizzes");
    const endpoints = registeredEndpoints().join("\n");
    assert.doesNotMatch(
      endpoints,
      /^GET \/v1\/watchlist$/m,
      "singular /v1/watchlist is not a mounted path",
    );
    assert.doesNotMatch(
      endpoints,
      /\/v1\/index/,
      "index.ts mounts at /v1, not /v1/index",
    );
  });

  it("[meta] coverage matching is method-aware", () => {
    // `GET /v1/research` is uncovered while the suite drives that exact path
    // seven times — all POST. A path-only matcher would call it covered.
    const driven = drivenEndpoints();
    assert.equal(isCovered("POST /v1/research", driven), true);
    assert.equal(isCovered("GET /v1/research", driven), false);
  });

  it("no NEW endpoint ships without contract coverage", () => {
    const driven = drivenEndpoints();
    // No TICKET_ENDPOINT exemption: part 1 covered it, so it now passes this
    // filter on its own merits. Losing that coverage should trip BOTH this
    // guard and the dedicated assertion below, not just the dedicated one.
    const uncovered = registeredEndpoints().filter(
      (e) => !isCovered(e, driven) && !KNOWN_GAPS.has(e),
    );
    assert.deepEqual(
      uncovered,
      [],
      "these /v1 endpoints are registered but no contract test drives them. " +
        "Family-level presence is not coverage — the suite referenced all 38 " +
        "families while 31 endpoints were untested, including the one guarding " +
        "a permanent-data-loss path. Add a contract case, or add the endpoint " +
        "to KNOWN_GAPS with a follow-up ticket",
    );
  });

  it("POST /v1/fire/:id/turn keeps its contract coverage — MONEY-1091 part 1", () => {
    // Asserted rather than allow-listed, deliberately, and kept after the fact
    // for the same reason it was written before it: this is the endpoint the
    // ticket was filed for. It guards the scenario-retarget data loss, where
    // `POST /v1/fire/<A>/turn` carrying "load my Conservative plan" could
    // overwrite plan A with plan B's numbers — and it is the only /v1 route
    // that mutates a saved plan, calls a model AND charges credits.
    //
    // The DECISION logic was already unit-covered
    // (packages/fire/__tests__/scenario-save-target.test.ts, 10 cases); part 1
    // added the ROUTE contract in __tests__/routes/fire-turn-contract.test.ts,
    // whose retarget case asserts the target id AND the persisted values.
    // Deleting this line once green would give back exactly the blind spot the
    // ticket existed to remove, so it stays, inverted.
    assert.equal(
      isCovered(TICKET_ENDPOINT, drivenEndpoints()),
      true,
      "POST /v1/fire/:id/turn has LOST its contract coverage — restore " +
        "__tests__/routes/fire-turn-contract.test.ts rather than allow-listing " +
        "it; this endpoint is never a known gap",
    );
  });

  it("the known-gap list contains nothing that is actually covered", () => {
    // A stale allow-list silently excuses a future regression on an endpoint
    // somebody has since covered.
    const driven = drivenEndpoints();
    assert.deepEqual(
      [...KNOWN_GAPS].filter((e) => isCovered(e, driven)),
      [],
      "these are listed as known gaps but now have coverage — remove them from " +
        "KNOWN_GAPS so they are protected again",
    );
  });

  it("every known-gap entry is a real registered endpoint", () => {
    // The mirror failure: an entry for a renamed or deleted route quietly
    // shrinks the guard. This is what would have caught the `/v1/watchlist`
    // phantoms had they reached the list.
    const registered = new Set(registeredEndpoints());
    assert.deepEqual(
      [...KNOWN_GAPS].filter((e) => !registered.has(e)),
      [],
      "these known-gap entries match no registered route — the route moved or " +
        "was removed, so the entry is dead weight",
    );
  });
});
