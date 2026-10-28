"use client";

import { RefObject, useEffect, useState } from "react";

export interface PopoverAnchorRect {
  /** viewport y of the anchor's bottom edge (where a below-popover starts) */
  top: number;
  /** viewport x of the anchor's left edge */
  left: number;
  /** anchor width — so a menu can match its trigger */
  width: number;
}

/**
 * Tracks an anchor element's viewport rect while `open` is true, so a popover
 * rendered into a portal (document.body, position:fixed) can sit flush to its
 * trigger AND follow it when any ancestor scrolls or the window resizes.
 *
 * Why this exists: a popover positioned `absolute` inside an `overflow:auto`
 * container (e.g. a scrollable modal body) gets geometrically clipped by that
 * container. Portaling to the body escapes the clip, but then the popover no
 * longer moves with its trigger — this hook re-measures on scroll/resize to
 * keep them aligned. The `true` (capture) flag on the scroll listener is the
 * key: it catches scrolling inside nested overflow containers, not just the
 * window, which is exactly the modal-scroll case.
 */
export function usePopoverAnchor(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean
): PopoverAnchorRect | null {
  const [rect, setRect] = useState<PopoverAnchorRect | null>(null);

  useEffect(() => {
    if (!open) {
      setRect(null);
      return;
    }
    const el = anchorRef.current;
    if (!el) return;

    const measure = () => {
      const r = el.getBoundingClientRect();
      setRect({ top: r.bottom, left: r.left, width: r.width });
    };
    measure();

    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, anchorRef]);

  return rect;
}
