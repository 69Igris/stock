/**
 * The Financials panel must not tell a user "no financials" while a populated
 * period sits one click away.
 *
 * QUARTERLY is empty for EVERY symbol on the platform (32,359 rows, all
 * ANNUAL): `financial-data-sync` is its only Tickertape writer and prod
 * schedules it at `tier:"hot"`, which matches 0 of 10,444 symbols (MONEY-1211),
 * while the XBRL quarterly backfill has not been run. Until both land, the
 * empty Quarterly panel is the DEFAULT experience for anyone who toggles.
 *
 * The rule under test is the three-way distinction the component has to keep:
 *   other period HAS rows      -> point at it
 *   other period checked, empty-> generic message
 *   other period NOT checked   -> generic message (never claim it is empty)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const TAB = readFileSync(
  join(ROOT, "components", "stock", "StockFinancialsTab.tsx"),
  "utf8"
);
const CSS = readFileSync(
  join(ROOT, "components", "stock", "financials-playful.css"),
  "utf8"
);

/** Mirrors the component's derivation, which is the whole decision. */
function pointerFor(
  period: "QUARTERLY" | "ANNUAL",
  seen: Partial<Record<"QUARTERLY" | "ANNUAL", boolean>>
): "QUARTERLY" | "ANNUAL" | null {
  const other = period === "QUARTERLY" ? "ANNUAL" : "QUARTERLY";
  return seen[other] ? other : null;
}

describe("financials empty state — period pointer", () => {
  it("points at ANNUAL when quarterly is empty and annual has rows", () => {
    assert.equal(pointerFor("QUARTERLY", { ANNUAL: true }), "ANNUAL");
  });

  it("points at QUARTERLY in the mirror case", () => {
    assert.equal(pointerFor("ANNUAL", { QUARTERLY: true }), "QUARTERLY");
  });

  it("stays generic when the other period was checked and is empty", () => {
    assert.equal(pointerFor("QUARTERLY", { ANNUAL: false }), null);
  });

  it("stays generic when the other period has NOT been checked", () => {
    // The critical one: an unresolved probe must not be read as "empty", and
    // must not be read as "has data" either. Absent is its own state.
    assert.equal(pointerFor("QUARTERLY", {}), null);
  });

  it("never points at the period already being shown", () => {
    const p = pointerFor("ANNUAL", { ANNUAL: true, QUARTERLY: true });
    assert.notEqual(p, "ANNUAL");
    assert.equal(p, "QUARTERLY");
  });
});

describe("financials empty state — wiring", () => {
  it("records emptiness from the RESPONSE, never presumes it", () => {
    assert.match(TAB, /setPeriodsWithData/);
    // Seeding the map with `true` would fabricate a pointer to an unread
    // period. Sliced rather than regexed: the declaration's type argument is
    // `Partial<Record<PeriodType, boolean>>`, whose nested `>` defeats any
    // `[^>]*` span — the reason an earlier version of this assertion passed
    // against a deliberately seeded map.
    const decl = TAB.slice(
      TAB.indexOf("const [periodsWithData"),
      TAB.indexOf("const [periodsWithData") + 400
    );
    const init = decl.slice(decl.indexOf(">("), decl.indexOf(");") + 2);
    assert.ok(init.length > 0, "could not locate the initializer");
    assert.doesNotMatch(
      init,
      /:\s*true/,
      `periodsWithData must start empty, got: ${init}`
    );
  });

  it("guards the probe so a failed probe cannot fail the panel", () => {
    const probe = TAB.slice(TAB.indexOf("const other: PeriodType"));
    assert.match(probe, /\.catch\(/, "probe must be caught");
  });

  it("probes the sibling period UNCONDITIONALLY — it decides a control now", () => {
    // THIS ASSERTION WAS INVERTED, DELIBERATELY. It used to require
    // `if (hasRows) return;` on the rationale "a populated panel must not fire
    // a second read", which was right when the probe's only job was turning an
    // empty panel into a pointer at the data.
    //
    // The job grew: the Quarterly TAB is hidden until a quarterly row is
    // OBSERVED, and `periodsWithData.QUARTERLY` can only be observed by asking.
    // Under the old guard, any symbol that HAS annual rows — the normal case —
    // never probed, so the tab rendered, clicking it landed on the empty table
    // the change existed to remove, and the tab then vanished while still
    // selected.
    //
    // The cost is one extra read per mount against a cached action. That is
    // the price of a control that does not lie about what is behind it.
    assert.doesNotMatch(
      TAB,
      /if \(hasRows\) return;/,
      "the early return is back — the Quarterly tab will render for every " +
        "symbol that has annual rows, which is all of them"
    );
    // And the probe must still EXIST. Deleting it outright would satisfy the
    // assertion above while making the tab permanently invisible.
    assert.match(TAB, /const other: PeriodType/);
    assert.match(
      TAB,
      /getStockFinancialsAction\(\{[\s\S]{0,120}periodType: other/
    );
  });

  it("the probe's result is what the tab reads — not a separate source", () => {
    // Anti-vacuity for the pair above: a probe whose result nothing consumes
    // would pass both and hide nothing.
    assert.match(TAB, /periodsWithData\.QUARTERLY !== false/);
  });

  it("styles the switch with tokens, not literal colours", () => {
    const block = CSS.slice(
      CSS.indexOf(".fin-empty-switch"),
      CSS.indexOf("/* ── Section card")
    );
    assert.match(block, /var\(--/, "must use theme tokens");
    assert.doesNotMatch(
      block,
      /#[0-9a-fA-F]{3,8}\b|\brgb\(|\bhsl\(/,
      "no hardcoded colours — the panel is theme-aware"
    );
  });
});
