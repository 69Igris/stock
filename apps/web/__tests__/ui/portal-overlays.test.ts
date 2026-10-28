/**
 * Portal-aware outside-click predicate.
 *
 * ## The bug
 *
 * Ask FIRE and Ask Screener dismiss on outside `pointerdown`, testing
 * `panelRef.current.contains(target)`. Radix renders `DropdownMenuContent`
 * inside `DropdownMenuPrimitive.Portal`, which mounts under `document.body` —
 * visually above the panel, but not a descendant of it. So pressing "Rename"
 * in the chat-history row menu counted as a click OUTSIDE, and the panel
 * closed under the menu the user was still using.
 *
 * ## What this file can and cannot check
 *
 * `node:test` has no DOM and this repo has no jsdom, so `Element.closest()`
 * cannot be exercised for real. A hand-rolled fake `closest` would assert that
 * my fake matches selectors, not that the predicate works — a shadow test, and
 * worse than none.
 *
 * So this pins the part that genuinely regresses silently: the SELECTOR LIST.
 * Deleting `[data-radix-popper-content-wrapper]` restores the original bug
 * across every dropdown in both panels with no test failing and no error. The
 * `closest()` call itself is one line, type-checked, and verified in the
 * browser.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  PORTAL_SELECTOR,
  isInsidePortalledOverlay,
} from "../../lib/ui/portal-overlays";

describe("PORTAL_SELECTOR", () => {
  test("[regression] covers the Radix popper wrapper", () => {
    // The single most important entry: it is what a DropdownMenuContent is
    // actually wrapped in, and it is what the chat-history ⋯ menu needs.
    assert.match(PORTAL_SELECTOR, /\[data-radix-popper-content-wrapper\]/);
  });

  test("covers the overlay roles Radix renders", () => {
    // Menus (dropdown), listboxes (select), dialogs and tooltips all portal.
    for (const role of ["menu", "listbox", "dialog", "tooltip"]) {
      assert.ok(
        PORTAL_SELECTOR.includes(`[role="${role}"]`),
        `role="${role}" is portalled and must not read as an outside click`
      );
    }
  });

  test("is a valid comma-separated selector list", () => {
    // A stray trailing comma or empty entry makes `closest()` THROW, which in
    // a pointerdown handler surfaces as the panel simply never closing.
    const parts = PORTAL_SELECTOR.split(",");
    assert.ok(parts.length >= 6);
    for (const p of parts) {
      assert.ok(p.trim().length > 0, "empty selector segment");
      assert.doesNotMatch(p, /^\s*$/);
    }
  });

  test("matches on attributes/roles, not on class names", () => {
    // Radix class names are consumer-supplied and change with restyling; the
    // attributes and roles are part of its rendered contract.
    assert.doesNotMatch(PORTAL_SELECTOR, /\.[a-zA-Z]/);
  });
});

describe("isInsidePortalledOverlay", () => {
  test("null target is not inside anything", () => {
    // The handler calls this with `e.target as Node | null`; a null must not
    // suppress the dismiss, or the panel would stop closing entirely.
    assert.equal(isInsidePortalledOverlay(null), false);
  });
});
