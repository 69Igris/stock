"use client";

/**
 * Citation hover/scroll-sync store (MONEY-490 / MONEY-673, P3).
 *
 * The StockSage v2 design syncs inline `[n]` citation marks in an answer/report
 * with the right-hand Sources rail: hover a mark → highlight its source row;
 * click → scroll the rail to it. The mark and the rail live in different React
 * subtrees, so instead of a Context provider (which would force a common
 * ancestor wrap of the chat surface) we use a tiny module-level store via
 * `useSyncExternalStore`. One hot citation at a time — exactly the scope of an
 * ephemeral hover highlight.
 */

import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";

interface CitationState {
  hot: number | null;
  /** Bumped only on an explicit click, to trigger a one-shot scroll in the rail. */
  scrollKey: number;
}

let state: CitationState = { hot: null, scrollKey: 0 };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
function getSnapshot(): CitationState {
  return state;
}

/** Set (or clear) the hot citation. `scroll` bumps scrollKey for a click-scroll. */
export function setHotCitation(n: number | null, scroll = false): void {
  if (state.hot === n && !scroll) return;
  state = {
    hot: n,
    scrollKey: scroll && n != null ? state.scrollKey + 1 : state.scrollKey,
  };
  emit();
}

export function useCitationState(): CitationState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Inline `[n]` citation chip used in answers/reports. Hover → highlight the
 * matching Sources-rail row; click → scroll the rail to it. Uses the `.cite`
 * design class (scoped in ssx.css / chat-blocks.css).
 */
export function CitationMark({
  n,
  children,
}: {
  n: number;
  children?: ReactNode;
}) {
  const { hot } = useCitationState();
  return (
    <sup
      className={"cite" + (hot === n ? " hot" : "")}
      style={{ cursor: "pointer" }}
      onMouseEnter={() => setHotCitation(n)}
      onMouseLeave={() => setHotCitation(null)}
      onClick={(e) => {
        e.preventDefault();
        setHotCitation(n, true);
      }}
      aria-label={`Source ${n}`}
    >
      {children ?? n}
    </sup>
  );
}
