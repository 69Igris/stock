/**
 * DelayedDataNote must not promise real-time data — MONEY-1259.
 *
 * ## What this replaces, and why the old test could not have caught it
 *
 * This file used to assert `shouldShowDelayedNote(status, isLoading)`: hide
 * while loading, hide for an "active" broker, show otherwise. Every case
 * passed, and the behaviour it locked in was wrong — the test encoded the
 * component's premise rather than checking it against the product.
 *
 * That premise was "active-broker users receive real-time data under their own
 * access token". MONEY-837 ended it: portfolio sync runs on the FREE Zerodha
 * Personal app, which has no live quotes, charts or WebSockets, and the paid
 * Connect app is founder-only and dormant. Market data in apps/web is Yahoo —
 * exchange-delayed — for EVERY user.
 *
 * So the component was wrong in two opposite directions at once. It showed a
 * `connect a broker for real-time` CTA that pointed users at /brokers on a
 * false pretext, and it HID the delayed-data disclaimer from active-broker
 * users, who get the same delayed feed — suppressing a compliance disclosure
 * from exactly the people most likely to assume prices were live.
 *
 * ## Why this is a SOURCE guard
 *
 * The claim worth defending is "no chart tells a user that connecting a broker
 * gets them real-time data". That is a property of the rendered output, and the
 * repo's runner is `node:test` with no DOM — so asserting on the component
 * source is what can actually be checked here, rather than a render assertion
 * that would need a renderer this suite does not have.
 *
 * It is checked at BOTH ends: the component must not contain the CTA, and the
 * single mount point must not pass a prop that could bring it back.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const NOTE = join("components", "market", "DelayedDataNote.tsx");
const MOUNT = join("components", "charts", "TradingViewAdvancedChart.tsx");

const noteSrc = readFileSync(NOTE, "utf8");
const mountSrc = readFileSync(MOUNT, "utf8");

/** The component body, with the header comment stripped. */
function noteBody(): string {
  const end = noteSrc.indexOf("*/");
  assert.ok(end > 0, "ceiling: DelayedDataNote has no header comment to strip");
  return noteSrc.slice(end + 2);
}

describe("DelayedDataNote makes no real-time promise (MONEY-1259)", () => {
  it("[meta] both files are readable and are the ones we think", () => {
    // Ceiling. Every assertion below is "this string is absent", which a failed
    // read or a moved file would satisfy vacuously — the exact shape of a test
    // that reports green while protecting nothing.
    assert.ok(noteSrc.length > 500, `note read as ${noteSrc.length} chars`);
    assert.ok(mountSrc.length > 5000, `mount read as ${mountSrc.length} chars`);
    assert.match(noteBody(), /export default function DelayedDataNote/);
    assert.match(mountSrc, /<DelayedDataNote/);
  });

  it("still discloses that data is exchange-delayed", () => {
    // The disclosure is the POINT of the component. Deleting the CTA must not
    // quietly delete the disclaimer with it.
    assert.match(
      noteBody(),
      /Exchange-delayed data/,
      "the delayed-data disclosure has gone missing"
    );
  });

  it("does not link to /brokers or promise real-time", () => {
    const body = noteBody();
    assert.doesNotMatch(
      body,
      /\/brokers/,
      "DelayedDataNote links to /brokers. Connecting a broker does NOT get a " +
        "user real-time data — apps/web is Yahoo-only for everyone since " +
        "MONEY-837, so this routes users there on a false pretext."
    );
    assert.doesNotMatch(
      body,
      /real-time/i,
      "DelayedDataNote claims something about real-time data. No runtime " +
        "market-data path in apps/web is real-time (MONEY-837)."
    );
  });

  it("renders unconditionally — no broker-status gate", () => {
    const body = noteBody();
    // The gate hid the disclaimer from active-broker users, who receive the
    // same delayed feed. Hiding a compliance disclosure from them is the more
    // serious half of this defect.
    assert.doesNotMatch(
      body,
      /useBrokerStatus|shouldShowDelayedNote/,
      "DelayedDataNote gates on broker status again. Active-broker users get " +
        "the SAME exchange-delayed Yahoo feed, so gating hides the disclaimer " +
        "from the users most likely to assume prices are live."
    );
    assert.ok(
      !existsSync(join("components", "market", "delayed-data-note-logic.ts")),
      "the gate module is back; the component must not be conditional on broker status"
    );
  });

  it("the mount point cannot re-enable a CTA", () => {
    // `showCta` is gone from the component, so a prop here would not compile —
    // but this fails LOUDLY and by name rather than as a type error in a file
    // nobody is looking at.
    assert.doesNotMatch(
      mountSrc,
      /showCta/,
      "TradingViewAdvancedChart passes showCta; the prop no longer exists"
    );
  });
});
