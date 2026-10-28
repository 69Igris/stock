"use client";

import { useRef, useEffect, useCallback } from "react";
import { useChatContext } from "@/lib/chat/ChatContext";
import type { ActionBlock } from "@usemoney/types";
import ChatMessage from "./ChatMessage";
import { StockSageIcon } from "./StockSageIcon";
import QuickActionChips from "./QuickActionChips";

export default function ChatMessageList() {
  const {
    messages,
    isLoading,
    streamingId,
    confirmAction,
    cancelAction,
    sendMessage,
    loadFullReport,
    selectResearchOption,
    cancelResearchPrompt,
    setCitationMsgId,
    subscriptionAccess,
  } = useChatContext();

  const handleResearchStock = useCallback(
    (symbol: string) => {
      sendMessage(`Analyse ${symbol}`);
    },
    [sendMessage]
  );

  // MONEY-295: refusal-block suggestion chip → send as new message.
  const handleSelectSuggestion = useCallback(
    (prompt: string) => {
      sendMessage(prompt);
    },
    [sendMessage]
  );

  // MONEY-485: regenerate = re-send the user prompt that produced the
  // given assistant message. Finds the nearest preceding user message
  // and re-dispatches its raw content through the same sendMessage path,
  // so streaming / classifier / blocks all behave identically.
  //
  // MONEY-650 (B7): EXCEPT for a research RESULT — there, re-sending the prompt
  // routed back through the classifier, which popped a fresh "Start … research?"
  // confirmation card and could surface the prior report instead of running a
  // new analysis. For research results, re-run the original run_research params
  // straight through confirmAction (the already-confirmed execution path) with
  // a fresh confirm-<uuid> id: no confirmation card, and a genuinely fresh run
  // (startResearchAction always mints a new sessionId).
  const handleRegenerate = useCallback(
    (assistantMessageId: string) => {
      const idx = messages.findIndex((m) => m.id === assistantMessageId);
      if (idx === -1) return;

      const target = messages[idx];
      if (target?.researchSessionId) {
        const trigger = messages
          .slice(0, idx)
          .flatMap((m) => m.blocks || [])
          .filter(
            (b): b is ActionBlock =>
              b.type === "action" && b.tool === "run_research"
          )
          .pop();
        if (trigger?.params) {
          void confirmAction(`confirm-${crypto.randomUUID()}`, "run_research", {
            ...trigger.params,
          });
          return;
        }
      }

      for (let i = idx - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role === "user" && m.content.trim()) {
          void sendMessage(m.content);
          return;
        }
      }
    },
    [messages, sendMessage, confirmAction]
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  // MONEY-778 (#4): whether the viewport is pinned to the bottom. We only
  // auto-scroll on new content when the user hasn't scrolled up — otherwise a
  // research run's frequent progress ticks (the streaming block updates ~1/s)
  // would yank the user back to the end mid-read. Stored in a ref so the
  // high-frequency scroll handler never triggers a re-render, and so the
  // effect below reads the latest value synchronously.
  const pinnedToBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 80px slack so "near the bottom" still counts as pinned (smooth-scroll
    // momentum / sub-pixel rounding shouldn't unpin the user).
    pinnedToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // Scroll to bottom on new content — but only while the user is pinned to the
  // bottom. If they've scrolled up to read, respect that and stay put.
  useEffect(() => {
    if (scrollRef.current && pinnedToBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  /* ── Empty state: no messages yet ────────────────────────────────────── */
  if (messages.length === 0 && !isLoading) {
    return (
      <div className="h-full flex flex-col items-center justify-center px-6 py-10">
        <QuickActionChips asEmptyState />
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="h-full overflow-y-auto px-4 lg:px-6 py-5"
    >
      {/* MONEY-1274 (MONEY-1155 #31) — messages flow from the TOP.
          This was `min-h-full flex flex-col justify-end`: the inner column was
          forced to at least the scroller's full height and its children pushed
          to the BOTTOM. With a short conversation that leaves most of the panel
          empty and the exchange pinned to the composer — the reported screenshot
          is one question plus "thinking..." under roughly 60% blank space.
          Bottom-pinning is unnecessary here because the scroll effect above
          already drives scrollTop to scrollHeight on new messages (guarded by a
          near-bottom check, so it does not yank a user who scrolled up). CSS
          was solving a problem the effect had already solved, and only when
          there was too little content for it to matter. */}
      <div className="flex flex-col max-w-3xl mx-auto w-full">
        <div className="space-y-5">
          {messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              isStreaming={message.id === streamingId}
              onConfirmAction={confirmAction}
              onCancelAction={cancelAction}
              onResearchStock={handleResearchStock}
              onLoadReport={loadFullReport}
              onSelectResearchOption={selectResearchOption}
              onCancelResearchPrompt={cancelResearchPrompt}
              onSelectSuggestion={handleSelectSuggestion}
              onRegenerate={
                message.role === "assistant" ? handleRegenerate : undefined
              }
              onShowSources={
                message.role === "assistant" ? setCitationMsgId : undefined
              }
              subscriptionAccess={subscriptionAccess}
            />
          ))}

          {/* Hide the generic "thinking…" bubble once tokens start arriving —
              the streamed message (with its blinking caret) IS the live
              feedback at that point, so the loader below would just sit
              redundantly beneath the growing text. */}
          {isLoading && !streamingId && (
            <div className="flex gap-3 items-start">
              <StockSageIcon size={34} variant="sparkle" className="mt-0.5" />
              <div
                className="pf-card flat inline-flex items-center"
                style={{ padding: "11px 16px", borderRadius: 14, gap: 9 }}
              >
                <span style={{ display: "inline-flex", gap: 4 }} aria-hidden>
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 99,
                        background: "var(--emerald-pure)",
                        animation: `ss-pulse 1.1s ${i * 0.18}s infinite`,
                      }}
                    />
                  ))}
                </span>
                <span
                  className="mono"
                  style={{ fontSize: 11.5, color: "var(--ink-3)" }}
                >
                  thinking…
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <style jsx>{`
        .pf-dot-pulse {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: var(--emerald);
          animation: ph-pulse 1.4s infinite;
        }
      `}</style>
    </div>
  );
}
