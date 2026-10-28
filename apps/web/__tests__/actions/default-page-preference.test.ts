/**
 * Post-login landing: chat (StockSage) is the DEFAULT, dashboard is a choice.
 *
 * The preference is opt-in and stored in the `preferences` JSON blob, so almost
 * nobody has one — which makes the unset fallback the real product decision,
 * not the setting. Three properties are pinned here, and the second is the one
 * a careless edit breaks:
 *
 *  1. Unset (or malformed) ⇒ "stocksage".
 *  2. An EXPLICITLY saved "dashboard" still wins. Changing a default must never
 *     override a choice the user actually made.
 *  3. The client's optimistic initial state matches the server default —
 *     otherwise Settings renders the wrong option as selected until `loadPrefs`
 *     resolves, then visibly flips, which reads as the setting changing by
 *     itself.
 *
 * Source-level, matching the convention used elsewhere in this suite: the
 * action is `"use server"` and reaches Prisma + Clerk, so it cannot be imported
 * into a unit test without the whole auth stack.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

const userActionsSrc = read("lib/actions/user.ts");
const launchSrc = read("app/launch/page.tsx");
const prefsTabSrc = read("app/settings/tabs/PreferencesTab.tsx");

/** The `getDefaultPagePreferenceAction` body. */
function actionBody(): string {
  const start = userActionsSrc.indexOf(
    "export async function getDefaultPagePreferenceAction"
  );
  assert.ok(start > -1, "could not locate getDefaultPagePreferenceAction");
  // Up to the next top-level export — enough to cover the resolution.
  const rest = userActionsSrc.slice(start + 1);
  const end = rest.indexOf("\nexport ");
  return end === -1 ? rest : rest.slice(0, end);
}

describe("default page after login", () => {
  it("[regression] resolves to stocksage when nothing is stored", () => {
    const body = actionBody();
    // The ternary's fallback arm is the default.
    assert.match(
      body,
      /\?\s*\(stored as DefaultPage\)\s*:\s*"stocksage"/,
      "an unset preference must resolve to stocksage (chat), not dashboard"
    );
    assert.doesNotMatch(
      body,
      /:\s*"dashboard";/,
      "a `dashboard` fallback is the behaviour this change replaces"
    );
  });

  it("[regression] an explicitly saved preference still wins", () => {
    const body = actionBody();
    // The stored value is returned whenever it validates — the default only
    // applies to the fallback arm. Changing a default must not override a
    // choice the user made deliberately.
    assert.match(
      body,
      /VALID_DEFAULT_PAGES\.includes\(stored as DefaultPage\)/,
      "a stored, valid preference must be returned as-is"
    );
    assert.match(userActionsSrc, /VALID_DEFAULT_PAGES = \[[^\]]*"dashboard"/);
  });

  it("/launch routes an explicit dashboard preference to /dashboard", () => {
    assert.match(
      launchSrc,
      /result\.value === "dashboard"\s*\?\s*"\/dashboard"\s*:\s*"\/stocksage"/,
      "/launch must honour a saved dashboard preference"
    );
  });

  it("/launch does NOT fall back to the default when the read FAILS", () => {
    // An error path should land somewhere resilient, not somewhere typical.
    // The dashboard is a client shell whose own actions retry provisioning,
    // so it recovers from the condition that broke the preference read.
    assert.match(
      launchSrc,
      /redirect\("\/dashboard\?from=launch-pref-error"\)/,
      "a failed preference read must land on the recoverable page, tagged"
    );
  });

  it("Settings' optimistic initial value matches the server default", () => {
    // A mismatch makes the toggle flip on its own once loadPrefs resolves.
    assert.match(
      prefsTabSrc,
      /useState<"dashboard" \| "stocksage">\(\s*"stocksage"\s*\)/,
      "the Preferences tab must start on the same default the server returns"
    );
  });
});
