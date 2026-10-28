/**
 * UNIT TEST — every prompt-library `navigateTo` points at a real route
 * (MONEY-776 / MONEY-777).
 *
 * ## The defect
 *
 * Four entries in `app/help/lib/prompt-library.ts` sent the user to `/markets`,
 * which has never existed — the route is `/discover/markets`. Clicking the
 * prompt navigated to a 404.
 *
 * Two were reported ("Market Today" → MONEY-776, "Top Gainers Today" →
 * MONEY-777). The other two — "Trending Stocks" and "Large Cap Movers" — were
 * broken in exactly the same way and nobody had filed them, which is the
 * argument for checking the whole table instead of the two paths in the tickets.
 *
 * ## Why it survived
 *
 * `navigateTo` is a plain string in a data table. Nothing type-checks it against
 * the router, nothing renders it at build time, and the neighbouring entry
 * (`/discover/markets`, on the same screen) was correct — so the file looked
 * self-consistent to a reader skimming it.
 *
 * ## What this asserts
 *
 * Every target resolves against the real `app/` directory: an exact match, a
 * parent of a real route, or a dynamic-segment match (`/stock/RELIANCE` is
 * satisfied by `app/stock/[symbol]/page.tsx`). Route groups — `app/(public)/x`
 * — are URL-transparent and are stripped before comparison, the same rule
 * `route-access.test.ts` applies.
 *
 * Pure file walking: no router, no network, no render.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "..", "..");
const APP = join(WEB, "app");

/** Every URL path that has a `page` file, route groups stripped. */
function realRoutes(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const hasPage = entries.some((e) => /^page\.(tsx?|jsx?)$/.test(e));
    if (hasPage) {
      const rel = dir.slice(APP.length).replace(/\\/g, "/");
      // Route groups `(marketing)` are URL-transparent — drop them, keep the rest.
      const path =
        rel
          .split("/")
          .filter((s) => s && !(s.startsWith("(") && s.endsWith(")")))
          .join("/") || "";
      out.add("/" + path);
    }
    for (const e of entries) {
      if (e === "node_modules" || e === ".next") continue;
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
    }
  };
  walk(APP);
  return out;
}

/** Does `target` resolve against the real route table? */
function resolves(target: string, routes: Set<string>): boolean {
  const base = target.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";
  if (routes.has(base)) return true;
  // A parent path is fine — `/discover` is real if `/discover/markets` is.
  if ([...routes].some((r) => r.startsWith(base + "/"))) return true;
  // Dynamic segments: `/stock/RELIANCE` is served by `/stock/[symbol]`.
  const segs = base.split("/").filter(Boolean);
  return [...routes].some((r) => {
    const rs = r.split("/").filter(Boolean);
    return (
      rs.length === segs.length &&
      rs.every((s, i) => s === segs[i] || s.startsWith("["))
    );
  });
}

const SOURCE = readFileSync(
  join(APP, "help", "lib", "prompt-library.ts"),
  "utf8"
);

interface Entry {
  id: string;
  target: string;
}

/** `id` + `navigateTo` for every entry that declares a destination. */
function entries(): Entry[] {
  const out: Entry[] = [];
  // Each entry is an object literal; pair the nearest preceding id with the target.
  for (const m of SOURCE.matchAll(/navigateTo:\s*"([^"]+)"/g)) {
    const before = SOURCE.slice(0, m.index);
    const id =
      [...before.matchAll(/id:\s*"([^"]+)"/g)].pop()?.[1] ?? "(unknown)";
    out.push({ id, target: m[1]! });
  }
  return out;
}

describe("MONEY-776/777 — prompt-library destinations exist", () => {
  it("[meta] the route table and the prompt table both parse", () => {
    // Without this, a moved directory or a renamed field makes the assertion
    // below vacuously true — it would report zero dead links because it found
    // no links at all.
    const routes = realRoutes();
    assert.ok(
      routes.size > 30,
      `found only ${routes.size} routes under app/ — the walker is broken`
    );
    assert.ok(
      entries().length >= 5,
      `found only ${entries().length} navigateTo entries — the parser is broken`
    );
    // Sanity that the resolver accepts a known-good and rejects a known-bad.
    assert.ok(resolves("/dashboard", routes), "should accept a real route");
    assert.ok(
      !resolves("/definitely-not-a-route-xyz", routes),
      "should reject a route that does not exist"
    );
  });

  it("every navigateTo resolves to a real route", () => {
    const routes = realRoutes();
    const dead = entries().filter((e) => !resolves(e.target, routes));
    assert.deepEqual(
      dead.map((d) => `${d.id} → ${d.target}`),
      [],
      "these prompts navigate to routes that do not exist, so clicking them " +
        "lands the user on a 404. `navigateTo` is a plain string in a data " +
        "table — nothing type-checks it against the router, which is how " +
        "/markets survived when /discover/markets sat two entries away"
    );
  });

  it("[regression] the four /markets prompts point at /discover/markets", () => {
    // Pinned by id: the two reported (MONEY-776 market-today, MONEY-777
    // top-gainers) plus the two that were equally broken and unreported.
    assert.doesNotMatch(
      SOURCE,
      /navigateTo:\s*"\/markets"/,
      "/markets has never been a route — use /discover/markets"
    );
    for (const id of [
      "market-today",
      "top-gainers",
      "trending-stocks",
      "large-cap-movers",
    ]) {
      const entry = entries().find((e) => e.id === id);
      assert.ok(entry, `prompt "${id}" should still exist`);
      assert.equal(
        entry.target,
        "/discover/markets",
        `prompt "${id}" must navigate to the real markets route`
      );
    }
  });
});
