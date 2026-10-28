/**
 * MONEY-1274 / MONEY-1155 #31 — "UI needs to be fixed".
 *
 * ## What the screenshot actually showed
 *
 * The StockSage panel on an analysis page (M&M) with ONE exchange in it: the
 * question "explain data from fetched earnings - what it means" and a
 * "thinking..." pill, both pinned to the bottom of the card, under roughly 60%
 * empty space.
 *
 * ## Cause
 *
 * `ChatMessageList` wrapped its messages in
 *
 *     min-h-full flex flex-col justify-end
 *
 * `min-h-full` forced the inner column to at least the scroller's height, and
 * `justify-end` pushed its children to the BOTTOM of that. So a conversation
 * too short to fill the panel got shoved down against the composer, with the
 * space above it blank.
 *
 * ## Why removing it is safe
 *
 * The bottom-pinning was redundant. The component already drives
 * `scrollTop = scrollHeight` in an effect on `[messages, isLoading]`, guarded by
 * a near-bottom check so a user who scrolled up is not yanked back. That effect
 * handles the case bottom-pinning exists for — content OVERFLOWING — while the
 * CSS only changed behaviour in the case where there was too little content for
 * it to matter, which is precisely where it looked broken.
 *
 * These are structural assertions: the classes are the behaviour here, and
 * there is no DOM in this runner to measure layout with. The real confirmation
 * is visual and is called out as such on the PR.
 *
 * Source under test: apps/web/components/chat/ChatMessageList.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(process.cwd(), "components/chat/ChatMessageList.tsx"),
  "utf8"
);

/** Comments stripped: the file now EXPLAINS the old classes in prose, and
 *  matching that explanation would fail a corrected file. */
const CODE = SRC.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

describe("ChatMessageList — messages flow from the top", () => {
  it("[regression] the message column is not bottom-justified", () => {
    // THE BUG: `justify-end` on the message column is what emptied the panel.
    assert.doesNotMatch(
      CODE,
      /justify-end/,
      "messages are being pushed to the bottom again"
    );
  });

  it("[regression] the column is not forced to full height", () => {
    // `min-h-full` is the other half — without it, `justify-end` would have had
    // no spare height to push into.
    assert.doesNotMatch(
      CODE,
      /min-h-full/,
      "the message column is stretched to full height again"
    );
  });

  it("the scroller itself still fills its parent and scrolls", () => {
    // The OUTER element must keep h-full + overflow-y-auto. Removing those
    // while fixing the inner column would trade a blank panel for one that
    // cannot scroll — a worse bug wearing the fix's clothes.
    assert.match(CODE, /h-full overflow-y-auto/);
  });

  it("the scroll-to-bottom effect that replaces the CSS still exists", () => {
    // The whole argument for deleting `justify-end` is that this effect covers
    // the overflow case. If it is ever removed, the deletion stops being safe.
    assert.match(CODE, /scrollTop\s*=\s*[\w.]*\.scrollHeight/);
  });

  it("the effect still runs when messages or the loading flag change", () => {
    assert.match(CODE, /\[\s*messages\s*,\s*isLoading\s*\]/);
  });

  it("the near-bottom guard survives, so a scrolled-up reader is not yanked", () => {
    assert.match(CODE, /scrollHeight\s*-\s*[\w.]*\.scrollTop\s*-/);
  });

  it("the empty state is untouched — it centres deliberately", () => {
    // `items-center justify-center` on the NO-MESSAGES branch is correct and
    // must not be caught by the same broom.
    assert.match(CODE, /items-center justify-center/);
  });
});
