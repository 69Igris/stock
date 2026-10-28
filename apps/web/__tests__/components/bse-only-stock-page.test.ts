/**
 * MONEY-1255 — a BSE-only company must resolve to its OWN exchange.
 *
 * 2,389 real companies are listed on BSE with no NSE row (measured on prod:
 * 5,523 real companies total, 3,134 NSE-listed). `/stock/<SYM>` defaulted the
 * exchange to "NSE" at the destructure, so for those companies the instrument
 * lookup missed and the page fell through to a SYNTHESISED row stamped
 * `exchange: "NSE"`.
 *
 * That is not a cosmetic mislabel. Every numeric read downstream is
 * exchange-scoped — `apps/web/lib/actions/stock-tabs.ts` and
 * `packages/services/src/stock-tabs.service.ts` both filter on it — while the
 * Documents/Filings tab reads on SYMBOL ALONE. So the page rendered an EMPTY
 * Financials tab beside a POPULATED Documents tab: the annual reports we had
 * just gone to some trouble to fetch were visible, and the numbers extracted
 * from those same documents were not.
 *
 * This is the "rows the UI never reads" failure the exchange-survival audit
 * existed to catch, and it was the ONLY hop in the whole chain that broke —
 * extract, parse, projection and embed all carry no exchange predicate.
 *
 * ## Why the fallback is gated on the param being ABSENT
 *
 * `?exchange=NSE` is a caller ASSERTION and must be honoured — including when
 * it returns nothing, because "NSE has no such listing" is a true and useful
 * answer. Only silence gets the widened search. Collapsing those two at the
 * destructure is what created the bug, so the distinction is what fixes it.
 *
 * Source: apps/web/app/stock/[symbol]/page.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE = join(
  __dirname,
  "..",
  "..",
  "app",
  "stock",
  "[symbol]",
  "page.tsx"
);
const src = readFileSync(PAGE, "utf8");

describe("BSE-only stock page resolution (MONEY-1255)", () => {
  it("[meta] the file under assertion is the real page", () => {
    // Ceiling: every assertion below is a substring test, so a wrong or empty
    // read would make some of them vacuous and the rest fail confusingly.
    assert.ok(src.length > 2000, `page.tsx read as ${src.length} chars`);
    assert.match(src, /export default async function StockPage/);
    assert.match(src, /instrumentMapping\.findFirst/);
  });

  it("does NOT default the exchange at the destructure", () => {
    // The original defect, in one line. `exchange = "NSE"` there makes
    // "asked for NSE" and "said nothing" the same value, and the fallback
    // below cannot then tell them apart.
    assert.doesNotMatch(
      src,
      /const \{ exchange = "NSE"/,
      "the exchange must not be defaulted while destructuring searchParams — " +
        'that collapses an explicit "NSE" into an absent param'
    );
    assert.match(
      src,
      /exchange: exchangeParam/,
      "the raw param must be read so its absence stays observable"
    );
    assert.match(src, /exchangeExplicit/);

    // `generateMetadata` had the SAME default, and it is the one that reaches
    // search engines: it put "SYMBOL - NSE" in the <title> and "on NSE" in the
    // description for every BSE-only company. It cannot resolve the real
    // exchange without a DB query on a deliberately query-free path, so it
    // names one only when the caller did.
    assert.match(
      src,
      /title: venue \? `\$\{decodedSymbol\} - \$\{venue\}` : decodedSymbol/,
      "metadata must omit the exchange rather than guess it"
    );
  });

  it("falls back to ANY exchange only when the caller named none", () => {
    const fallback = src.match(
      /if \(!instrument && !exchangeExplicit\)[\s\S]{0,900}?\n  \}/
    );
    assert.ok(
      fallback,
      "the widened lookup must be gated on BOTH a miss and an absent param"
    );
    const block = fallback[0];

    // It must NOT re-scope to an exchange — that is the whole point.
    assert.doesNotMatch(
      block,
      /exchange: *exchange/,
      "the fallback must not filter by exchange; it exists to look past it"
    );
    assert.match(
      block,
      /symbol: decodedSymbol/,
      "the fallback must still be keyed on the symbol"
    );
    assert.match(
      block,
      /isActive: true/,
      "a delisted row must not resurface through the fallback"
    );
  });

  it("prefers NSE deterministically when a symbol exists on both", () => {
    // "BSE" sorts before "NSE", and the NSE-scoped lookup already ran above,
    // so a dual-listed company never reaches the fallback at all. The ordering
    // matters for the case where the primary lookup failed for another reason:
    // it must be deterministic rather than whatever Mongo returns first.
    const fallback =
      src.match(
        /if \(!instrument && !exchangeExplicit\)[\s\S]{0,900}?\n  \}/
      )?.[0] ?? "";
    assert.match(
      fallback,
      /orderBy: \{ exchange: "asc" \}/,
      "the fallback must order deterministically, not take an arbitrary row"
    );
  });

  it("a lookup failure degrades to the synthesised shell, never a 500", () => {
    const fallback =
      src.match(
        /if \(!instrument && !exchangeExplicit\)[\s\S]{0,900}?\n  \}/
      )?.[0] ?? "";
    assert.match(
      fallback,
      /catch/,
      "a widened-lookup failure must not take the whole page down — the " +
        "synthesised block still renders a usable shell"
    );
  });
});
