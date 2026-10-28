/* =====================================================================
   Screener chat — actions contract  (MONEY-1078)
   ---------------------------------------------------------------------
   The set of mutations the Ask Screener chat can perform on the screener
   page, mirroring the FIRE chat's actions seam (fire/lib/chat/actions.ts).

   The screener page (`client.tsx`) implements this interface from its own
   `useState` setters and provides it through `ScreenerActionsContext`.
   The tool executor (`toolExecutor.ts`) is handed an implementation and
   never touches React state directly — so the same executor is
   unit-testable against a plain mock object.

   Chat-driven `switchMode` deliberately does NOT clear the search query
   (unlike a manual tab click): the model may set a query and filters in
   the same batched turn, and the tab-click heuristic would silently eat
   the query depending on call order.
   ===================================================================== */

import type { ScreenerMode } from "@/components/screener/ModeTabs";

export interface ScreenerChatActions {
  /** Switch the active tab. Does NOT clear the search query (see above). */
  switchMode(mode: ScreenerMode): void;
  /** Merge already-validated filter values into the given mode's state. */
  mergeFilters(mode: ScreenerMode, filters: Record<string, unknown>): void;
  /** Unset specific filter keys on the given mode. */
  unsetFilters(mode: ScreenerMode, keys: string[]): void;
  /** Reset the given mode's filters to none. */
  clearFilters(mode: ScreenerMode): void;
  /** Set the search query ("" clears it). */
  setQuery(query: string): void;
  /** Set the given mode's sort key (already validated per mode). */
  setSort(mode: ScreenerMode, sort: string): void;
}

/** Result of executing a single tool call. */
export type ToolResult =
  | { ok: true; message: string }
  | { ok: false; error: string };
