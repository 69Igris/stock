/**
 * "Reset all" in the composer's Research-preferences popover.
 *
 * The button shipped with NO onClick at all — it rendered as a live control
 * and did nothing when clicked, the same defect class as MONEY-1167's
 * "Upload document" button. Wiring it introduced a second, quieter hazard
 * that these cases exist to pin.
 *
 * `setComposerPreferences` merges SHALLOWLY per namespace
 * (`{...current.sources, ...patch.sources}`), so writing the whole
 * DEFAULT_SOURCE_PREFERENCES would also write `webSearchUsedThisMonth: 0` and
 * `webSearchCap: 200`. Neither is a preference: the first is a usage meter,
 * the second the plan's quota. A whole-namespace reset would therefore refill
 * the user's web-search allowance on every click — an unlimited free-quota
 * button — and stamp a raised cap back down to the default.
 *
 * `buildComposerResetPatch` is the REAL exported helper the server action
 * calls, so these assert the shipped payload rather than a re-implementation
 * of it. The merge below mirrors the one in `setComposerPreferences`; the
 * round-trip case exists so the carve-out is proven against merge semantics,
 * not just against the patch's shape.
 *
 * Source: packages/services/src/preferences/composer-preferences.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildComposerResetPatch,
  sourcePreferencesSchema,
  DEFAULT_CONNECTOR_PREFERENCES,
  DEFAULT_TOOLS_PREFERENCES,
  DEFAULT_INSTRUMENT_BASKET,
  DEFAULT_SOURCE_PREFERENCES,
  type SourcePreferences,
} from "../src/preferences/composer-preferences";

describe("composer reset patch - the namespaces it clears", () => {
  it("resets connectors, tools and pinned instruments to their defaults", () => {
    const patch = buildComposerResetPatch();

    assert.deepEqual(patch.connectors, DEFAULT_CONNECTOR_PREFERENCES);
    assert.deepEqual(patch.tools, DEFAULT_TOOLS_PREFERENCES);
    assert.deepEqual(patch.pinnedInstruments, DEFAULT_INSTRUMENT_BASKET);
  });

  it("clears the two source fields that ARE preferences", () => {
    const patch = buildComposerResetPatch();

    assert.equal(patch.sources.webSearch, DEFAULT_SOURCE_PREFERENCES.webSearch);
    assert.deepEqual(
      patch.sources.activeDocumentIds,
      DEFAULT_SOURCE_PREFERENCES.activeDocumentIds,
    );
  });

  it("omits recentInstruments, model and thinking so the merge leaves them alone", () => {
    const patch = buildComposerResetPatch();

    // A namespace absent from the patch is untouched by setComposerPreferences.
    assert.equal("recentInstruments" in patch, false);
    assert.equal("model" in patch, false);
    assert.equal("thinking" in patch, false);
  });
});

describe("composer reset patch - the web-search meter must survive", () => {
  it("[regression] carries NO usage meter and NO cap", () => {
    const patch = buildComposerResetPatch();

    // The whole point. If either key reappears here, Reset all becomes a
    // free-quota refill button.
    assert.equal("webSearchUsedThisMonth" in patch.sources, false);
    assert.equal("webSearchCap" in patch.sources, false);
  });

  it("[regression] merged over a used allowance, usage and cap are preserved", () => {
    // A user partway through the month, on a raised cap, with the popover
    // fully configured.
    const current: SourcePreferences = {
      webSearch: true,
      webSearchUsedThisMonth: 57,
      webSearchCap: 1000,
      activeDocumentIds: ["12", "34"],
    };

    // Mirrors setComposerPreferences' per-namespace merge exactly.
    const merged = sourcePreferencesSchema.parse({
      ...current,
      ...buildComposerResetPatch().sources,
    });

    // Preferences cleared...
    assert.equal(merged.webSearch, false);
    assert.deepEqual(merged.activeDocumentIds, []);

    // ...meter and quota untouched.
    assert.equal(merged.webSearchUsedThisMonth, 57);
    assert.equal(merged.webSearchCap, 1000);
  });

  it("[regression] repeated resets never refill the allowance", () => {
    let sources: SourcePreferences = {
      webSearch: true,
      webSearchUsedThisMonth: 199,
      webSearchCap: 200,
      activeDocumentIds: ["7"],
    };

    // The abuse shape: spam the button hoping the meter rolls back.
    for (let i = 0; i < 5; i++) {
      sources = sourcePreferencesSchema.parse({
        ...sources,
        ...buildComposerResetPatch().sources,
      });
    }

    assert.equal(sources.webSearchUsedThisMonth, 199);
    assert.equal(sources.webSearchCap, 200);
  });

  it("a whole-namespace reset WOULD have zeroed the meter (documents the trap)", () => {
    const current: SourcePreferences = {
      webSearch: true,
      webSearchUsedThisMonth: 57,
      webSearchCap: 1000,
      activeDocumentIds: ["12"],
    };

    // Not what ships — this is the tempting one-liner the patch avoids.
    const naive = sourcePreferencesSchema.parse({
      ...current,
      ...DEFAULT_SOURCE_PREFERENCES,
    });

    assert.equal(naive.webSearchUsedThisMonth, 0);
    assert.equal(naive.webSearchCap, 200);
  });
});
