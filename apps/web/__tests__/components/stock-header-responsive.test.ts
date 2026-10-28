/**
 * The stock detail header must survive a phone viewport, and its tab strip must
 * never scroll vertically.
 *
 * Both defects were invisible on a desktop dev machine and unmissable at 390px:
 * the header hardcoded 38px/30px/40px type plus a 56px avatar, which wrapped
 * "AARTIIND Aarti Industries Limited" into a four-line tower and pushed every
 * badge onto its own row; and the tab strip declared only `overflowX`, which
 * the CSS Overflow spec resolves by computing the OTHER axis to `auto` too.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLIENT = readFileSync(
  join(__dirname, "..", "..", "app", "stock", "[symbol]", "client.tsx"),
  "utf8"
);

describe("stock header — fluid type", () => {
  it("sizes the ticker heading with clamp(), not a fixed px", () => {
    // Anchored on `<h1`, not on surrounding whitespace: an earlier version
    // matched an indentation-sensitive needle and broke the moment prettier
    // reflowed the element after it was lifted out of the badge row.
    const h1At = CLIENT.indexOf("<h1");
    assert.ok(h1At > 0, "h1 not found");
    const block = CLIENT.slice(h1At, CLIENT.indexOf("</h1>", h1At));
    assert.match(block, /fontSize: "clamp\(/, "h1 must be fluid");
    assert.doesNotMatch(
      block.replace(/\/\/[^\n]*/g, ""),
      /fontSize: 38\b/,
      "38px cannot fit a 390px viewport"
    );
  });

  it("sizes the company name with clamp()", () => {
    assert.match(
      CLIENT,
      /fontSize: "clamp\(16px, [\d.]+vw, 30px\)"/,
      "company-name span must be fluid"
    );
  });

  it("sizes the LTP with clamp()", () => {
    assert.match(
      CLIENT,
      /fontSize: "clamp\(26px, [\d.]+vw, 40px\)"/,
      "price must be fluid"
    );
  });

  it("sizes the avatar square with clamp()", () => {
    assert.match(CLIENT, /width: "clamp\(40px, [\d.]+vw, 56px\)"/);
    assert.match(CLIENT, /height: "clamp\(40px, [\d.]+vw, 56px\)"/);
  });

  it("every clamp keeps the original desktop size as its MAX", () => {
    // A clamp that lowered the ceiling would "fix" mobile by shrinking desktop.
    for (const max of ["38px", "30px", "40px", "56px"]) {
      assert.ok(
        CLIENT.includes(`, ${max})"`),
        `no clamp tops out at the original ${max}`
      );
    }
  });

  it("wraps a long ticker WITHOUT collapsing its min-content width", () => {
    // `anywhere` also sets min-content to one character, which let the h1
    // shrink to ~60px so the price could share the row — "AARTIIND" rendered
    // as "AAR/TIIN/D". `break-word` breaks only when the word cannot fit.
    assert.match(CLIENT, /overflowWrap: "break-word"/);
    assert.doesNotMatch(
      CLIENT,
      /overflowWrap: "anywhere"/,
      "`anywhere` collapses the flex item's min-content width"
    );
  });

  it("gives the identity block a width floor so the price wraps instead", () => {
    // No media query needed: min(100%, 300px) is a 300px floor on desktop and
    // resolves to 100% on a phone, which forces the price onto its own line.
    assert.match(CLIENT, /minWidth: "min\(100%, 300px\)"/);
  });
});

describe("stock header — layout integrity", () => {
  it("does not mix flex properties into a grid container", () => {
    // `flexWrap` on `display: grid` is inert. The hero carried both, so the
    // price column stayed pinned beside the title at every width and the `1fr`
    // column collapsed to ~100px on a phone — which is what stacked every
    // badge onto its own line.
    const at = CLIENT.indexOf("Hero header");
    assert.ok(at > 0, "hero header not found");
    // Comments stripped first: the fix's own comment NAMES the property it
    // removed, and an earlier version of this assertion failed against the
    // fixed file for exactly that reason. LINE comments before BLOCK comments
    // (MONEY-1143) — a `//` containing `/*` otherwise opens a phantom block.
    const hero = CLIENT.slice(at, at + 1600)
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(hero, /display: "flex"/, "hero must be a flex row");
    assert.doesNotMatch(
      hero,
      /gridTemplateColumns/,
      "a rigid 2-column grid cannot wrap the price onto its own line"
    );
    assert.doesNotMatch(
      hero,
      /display: "grid"/,
      "flexWrap is inert on a grid — the two must not be mixed"
    );
  });

  it("renders the company name ONCE, not in the shell title too", () => {
    // The shell title and the hero h1 both rendered `symbol` + `name`, so the
    // company name printed twice on every screen size.
    const at = CLIENT.indexOf("<TerminalLuxeShell");
    assert.ok(at > 0, "shell not found");
    const shell = CLIENT.slice(at, CLIENT.indexOf("breadcrumb={crumb}", at));
    assert.doesNotMatch(
      shell,
      /\{name\}/,
      "shell title must not repeat the company name — the hero h1 has it"
    );
    assert.match(shell, /title=\{symbol\}/);
  });
});

describe("stock header — badge row and alignment", () => {
  it("keeps the h1 OUT of the badge flex row", () => {
    // With the h1 as the first flex item, a wide viewport ran the title and all
    // six pills together on one line, and a narrow one gave each pill a row.
    const at = CLIENT.indexOf("The h1 sits OUTSIDE the badge row");
    assert.ok(at > 0, "h1 must be lifted out of the badge row");
    const h1At = CLIENT.indexOf("<h1", at);
    const closeAt = CLIENT.indexOf("</h1>", h1At);
    const badgeRowAt = CLIENT.indexOf('className="pf-pill emerald"', closeAt);
    assert.ok(
      badgeRowAt > closeAt,
      "the first pill must come AFTER the h1 closes"
    );
    // …and inside its own flex container, not loose in the parent.
    const between = CLIENT.slice(closeAt, badgeRowAt);
    assert.match(between, /display: "flex"/, "badges need their own row");
    assert.match(between, /flexWrap: "wrap"/);
  });

  it("top-aligns the avatar with the title, not the stack's midpoint", () => {
    const at = CLIENT.indexOf("The avatar aligns to the TITLE");
    assert.ok(at > 0, "identity block must be top-aligned");
    const block = CLIENT.slice(at - 200, at + 400);
    assert.match(block, /alignItems: "flex-start"/);
    assert.doesNotMatch(
      block.replace(/\/\/[^\n]*/g, ""),
      /alignItems: "center"/,
      "centre-aligning drifts the avatar down beside the badge rows"
    );
  });
});

describe("stock header — tab strip overflow", () => {
  it("pins BOTH axes on the tablist", () => {
    const at = CLIENT.indexOf('role="tablist"');
    assert.ok(at > 0, "tablist not found");
    const block = CLIENT.slice(at, at + 1200);
    assert.match(block, /overflowX: "auto"/, "must scroll horizontally");
    assert.match(
      block,
      /overflowY: "hidden"/,
      "a tab strip must never scroll vertically — declaring only overflowX " +
        "makes the browser compute overflow-y: auto"
    );
  });
});
