/**
 * Roast - pickVerdictLine tests
 *
 * De-shadowed: imports the REAL pickVerdictLine from
 * components/roast/roast-detail-logic.ts — the same function RoastResults.tsx
 * renders into "THE VERDICT" hero. It prefers the first burn highlight, falls
 * back to the first praise, then to synthetic copy + a 280-char narrative
 * excerpt so the hero always renders.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickVerdictLine } from "../../components/roast/roast-detail-logic";

describe("pickVerdictLine", () => {
  it("prefers the first burn over praises", () => {
    const result = {
      roastHighlights: [
        {
          type: "praise" as const,
          emoji: "👍",
          title: "Good IT bag",
          description: "Solid",
        },
        {
          type: "burn" as const,
          emoji: "🔥",
          title: "PAYTM is dragging you",
          description: "Down 31% - cut it",
        },
      ],
    };
    const v = pickVerdictLine(result);
    assert.equal(v.headline, "PAYTM is dragging you");
    assert.equal(v.body, "Down 31% - cut it");
  });

  it("falls back to first praise when no burns exist", () => {
    const result = {
      roastHighlights: [
        {
          type: "praise" as const,
          emoji: "👍",
          title: "Discipline",
          description: "14-month INFY SIP shows commitment",
        },
      ],
    };
    const v = pickVerdictLine(result);
    assert.equal(v.headline, "Discipline");
  });

  it("uses narrative excerpt when no highlights", () => {
    const result = {
      roastHighlights: [],
      roastNarrative:
        "You are a textbook value investor stuck with a single bad bet on PAYTM.",
    };
    const v = pickVerdictLine(result);
    assert.equal(v.headline, "Your portfolio · the unfiltered take");
    assert.match(v.body, /textbook value investor/);
  });

  it("uses default body when narrative also missing", () => {
    const v = pickVerdictLine({ roastHighlights: [] });
    assert.equal(v.headline, "Your portfolio · the unfiltered take");
    assert.equal(v.body, "AI critique below. Skim-safe, sugar-free.");
  });

  it("truncates very long narrative to 280 chars", () => {
    const long = "x".repeat(500);
    const v = pickVerdictLine({ roastHighlights: [], roastNarrative: long });
    assert.equal(v.body.length, 280);
  });

  it("returns first burn even when many burns exist", () => {
    const result = {
      roastHighlights: [
        {
          type: "burn" as const,
          emoji: "🔥",
          title: "First burn",
          description: "a",
        },
        {
          type: "burn" as const,
          emoji: "🔥",
          title: "Second burn",
          description: "b",
        },
      ],
    };
    assert.equal(pickVerdictLine(result).headline, "First burn");
  });
});
