/**
 * EVERY surface that serves US market data must pass it through the licence gate.
 *
 * ## Why this is derived rather than a list
 *
 * The three US surfaces were gated by hand. A fourth added later would be gated
 * only if whoever added it knew the rule existed — and the rule is a LICENCE
 * boundary (Tiingo COMMERCIAL is internal-use-only; serving US prices is
 * redistribution and needs MONEY-1262), so "they will remember" is not enough.
 *
 * So the population is COMPUTED: any production file that calls the US read
 * entry points must also reference a gate. A new route inherits the check by
 * existing, which is the only version of this that survives a future change.
 *
 * ## The shape of the hole this closes
 *
 * The stock PAGE was already behind the `us-stocks-listing` flag, and that made
 * the whole feature look gated. The routes underneath were behind nothing:
 * `/api/market/quote`, `/api/market/stream`, and `/v1/market/us/quotes` — the
 * last reachable by any client holding a Bearer token, with no page in the way.
 * A dark page in front of open data is not a gate; it is a link nobody has been
 * given yet. This is the MONEY-1142 shape (a paywall on `apps/web` and not on
 * `apps/api`) repeating one feature over.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/** Where a US-serving surface could live. */
const SCAN_ROOTS = [
  join(REPO, "apps", "web", "app"),
  join(REPO, "apps", "web", "lib"),
  join(REPO, "apps", "api", "src"),
  // MONEY-1469/1470 — the FOURTH app, and the guard could not see it.
  //
  // `apps/market-data` shipped `/quotes` with no auth and no licence gate,
  // accepting `market=US`, and this suite stayed green throughout: every file
  // in that service sits outside all three roots above, so none was ever read.
  // Its own header says "a new route inherits the check by existing, which is
  // the only version of this that survives a future change." It did not — a new
  // APP does not inherit a root list.
  join(REPO, "apps", "market-data", "src"),
];

/**
 * Calling any of these means the file can put US prices in front of a caller.
 *
 * `resolveUsQuotes` is the read entry point; `readRtQuotes` is the raw Redis
 * read beneath it. Both are listed so a surface cannot slip under the gate by
 * reaching one level lower.
 */
const US_READ_ENTRY_POINTS = [
  "resolveUsQuotes",
  "readRtQuotes",
  // The cache-layer wrapper. Omitting it left the BIGGEST surface invisible:
  // `app/api/market/quote/route.ts` calls this rather than `resolveUsQuotes`,
  // so removing its gate produced ZERO failures — the guard could not see the
  // route it most needed to watch. Caught by mutating the guard itself.
  "fetchUsQuotesUncached",
  // MONEY-1469/1470 — two MORE doors into `rt:us:quote:*` and the US intraday
  // buffer. Adding the scan root alone would still have reported green, because
  // the guard names the functions it watches: an unnamed entry point is
  // invisible under every root.
  "readQuotes",
  "readBars",
  // MONEY-1477 — the DAILY tile lane. `history.ts` satisfied this scan only
  // because its INTRADAY branch imports `tokenMayReadUs`, so the file looked
  // wired while one of its two US lanes was open to anyone with the URL.
  // Naming the tile reader makes the daily lane visible on its own.
  "readTile",
];

/**
 * Any of these counts as gating.
 *
 * Three spellings because the surfaces legitimately differ: the web routes call
 * the Clerk-backed resolver, apps/api calls its own user-id-backed one, and a
 * module may consume the pure rule directly.
 */
const GATE_MARKERS = [
  "currentUserMaySeeUsMarket",
  "mayServeUsMarket",
  "isUsMarketAllowed",
  "partitionUsSymbolsByAccess",
  // MONEY-1469/1470 — `apps/market-data` CANNOT call the others. It is a
  // Cloud Run service with no database and no Clerk, which is most of the
  // latency it exists to remove; resolving a user's entitlement per request
  // would put all of it back. Its gate is a signed CLAIM, decided at mint time
  // on the web side by `currentUserMaySeeUsMarket` and verified here with one
  // HMAC and no I/O.
  //
  // Accepting this marker is only safe because the test below re-anchors the
  // chain to the real check: the MINTER must call `currentUserMaySeeUsMarket`.
  // Without that, this would be a rename of the gate rather than a second
  // spelling of it.
  "tokenMayReadUs",
];

/**
 * Files that serve US data but cannot hold the gate themselves.
 *
 * NOT a rubber stamp: an entry is honoured only while the companion test below
 * still finds every IMPORTER gated. An allow-list whose justification is not
 * itself checked is how a temporary exemption becomes permanent — and this one
 * guards a licence boundary.
 */
const GATED_BY_CALLERS: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: "apps/web/lib/market/quote-cache.ts",
    why:
      "Defines `fetchUsQuotesUncached`; it is a cache/budget layer with no " +
      "request context. Its only production importer is the gated branch in " +
      "app/api/market/quote/route.ts.",
  },
  {
    file: "apps/web/lib/market/quote-cache-logic.ts",
    why: "Pure helpers for the layer above; holds no request context.",
  },
  {
    file: "apps/web/lib/market/providers/quote-providers.ts",
    why:
      "A provider layer with no request context — its own module comment " +
      "records that a provider is routinely pulled out of the chain array and " +
      "called DETACHED, so a Clerk `auth()` here would run outside a request. " +
      "Its only importers are quote-cache.ts and quote-cache-logic.ts, and the " +
      "single production path into those is the gated branch in " +
      "app/api/market/quote/route.ts.",
  },
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
}

function tsFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".next")
        continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
        out.push(full);
    }
  };
  walk(root);
  return out;
}

describe("US market data — every serving surface is behind the licence gate", () => {
  const files = SCAN_ROOTS.flatMap(tsFiles);

  it("PREMISE: the scan resolved production files under every root", () => {
    // Without a per-root floor this suite passes by finding nothing — a root
    // retargeted at a directory that does not exist returns [] and an
    // absence-assertion stays green. A falsifiable check needs a ceiling.
    assert.ok(files.length > 100, `only ${files.length} files scanned`);
    for (const root of SCAN_ROOTS) {
      assert.ok(existsSync(root), `scan root missing: ${root}`);
      assert.ok(
        tsFiles(root).length > 0,
        `scan root resolved nothing: ${root}`,
      );
    }
  });

  it("PREMISE: at least one surface actually serves US quotes", () => {
    // If the entry-point names are ever renamed, the population silently
    // becomes empty and every assertion below is vacuously satisfied. This is
    // the check that the guard has anything to guard.
    const serving = files.filter((f) => {
      const src = stripComments(readFileSync(f, "utf8"));
      return US_READ_ENTRY_POINTS.some((e) => src.includes(e));
    });
    assert.ok(
      serving.length >= 2,
      `expected at least 2 US-serving surfaces, found ${serving.length} — ` +
        `have ${US_READ_ENTRY_POINTS.join("/")} been renamed?`,
    );

    // A COUNT IS NOT COVERAGE — and this guard has a LIMIT worth stating.
    //
    // MONEY-1477 found US DAILY served with no auth while this suite was
    // green. The reason is structural: the scan is FILE-LEVEL, and
    // `history.ts` contains two US lanes. Its intraday lane references a gate,
    // so the file is "covered" no matter what the daily lane does.
    //
    // Mutation-proved twice over: removing `readTile` from the list leaves
    // this suite green, because `history.ts` still matches via `readBars`.
    // The pin below therefore CANNOT catch a per-lane gap, and claiming it
    // does would be worse than not having it.
    //
    // What it DOES catch is a file dropping out of the guarded set entirely —
    // a renamed entry point, or a new US surface nobody listed. The per-lane
    // property is covered behaviourally instead, by
    // `apps/market-data/__tests__/history.test.ts` ("a VALID token WITHOUT the
    // `us` claim is refused"), which a mutation removing `tokenMayReadUs` from
    // the daily gate DOES fail.
    for (const required of [
      "apps/market-data/src/routes/history.ts",
      "apps/market-data/src/routes/quotes.ts",
    ]) {
      assert.ok(
        serving.some((f) => f.replace(/\\/g, "/").endsWith(required)),
        `${required} reads US data but is NOT in the guarded set — every ` +
          `entry point it uses is missing from US_READ_ENTRY_POINTS, so this ` +
          `guard is not watching it at all`,
      );
    }
  });

  it("every file that reads US quotes also references a gate", () => {
    const ungated: string[] = [];
    for (const f of files) {
      const rel = f.replace(`${REPO}/`, "");
      if (GATED_BY_CALLERS.some((a) => rel.endsWith(a.file))) continue;
      const src = stripComments(readFileSync(f, "utf8"));
      const serves = US_READ_ENTRY_POINTS.some((e) => src.includes(e));
      if (!serves) continue;
      const gated = GATE_MARKERS.some((g) => src.includes(g));
      if (!gated) ungated.push(rel);
    }
    assert.deepEqual(
      ungated,
      [],
      "US market data is served WITHOUT a licence gate from:\n  " +
        ungated.join("\n  ") +
        "\n\nTiingo COMMERCIAL is internal-use-only: ingesting US prices is " +
        "permitted, serving them to a user is redistribution and needs " +
        "MONEY-1262. Gate the surface with `currentUserMaySeeUsMarket` " +
        "(apps/web) or `mayServeUsMarket` (apps/api), and refuse by ABSENCE " +
        "rather than an error.",
    );
  });

  it("the market-data service's CLAIM is minted from the real licence check", () => {
    // `tokenMayReadUs` is accepted as a gate marker above, and on its own it is
    // only a boolean read off a JWT. What makes it a LICENCE gate is that the
    // one place that can set it consults `currentUserMaySeeUsMarket` — the same
    // function every other surface uses, whose default is the FOUNDER ALONE.
    //
    // Without this assertion, minting `us: true` unconditionally would satisfy
    // the marker scan and reopen the whole boundary with nothing failing.
    const minter = readFileSync(
      join(REPO, "apps", "web", "lib", "actions", "market-data-token.ts"),
      "utf8",
    );
    assert.match(
      minter,
      /currentUserMaySeeUsMarket/,
      "the market-data token must derive its `us` claim from the licence check",
    );
    assert.match(minter, /\bus\b/, "the token must carry a `us` claim at all");
  });

  it("an allow-listed file's IMPORTERS are all gated — the exemption is earned", () => {
    // The entry above claims "the gate sits above every caller". This is that
    // claim, checked. Add an ungated importer and the exemption stops holding,
    // which is the only thing separating an allow-list from a hole.
    for (const entry of GATED_BY_CALLERS) {
      const base = entry.file
        .split("/")
        .pop()!
        .replace(/\.tsx?$/, "");
      const importers = files.filter((f) => {
        if (f.endsWith(entry.file)) return false;
        const src = stripComments(readFileSync(f, "utf8"));
        return new RegExp(`from\\s+["'][^"']*${base}["']`).test(src);
      });
      assert.ok(
        importers.length > 0,
        `${entry.file} has no importers — the exemption's premise is stale`,
      );
      const ungatedImporters = importers.filter((f) => {
        const src = stripComments(readFileSync(f, "utf8"));
        const rel2 = f.replace(`${REPO}/`, "");
        // Gated directly, or itself allow-listed — in which case its own
        // importers are checked on its own iteration, so the chain still ends
        // at something gated rather than at an exemption pointing at an
        // exemption.
        return (
          !GATE_MARKERS.some((g) => src.includes(g)) &&
          !GATED_BY_CALLERS.some((a) => rel2.endsWith(a.file))
        );
      });
      assert.deepEqual(
        ungatedImporters.map((f) => f.replace(`${REPO}/`, "")),
        [],
        `${entry.file} is exempt because its callers are gated, but these ` +
          "importers are not — the exemption no longer holds",
      );
    }
  });

  it("the founder default is not accidentally widened by the shipped env", () => {
    // The gate is only as narrow as its configuration. Nothing in the repo
    // should ship a widened allowlist; if one appears in a Cloud Build spec
    // that is a deliberate act and should be visible in a diff rather than
    // discovered in production.
    const specs = [
      "workers/cloudbuild.prod.yaml",
      "workers/cloudbuild.qa.yaml",
    ].filter((p) => existsSync(join(REPO, p)));
    assert.ok(specs.length > 0, "no cloudbuild specs found — check the paths");
    for (const spec of specs) {
      const src = readFileSync(join(REPO, spec), "utf8");
      assert.ok(
        !src.includes("US_MARKET_ALLOWED_EMAILS"),
        `${spec} sets US_MARKET_ALLOWED_EMAILS — widening the licence gate must ` +
          "be a deliberate, reviewed change, not a spec default",
      );
    }
  });
});
