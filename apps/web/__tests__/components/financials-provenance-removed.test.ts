/**
 * MONEY-1211 — the "Financials provenance" section is removed from the web
 * stock page.
 *
 * MONEY-1204 (14c.8) shipped `StockFinancialsSourceBadge` above the financials
 * table: a "STATEMENT SOURCE / Third-party data / LAST REFRESHED …" card, a
 * standalone-vs-consolidated toggle, per-filing coverage rows, and a "Where
 * these numbers come from." explainer. The founder's call is that the section
 * itself is not wanted. It is deleted, not hidden behind a flag.
 *
 * Two directions are pinned, because a removal can fail in both:
 *
 *  1. UNDER-removal — the component, its mount, or its copy creeping back onto
 *     the page.
 *  2. OVER-removal — deleting the DATA path with the UI. `sourceLabel` still
 *     renders through `StockFlagsBadges`, and `getStockFinancialsSource` is
 *     still mounted on `GET /v1/stocks/:symbol/financials-source` for mobile
 *     (apps/api/src/routes/v1/stocks.ts, with a parity contract test). This was
 *     a web-surface removal; the service is live and must stay that way.
 *
 * Sources: apps/web/app/stock/[symbol]/client.tsx
 *          apps/web/components/stock/SectionShell.tsx
 *          apps/api/src/routes/v1/stocks.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// `__dirname`, not `import.meta.dirname`: tsx loads apps/web tests as CJS.
const WEB = join(__dirname, "..", "..");
const REPO = join(WEB, "..", "..");
const read = (abs: string) => readFileSync(abs, "utf8");

function stripComments(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every .tsx/.ts under a directory, skipping build output. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(abs)) out.push(abs);
  }
  return out;
}

describe("MONEY-1211 — the section is gone (under-removal)", () => {
  it("the component file is deleted", () => {
    assert.equal(
      existsSync(join(WEB, "components/stock/StockFinancialsSourceBadge.tsx")),
      false
    );
  });

  it("the stock page neither imports nor mounts it", () => {
    const live = stripComments(
      read(join(WEB, "app/stock/[symbol]/client.tsx"))
    );
    assert.doesNotMatch(live, /StockFinancialsSourceBadge/);
    assert.doesNotMatch(live, /getStockFinancialsSourceAction/);
  });

  it("leaves no empty shell or stray heading behind", () => {
    const live = stripComments(
      read(join(WEB, "app/stock/[symbol]/client.tsx"))
    );
    // The financials tab must still render its table — a removal that also
    // took the table would be the other way to fail this ticket.
    assert.match(live, /<StockFinancialsTab/);
    // …and must not leave a wrapper whose only child was the badge.
    assert.doesNotMatch(live, /space-y-6">\s*<StockFinancialsTab/);
  });

  it("none of the section's copy survives anywhere in the web UI", () => {
    const COPY = [
      "Financials provenance",
      "Where these numbers come from",
      "Statement source",
      "Replaced by an exchange filing",
    ];
    const offenders: string[] = [];
    for (const file of [
      ...walk(join(WEB, "components")),
      ...walk(join(WEB, "app")),
    ]) {
      const live = stripComments(read(file));
      for (const phrase of COPY) {
        if (live.includes(phrase)) {
          offenders.push(`${file.slice(WEB.length + 1)} :: ${phrase}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});

describe("MONEY-1211 — the data path survives (over-removal)", () => {
  it("sourceLabel is still minted and still consumed", () => {
    const shell = read(join(WEB, "components/stock/SectionShell.tsx"));
    assert.match(shell, /export function sourceLabel/);
    const flags = stripComments(
      read(join(WEB, "components/stock/StockFlagsBadges.tsx"))
    );
    assert.match(flags, /sourceLabel\(/);
  });

  it("the mobile /v1 financials-source endpoint is untouched", () => {
    const api = read(join(REPO, "apps/api/src/routes/v1/stocks.ts"));
    assert.match(api, /getStockFinancialsSource/);
    assert.match(api, /financials-source/);
  });
});
