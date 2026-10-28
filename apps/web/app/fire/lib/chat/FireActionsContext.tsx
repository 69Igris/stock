"use client";

import { createContext, useContext } from "react";
import type { FireChatActions } from "./actions";
import type { FireSnapshot } from "./systemPrompt";

/* =====================================================================
   FireActionsContext  (MONEY-1049)
   ---------------------------------------------------------------------
   Bridges the FIRE page's local `useState` to the Ask FIRE chat.
   `client.tsx` builds a stable bridge (mutators + a live snapshot
   getter) and provides it here; `AskFirePanel` consumes it via
   `useFireChat()` and hands the actions to the tool executor.

   This keeps the page's existing state management intact (no store
   refactor) while giving the chat a single, typed surface.
   ===================================================================== */

export interface FireChatBridge {
  /** Mutations the chat can perform on the plan. */
  actions: FireChatActions;
  /** Latest serialisable plan snapshot (for the system prompt). */
  getSnapshot: () => FireSnapshot;
  /**
   * Deterministic 100% guarantee: after a chat turn changes allocations,
   * adjust the untouched assets so the mix totals exactly 100%.
   * `preserveNames` are the assets the assistant set explicitly this turn.
   */
  rebalanceAllocations: (preserveNames: string[]) => void;
}

const FireChatContext = createContext<FireChatBridge | null>(null);

export function FireActionsProvider({
  value,
  children,
}: {
  value: FireChatBridge;
  children: React.ReactNode;
}) {
  return (
    <FireChatContext.Provider value={value}>
      {children}
    </FireChatContext.Provider>
  );
}

/**
 * Access the FIRE chat bridge. Returns `null` when rendered outside a
 * provider so the chat can degrade gracefully rather than throw.
 */
export function useFireChat(): FireChatBridge | null {
  return useContext(FireChatContext);
}
