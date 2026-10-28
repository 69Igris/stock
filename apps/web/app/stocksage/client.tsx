"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { ChatProvider, useChatContext } from "@/lib/chat/ChatContext";
import ChatPromptArea from "@/components/chat/ChatPromptArea";
import ChatMessageList from "@/components/chat/ChatMessageList";
import ChatHistorySidebar from "@/components/chat/ChatHistorySidebar";
import FollowUpChips from "@/components/chat/FollowUpChips";
import CitationsRail, {
  hasCitations,
  deriveCitations,
} from "@/components/chat/CitationsRail";
import { Button } from "@usemoney/ui/button";
import { PanelLeftOpen, History, Plus, Link2 } from "lucide-react";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import "./stocksage-shell.css";
import { StockSageIcon } from "@/components/chat/StockSageIcon";
import { getDashboardStatsAction } from "@/lib/actions/dashboard";
import { useIDBCache } from "@/hooks/useIDBCache";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";
import type { DashboardStats } from "@usemoney/types";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@usemoney/ui/tooltip";
import { AppShell, useAppAuthGuard } from "@/components/app/AppShell";

// ---------------------------------------------------------------------------
// StockSageChat - the chat UI (consumes ChatContext). Chat always lives at the
// /stocksage route, so navigation (new chat / open past chat / delete) targets
// /stocksage and never bounces to the dashboard overview.
// ---------------------------------------------------------------------------
function StockSageChat() {
  const { user } = useUser();
  const {
    setDashboardStats,
    messages,
    clearChat,
    compactChat,
    currentChatId,
    contextUsage,
    citationMsgId,
    setCitationMsgId,
  } = useChatContext();
  const router = useRouter();

  const isDemoInner = useIsDemoMode({ user });

  const [historySidebarOpen, setHistorySidebarOpen] = useState(true);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  // External input from QuickActionChips (fill-only actions)
  const [pendingInput, setPendingInput] = useState("");

  // MONEY-485: citations rail sources the latest assistant turn. The rail
  // self-hides when that turn carries no real provenance (no fake sources).
  const latestAssistantMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") return messages[i];
    }
    return undefined;
  }, [messages]);

  // MONEY-778: the rail shows a *selected* message's sources, not always the
  // latest. `citationMsgId` (set by a per-message "Sources" button) pins a
  // specific analysis; when unset, the rail follows the latest cited turn. This
  // keeps every analysis's sources reachable in a multi-analysis chat.
  const activeCitationMessage = useMemo(() => {
    if (citationMsgId) {
      const pinned = messages.find((m) => m.id === citationMsgId);
      if (pinned) return pinned;
    }
    return latestAssistantMessage;
  }, [citationMsgId, messages, latestAssistantMessage]);

  const showCitationsRail = hasCitations(activeCitationMessage);

  // Total source count for the reopen badge.
  const sourceCount = useMemo(
    () =>
      deriveCitations(activeCitationMessage).reduce(
        (n, g) => n + g.rows.length,
        0
      ),
    [activeCitationMessage]
  );

  // Sources rail is an off-canvas drawer below 1280px and an inline pane at
  // >=1280px. We open it inline on desktop when a cited answer arrives, but
  // keep it parked off-screen on mobile (the reopen FAB shows the badge).
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const lastCitedMsgIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!showCitationsRail) return;
    const id = latestAssistantMessage?.id;
    // Only react when a *new* cited answer lands (avoid re-opening on every
    // streaming tick of the same message).
    if (id === lastCitedMsgIdRef.current) return;
    lastCitedMsgIdRef.current = id;
    // MONEY-778: a genuinely new analysis arrived → drop any pin so the rail
    // follows the latest turn.
    setCitationMsgId(undefined);
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 1280px)").matches
    ) {
      setSourcesOpen(true);
    }
  }, [showCitationsRail, latestAssistantMessage?.id, setCitationMsgId]);

  // MONEY-778: clicking a message's "Sources" button pins that analysis; open
  // the drawer (mobile + desktop) so its sources show immediately.
  useEffect(() => {
    if (citationMsgId) setSourcesOpen(true);
  }, [citationMsgId]);

  // Fetch dashboard stats for chat context (background, no UI rendering)
  const { data: stats } = useIDBCache<DashboardStats>({
    module: "dashboard",
    identifier: "stats",
    fetcher: async () => {
      const result = await getDashboardStatsAction();
      if (result?.success && result?.data)
        return result?.data as DashboardStats;
      throw new Error(result?.error || "Failed to load dashboard data");
    },
    skip: !user && !isDemoInner,
  });

  useEffect(() => {
    if (stats) {
      setDashboardStats(stats);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats]);

  const handleNewChat = useCallback(() => {
    clearChat();
    // Stay on StockSage — never bounce to the dashboard overview on "new chat"
    // or after deleting the active chat.
    router.replace("/stocksage", { scroll: false });
  }, [clearChat, router]);

  const handleSelectChat = useCallback(
    (chatId: string) => {
      router.push(`/stocksage?chatId=${chatId}`, { scroll: false });
      setMobileHistoryOpen(false);
    },
    [router]
  );

  return (
    <TooltipProvider delayDuration={0}>
      <div className="ss-shell flex flex-1 min-h-0 lg:pt-4">
        {/* Chat-history sidebar */}
        <div className="hidden lg:flex">
          {historySidebarOpen ? (
            <ChatHistorySidebar
              currentChatId={currentChatId}
              onNewChat={handleNewChat}
              onSelectChat={handleSelectChat}
              onToggle={() => setHistorySidebarOpen(false)}
            />
          ) : (
            /* Collapsed state: thin bar with + icon */
            <div className="flex flex-col items-center py-3 px-1 border-r border-border bg-[var(--bg-primary)] w-10 shrink-0 gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleNewChat}
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={4}>
                  New Chat
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setHistorySidebarOpen(true)}
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  >
                    <PanelLeftOpen className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={4}>
                  Show history
                </TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>

        {/* Mobile Chat History Drawer - opens below the main navbar */}
        {mobileHistoryOpen && (
          <div
            className="lg:hidden fixed inset-x-0 bottom-0 z-50 flex"
            style={{ top: "var(--mobile-header-h)" }}
          >
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setMobileHistoryOpen(false)}
            />
            <div className="relative z-10 h-full">
              <ChatHistorySidebar
                currentChatId={currentChatId}
                onNewChat={() => {
                  handleNewChat();
                  setMobileHistoryOpen(false);
                }}
                onSelectChat={handleSelectChat}
                onToggle={() => setMobileHistoryOpen(false)}
              />
            </div>
          </div>
        )}

        {/* Main Chat Area */}
        <div className="flex flex-col flex-1 min-h-0 min-w-0">
          <div className="pf-app flex flex-col flex-1 min-h-0">
            {/* Chat header */}
            <div
              className="flex items-center justify-between px-4 lg:px-6 py-3 shrink-0"
              style={{ borderBottom: "2px solid var(--ink)" }}
            >
              <div className="flex items-center gap-2.5">
                {/* Mobile history toggle */}
                <button
                  type="button"
                  onClick={() => setMobileHistoryOpen(true)}
                  className="lg:hidden grid place-items-center"
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 7,
                    border: "1.5px solid var(--ink)",
                    background: "var(--paper)",
                    color: "var(--ink)",
                  }}
                  aria-label="Show chat history"
                >
                  <History className="h-4 w-4" />
                </button>
                <StockSageIcon size={28} variant="sparkle" />
                <div className="leading-tight">
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 800,
                      color: "var(--ink)",
                      letterSpacing: "-0.3px",
                    }}
                  >
                    StockSage
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: 10,
                      color: "var(--ink-3)",
                      letterSpacing: "0.5px",
                    }}
                  >
                    AI research assistant
                  </div>
                </div>
              </div>
              {/* MONEY-778: design's top-right control cluster — a sources-count
                  pill (toggles the rail) + theme toggle, alongside New chat. */}
              <div className="flex items-center gap-2">
                {showCitationsRail && sourceCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setSourcesOpen((v) => !v)}
                    className="pf-bf sm"
                    aria-label="Toggle sources"
                    title="Sources"
                  >
                    <Link2 className="h-3.5 w-3.5" />
                    {sourceCount}
                  </button>
                )}
                <AnimatedThemeToggler
                  iconSize="h-[15px] w-[15px]"
                  className="pf-bf sm"
                />
                <button
                  type="button"
                  onClick={handleNewChat}
                  className="pf-bf sm"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New chat
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <ChatMessageList />
            </div>

            {/* Follow-up chips */}
            <div className="px-4 lg:px-6 shrink-0">
              <FollowUpChips />
            </div>

            {/* Context budget warning */}
            {contextUsage >= 0.8 && (
              <div
                className="mx-4 lg:mx-6 mb-2 px-3 py-2 rounded-lg shrink-0 max-w-3xl xl:mx-auto"
                style={{
                  background: "var(--pop-2)",
                  border: "1.5px solid var(--ink)",
                  color: "#1d1d1b",
                }}
              >
                <p className="text-xs">
                  Conversation is getting long ({Math.round(contextUsage * 100)}
                  % of context used). Type{" "}
                  <button
                    type="button"
                    onClick={() => compactChat()}
                    className="mono font-bold underline"
                  >
                    /compact
                  </button>{" "}
                  to summarize and continue, or{" "}
                  <button
                    type="button"
                    onClick={() => clearChat()}
                    className="mono font-bold underline"
                  >
                    /clear
                  </button>{" "}
                  to start fresh.
                </p>
              </div>
            )}

            {/* Prompt pinned at bottom. */}
            <div
              className="p-4 shrink-0 pb-[calc(1rem+60px+env(safe-area-inset-bottom,0px))] lg:pb-4"
              style={{ borderTop: "2px solid var(--ink)" }}
            >
              <div className="max-w-3xl mx-auto w-full">
                <ChatPromptArea
                  externalInput={pendingInput}
                  onExternalInputConsumed={() => setPendingInput("")}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Citations rail (3rd pane) — only when the latest answer has real
            provenance; otherwise CitationsRail returns null. Below 1280px it
            is an off-canvas drawer with a click-to-close backdrop + reopen
            FAB; at >=1280px it is an inline pane with a thin reopen tab. */}
        {showCitationsRail && (
          <>
            {/* Click-to-close backdrop (mobile drawer only). */}
            <button
              type="button"
              aria-label="Close sources"
              aria-hidden={!sourcesOpen}
              tabIndex={sourcesOpen ? 0 : -1}
              className={`ss-backdrop xl:hidden${sourcesOpen ? " is-open" : ""}`}
              onClick={() => setSourcesOpen(false)}
            />

            <CitationsRail
              message={activeCitationMessage}
              open={sourcesOpen}
              onClose={() => setSourcesOpen(false)}
            />

            {/* Desktop reopen tab (≥1280, only when the rail is closed). */}
            {!sourcesOpen && (
              <button
                type="button"
                className="ss-reopen"
                onClick={() => setSourcesOpen(true)}
                title="Open sources"
                aria-label="Open sources"
              >
                <span className="cnt">{sourceCount}</span>
                <span className="vt">Sources</span>
              </button>
            )}

            {/* Mobile reopen FAB (below 1280, only when the drawer is closed). */}
            {!sourcesOpen && (
              <button
                type="button"
                className="ss-reopen-fab"
                onClick={() => setSourcesOpen(true)}
                aria-label="Open sources"
              >
                <Link2 className="h-3.5 w-3.5" />
                Sources
                <span className="cnt">{sourceCount}</span>
              </button>
            )}
          </>
        )}
      </div>
    </TooltipProvider>
  );
}

// Parse the JSON-encoded toolParams URL param. Failures fall back to undefined
// — better to fire the tool with no params than to wedge on a malformed link.
function parseToolParams(
  raw: string | null | undefined
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// StockSagePageClient - outer shell + ChatProvider for the /stocksage route
// ---------------------------------------------------------------------------
export default function StockSagePageClient({ isDemo }: { isDemo?: boolean }) {
  const searchParams = useSearchParams();
  const { user, isRealUser } = useAppAuthGuard(isDemo);
  // MONEY-1137: `user` was already in scope here (and the inner StockSageChat
  // passed it) — this outer call just never did, so the value handed to
  // ChatProvider as `isDemoMode` disagreed with the inner one for a signed-in
  // user with a stale flag.
  const isDemoMode = useIsDemoMode({ isDemo, user });
  const userName = user?.fullName || user?.firstName || "Trader";

  return (
    <AppShell>
      <ChatProvider
        userName={userName}
        isRealUser={isRealUser}
        isDemoMode={isDemoMode}
        pagePath="/stocksage"
        initialChatId={searchParams?.get("chatId") || undefined}
        initialPrompt={searchParams?.get("prompt") || undefined}
        // MONEY-228 - Help Center entries with a `tool` field arrive here as
        // ?tool=...&toolParams=...&userText=... so we fire executeToolDirect on
        // mount, bypassing the classifier.
        initialTool={searchParams?.get("tool") || undefined}
        initialToolParams={parseToolParams(searchParams?.get("toolParams"))}
        initialUserText={searchParams?.get("userText") || undefined}
      >
        <StockSageChat />
      </ChatProvider>
    </AppShell>
  );
}
