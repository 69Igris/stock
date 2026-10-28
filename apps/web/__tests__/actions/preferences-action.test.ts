/**
 * MONEY-393 §17 - `lib/actions/preferences.ts` shape + auth gating.
 *
 * The action file is a thin wrapper around `@usemoney/services/preferences`
 * - it (1) authenticates the caller, (2) forwards to the service, and
 * (3) shapes the response into a discriminated union. We assert:
 *
 *   - Every exported action exists with the right name + Promise return.
 *   - Source guards: every action calls `getAuthenticatedUser()` and
 *     returns `{ success: false, error: "Unauthorized" }` on null.
 *   - The composer setter forwards a partial patch (won't clobber
 *     siblings).
 *   - Re-exported types are listed at the top.
 *
 * The per-action guard counts are DERIVED from the exported-action count
 * rather than hardcoded. They were literal 4s, so adding a fifth action
 * (`resetMyComposerPreferencesAction`) failed them on arithmetic even though
 * it carried all three guards. A derived count keeps asserting the real
 * invariant — one auth check, one Unauthorized branch and one sanitized error
 * per action — at any number of actions, so the next one added is still
 * genuinely checked instead of just bumping the constant again. The action
 * NAMES stay listed explicitly, because a derived count alone would not
 * notice a rename or a swap.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-text guards only - importing the real action would pull
// React's `cache()` through `@/lib/auth`, which doesn't work outside
// a Next.js runtime. The source-text checks below are equivalent for
// the contracts we care about (auth gating, sanitized errors,
// discriminated-union return shape, type re-exports).
const SRC = readFileSync(
  join(__dirname, "..", "..", "lib", "actions", "preferences.ts"),
  "utf8"
);

// Every `export async function …Action` in the file. The guard counts below
// are measured against this, so they track the file instead of a constant.
const ACTION_NAMES =
  SRC.match(/export\s+async\s+function\s+(\w+Action)\b/g)?.map((m) =>
    m.replace(/.*\s/, "")
  ) ?? [];
const ACTION_COUNT = ACTION_NAMES.length;

describe("MONEY-393 §17 - lib/actions/preferences.ts shape", () => {
  it("[exports] the documented server actions are declared", () => {
    // Named explicitly so a RENAME or deletion still fails loudly — the
    // derived count alone would not notice a swap.
    for (const name of [
      "getMyResearchPreferencesAction",
      "setMyResearchPreferencesAction",
      "getMyComposerPreferencesAction",
      "setMyComposerPreferencesAction",
      "resetMyComposerPreferencesAction",
    ]) {
      assert.ok(
        ACTION_NAMES.includes(name),
        `expected ${name} to be an exported server action; found ${ACTION_NAMES.join(", ")}`
      );
    }
  });

  it("[src] file is marked 'use server' (Next.js server action requirement)", () => {
    assert.match(SRC, /^"use server"/m);
  });

  it("[src] every action calls getAuthenticatedUser() before touching the service", () => {
    // One auth check per action — count derived, not hardcoded.
    const occurrences = SRC.match(/await\s+getAuthenticatedUser\(\)/g) ?? [];
    assert.equal(
      occurrences.length,
      ACTION_COUNT,
      `expected ${ACTION_COUNT} getAuthenticatedUser() calls (one per action), got ${occurrences.length}`
    );
  });

  it("[src] every action returns Unauthorized when authUser is null", () => {
    // One auth-fail branch per action.
    const occurrences = SRC.match(/error:\s*"Unauthorized"/g) ?? [];
    assert.equal(
      occurrences.length,
      ACTION_COUNT,
      `expected ${ACTION_COUNT} Unauthorized branches (one per action), got ${occurrences.length}`
    );
  });

  it("[src] research setter passes a Partial<ResearchPreferencesInput>", () => {
    assert.match(
      SRC,
      /setMyResearchPreferencesAction\([\s\S]{0,200}Partial<ResearchPreferencesInput>/,
      "research setter must accept a Partial input so the popover can toggle one field"
    );
  });

  it("[src] composer setter accepts a partial patch (each namespace optional)", () => {
    // The patch type is `Partial<{ connectors, sources, tools,
    // pinnedInstruments, recentInstruments, model }>` so callers can
    // update one namespace without clobbering the others.
    assert.match(
      SRC,
      /setMyComposerPreferencesAction\([\s\S]{0,200}Partial<\{/
    );
    assert.match(SRC, /connectors\?\s*:|connectors:\s*Partial</);
    assert.match(SRC, /sources\?\s*:|sources:\s*Partial</);
    assert.match(SRC, /tools\?\s*:|tools:\s*Partial</);
    assert.match(SRC, /pinnedInstruments\?\s*:|pinnedInstruments:\s*Partial</);
    assert.match(SRC, /recentInstruments\?\s*:|recentInstruments:\s*Partial</);
    assert.match(SRC, /model:\s*string\s*\|\s*null/);
  });

  it("[src] re-exports the typed shape from @usemoney/services/preferences", () => {
    assert.match(
      SRC,
      /export\s+type\s+\{[\s\S]{0,400}\}\s+from\s+["']@usemoney\/services\/preferences["']/
    );
    // Specific types that consumers depend on.
    assert.match(SRC, /ResearchPreferences\b/);
    assert.match(SRC, /ResearchPreferencesInput\b/);
    assert.match(SRC, /ComposerPreferences\b/);
    assert.match(SRC, /ConnectorPreferences\b/);
    assert.match(SRC, /SourcePreferences\b/);
    assert.match(SRC, /ToolsPreferences\b/);
    assert.match(SRC, /InstrumentBasket\b/);
  });

  it("[src] errors are sanitized to a string before returning", () => {
    // One catch per action, each wrapping Error.message. Important: no raw
    // stack traces or Prisma error codes leak to the client.
    const occurrences =
      SRC.match(/error\s+instanceof\s+Error\s*\?\s*error\.message\s*:/g) ?? [];
    assert.equal(
      occurrences.length,
      ACTION_COUNT,
      `expected ${ACTION_COUNT} sanitized-error branches, got ${occurrences.length}`
    );
  });

  it("[src] discriminated union - every return is { success, ... }", () => {
    // The `success: true` path returns `data`; the `success: false`
    // path returns `error`. This shape lets the client narrow safely.
    assert.ok(SRC.includes("success: true, data:"));
    assert.ok(SRC.includes("success: false, error:"));
  });
});
