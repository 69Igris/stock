"use client";

import { useUser } from "@clerk/nextjs";
import { Sparkles, BarChart3, LineChart, Target } from "lucide-react";
import { ChatProvider, useChatContext } from "@/lib/chat/ChatContext";
import ChatPromptArea from "@/components/chat/ChatPromptArea";
import ChatMessageList from "@/components/chat/ChatMessageList";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";

const PAPER_QUICK_ACTIONS = [
  {
    label: "Show positions",
    prompt: "Show my paper trading positions",
    icon: LineChart,
  },
  {
    label: "Portfolio P&L",
    prompt: "Show my paper trading P&L and performance",
    icon: BarChart3,
  },
  {
    label: "Trade history",
    prompt: "Show my paper trading trade history",
    icon: Target,
  },
];

function PaperChatInner() {
  const { messages, executeQuickAction, isLoading } = useChatContext();
  const hasMessages = messages.length > 0;

  // Once a question is asked, switch to thread + pinned prompt layout
  if (hasMessages) {
    return (
      <div className="flex flex-col flex-1 min-h-0 -mx-4 lg:-mx-6 -mb-48 sm:-mb-44">
        <div className="flex-1 min-h-0 overflow-hidden">
          <ChatMessageList />
        </div>
        <div className="border-t border-border p-4 shrink-0 bg-background/80 backdrop-blur">
          <ChatPromptArea />
        </div>
      </div>
    );
  }

  // Hero state - mirrors the dashboard StockSage layout: hero sits in
  // the upper scroll area, chat prompt is pinned near the bottom with
  // the quick-action chips just under it.
  return (
    <div
      className="flex flex-col flex-1 min-h-0 -mx-4 lg:-mx-6 -mb-48 sm:-mb-44"
      data-walkthrough="paper-chat-thread"
    >
      <div className="pf-app flex-1 min-h-0 overflow-y-auto px-4 lg:px-6 pb-6">
        <div className="flex flex-col items-center justify-center min-h-[40vh] pt-6 sm:pt-10">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
            style={{
              background: "var(--emerald)",
              border: "2px solid var(--ink)",
              boxShadow: "3px 3px 0 var(--ink)",
              transform: "rotate(-3deg)",
            }}
          >
            <Sparkles className="h-6 w-6" style={{ color: "var(--paper)" }} />
          </div>
          <h2
            className="text-[22px] sm:text-[26px] font-bold tracking-[-0.4px] mb-1 text-center"
            style={{ color: "var(--ink)" }}
          >
            Talk to Sage about your <span className="ser">paper book.</span>
          </h2>
          <p
            className="text-[13px] sm:text-sm max-w-md text-center"
            style={{ color: "var(--ink-3)" }}
          >
            Ask StockSage about your virtual portfolio &mdash; positions,
            P&amp;L, trade history, strategy ideas. Replies stream into this
            thread.
          </p>
        </div>
      </div>

      <div className="shrink-0 px-4 sm:px-6 pb-4 sm:pb-6 sm:flex sm:justify-center">
        <div className="w-full max-w-2xl">
          <ChatPromptArea centered />
          <div
            className="hidden sm:flex mt-3 flex-wrap items-center justify-center gap-2"
            data-walkthrough="paper-chat-quickactions"
          >
            {PAPER_QUICK_ACTIONS.map((a) => {
              const Icon = a.icon;
              return (
                <button
                  key={a.label}
                  type="button"
                  disabled={isLoading}
                  onClick={() => executeQuickAction(a.prompt)}
                  className="pf-bf sm disabled:opacity-50"
                >
                  <Icon className="h-3 w-3" />
                  {a.label}
                </button>
              );
            })}
          </div>
          {/* Mobile quick actions - render below the prompt, horizontally
              scrollable to keep the prompt focused on small screens. */}
          <div className="sm:hidden mt-3 overflow-x-auto scrollbar-none">
            <div className="flex items-center gap-2 px-2 pb-1">
              {PAPER_QUICK_ACTIONS.map((a) => {
                const Icon = a.icon;
                return (
                  <button
                    key={a.label}
                    type="button"
                    disabled={isLoading}
                    onClick={() => executeQuickAction(a.prompt)}
                    className="pf-bf sm shrink-0 disabled:opacity-50"
                  >
                    <Icon className="h-3 w-3" />
                    {a.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PaperTradingChatPage() {
  const { user } = useUser();
  const isDemoMode = useIsDemoMode({ user });
  return (
    <ChatProvider
      isRealUser={!!user && !isDemoMode}
      isDemoMode={isDemoMode}
      pagePath="/paper-trading/chat"
      defaultContext="paper_trading"
      userName={user?.firstName || user?.username || undefined}
    >
      <PaperChatInner />
    </ChatProvider>
  );
}
