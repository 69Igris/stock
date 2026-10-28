/**
 * Is this event target inside a PORTALLED overlay (Radix dropdown, select,
 * popover, tooltip, dialog)?
 *
 * ## The bug this exists for
 *
 * Ask FIRE and Ask Screener both dismiss on outside `pointerdown`:
 *
 *     if (panelRef.current?.contains(target)) return;
 *     setIsOpen(false);
 *
 * That is correct for ordinary DOM. It is wrong for anything Radix renders,
 * because `DropdownMenuContent` is wrapped in `DropdownMenuPrimitive.Portal`
 * and mounts under `document.body` — visually on top of the panel, but NOT a
 * descendant of `panelRef`. So pressing an item in the chat-history row menu
 * counted as a click outside, and the panel closed underneath the menu the
 * user was still using.
 *
 * The symptom is confusing rather than obviously broken: hit "Rename" and the
 * whole chat panel disappears. Reopening it shows the row already in edit mode
 * — the state survived — so it reads as "the rename button closes the chat"
 * rather than "the dismiss handler cannot see portals".
 *
 * ## Why match on attributes rather than keep a ref
 *
 * The portal container is created and destroyed by Radix per open/close, so
 * there is nothing stable to hold a ref to. Radix stamps its popper content
 * with `data-radix-popper-content-wrapper`, and every menu/listbox/dialog it
 * renders carries a landmark `role`. Matching those covers dropdowns, selects,
 * popovers, tooltips and dialogs with one predicate.
 *
 * A target already detached from the document is also treated as "inside": a
 * menu that closed on the same gesture leaves an unrooted node, and closing
 * the panel because of it would be the same bug wearing a different hat.
 */

/**
 * Radix popper wrapper + the roles its overlay surfaces render with.
 *
 * Exported so a test can pin its contents. There is no DOM in `node:test` and
 * no jsdom in this repo, so `closest()` itself cannot be exercised honestly —
 * faking it would only test the fake. What CAN regress without anyone
 * noticing is this list: drop
 * `[data-radix-popper-content-wrapper]` and every dropdown goes back to
 * closing the panel underneath it, with nothing failing.
 */
export const PORTAL_SELECTOR = [
  "[data-radix-popper-content-wrapper]",
  "[data-radix-portal]",
  '[role="menu"]',
  '[role="listbox"]',
  '[role="dialog"]',
  '[role="tooltip"]',
].join(",");

export function isInsidePortalledOverlay(target: Node | null): boolean {
  if (!target) return false;

  const el =
    target.nodeType === Node.ELEMENT_NODE
      ? (target as Element)
      : target.parentElement;
  if (!el) return false;

  // Detached: whatever it belonged to has already been torn down this tick.
  if (!el.isConnected) return true;

  return el.closest(PORTAL_SELECTOR) !== null;
}
