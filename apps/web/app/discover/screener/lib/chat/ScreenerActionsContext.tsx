"use client";

import { createContext, useContext } from "react";
import type { ScreenerMode } from "@/components/screener/ModeTabs";
import type { ScreenerChatActions } from "./actions";
import type { ScreenerSnapshot } from "./systemPrompt";

/* =====================================================================
   ScreenerActionsContext  (MONEY-1078)
   ---------------------------------------------------------------------
   Bridges the screener page's local `useState` to the Ask Screener chat,
   mirroring FireActionsContext. `client.tsx` builds a stable bridge
   (mutators + live snapshot/mode getters) and provides it here;
   `AskScreenerPanel` consumes it via `useScreenerChat()` and hands the
   actions to the tool executor.
   ===================================================================== */

export interface ScreenerChatBridge {
  /** Mutations the chat can perform on the screener. */
  actions: ScreenerChatActions;
  /** Latest serialisable screener snapshot (for the system prompt). */
  getSnapshot: () => ScreenerSnapshot;
  /** Synchronous active-mode read — stays correct mid-batch (the ref
      behind it is updated inside `switchMode`, before React flushes). */
  getActiveMode: () => ScreenerMode;
  /** True while the active mode's results are refetching. The chat loop
      waits on this before snapshotting, so a follow-up hop never reports
      the PREVIOUS result count alongside the NEW filters. */
  isFetching: () => boolean;
  /** Settle counter — see ScreenerLive.fetchGeneration. */
  fetchGeneration: () => number;
}

const ScreenerChatContext = createContext<ScreenerChatBridge | null>(null);

export function ScreenerActionsProvider({
  value,
  children,
}: {
  value: ScreenerChatBridge;
  children: React.ReactNode;
}) {
  return (
    <ScreenerChatContext.Provider value={value}>
      {children}
    </ScreenerChatContext.Provider>
  );
}

/**
 * Access the screener chat bridge. Returns `null` when rendered outside
 * a provider so the chat can degrade gracefully rather than throw.
 */
export function useScreenerChat(): ScreenerChatBridge | null {
  return useContext(ScreenerChatContext);
}
