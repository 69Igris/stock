"use client";

import { useChatContext } from "@/lib/chat/ChatContext";
import ChatPromptArea from "./ChatPromptArea";
import QuickActionChips from "./QuickActionChips";
import ChatMessageList from "./ChatMessageList";
import MiniStatsBar from "./MiniStatsBar";
import { Sparkles } from "lucide-react";

interface ChatDashboardProps {
  userName?: string;
}

export default function ChatDashboard({ userName }: ChatDashboardProps) {
  const { messages } = useChatContext();
  const hasMessages = messages.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Mini Stats Bar - always at top */}
      <MiniStatsBar />

      {hasMessages ? (
        /* Active Chat State */
        <>
          <ChatMessageList />
          <div className="border-t border-[var(--border-default)] p-4">
            <ChatPromptArea />
          </div>
        </>
      ) : (
        /* Empty State - centered prompt */
        <div className="flex-1 flex flex-col items-center justify-center px-6 pb-8">
          <div className="text-center mb-8 max-w-lg">
            {/* Logo */}
            <div className="h-16 w-16 rounded-2xl bg-[var(--accent-primary-dim)] flex items-center justify-center mx-auto mb-4">
              <Sparkles className="h-8 w-8 text-[var(--accent-primary)]" />
            </div>

            <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
              {userName ? `Hi ${userName},` : "Hi,"} ready to dig in?
            </h1>
            <p className="text-[var(--text-muted)] text-sm">
              Your AI-powered trading assistant. Ask anything about your
              portfolio, analyze stocks, plan for retirement, or explore
              investment ideas.
            </p>
          </div>

          {/* Centered prompt area */}
          <ChatPromptArea centered />

          {/* Quick action chips */}
          <div className="mt-6 max-w-2xl">
            <QuickActionChips />
          </div>
        </div>
      )}
    </div>
  );
}
