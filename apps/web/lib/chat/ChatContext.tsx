"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import type {
  ChatMessageWithBlocks,
  ChatContextMode,
  ChatContextModeSerializable,
  ContentBlock,
  ActionBlock,
  RoastSummaryBlock,
  DashboardStats,
} from "@usemoney/types";
import { parseMessageToBlocks } from "@/lib/chat/message-parser";
import { synthesizeSlashActionId } from "@/app/api/chat/execute-tool/route-logic";
import {
  partitionResumableJobBlocks,
  hasResumableJobs,
  type ResumableMessage,
} from "@/lib/chat/roast-reconcile-logic";
import {
  CHAT_STREAM_CONTENT_TYPE,
  parseSSEChunks,
} from "@/lib/chat/chat-stream";
import { toast } from "sonner";

// MONEY-291: chat streaming, gated so it stays a config flip. MONEY-650 (B9):
// flipped to ON by default — the SSE route (/api/chat) and the SSE reader below
// are complete + guarded (chat-switch, abort, and a JSON fallback for
// confirm/error/paywall turns the route still returns as JSON). Set
// NEXT_PUBLIC_CHAT_STREAMING="0" to fall back to the buffered JSON response.
const STREAMING_ENABLED = process.env.NEXT_PUBLIC_CHAT_STREAMING !== "0";
import {
  saveChatHistoryAction,
  getChatHistoryByIdAction,
} from "@/lib/actions/chat-history";
import { emitChatHistoryEvent } from "@/lib/chat-history/event-bus";
import {
  getResearchStatusAction,
  getResearchResultAction,
  getRecentResearchSessionsAction,
} from "@/lib/actions/research";
import { getRoastStatusAction } from "@/lib/actions/roast";
import { getRoastBySessionIdAction } from "@/lib/actions/roast-history";
import {
  getScanStatusAction,
  getScanResultAction,
} from "@/lib/actions/custom-strategy";
import {
  getDocumentAction,
  getDownloadUrlAction,
} from "@/lib/actions/documents";
import { buildStructuredReportBlocks } from "@/lib/chat/research-blocks";

// ============== Types ==============

interface SubscriptionAccess {
  fastQueriesUsed: number;
  fastQueriesLimit: number;
  advancedQueriesUsed: number;
  advancedQueriesLimit: number;
  canAccessAIQueries: boolean;
  // Unified credits
  creditsUsed: number;
  /**
   * The PLAN's credit allowance only. Purchased packs are counted separately in
   * `packCreditsLimit` — `totalCreditsRemaining` spans BOTH, so anything
   * rendering "remaining / limit" must add the two. Pairing the total remaining
   * with this field alone is what produced "2750 / 200 credits" (MONEY-1199).
   */
  creditsLimit: number;
  /** Purchased query-pack allowance. Zero for a user who has bought none. */
  packCreditsLimit: number;
  /** Plan remaining + pack remaining. Spans both allowances. */
  totalCreditsRemaining: number;
  // MONEY-229 - plan tier for the model picker's plan-gating UI.
  // "FREE" sentinel when the API doesn't surface a planId (e.g. fetch
  // failed, demo mode) - keeps the picker safely conservative.
  planId: "FREE" | "PRO" | "QUERY_PACK" | "PREMIUM" | "ULTIMATE";
}

interface ChatState {
  messages: ChatMessageWithBlocks[];
  isLoading: boolean;
  /**
   * MONEY-291 / task #38: id of the assistant message currently being
   * streamed token-by-token, or undefined when no stream is in flight. The
   * message list uses this to (a) hide the "thinking…" loader once the first
   * delta lands and (b) render the blinking caret on the live message.
   */
  streamingId: string | undefined;
  selectedContext: ChatContextMode;
  queryType: "fast" | "advanced";
  subscriptionAccess: SubscriptionAccess | null;
  currentChatId: string | undefined;
  dashboardStats: DashboardStats | null;
  /** Currently active persona from the last API response */
  currentPersonaId: string | undefined;
}

interface ChatContextValue extends ChatState {
  sendMessage: (text: string) => Promise<void>;
  executeQuickAction: (prompt: string) => Promise<void>;
  setContext: (mode: ChatContextMode) => void;
  setQueryType: (type: "fast" | "advanced") => void;
  confirmAction: (
    actionId: string,
    tool: string,
    params: Record<string, unknown>
  ) => Promise<void>;
  cancelAction: (actionId: string) => void;
  clearChat: () => void;
  /** Summarize conversation to save context, replace messages with summary */
  compactChat: () => Promise<void>;
  /** Estimated token usage as a fraction 0-1 of total budget */
  contextUsage: number;
  setDashboardStats: (stats: DashboardStats | null) => void;
  hideContextSelector: boolean;
  /** Inject a local assistant message without API call (for slash commands like /help) */
  addLocalMessage: (
    userText: string,
    assistantContent: string,
    navigateTo?: string
  ) => void;
  /** Execute a tool directly via API fast-path (for slash commands like /holdings) */
  executeToolDirect: (
    userText: string,
    tool: string,
    params: Record<string, unknown>
  ) => Promise<void>;
  /** Load a full research report inline in chat, replacing the summary nav block */
  loadFullReport: (sessionId: string) => Promise<void>;
  /** Cancel the in-flight chat request */
  cancelRequest: () => void;
  /** Select a research option from the inline prompt */
  selectResearchOption: (
    optionId: string,
    tool: string,
    params: Record<string, unknown>,
    actionId?: string
  ) => void;
  /** Cancel a research prompt */
  cancelResearchPrompt: (actionId?: string) => void;
  /**
   * Cross-component signal so chips/buttons outside the composer (e.g. the
   * "Analyse a stock / Analyse a fund" follow-up chips) can open the composer's
   * @ stock/fund picker. The composer watches `pickerRequest.nonce` and opens
   * the StockMentionPicker on that tab (brokers hidden). This replaces sending
   * a free-text prompt the classifier misrouted into "research <the sentence>".
   */
  pickerRequest: { tab: "stocks" | "funds"; nonce: number } | null;
  requestStockPicker: (tab: "stocks" | "funds") => void;
  /**
   * MONEY-778: which assistant message's sources the CitationsRail shows.
   * `undefined` = follow the latest cited turn. A per-message "Sources" button
   * sets this so that in a chat with multiple analyses, each analysis's sources
   * stay reachable (the rail no longer only ever shows the most recent turn).
   */
  citationMsgId: string | undefined;
  setCitationMsgId: (id: string | undefined) => void;
}

// ============== Context ==============

const ChatCtx = createContext<ChatContextValue | null>(null);

export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatCtx);
  if (!ctx) {
    throw new Error("useChatContext must be used within ChatProvider");
  }
  return ctx;
}

/**
 * Read the chat context without throwing when no provider is present.
 * Used by components (e.g. ChatHistorySidebar tab bodies) that may be
 * rendered both inside and outside a ChatProvider.
 */
export function useOptionalChatContext(): ChatContextValue | null {
  return useContext(ChatCtx);
}

// ============== Provider ==============

interface ChatProviderProps {
  children: ReactNode;
  userName?: string;
  isRealUser: boolean;
  isDemoMode: boolean;
  pagePath: string;
  initialChatId?: string;
  defaultContext?: ChatContextMode;
  userContext?: string;
  hideContextSelector?: boolean;
  initialPrompt?: string;
  /**
   * MONEY-228 - when the help center / a deep link wants to fire a
   * deterministic chat tool instead of falling through the classifier,
   * it sends `?tool=...&toolParams=...&userText=...`. The ChatProvider
   * picks these up and runs `executeToolDirect` once on mount.
   */
  initialTool?: string;
  initialToolParams?: Record<string, unknown>;
  initialUserText?: string;
}

export function ChatProvider({
  children,
  userName,
  isRealUser,
  isDemoMode,
  pagePath,
  initialChatId,
  defaultContext = "all",
  userContext,
  hideContextSelector: hideCtxSelector = false,
  initialPrompt,
  initialTool,
  initialToolParams,
  initialUserText,
}: ChatProviderProps) {
  const promptRouter = useRouter();
  const hasSentInitialPrompt = useRef(false);
  const [messages, setMessages] = useState<ChatMessageWithBlocks[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  // MONEY-291 / task #38: streamed-message signal (see ChatState docs).
  const [streamingId, setStreamingId] = useState<string | undefined>();
  const [selectedContext, setSelectedContext] =
    useState<ChatContextMode>(defaultContext);
  const [queryType, setQueryType] = useState<"fast" | "advanced">("fast");
  const [subscriptionAccess, setSubscriptionAccess] =
    useState<SubscriptionAccess | null>(null);
  const [currentChatId, setCurrentChatId] = useState<string | undefined>();
  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(
    null
  );
  const [currentPersonaId, setCurrentPersonaId] = useState<
    string | undefined
  >();
  // Composer stock/fund-picker open request (see ChatContextValue docs). The
  // monotonically-increasing nonce lets repeated chip clicks re-open the picker
  // even when the tab is unchanged.
  const [pickerRequest, setPickerRequest] = useState<{
    tab: "stocks" | "funds";
    nonce: number;
  } | null>(null);
  const pickerNonceRef = useRef(0);
  const requestStockPicker = useCallback((tab: "stocks" | "funds") => {
    pickerNonceRef.current += 1;
    setPickerRequest({ tab, nonce: pickerNonceRef.current });
  }, []);
  // MONEY-778: per-message sources selection for the CitationsRail.
  const [citationMsgId, setCitationMsgId] = useState<string | undefined>();
  const chatIdRef = useRef<string | undefined>();
  const isSavingRef = useRef(false);
  const pollIntervalsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const abortControllerRef = useRef<AbortController | null>(null);
  // MONEY-587 (C1): conversation epoch — a monotonically increasing token that
  // identifies the CURRENT in-view conversation instance. It is bumped whenever
  // the active chat changes (open another chat from the sidebar, "New chat",
  // /clear, /compact). An async request (send / confirm / tool / report) that
  // resolves AFTER the user has switched chats must not write its response into
  // the now-active chat — otherwise messages leak across conversations. Each
  // such operation captures `convEpochRef.current` at the start and drops its
  // terminal `setMessages`/save when the epoch no longer matches. This is the
  // start-relative counterpart to the poll callbacks' `isSameChat()` chatId
  // check (which only works once a chatId exists; a brand-new chat has none at
  // send time, so we need a token, not the id).
  const convEpochRef = useRef(0);
  // Ref indirection so sendMessage (defined before the poll callbacks below)
  // can kick off scan tracking without a declaration-order / deps cycle.
  const beginScanTrackingRef = useRef<
    ((scanId: string, params: Record<string, unknown>) => void) | null
  >(null);

  useEffect(() => {
    chatIdRef.current = currentChatId;
  }, [currentChatId]);

  // Load subscription access
  useEffect(() => {
    if (isRealUser) {
      fetch("/api/subscription/access")
        .then((res) => res.json())
        .then((access) => {
          setSubscriptionAccess({
            fastQueriesUsed: access.fastQueriesUsed || 0,
            fastQueriesLimit: access.fastQueriesLimit || 0,
            advancedQueriesUsed: access.advancedQueriesUsed || 0,
            advancedQueriesLimit: access.advancedQueriesLimit || 0,
            canAccessAIQueries: access.canAccessAIQueries || false,
            creditsUsed: access.creditsUsed || 0,
            creditsLimit: access.creditsLimit || 0,
            packCreditsLimit: access.packCreditsLimit || 0,
            totalCreditsRemaining: access.totalCreditsRemaining ?? 0,
            planId: access.planId ?? "FREE",
          });
        })
        .catch(() => {
          setSubscriptionAccess({
            fastQueriesUsed: 0,
            fastQueriesLimit: 0,
            advancedQueriesUsed: 0,
            advancedQueriesLimit: 0,
            canAccessAIQueries: false,
            creditsUsed: 0,
            creditsLimit: 0,
            packCreditsLimit: 0,
            totalCreditsRemaining: 0,
            planId: "FREE",
          });
        });
    }
  }, [isRealUser]);

  // Load chat history when initialChatId is provided (from URL ?chatId= param)
  useEffect(() => {
    if (!initialChatId) return;
    if (chatIdRef.current === initialChatId) return; // Already loaded

    // MONEY-587 (C1): switching to a different chat starts a NEW conversation
    // epoch. This (a) invalidates any in-flight response from the previous chat
    // so it can't append here, and (b) lets us reset the view to a clean slate
    // while this chat's history loads, so the prior chat's messages never flash
    // into — or persist alongside — the incoming one.
    //
    // Active background polls (research/roast/scan/report) are intentionally
    // LEFT RUNNING: each already suppresses UI writes for a chat it no longer
    // owns via its own `isSameChat()` chatId check, then surfaces a toast and
    // gets re-attached by the reconcile effects on return. Killing them here
    // would break that resume/notify design (MONEY-218/240).
    convEpochRef.current += 1;
    // Re-point chatIdRef to the target chat NOW (not after the async load
    // resolves) so any still-running poll from the previous chat immediately
    // fails its `isSameChat()` check and can't write into this loading view.
    chatIdRef.current = initialChatId;
    setMessages([]);
    setStreamingId(undefined);
    setCurrentPersonaId(undefined);

    const loadChat = async () => {
      const result = await getChatHistoryByIdAction(initialChatId);
      if (result.success && result.data) {
        const loadedMessages = (
          result.data.messages as Array<{
            id?: string;
            role: string;
            content: string;
            timestamp?: string;
            blocks?: unknown[];
            turnMeta?: unknown;
          }>
        ).map((msg) => ({
          id: msg.id || Date.now().toString() + Math.random(),
          role: msg.role as "user" | "assistant",
          content: msg.content,
          // Restore persisted blocks if available, otherwise re-parse from content
          blocks:
            msg.blocks && Array.isArray(msg.blocks) && msg.blocks.length > 0
              ? (msg.blocks as ContentBlock[])
              : msg.role === "assistant"
                ? parseMessageToBlocks(msg.content)
                : undefined,
          timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
          // Restore turn metadata for conversation memory
          turnMeta: msg.turnMeta as ChatMessageWithBlocks["turnMeta"],
        }));
        setMessages(loadedMessages);
        setCurrentChatId(initialChatId);
        chatIdRef.current = initialChatId;
      }
    };

    loadChat();
  }, [initialChatId, isDemoMode]);

  const hasReconciledRef = useRef(false);

  // MONEY-240 follow-up (QA bundle B4): reset the reconcile guard when
  // the user navigates to a different chat. Without this, the second
  // (and later) chat-load skips reconciliation entirely - so a research
  // run started in chat A then revisited from chat B → back to chat A
  // shows the action block stuck at "running" forever, even though the
  // worker finished. Resetting on chat-switch lets reconcile re-run
  // and pick up the COMPLETED status from the DB.
  const lastReconciledChatRef = useRef<string | undefined>(undefined);
  // Separate guard for the roast-resume reconcile (below) so it re-runs on
  // every chat switch too.
  const hasRoastReconciledRef = useRef(false);
  useEffect(() => {
    if (initialChatId !== lastReconciledChatRef.current) {
      hasReconciledRef.current = false;
      hasRoastReconciledRef.current = false;
      lastReconciledChatRef.current = initialChatId;
    }
  }, [initialChatId]);

  const serializeContext = useCallback(
    (ctx: ChatContextMode): ChatContextModeSerializable => {
      if (ctx === "all") return "all";
      if (typeof ctx === "object" && ctx.type === "broker") {
        return `broker:${ctx.brokerId}:${ctx.brokerName}`;
      }
      return ctx as ChatContextModeSerializable;
    },
    []
  );

  const refreshSubscription = useCallback(() => {
    if (!isRealUser) return;
    fetch("/api/subscription/access")
      .then((res) => res.json())
      .then((access) => {
        setSubscriptionAccess({
          fastQueriesUsed: access.fastQueriesUsed || 0,
          fastQueriesLimit: access.fastQueriesLimit || 0,
          advancedQueriesUsed: access.advancedQueriesUsed || 0,
          advancedQueriesLimit: access.advancedQueriesLimit || 0,
          canAccessAIQueries: access.canAccessAIQueries || false,
          creditsUsed: access.creditsUsed || 0,
          creditsLimit: access.creditsLimit || 0,
          packCreditsLimit: access.packCreditsLimit || 0,
          totalCreditsRemaining: access.totalCreditsRemaining ?? 0,
          planId: access.planId ?? "FREE",
        });
      })
      .catch(() => {});
  }, [isRealUser]);

  const saveChat = useCallback(
    async (msgs: ChatMessageWithBlocks[]) => {
      if (!isRealUser || isSavingRef.current) return;
      const userMsgs = msgs.filter((m) => m.role === "user");
      if (userMsgs.length === 0) return;

      isSavingRef.current = true;
      try {
        const result = await saveChatHistoryAction(
          pagePath,
          "StockSage",
          "Sparkles",
          msgs.map((m) => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            // Persist rich blocks so they survive chat reload
            ...(m.blocks && m.blocks.length > 0 ? { blocks: m.blocks } : {}),
            // Persist turn metadata for conversation memory
            ...(m.turnMeta ? { turnMeta: m.turnMeta } : {}),
          })),
          chatIdRef.current
        );
        if (result.success && result.data?.chatId && !chatIdRef.current) {
          setCurrentChatId(result.data.chatId);
          chatIdRef.current = result.data.chatId;
          // Notify sidebar / chat-history page (this tab + cross-tab) so the
          // new chat appears immediately without waiting for the next poll.
          emitChatHistoryEvent({
            type: "chat-created",
            chatId: result.data.chatId,
          });
        }
      } finally {
        isSavingRef.current = false;
      }
    },
    [isRealUser, pagePath]
  );

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isLoading) return;

      // MONEY-587 (C1): pin the conversation this send belongs to. If the user
      // switches chats before the response lands, `convEpochRef.current` will
      // have advanced and every terminal write below becomes a no-op — the
      // answer never leaks into the chat they navigated to.
      const epoch = convEpochRef.current;
      const isSameConversation = () => convEpochRef.current === epoch;

      const userMessage: ChatMessageWithBlocks = {
        id: Date.now().toString(),
        role: "user",
        content: text.trim(),
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);

      // Demo mode
      if (isDemoMode && !isRealUser) {
        setTimeout(() => {
          const demoResponse: ChatMessageWithBlocks = {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            content:
              "This is a demo preview. To get AI-powered trading insights, please create a free account!",
            blocks: [
              {
                type: "text",
                content:
                  "This is a demo preview. To get AI-powered trading insights, please create a free account!",
              },
            ],
            timestamp: new Date(),
          };
          setMessages((prev) => [...prev, demoResponse]);
          setIsLoading(false);
        }, 500);
        return;
      }

      // MONEY-295: No client-side gate. The server is the source of truth:
      //   - L1 chat (Flash/Lite) costs 0 credits → always allowed for FREE
      //   - L2+ research returns 403 with credit-specific copy when exhausted
      //   - Premium models are filtered at the picker via isModelAvailableOnPlan;
      //     if a stale saved pref slips through, the server's resolveModelId
      //     falls back to the plan default silently
      // The previous binary `canAccessAIQueries` gate (a) blocked during the
      // subscription-load race and (b) blocked all FREE users despite Flash
      // being free server-side. Both flaws gone.

      try {
        const conversationHistory = messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.turnMeta ? { turnMeta: m.turnMeta } : {}),
          }));

        const controller = new AbortController();
        abortControllerRef.current = controller;

        const res = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(STREAMING_ENABLED ? { Accept: CHAT_STREAM_CONTENT_TYPE } : {}),
          },
          body: JSON.stringify({
            message: text.trim(),
            queryType,
            pagePath,
            context: serializeContext(selectedContext),
            conversationHistory,
            ...(userContext ? { userContext } : {}),
          }),
          signal: controller.signal,
        });

        // MONEY-587 (C1): the user navigated to a different chat while this
        // request was in flight. Drop the response entirely (and the still-open
        // body) rather than rendering it into the chat they're now viewing. The
        // poll-driven flows below already guard via `isSameChat()`; this covers
        // the synchronous chat reply path.
        if (!isSameConversation()) {
          try {
            await res.body?.cancel();
          } catch {
            // body may already be consumed/closed — nothing to do.
          }
          return;
        }

        // MONEY-291: incremental SSE render when the route streamed back.
        if (
          STREAMING_ENABLED &&
          res.body &&
          (res.headers.get("content-type") || "").includes(
            CHAT_STREAM_CONTENT_TYPE
          )
        ) {
          const assistantId = (Date.now() + 1).toString();
          setMessages((prev) => [
            ...prev,
            {
              id: assistantId,
              role: "assistant",
              content: "",
              blocks: [],
              timestamp: new Date(),
            },
          ]);

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          let acc = "";
          let finalBlocks: ContentBlock[] | undefined;
          let finalTurnMeta: ChatMessageWithBlocks["turnMeta"];
          let streamErr: string | undefined;

          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              // MONEY-587 (C1): chat switched mid-stream — stop reading and
              // discard the rest. The final-settle write below is also gated,
              // so nothing from this stream reaches the now-active chat.
              if (!isSameConversation()) {
                try {
                  await reader.cancel();
                } catch {
                  /* reader already closed */
                }
                return;
              }
              buf += decoder.decode(value, { stream: true });
              const { events, rest } = parseSSEChunks(buf);
              buf = rest;
              for (const ev of events) {
                if (ev.t === "delta") {
                  // delta carries the cumulative, pre-scrubbed prose-so-far —
                  // replace, don't append (scrubbing can shrink earlier text).
                  acc = ev.text;
                  // First delta → the assistant is now actively typing: flip
                  // off the generic "thinking…" loader and mark this message as
                  // the streaming one (drives the blinking caret).
                  setStreamingId(assistantId);
                  setIsLoading(false);
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId ? { ...m, content: acc } : m
                    )
                  );
                } else if (ev.t === "blocks" || ev.t === "meta") {
                  if (ev.blocks) {
                    finalBlocks = ev.blocks as ContentBlock[];
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === assistantId ? { ...m, blocks: finalBlocks } : m
                      )
                    );
                  }
                  if (ev.t === "meta" && ev.turnMeta) {
                    finalTurnMeta =
                      ev.turnMeta as ChatMessageWithBlocks["turnMeta"];
                    // Apply the up-front turnMeta immediately so the meta line
                    // (StockSage · intent · symbols) renders alongside the
                    // streaming text instead of only at the final settle.
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === assistantId
                          ? { ...m, turnMeta: finalTurnMeta }
                          : m
                      )
                    );
                  }
                } else if (ev.t === "done") {
                  finalTurnMeta =
                    (ev.turnMeta as ChatMessageWithBlocks["turnMeta"]) ??
                    finalTurnMeta;
                  if (ev.remaining !== undefined) refreshSubscription();
                } else if (ev.t === "error") {
                  streamErr = ev.message;
                }
              }
            }
          } catch (streamReadErr) {
            if (
              streamReadErr instanceof DOMException &&
              streamReadErr.name === "AbortError"
            ) {
              setMessages((prev) =>
                prev.filter(
                  (m) => m.id !== assistantId && m.id !== userMessage.id
                )
              );
              setStreamingId(undefined);
              setIsLoading(false);
              return;
            }
            streamErr = "Sorry, I encountered an error. Please try again.";
          }

          // MONEY-587 (C1): final guard before settling the streamed message —
          // a switch that landed exactly as the stream ended must not write.
          if (!isSameConversation()) return;

          setMessages((prev) => {
            const updated = prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: acc,
                    blocks: streamErr
                      ? ([
                          {
                            type: "error",
                            severity: "error",
                            title: "Error",
                            message: streamErr,
                          },
                        ] as ContentBlock[])
                      : (finalBlocks ?? m.blocks),
                    turnMeta: finalTurnMeta ?? m.turnMeta,
                  }
                : m
            );
            setTimeout(() => saveChat(updated), 1000);
            return updated;
          });
          // Stream finished (or errored into a block): drop the caret + loader.
          setStreamingId(undefined);
          setIsLoading(false);
          return;
        }

        const data = await res.json();

        // MONEY-587 (C1): chat switched while the JSON body was being parsed —
        // discard this reply (and its credit refresh) so it can't append to the
        // chat now in view.
        if (!isSameConversation()) return;

        if (data.error) {
          const errorMsg: ChatMessageWithBlocks = {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            content: data.error,
            blocks: [
              {
                type: "error",
                severity: "error",
                title: "Error",
                message: data.error,
              },
            ],
            timestamp: new Date(),
          };
          setMessages((prev) => [...prev, errorMsg]);
          setIsLoading(false);
          return;
        }

        const blocks: ContentBlock[] =
          data.blocks || parseMessageToBlocks(data.response || "");

        // If the route kicked off a strategy scan (async worker job), attach a
        // poll + persisted action block so it streams its matches and survives
        // navigation — instead of the dead {scanId} card the generic handler
        // would render and never follow up on.
        const scanKick = Array.isArray(data.toolResults)
          ? (
              data.toolResults as Array<{
                tool?: string;
                success?: boolean;
                data?: { scanId?: string };
              }>
            ).find(
              (t) =>
                t.tool === "run_strategy_scan" && t.success && t.data?.scanId
            )
          : undefined;
        if (scanKick?.data?.scanId) {
          beginScanTrackingRef.current?.(scanKick.data.scanId, {});
          if (data.remaining !== undefined) refreshSubscription();
          setIsLoading(false);
          return;
        }

        // Track persona from API response for follow-up chips
        if (data.personaId) {
          setCurrentPersonaId(data.personaId);
        }

        const assistantMsg: ChatMessageWithBlocks = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: data.response || "",
          blocks,
          timestamp: new Date(),
          turnMeta: data.turnMeta || undefined,
        };

        setMessages((prev) => {
          const updated = [...prev, assistantMsg];
          // Auto-save debounced
          setTimeout(() => saveChat(updated), 1000);
          return updated;
        });

        if (data.remaining !== undefined) {
          refreshSubscription();
        }
      } catch (err) {
        // Don't show error if user cancelled the request
        if (err instanceof DOMException && err.name === "AbortError") {
          // Remove the user's message since the request was cancelled
          setMessages((prev) => prev.filter((m) => m.id !== userMessage.id));
        } else if (isSameConversation()) {
          // MONEY-587 (C1): only surface the connection error in the chat that
          // actually issued the request — never in one the user switched to.
          const errorMsg: ChatMessageWithBlocks = {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            content: "Sorry, I encountered an error. Please try again.",
            blocks: [
              {
                type: "error",
                severity: "error",
                title: "Connection Error",
                message: "Sorry, I encountered an error. Please try again.",
              },
            ],
            timestamp: new Date(),
          };
          setMessages((prev) => [...prev, errorMsg]);
        }
      } finally {
        abortControllerRef.current = null;
        setIsLoading(false);
        refreshSubscription();
      }
    },
    [
      isLoading,
      isDemoMode,
      isRealUser,
      // `subscriptionAccess` was previously listed but is not read inside
      // this callback body - `refreshSubscription()` calls down at line 501
      // mutate it through the setter, but the callback's identity doesn't
      // need to change when subscriptionAccess updates.
      queryType,
      pagePath,
      selectedContext,
      messages,
      serializeContext,
      saveChat,
      refreshSubscription,
      userContext,
    ]
  );

  const executeQuickAction = useCallback(
    async (prompt: string) => {
      await sendMessage(prompt);
    },
    [sendMessage]
  );

  // Auto-send initialPrompt from URL param (e.g. from Help Center prompt clicks)
  useEffect(() => {
    if (
      hasSentInitialPrompt.current ||
      messages.length > 0 ||
      subscriptionAccess === null
    ) {
      return;
    }

    // MONEY-228 - deterministic tool dispatch from URL takes priority over
    // the free-text prompt. The Help Center sets these when a prompt-library
    // entry has a `tool` field; bypassing the classifier prevents the same
    // routing-collapse bug fixed for the persona chips.
    if (initialTool) {
      hasSentInitialPrompt.current = true;
      executeToolDirect(
        initialUserText || initialPrompt || initialTool,
        initialTool,
        initialToolParams || {}
      );
      // Strip the consumed query params by replacing with the CURRENT route
      // (pagePath). Hardcoding "/dashboard" here bounced the user off the
      // /stocksage chat surface back to the overview (MONEY-581).
      promptRouter.replace(pagePath, { scroll: false });
      return;
    }

    if (initialPrompt) {
      hasSentInitialPrompt.current = true;
      sendMessage(initialPrompt);
      promptRouter.replace(pagePath, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    initialPrompt,
    initialTool,
    initialToolParams,
    initialUserText,
    subscriptionAccess,
    sendMessage,
  ]);

  // Helper: update a specific ActionBlock within messages state
  const updateActionBlock = useCallback(
    (actionId: string, updates: Partial<ActionBlock>) => {
      setMessages((prev) =>
        prev.map((msg) => ({
          ...msg,
          blocks: msg.blocks?.map((block) => {
            // Update ActionBlock
            if (block.type === "action" && block.actionId === actionId) {
              return { ...block, ...updates };
            }
            // Also update ResearchStreamBlock with same actionId
            if (
              block.type === "research-stream" &&
              block.actionId === actionId
            ) {
              // Merge taskProgress: preserve resultSummary from previous polls
              // (delta delivery means new polls omit summaries already received)
              let mergedTaskProgress =
                updates.taskProgress ?? block.taskProgress;
              if (updates.taskProgress && block.taskProgress) {
                const existingSummaries = new Map<string, unknown>();
                for (const t of block.taskProgress) {
                  if (t.resultSummary !== undefined) {
                    existingSummaries.set(t.id, t.resultSummary);
                  }
                }
                if (existingSummaries.size > 0) {
                  mergedTaskProgress = updates.taskProgress.map((t) => {
                    if (t.resultSummary !== undefined) return t;
                    const prev = existingSummaries.get(t.id);
                    if (prev !== undefined)
                      return { ...t, resultSummary: prev };
                    return t;
                  });
                }
              }
              return {
                ...block,
                progress: updates.progress ?? block.progress,
                currentStep: updates.currentStep ?? block.currentStep,
                skill: updates.skill ?? block.skill,
                totalSteps: updates.totalSteps ?? block.totalSteps,
                taskProgress: mergedTaskProgress,
                status:
                  updates.status === "executed"
                    ? ("completed" as const)
                    : updates.status === "failed"
                      ? ("failed" as const)
                      : block.status,
              };
            }
            return block;
          }),
        }))
      );
    },
    []
  );

  // Helper: append a new assistant message with research results.
  const appendResearchResults = useCallback(
    (blocks: ContentBlock[], sessionId?: string) => {
      setMessages((prev) => {
        // If sessionId provided, check for an existing RESULTS message for THIS session
        // (from reconciliation after reload) and update it instead of duplicating.
        // Skip the stream block message (which has a research-stream block) - that's
        // the progress tracker, not the results container.
        if (sessionId) {
          const existingIdx = prev.findIndex(
            (m) =>
              m.role === "assistant" &&
              m.researchSessionId === sessionId &&
              !m.blocks?.some((b) => b.type === "research-stream")
          );
          if (existingIdx >= 0) {
            const updated = [...prev];
            updated[existingIdx] = { ...updated[existingIdx]!, blocks };
            setTimeout(() => saveChat(updated), 1000);
            return updated;
          }
        }

        // Message 1: Research results
        const researchMsg: ChatMessageWithBlocks = {
          id: Date.now().toString(),
          role: "assistant",
          content: "Here are the research results:",
          blocks,
          timestamp: new Date(),
          researchSessionId: sessionId,
        };

        // Only show deep dive nudge after FAST research (not after advanced/deep)
        const triggerBlock = prev
          .flatMap((m) => m.blocks || [])
          .filter(
            (b): b is ActionBlock =>
              b.type === "action" && b.tool === "run_research"
          )
          .pop();

        const wasAdvanced =
          triggerBlock?.params?.mode === "advanced" ||
          triggerBlock?.params?.skill === "financial-deep-dive";

        // MONEY-240 follow-up (QA bundle B3): also suppress when the
        // trigger had customSkills set (user opted into Deep via the
        // "+" popover, OR via the v2 preset path). The legacy
        // "Want a comprehensive deep dive?" upsell is a v1 holdover -
        // it's noisy and confusing when the user has already
        // expressed preferences via the popover.
        const hadCustomSkills =
          Array.isArray(triggerBlock?.params?.customSkills) &&
          (triggerBlock!.params!.customSkills as unknown[]).length > 0;
        const hadPreset =
          typeof triggerBlock?.params?.preset === "string" &&
          (triggerBlock!.params!.preset as string).length > 0;

        if (wasAdvanced || hadCustomSkills || hadPreset || !triggerBlock) {
          // Deep analysis already done OR user has explicit prefs -
          // no upsell nudge.
          const updated = [...prev, researchMsg];
          setTimeout(() => saveChat(updated), 1000);
          return updated;
        }

        // Extract symbol for the nudge
        const researchSymbol =
          (triggerBlock.params?.symbols as string[] | undefined)?.[0] ||
          (triggerBlock.params?.query as string) ||
          "";

        const nudgeBlocks: ContentBlock[] = [
          {
            type: "text",
            content: researchSymbol
              ? `**Want a comprehensive deep dive on ${researchSymbol}?** Get detailed financials, DCF valuation, earnings analysis, and peer comparison.`
              : "**Want a more detailed analysis?** I can run a comprehensive deep dive with DCF valuation, earnings breakdown, and peer comparison.",
          },
          {
            type: "action",
            actionId: `confirm-${crypto.randomUUID()}`,
            tool: "run_research",
            description: researchSymbol
              ? `Deep analysis of ${researchSymbol}`
              : "Comprehensive deep analysis",
            params: {
              query: researchSymbol
                ? `comprehensive deep analysis of ${researchSymbol}`
                : "comprehensive deep analysis",
              ...(researchSymbol ? { symbols: [researchSymbol] } : {}),
              mode: "advanced",
              skill: "financial-deep-dive",
            },
            status: "pending",
          },
        ];

        const nudgeMsg: ChatMessageWithBlocks = {
          id: (Date.now() + 2).toString(),
          role: "assistant",
          content: "Want a deeper analysis?",
          blocks: nudgeBlocks,
          timestamp: new Date(),
        };

        const updated = [...prev, researchMsg, nudgeMsg];
        setTimeout(() => saveChat(updated), 1000);
        return updated;
      });
    },
    [saveChat]
  );

  // Store original summary blocks so user can toggle back
  const savedSummaryBlocksRef = useRef<Map<string, ContentBlock[]>>(new Map());

  // Load full research report inline in chat - replaces summary with all sections
  const loadFullReport = useCallback(
    async (sessionId: string) => {
      try {
        // Check if this is a "collapse" request (toggling back to summary)
        const savedSummary = savedSummaryBlocksRef.current.get(sessionId);
        if (savedSummary) {
          setMessages((prev) => {
            const updated = prev.map((msg) => {
              if (msg.role !== "assistant" || !msg.blocks) return msg;
              const hasCollapseLink = msg.blocks.some(
                (b) =>
                  b.type === "navigation" &&
                  "links" in b &&
                  (b.links as Array<{ href: string }>).some(
                    (l) => l.href === `#collapse-report:${sessionId}`
                  )
              );
              if (!hasCollapseLink) return msg;
              return {
                ...msg,
                content: "Here are the research results:",
                blocks: savedSummary,
              };
            });
            setTimeout(() => saveChat(updated), 1000);
            return updated;
          });
          savedSummaryBlocksRef.current.delete(sessionId);
          return;
        }

        // Retry once if the first attempt fails (DB write may still be in progress)
        let resultData = await getResearchResultAction(sessionId);
        if (!resultData.success || !resultData.data) {
          await new Promise((r) => setTimeout(r, 2000));
          resultData = await getResearchResultAction(sessionId);
        }
        if (!resultData.success || !resultData.data) {
          toast.error("Failed to load research report");
          return;
        }

        const fullBlocks = buildStructuredReportBlocks(resultData.data);
        if (fullBlocks.length === 0) return;

        // MONEY-668 item 4: reveal the report section-by-section so it "streams"
        // in rather than popping all at once. The results message is identified
        // by researchSessionId AND not having a research-stream block (that's
        // the progress tracker) — a predicate that stays stable across the
        // reveal even after the nav link is swapped out.
        const isReportMsg = (msg: ChatMessageWithBlocks) =>
          msg.role === "assistant" &&
          msg.researchSessionId === sessionId &&
          !msg.blocks?.some((b) => b.type === "research-stream");

        // Step 1: stash the summary + show the first block. Match by the session
        // nav link (still present at this point) and stamp researchSessionId so
        // the reveal predicate can re-find the message afterwards.
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.role !== "assistant" || !msg.blocks) return msg;
            const hasSessionNav = msg.blocks.some(
              (b) =>
                b.type === "navigation" &&
                "links" in b &&
                (b.links as Array<{ href: string }>).some(
                  (l) =>
                    l.href.includes(sessionId) ||
                    l.href.includes(`#load-report:${sessionId}`)
                )
            );
            if (!hasSessionNav) return msg;
            savedSummaryBlocksRef.current.set(sessionId, msg.blocks!);
            return {
              ...msg,
              content: "Full research report loaded:",
              researchSessionId: sessionId,
              blocks: fullBlocks.slice(0, 1),
            };
          })
        );

        // Step 2: append the remaining blocks on a short interval, persisting
        // once at the end.
        if (fullBlocks.length <= 1) {
          setMessages((prev) => {
            setTimeout(() => saveChat(prev), 0);
            return prev;
          });
          return;
        }
        let shown = 1;
        const revealNext = () => {
          shown += 1;
          const done = shown >= fullBlocks.length;
          setMessages((prev) => {
            const updated = prev.map((msg) =>
              isReportMsg(msg)
                ? { ...msg, blocks: fullBlocks.slice(0, shown) }
                : msg
            );
            if (done) setTimeout(() => saveChat(updated), 0);
            return updated;
          });
          if (!done) setTimeout(revealNext, 90);
        };
        setTimeout(revealNext, 90);
      } catch {
        toast.error("Failed to load research report");
      }
    },
    [saveChat]
  );

  // Start polling for research session progress
  const startResearchPoll = useCallback(
    (actionId: string, sessionId: string) => {
      let pollCount = 0;
      let lastProgress = -1;
      let staleSince = 0;
      const MAX_POLLS = 300; // 300 * 1.5s = 7.5 minutes max
      const STALE_TIMEOUT = 180_000; // 180s without progress = stale (Gemini Pro can take 60-90s per generation)

      // Capture the chat the research was triggered from. If the user navigates
      // to a different chat while research runs, completion handlers must NOT
      // write the result into the new chat - the streamBlock+sessionId are
      // already persisted in the originating chat's DB row, so reconciliation
      // on next visit (lines ~1100-1150) will fetch the COMPLETED status and
      // append the results there. See MONEY-218.
      const triggeringChatId = chatIdRef.current;
      const isSameChat = () => chatIdRef.current === triggeringChatId;

      // Delta tracking: keep IDs of tasks whose resultSummary we already received
      const receivedTaskData = new Set<string>();

      const interval = setInterval(async () => {
        pollCount++;

        // Max poll limit reached
        if (pollCount > MAX_POLLS) {
          clearInterval(interval);
          pollIntervalsRef.current.delete(actionId);
          if (isSameChat()) {
            updateActionBlock(actionId, {
              status: "failed",
              result:
                "Research is taking longer than expected. Please try again.",
            });
            toast.error("Research timed out - please try again");
          }
          return;
        }

        try {
          const statusResult = await getResearchStatusAction(
            sessionId,
            receivedTaskData.size > 0 ? Array.from(receivedTaskData) : undefined
          );
          if (!statusResult.success || !statusResult.data) {
            // Don't bail on transient errors, but track them
            return;
          }

          const {
            status,
            progress,
            currentStep,
            taskProgress,
            skill,
            totalSteps,
          } = statusResult.data;

          // Track newly received resultSummary data for delta delivery
          if (taskProgress) {
            for (const task of taskProgress) {
              if (task.resultSummary) {
                receivedTaskData.add(task.id);
              }
            }
          }

          // Update progress on the ActionBlock - include task-level progress.
          // Skipped when user has navigated away: the action block isn't in
          // the current chat's state anyway, so this would be a no-op map.
          if (isSameChat()) {
            updateActionBlock(actionId, {
              progress,
              currentStep,
              taskProgress,
              skill,
              totalSteps,
            });
          }

          // Track stale progress (no change for too long)
          if (progress !== lastProgress) {
            lastProgress = progress;
            staleSince = Date.now();
          } else if (
            staleSince > 0 &&
            Date.now() - staleSince > STALE_TIMEOUT
          ) {
            clearInterval(interval);
            pollIntervalsRef.current.delete(actionId);
            if (isSameChat()) {
              updateActionBlock(actionId, {
                status: "failed",
                result:
                  "Research is taking longer than expected. Please try again.",
              });
              toast.error("Research timed out - please try again");
            }
            return;
          }

          if (status === "COMPLETED") {
            clearInterval(interval);
            pollIntervalsRef.current.delete(actionId);

            // Skip all UI/state mutations if the user navigated to a different
            // chat. The streamBlock+sessionId is already saved in the
            // originating chat - reconciliation on next visit will fetch the
            // COMPLETED status and append the results to the correct chat.
            if (!isSameChat()) {
              toast.success("Research analysis is ready!");
              return;
            }

            // Mark block as executed BEFORE appending results
            // so saveChat (triggered by appendResearchResults) persists the correct status
            // Include taskProgress explicitly so it persists in saved chat
            updateActionBlock(actionId, {
              status: "executed",
              result: "Research completed",
              progress: 100,
              taskProgress,
              skill,
              totalSteps,
            });

            // Fetch full result and display blocks in chat
            try {
              const resultData = await getResearchResultAction(sessionId);
              if (resultData.success && resultData.data) {
                // P6 (MONEY-676): render the full <ResearchReport> on completion
                // — the same renderer as /analysis — so the chat report matches
                // the design (no more old scorecard summary). Falls back to
                // summary blocks internally when the result isn't structured.
                const blocks = buildStructuredReportBlocks(resultData.data);
                if (blocks.length > 0) {
                  appendResearchResults(blocks, sessionId);
                } else {
                  console.warn(
                    "[chat] buildStructuredReportBlocks returned empty for session:",
                    sessionId
                  );
                  appendResearchResults(
                    [
                      {
                        type: "text",
                        content:
                          "Research completed! View the full report on the analysis page.",
                      },
                      {
                        type: "navigation",
                        links: [
                          {
                            label: "View Full Analysis",
                            href: `/analysis/${encodeURIComponent(sessionId)}`,
                            icon: "chart",
                            description: "Open the detailed research report",
                          },
                        ],
                      },
                    ],
                    sessionId
                  );
                }
              } else {
                console.error(
                  "[chat] getResearchResultAction failed:",
                  resultData.error,
                  "sessionId:",
                  sessionId
                );
                appendResearchResults(
                  [
                    {
                      type: "text",
                      content:
                        "Research completed! The results are available on the analysis page.",
                    },
                    {
                      type: "navigation",
                      links: [
                        {
                          label: "View Full Analysis",
                          href: `/analysis/${encodeURIComponent(sessionId)}`,
                          icon: "chart",
                          description: "Open the detailed research report",
                        },
                      ],
                    },
                  ],
                  sessionId
                );
              }
            } catch (fetchError) {
              console.error(
                "[chat] Failed to fetch research result:",
                fetchError,
                "sessionId:",
                sessionId
              );
              appendResearchResults(
                [
                  {
                    type: "text",
                    content:
                      "Research completed! View results on the analysis page.",
                  },
                  {
                    type: "navigation",
                    links: [
                      {
                        label: "View Full Analysis",
                        href: `/analysis/${encodeURIComponent(sessionId)}`,
                        icon: "chart",
                        description: "Open the detailed research report",
                      },
                    ],
                  },
                ],
                sessionId
              );
            }

            toast.success("Research analysis is ready!");
          } else if (status === "FAILED") {
            clearInterval(interval);
            pollIntervalsRef.current.delete(actionId);
            if (isSameChat()) {
              updateActionBlock(actionId, {
                status: "failed",
                result: "Research failed",
              });
              toast.error("Research analysis failed");
            }
          }
        } catch {
          // Transient fetch error - keep polling
        }
      }, 1500); // 1.5s so research task cards stream in smoothly (was 3s); the
      // getResearchStatus delta (seen-task-ids) keeps each poll light.

      pollIntervalsRef.current.set(actionId, interval);
    },
    [updateActionBlock, appendResearchResults]
  );

  /**
   * Roast polling - mirror of startResearchPoll but lighter: roast jobs
   * have a single linear pipeline (fetch → analyze → score → commentary)
   * with no per-step subtasks, so the action block just tracks the
   * progress percentage + currentStep label. On COMPLETED, the full roast
   * record is fetched and surfaced as a result block; on FAILED the action
   * block flips to the failed state with the user-facing error message.
   */
  const startRoastPoll = useCallback(
    (actionId: string, sessionId: string) => {
      let pollCount = 0;
      const MAX_POLLS = 60; // 60 * 5s = 5 min max - roasts typically finish in 1-2 min
      const triggeringChatId = chatIdRef.current;
      const isSameChat = () => chatIdRef.current === triggeringChatId;

      const interval = setInterval(async () => {
        pollCount++;
        if (pollCount > MAX_POLLS) {
          clearInterval(interval);
          pollIntervalsRef.current.delete(actionId);
          if (isSameChat()) {
            updateActionBlock(actionId, {
              status: "failed",
              result: "Roast is taking longer than expected. Please try again.",
            });
            toast.error("Roast timed out - please try again");
          }
          return;
        }

        try {
          const statusResult = await getRoastStatusAction(sessionId);
          if (!statusResult.success || !statusResult.data) return;

          const { status, progress, currentStep } = statusResult.data;

          if (isSameChat()) {
            updateActionBlock(actionId, {
              progress: progress ?? 0,
              currentStep: currentStep ?? "Analysing portfolio…",
            });
          }

          if (status === "COMPLETED") {
            clearInterval(interval);
            pollIntervalsRef.current.delete(actionId);

            const result = await getRoastBySessionIdAction(sessionId);
            if (!isSameChat()) return;

            if (result.success && result.data) {
              const structured = result.data.result;
              const score = result.data.score ?? structured?.overallScore ?? 0;

              // MONEY-581: render a COMPACT roast card in chat (score gauge +
              // verdict headline + a couple of highlights), NOT the full
              // narrative wall of text. The rich multi-section report lives on
              // /roast/[sessionId]; the card links out to it. Derive a one-line
              // headline from the highlights (prefer a "burn"), else the score.
              const allHighlights = structured?.roastHighlights ?? [];
              const headlineSource =
                allHighlights.find((h) => h.type === "burn") ??
                allHighlights[0];
              const headline =
                headlineSource?.title || `Your portfolio scored ${score}/100`;
              const top = structured?.topPerformers?.[0];
              const worst = structured?.worstPerformers?.[0];

              const roastBlock: RoastSummaryBlock = {
                type: "roast-summary",
                sessionId,
                score,
                headline,
                // Skip the highlight already surfaced as the headline so the
                // card doesn't repeat it; keep the next few (mix of praise/burn).
                highlights: allHighlights
                  .filter((h) => h !== headlineSource)
                  .slice(0, 3)
                  .map((h) => ({
                    type: h.type,
                    emoji: h.emoji,
                    title: h.title,
                  })),
              };
              if (top) {
                roastBlock.topPerformer = {
                  symbol: top.symbol,
                  pnlPercent: top.pnlPercent,
                };
              }
              if (worst) {
                roastBlock.worstPerformer = {
                  symbol: worst.symbol,
                  pnlPercent: worst.pnlPercent,
                };
              }

              // Atomically flip the action block to executed AND append the
              // card, then persist immediately. This survives navigate-away/
              // back: the reload sees a finished roast (not the confirm modal
              // or a stuck "polling" block), and the id-dedupe stops a later
              // reconcile/re-poll from appending a second card.
              setMessages((prev) => {
                const withExecuted = prev.map((msg) => ({
                  ...msg,
                  blocks: msg.blocks?.map((b) =>
                    b.type === "action" && b.actionId === actionId
                      ? {
                          ...b,
                          status: "executed" as const,
                          result: `Roast complete — score ${score}/100`,
                        }
                      : b
                  ),
                }));
                const alreadyHasCard = withExecuted.some(
                  (m) => m.id === `roast-${sessionId}`
                );
                const updated = alreadyHasCard
                  ? withExecuted
                  : [
                      ...withExecuted,
                      {
                        id: `roast-${sessionId}`,
                        role: "assistant" as const,
                        content: `Portfolio Roast — Score ${score}/100`,
                        blocks: [roastBlock],
                        timestamp: new Date(),
                      },
                    ];
                void saveChat(updated);
                return updated;
              });
            } else {
              updateActionBlock(actionId, {
                status: "failed",
                result:
                  result.error ||
                  "Roast finished but the report couldn't be loaded.",
              });
            }
          } else if (status === "FAILED") {
            clearInterval(interval);
            pollIntervalsRef.current.delete(actionId);
            if (isSameChat()) {
              updateActionBlock(actionId, {
                status: "failed",
                result:
                  "Roast failed - your portfolio data may be unavailable. Try syncing your brokers and retrying.",
              });
            }
          }
        } catch (err) {
          console.error("[roast-poll]", err);
        }
      }, 5_000);

      pollIntervalsRef.current.set(actionId, interval);
    },
    [updateActionBlock, saveChat]
  );

  // Strategy-scan poll — mirrors startRoastPoll. A scan is a Pub/Sub worker job
  // (runStrategyAction → PENDING). The scanId rides on the action block's
  // `sessionId` field. On COMPLETED we fetch results and render a table; the
  // executed-flip + card append + save happen atomically (dedupe by message id)
  // so a reload shows the finished scan, never re-appends, and never orphans.
  const startScanPoll = useCallback(
    (actionId: string, scanId: string) => {
      let pollCount = 0;
      const MAX_POLLS = 60; // 60 * 5s = 5 min cap
      const triggeringChatId = chatIdRef.current;
      const isSameChat = () => chatIdRef.current === triggeringChatId;

      const interval = setInterval(async () => {
        pollCount++;
        if (pollCount > MAX_POLLS) {
          clearInterval(interval);
          pollIntervalsRef.current.delete(actionId);
          if (isSameChat()) {
            updateActionBlock(actionId, {
              status: "failed",
              result: "Scan is taking longer than expected. Please try again.",
            });
          }
          return;
        }

        try {
          const statusResult = await getScanStatusAction(scanId);
          if (!statusResult.success || !statusResult.data) return;
          const { status } = statusResult.data;

          if (isSameChat()) {
            updateActionBlock(actionId, {
              progress: status === "RUNNING" ? 60 : 15,
              currentStep:
                status === "RUNNING" ? "Scanning the market…" : "Queued…",
            });
          }

          if (status === "COMPLETED") {
            clearInterval(interval);
            pollIntervalsRef.current.delete(actionId);

            const result = await getScanResultAction(scanId);
            if (!isSameChat()) return;

            if (result.success && result.data) {
              const { scanName, stockCount } = result.data;
              const rows = Array.isArray(result.data.results)
                ? (result.data.results as Record<string, unknown>[])
                : [];
              const resultBlocks: ContentBlock[] = [
                {
                  type: "text",
                  content: `**${scanName}** — ${stockCount} stock${
                    stockCount === 1 ? "" : "s"
                  } matched.`,
                },
              ];
              if (rows.length > 0) {
                const sample = rows[0]!;
                const columns = Object.keys(sample)
                  .filter(
                    (k) => typeof sample[k] !== "object" || sample[k] === null
                  )
                  .slice(0, 6)
                  .map((key) => ({
                    key,
                    label: key
                      .replace(/([A-Z])/g, " $1")
                      .replace(/^./, (s) => s.toUpperCase()),
                    align: (typeof sample[key] === "number"
                      ? "right"
                      : "left") as "left" | "right",
                  }));
                resultBlocks.push({
                  type: "table",
                  title: scanName,
                  columns,
                  rows: rows.slice(0, 15),
                });
              }

              setMessages((prev) => {
                const withExecuted = prev.map((msg) => ({
                  ...msg,
                  blocks: msg.blocks?.map((b) =>
                    b.type === "action" && b.actionId === actionId
                      ? {
                          ...b,
                          status: "executed" as const,
                          result: `Scan complete — ${stockCount} match${
                            stockCount === 1 ? "" : "es"
                          }`,
                        }
                      : b
                  ),
                }));
                const dupId = `scan-${scanId}`;
                const updated = withExecuted.some((m) => m.id === dupId)
                  ? withExecuted
                  : [
                      ...withExecuted,
                      {
                        id: dupId,
                        role: "assistant" as const,
                        content: `${scanName} — ${stockCount} matches`,
                        blocks: resultBlocks,
                        timestamp: new Date(),
                      },
                    ];
                void saveChat(updated);
                return updated;
              });
            } else {
              updateActionBlock(actionId, {
                status: "failed",
                result:
                  result.error ||
                  "Scan finished but the results couldn't be loaded.",
              });
            }
          } else if (status === "FAILED") {
            clearInterval(interval);
            pollIntervalsRef.current.delete(actionId);
            if (isSameChat()) {
              updateActionBlock(actionId, {
                status: "failed",
                result:
                  statusResult.data.errorMessage ||
                  "Scan failed — please try again.",
              });
            }
          }
        } catch (err) {
          console.error("[scan-poll]", err);
        }
      }, 5_000);

      pollIntervalsRef.current.set(actionId, interval);
    },
    [updateActionBlock, saveChat]
  );

  // Insert a polling action block for a freshly-started scan, persist it
  // immediately (so navigate-away/back resumes instead of orphaning), and start
  // the poll. The scanId is carried on the action block's `sessionId` field.
  const beginScanTracking = useCallback(
    (scanId: string, params: Record<string, unknown>) => {
      const actionId = `scan-action-${scanId}`;
      const actionBlock: ContentBlock = {
        type: "action",
        actionId,
        tool: "run_strategy_scan",
        description: "Running strategy scan…",
        params,
        status: "polling",
        sessionId: scanId,
        progress: 10,
        currentStep: "Starting scan…",
      };
      setMessages((prev) => {
        // Guard against a double-insert if both dispatch paths fire.
        if (prev.some((m) => m.id === `scan-start-${scanId}`)) return prev;
        const updated: ChatMessageWithBlocks[] = [
          ...prev,
          {
            id: `scan-start-${scanId}`,
            role: "assistant" as const,
            content:
              "Strategy scan started — I'll show the matches when ready.",
            blocks: [actionBlock],
            timestamp: new Date(),
          },
        ];
        void saveChat(updated);
        return updated;
      });
      startScanPoll(actionId, scanId);
    },
    [saveChat, startScanPoll]
  );
  // Keep the ref current so sendMessage (declared earlier) can reach it.
  beginScanTrackingRef.current = beginScanTracking;

  // Report-generation poll — generate_report kicks off a background
  // DOCUMENT_PROCESS job and returns a documentId (carried on the action
  // block's `sessionId`). Poll getDocumentAction until processingStatus READY,
  // then append a download link. Persisted + reconciled like the others so the
  // chat tells the user it's done (not just "started") and survives navigation.
  const startReportPoll = useCallback(
    (actionId: string, documentId: string) => {
      let pollCount = 0;
      const MAX_POLLS = 60; // 60 * 5s = 5 min cap
      const triggeringChatId = chatIdRef.current;
      const isSameChat = () => chatIdRef.current === triggeringChatId;

      const interval = setInterval(async () => {
        pollCount++;
        if (pollCount > MAX_POLLS) {
          clearInterval(interval);
          pollIntervalsRef.current.delete(actionId);
          if (isSameChat()) {
            updateActionBlock(actionId, {
              status: "failed",
              result:
                "Report is taking longer than expected — check the Documents page shortly.",
            });
          }
          return;
        }

        try {
          const doc = await getDocumentAction(documentId);
          if (!doc.success || !doc.data) return;
          const ps = doc.data.processingStatus;

          if (ps === "READY") {
            clearInterval(interval);
            pollIntervalsRef.current.delete(actionId);
            if (!isSameChat()) return;

            const dl = await getDownloadUrlAction(documentId);
            const fileName = doc.data.fileName || "report.pdf";
            const links =
              dl.success && dl.data?.downloadUrl
                ? [
                    {
                      label: `Download ${fileName}`,
                      href: dl.data.downloadUrl,
                      icon: "arrow-right",
                      description: "Your generated report (PDF)",
                    },
                  ]
                : [
                    {
                      label: "Open Documents",
                      href: "/documents",
                      icon: "folder",
                      description: "Find your report in the Documents page",
                    },
                  ];

            setMessages((prev) => {
              const withExecuted = prev.map((msg) => ({
                ...msg,
                blocks: msg.blocks?.map((b) =>
                  b.type === "action" && b.actionId === actionId
                    ? {
                        ...b,
                        status: "executed" as const,
                        result: "Report ready",
                      }
                    : b
                ),
              }));
              const dupId = `report-${documentId}`;
              const updated = withExecuted.some((m) => m.id === dupId)
                ? withExecuted
                : [
                    ...withExecuted,
                    {
                      id: dupId,
                      role: "assistant" as const,
                      content: "Your report is ready to download.",
                      blocks: [
                        {
                          type: "text" as const,
                          content: "Your report is ready to download.",
                        },
                        { type: "navigation" as const, links },
                      ],
                      timestamp: new Date(),
                    },
                  ];
              void saveChat(updated);
              return updated;
            });
          } else if (ps === "FAILED") {
            clearInterval(interval);
            pollIntervalsRef.current.delete(actionId);
            if (isSameChat()) {
              updateActionBlock(actionId, {
                status: "failed",
                result: "Report generation failed — please try again.",
              });
            }
          } else if (isSameChat()) {
            updateActionBlock(actionId, {
              progress: 50,
              currentStep: "Generating your report…",
            });
          }
        } catch (err) {
          console.error("[report-poll]", err);
        }
      }, 5_000);

      pollIntervalsRef.current.set(actionId, interval);
    },
    [updateActionBlock, saveChat]
  );

  // Stop all active polls
  const stopAllPolls = useCallback(() => {
    pollIntervalsRef.current.forEach((interval) => {
      clearInterval(interval);
    });
    pollIntervalsRef.current.clear();
  }, []);

  // Cleanup polls on unmount
  useEffect(() => {
    return () => {
      stopAllPolls();
    };
  }, [stopAllPolls]);

  // Reconcile research ActionBlocks after chat history loads.
  // When a chat is reloaded, blocks are re-parsed from content and lose their
  // runtime state (sessionId, progress, polling status). This effect finds
  // run_research ActionBlocks, matches them to DB sessions by query string,
  // and either marks them completed (fetching results) or resumes polling.
  useEffect(() => {
    if (!initialChatId || messages.length === 0 || hasReconciledRef.current)
      return;

    const researchBlocks: Array<{
      actionId: string;
      query: string;
      sessionId?: string;
      status: string;
    }> = [];
    // Also track stream blocks that need taskProgress restoration
    const streamBlocksNeedingData: Array<{
      actionId: string;
      sessionId: string;
    }> = [];

    for (const msg of messages) {
      if (!msg.blocks) continue;
      for (const block of msg.blocks) {
        if (
          block.type === "action" &&
          block.tool === "run_research" &&
          (block.status === "pending" ||
            block.status === "polling" ||
            block.status === "confirmed")
        ) {
          const query =
            (block.params?.query as string) ||
            ("description" in block ? (block.description as string) : "") ||
            "";
          const sid =
            "sessionId" in block ? (block.sessionId as string) : undefined;
          researchBlocks.push({
            actionId: block.actionId,
            query,
            sessionId: sid,
            status: block.status,
          });
        }
        // Find completed stream blocks missing taskProgress (need data restoration)
        if (
          block.type === "research-stream" &&
          block.status === "completed" &&
          (!block.taskProgress || block.taskProgress.length === 0) &&
          block.sessionId
        ) {
          streamBlocksNeedingData.push({
            actionId: block.actionId,
            sessionId: block.sessionId,
          });
        }
      }
    }

    // Check for stale "results" messages (saved before blocks were persisted)
    const hasStaleResults = messages.some(
      (m) =>
        m.role === "assistant" &&
        m.content === "Here are the research results:" &&
        (!m.blocks ||
          m.blocks.length === 0 ||
          (m.blocks.length === 1 && m.blocks[0].type === "text"))
    );

    if (
      researchBlocks.length === 0 &&
      streamBlocksNeedingData.length === 0 &&
      !hasStaleResults
    )
      return;
    hasReconciledRef.current = true;

    const reconcile = async () => {
      const sessionsResult = await getRecentResearchSessionsAction();
      if (!sessionsResult.success || !sessionsResult.data) return;

      const sessions = sessionsResult.data;

      // Phase 1: Reconcile action blocks
      for (const rb of researchBlocks) {
        // Match by sessionId first, then by query string
        let matchedSession = rb.sessionId
          ? sessions.find((s) => s.sessionId === rb.sessionId)
          : null;

        if (!matchedSession && rb.query) {
          const normalizedQuery = rb.query.trim().toLowerCase();
          matchedSession = sessions.find(
            (s) => s.query.trim().toLowerCase() === normalizedQuery
          );
        }

        // Last resort: match the most recent session (for blocks with no query/sessionId)
        if (!matchedSession && !rb.query && !rb.sessionId) {
          matchedSession = sessions[0] || null;
        }

        if (!matchedSession) continue;

        if (matchedSession.status === "COMPLETED") {
          // Fetch status to get taskProgress for the stream block
          const statusData = await getResearchStatusAction(
            matchedSession.sessionId
          );
          updateActionBlock(rb.actionId, {
            status: "executed",
            sessionId: matchedSession.sessionId,
            result: "Research completed",
            progress: 100,
            taskProgress: statusData.data?.taskProgress,
            skill: statusData.data?.skill,
            totalSteps: statusData.data?.totalSteps,
          });

          const resultData = await getResearchResultAction(
            matchedSession.sessionId
          );
          if (resultData.success && resultData.data) {
            const blocks = buildStructuredReportBlocks(resultData.data);
            appendResearchResults(blocks, matchedSession.sessionId);
          }
        } else if (matchedSession.status === "FAILED") {
          updateActionBlock(rb.actionId, {
            status: "failed",
            sessionId: matchedSession.sessionId,
            result: "Research failed",
          });
        } else {
          // Still in progress - fetch latest status and resume polling
          const statusData = await getResearchStatusAction(
            matchedSession.sessionId
          );
          updateActionBlock(rb.actionId, {
            status: "polling",
            sessionId: matchedSession.sessionId,
            progress: statusData.data?.progress ?? matchedSession.progress,
            currentStep:
              statusData.data?.currentStep ||
              matchedSession.currentStep ||
              "Resuming...",
            taskProgress: statusData.data?.taskProgress,
            skill: statusData.data?.skill,
            totalSteps: statusData.data?.totalSteps,
          });
          startResearchPoll(rb.actionId, matchedSession.sessionId);
        }
      }

      // Phase 2: Refresh stale results messages
      if (researchBlocks.length === 0 && hasStaleResults) {
        const completedSession = sessions.find((s) => s.status === "COMPLETED");
        if (completedSession) {
          const resultData = await getResearchResultAction(
            completedSession.sessionId
          );
          if (resultData.success && resultData.data) {
            const blocks = buildStructuredReportBlocks(resultData.data);
            appendResearchResults(blocks, completedSession.sessionId);
          }
        }
      }

      // Phase 3: Restore taskProgress for completed stream blocks missing data
      for (const sb of streamBlocksNeedingData) {
        const statusData = await getResearchStatusAction(sb.sessionId);
        if (statusData.success && statusData.data?.taskProgress) {
          updateActionBlock(sb.actionId, {
            taskProgress: statusData.data.taskProgress,
            skill: statusData.data.skill,
            totalSteps: statusData.data.totalSteps,
          });
        }
      }
    };

    reconcile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialChatId, messages]);

  // Reconcile roast ActionBlocks after a chat reloads. A roast confirmed in a
  // prior visit persists as a "polling" action block carrying its sessionId
  // (saved at confirm time, above). On reload the in-memory poll is gone, so we
  // re-attach it here: startRoastPoll resumes status polling and finalizes the
  // compact card on COMPLETED (or marks failed). Without this the block would
  // sit forever showing "polling". Confirmation-modal reappearance is fixed by
  // the confirm-time save; this makes the resumed roast actually finish.
  useEffect(() => {
    if (
      !initialChatId ||
      messages.length === 0 ||
      hasRoastReconciledRef.current
    )
      return;

    // Both roast and strategy-scan jobs persist as a "polling" action block
    // carrying their id on `sessionId`; resume whichever poll is gone.
    // De-shadowed (MONEY-620): the block partitioning is the pure
    // partitionResumableJobBlocks in roast-reconcile-logic.ts.
    const { roastBlocks, scanBlocks, reportBlocks } =
      partitionResumableJobBlocks(
        messages as unknown as ResumableMessage[],
        (actionId) => pollIntervalsRef.current.has(actionId)
      );

    if (!hasResumableJobs({ roastBlocks, scanBlocks, reportBlocks })) return;
    hasRoastReconciledRef.current = true;

    for (const rb of roastBlocks) {
      startRoastPoll(rb.actionId, rb.sessionId);
    }
    for (const sb of scanBlocks) {
      startScanPoll(sb.actionId, sb.scanId);
    }
    for (const rp of reportBlocks) {
      startReportPoll(rp.actionId, rp.documentId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialChatId, messages]);

  const confirmAction = useCallback(
    async (actionId: string, tool: string, params: Record<string, unknown>) => {
      try {
        // For research tools, ensure query is present by extracting from block description
        let enrichedParams = params;
        if (tool === "run_research" && !params.query) {
          const block = messages
            .flatMap((m) => m.blocks || [])
            .find((b) => b.type === "action" && b.actionId === actionId);
          if (block && "description" in block && block.description) {
            enrichedParams = { ...params, query: block.description };
          }
        }

        const res = await fetch("/api/chat/execute-tool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool, params: enrichedParams, actionId }),
        });

        const data = await res.json();

        // Special handling for research tools - start polling
        if (tool === "run_research") {
          if (data.success && data.data?.sessionId) {
            const sessionId = data.data.sessionId as string;

            // Build the updated messages array in a single pass so we can
            // (a) apply the action-block sessionId update,
            // (b) append the ResearchStreamBlock, AND
            // (c) persist immediately (no 1000ms debounce) - all atomically.
            //
            // Without the immediate save, a user navigating away within the
            // first second of starting research loses the sessionId from the
            // persisted action block, and reconcileChatOnMount() can't re-attach
            // polling on return - the chat asks them to start research again
            // even though the backend job is still running. See MONEY-218.
            const streamBlock: ContentBlock = {
              type: "research-stream",
              sessionId,
              actionId,
              status: "running",
              progress: 0,
              currentStep: "Starting research...",
              // Carry the chosen depth so the card shows the REAL mode (e.g.
              // "Advanced") instead of a hardcoded label (MONEY-669).
              mode:
                typeof enrichedParams.mode === "string"
                  ? enrichedParams.mode
                  : undefined,
            };
            setMessages((prev) => {
              const withUpdatedAction = prev.map((msg) => ({
                ...msg,
                blocks: msg.blocks?.map((block) => {
                  if (block.type === "action" && block.actionId === actionId) {
                    return {
                      ...block,
                      status: "polling" as const,
                      sessionId,
                      progress: 0,
                      currentStep: "Starting research...",
                    };
                  }
                  return block;
                }),
              }));
              // MONEY-668: keep the confirm/"happening" action block and the
              // progress loader in ONE bubble instead of two separate StockSage
              // messages. Append the ResearchStreamBlock to the action block's
              // OWN message rather than spawning a standalone stream message.
              // (updateActionBlock finds blocks by type+actionId across all
              // messages, so polling still syncs both; appendResearchResults
              // skips any message containing a research-stream block, so the
              // final results still land in a fresh message.)
              let attached = false;
              const merged = withUpdatedAction.map((msg) => {
                if (
                  !attached &&
                  msg.blocks?.some(
                    (b) => b.type === "action" && b.actionId === actionId
                  )
                ) {
                  attached = true;
                  return {
                    ...msg,
                    blocks: [...(msg.blocks ?? []), streamBlock],
                    researchSessionId: sessionId,
                  };
                }
                return msg;
              });
              // Fallback: if the action message wasn't found (shouldn't happen),
              // append a standalone stream message so progress still renders.
              const updated = attached
                ? merged
                : [
                    ...merged,
                    {
                      id: `stream-${sessionId}`,
                      role: "assistant" as const,
                      content: "",
                      blocks: [streamBlock],
                      timestamp: new Date(),
                      researchSessionId: sessionId,
                    },
                  ];
              // Flush to DB immediately - durability over debounce here.
              void saveChat(updated);
              return updated;
            });

            startResearchPoll(actionId, sessionId);
            return;
          }
          // Research tool failed or sessionId missing
          const rawError = data.error || "";
          const friendlyError = rawError.includes("Invalid")
            ? "Something went wrong starting the research. Please try again."
            : rawError || "Failed to start research";
          updateActionBlock(actionId, {
            status: "failed",
            result: friendlyError,
          });
          toast.error(friendlyError);
          return;
        }

        // Roast - same lifecycle as research: confirm → execute →
        // updateActionBlock(polling) → startRoastPoll(actionId, sessionId).
        // The status block updates incrementally; final report appends as a
        // text message when COMPLETED.
        if (tool === "start_roast") {
          if (data.success && data.data?.sessionId) {
            const sessionId = data.data.sessionId as string;
            const startMsg =
              (data.data as { message?: string }).message ||
              "Roast in progress - score + commentary will appear here when ready.";

            // Persist the polling transition IMMEDIATELY (not just in React
            // state). Without this, navigating away and back reloaded the chat
            // from history with the block still "pending" — so the user saw the
            // confirm modal again and the running roast was orphaned. Mirrors
            // the research flow (MONEY-218). The roast reconcile effect re-
            // attaches the poll on reload.
            setMessages((prev) => {
              const updated = prev.map((msg) => ({
                ...msg,
                blocks: msg.blocks?.map((block) => {
                  if (block.type === "action" && block.actionId === actionId) {
                    return {
                      ...block,
                      status: "polling" as const,
                      sessionId,
                      progress: 0,
                      currentStep: startMsg,
                    };
                  }
                  return block;
                }),
              }));
              void saveChat(updated);
              return updated;
            });
            startRoastPoll(actionId, sessionId);
            return;
          }
          const errMsg = data.error || "Failed to start roast";
          updateActionBlock(actionId, { status: "failed", result: errMsg });
          toast.error(errMsg);
          return;
        }

        // Report generation (tax / risk / portfolio_statement PDF) is a
        // background DOCUMENT_PROCESS job. Persist a "generating" block carrying
        // the documentId, then poll to READY and append a download link — so the
        // chat actually tells the user it finished (not just "started") and the
        // job survives navigation. Without this it hit the generic handler below
        // and lied that the PDF was "fetched".
        if (tool === "generate_report") {
          if (data.success && data.data?.documentId) {
            const documentId = data.data.documentId as string;
            setMessages((prev) => {
              const updated = prev.map((msg) => ({
                ...msg,
                blocks: msg.blocks?.map((block) =>
                  block.type === "action" && block.actionId === actionId
                    ? {
                        ...block,
                        status: "polling" as const,
                        sessionId: documentId,
                        progress: 10,
                        currentStep: "Generating your report…",
                      }
                    : block
                ),
              }));
              void saveChat(updated);
              return updated;
            });
            startReportPoll(actionId, documentId);
            return;
          }
          const errMsg = data.error || "Failed to start report generation";
          updateActionBlock(actionId, { status: "failed", result: errMsg });
          toast.error(errMsg);
          return;
        }

        // Comprehensive analysis (L3) runs as a multi-minute worker job on its
        // own /analysis/[sessionId] page (the full streaming UI). Confirm →
        // start → mark the action done and surface a cross-navigation link to
        // that page. Without this branch it fell through to the generic handler
        // below, which mislabeled it "executed / Data fetched" and rendered the
        // raw {sessionId, creditsReserved, …} object inline instead of opening
        // the analysis page — the "cross navigation" bug.
        if (tool === "run_comprehensive_analysis") {
          if (data.success && data.data?.sessionId) {
            const sessionId = data.data.sessionId as string;
            const startMsg =
              (data.data as { message?: string }).message ||
              "Comprehensive analysis started.";
            updateActionBlock(actionId, {
              status: "executed",
              result: startMsg,
            });
            setMessages((prev) => {
              const updated: ChatMessageWithBlocks[] = [
                ...prev,
                {
                  id: `l3-nav-${sessionId}`,
                  role: "assistant" as const,
                  content: "",
                  blocks: [
                    {
                      type: "text",
                      content: `${startMsg} Track every segment live on the analysis page.`,
                    },
                    {
                      type: "navigation",
                      links: [
                        {
                          label: "Open Comprehensive Analysis",
                          href: `/analysis/${encodeURIComponent(sessionId)}`,
                          icon: "chart",
                          description:
                            "Watch the multi-segment deep dive stream in real time",
                        },
                      ],
                    },
                  ],
                  timestamp: new Date(),
                },
              ];
              void saveChat(updated);
              return updated;
            });
            return;
          }
          const errMsg = data.error || "Failed to start comprehensive analysis";
          updateActionBlock(actionId, { status: "failed", result: errMsg });
          toast.error(errMsg);
          return;
        }

        // Default handling for non-research tools
        if (data.success) {
          updateActionBlock(actionId, {
            status: "executed",
            result: "Data fetched successfully",
          });

          // Render the tool result as a new assistant message
          if (data.data && typeof data.data === "object") {
            const toolTitle =
              tool === "get_stock_news" ? "Stock News" : "Financial Data";
            const blocks: ContentBlock[] = [];

            if (Array.isArray(data.data) && data.data.length > 0) {
              // Array data (e.g. news articles) → render as table
              const sample = data.data[0] as Record<string, unknown>;
              const columns = Object.keys(sample)
                .filter(
                  (k) => typeof sample[k] !== "object" || sample[k] === null
                )
                .slice(0, 6)
                .map((key) => ({
                  key,
                  label: key
                    .replace(/([A-Z])/g, " $1")
                    .replace(/^./, (s) => s.toUpperCase()),
                  align: (typeof sample[key] === "number"
                    ? "right"
                    : "left") as "left" | "right",
                }));
              blocks.push({
                type: "table",
                title: toolTitle,
                columns,
                rows: (data.data as Record<string, unknown>[]).slice(0, 15),
              });
            } else {
              // Object data → render as metric card
              const items = Object.entries(data.data as Record<string, unknown>)
                .filter(
                  ([, v]) =>
                    typeof v === "string" ||
                    typeof v === "number" ||
                    typeof v === "boolean"
                )
                .slice(0, 12)
                .map(([k, v]) => ({
                  label: k
                    .replace(/([A-Z])/g, " $1")
                    .replace(/^./, (s) => s.toUpperCase()),
                  value:
                    typeof v === "number"
                      ? v.toLocaleString("en-IN")
                      : String(v),
                }));
              if (items.length > 0) {
                blocks.push({
                  type: "card",
                  variant: "metric",
                  title: toolTitle,
                  items,
                });
              }
            }

            if (blocks.length === 0) {
              blocks.push({
                type: "text",
                content: `${toolTitle}: Data retrieved successfully.`,
              });
            }

            const resultMsg: ChatMessageWithBlocks = {
              id: `result-${Date.now()}`,
              role: "assistant",
              content: "",
              blocks,
              timestamp: new Date(),
            };
            setMessages((prev) => {
              const updated = [...prev, resultMsg];
              setTimeout(() => saveChat(updated), 1000);
              return updated;
            });
          }
        } else {
          updateActionBlock(actionId, {
            status: "failed",
            result: data.error || "Action failed",
          });
          toast.error(data.error || "Action failed");
        }
      } catch {
        toast.error("Failed to execute action");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      updateActionBlock,
      startResearchPoll,
      startRoastPoll,
      startReportPoll,
      messages,
      saveChat,
    ]
  );

  const cancelAction = useCallback((actionId: string) => {
    setMessages((prev) =>
      prev.map((msg) => ({
        ...msg,
        blocks: msg.blocks?.map((block) => {
          if (block.type === "action" && block.actionId === actionId) {
            return { ...block, status: "cancelled" as const };
          }
          return block;
        }),
      }))
    );
  }, []);

  const clearChat = useCallback(() => {
    // MONEY-587 (C1): starting a fresh chat opens a new conversation epoch so
    // any in-flight response from the chat we just left is discarded instead of
    // landing in the empty new chat.
    convEpochRef.current += 1;
    stopAllPolls();
    setMessages([]);
    setStreamingId(undefined);
    setCurrentChatId(undefined);
    setCurrentPersonaId(undefined);
    chatIdRef.current = undefined;
  }, [stopAllPolls]);

  // Rough token estimate: ~4 chars per token
  const TOKEN_BUDGET = 100_000;
  const estimatedTokens = messages.reduce(
    (sum, m) => sum + Math.ceil((m.content?.length || 0) / 4),
    0
  );
  const contextUsage = Math.min(estimatedTokens / TOKEN_BUDGET, 1);

  const compactChat = useCallback(async () => {
    if (messages.length < 4) {
      toast.info("Not enough messages to compact.");
      return;
    }

    // MONEY-587 (C1): a compaction summary built from THIS chat must not replace
    // the messages of a different chat the user switched to mid-request.
    const epoch = convEpochRef.current;

    setIsLoading(true);
    try {
      // Build conversation text for summary
      const conversationText = messages
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n");

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message:
            "Summarize our conversation so far in 3-5 bullet points. Focus on: key topics discussed, specific stocks/funds mentioned, any analysis results, and what the user was exploring. Format as a concise summary.",
          queryType: "fast",
          pagePath,
          context: serializeContext(selectedContext),
          conversationHistory: [
            { role: "user" as const, content: conversationText },
          ],
        }),
      });

      const data = await res.json();

      // MONEY-587 (C1): user switched chats while the summary was generating —
      // drop it so we don't overwrite the chat now in view.
      if (convEpochRef.current !== epoch) return;

      const summaryText =
        data.response ||
        "Could not generate summary. Please try /clear instead.";

      // Preserve turn metadata from the last assistant message so
      // conversation state survives compaction (persona, symbols, screener)
      const lastAssistantMeta = [...messages]
        .reverse()
        .find((m) => m.role === "assistant" && m.turnMeta)?.turnMeta;

      // Replace all messages with a summary message
      const summaryMsg: ChatMessageWithBlocks = {
        id: Date.now().toString(),
        role: "assistant",
        content: `**Conversation Summary (compacted)**\n\n${summaryText}\n\n---\n*Previous messages have been compacted to save context space. You can continue your conversation from here.*`,
        blocks: [
          {
            type: "text",
            content: `**Conversation Summary (compacted)**\n\n${summaryText}\n\n---\n*Previous messages have been compacted to save context space. You can continue your conversation from here.*`,
          },
        ],
        timestamp: new Date(),
        turnMeta: lastAssistantMeta,
      };

      setMessages([summaryMsg]);
      toast.success("Conversation compacted! Context freed up.");
      setTimeout(() => saveChat([summaryMsg]), 1000);
    } catch {
      toast.error("Failed to compact conversation. Try /clear instead.");
    } finally {
      setIsLoading(false);
    }
  }, [messages, pagePath, selectedContext, serializeContext, saveChat]);

  const setContext = useCallback((mode: ChatContextMode) => {
    setSelectedContext(mode);
  }, []);

  const addLocalMessage = useCallback(
    (userText: string, assistantContent: string, navigateTo?: string) => {
      const userMsg: ChatMessageWithBlocks = {
        id: Date.now().toString(),
        role: "user",
        content: userText,
        timestamp: new Date(),
      };
      const blocks: ContentBlock[] = parseMessageToBlocks(assistantContent);
      // Add a navigation block if navigateTo is provided
      if (navigateTo) {
        blocks.push({
          type: "navigation",
          links: [
            {
              label: "Open Page",
              href: navigateTo,
              icon: "arrow-right",
              description: `Navigate to ${navigateTo}`,
            },
          ],
        });
      }
      const assistantMsg: ChatMessageWithBlocks = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: assistantContent,
        blocks,
        timestamp: new Date(),
      };
      setMessages((prev) => {
        const updated = [...prev, userMsg, assistantMsg];
        setTimeout(() => saveChat(updated), 1000);
        return updated;
      });
    },
    [saveChat]
  );

  const executeToolDirect = useCallback(
    async (userText: string, tool: string, params: Record<string, unknown>) => {
      // MONEY-587 (C1): same cross-chat guard as sendMessage — a deep-linked /
      // slash tool dispatch must not write its result into a chat the user
      // navigated to while it was running.
      const epoch = convEpochRef.current;
      const isSameConversation = () => convEpochRef.current === epoch;

      const userMsg: ChatMessageWithBlocks = {
        id: Date.now().toString(),
        role: "user",
        content: userText,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);

      try {
        // Synthetic actionId - the execute-tool route requires a
        // `confirm-<uuid>`-shaped id (originally minted by the chat
        // route for write-tool confirmations). For slash-command
        // direct dispatch there is no prior confirm step, so we mint
        // one client-side; the route only uses it for logging.
        // De-shadowed (MONEY-620): the synthesizer is shared with the route's
        // validator in execute-tool/route-logic.ts.
        const actionId = synthesizeSlashActionId();
        const res = await fetch("/api/chat/execute-tool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool, params, actionId }),
        });

        const data = await res.json();

        // MONEY-587 (C1): bail if the user switched chats while the tool ran.
        if (!isSameConversation()) return;

        // For research tools that need polling, use the same flow as confirmAction
        if (tool === "run_research" && data.success && data.data?.sessionId) {
          const sessionId = data.data.sessionId as string;
          const actionId = `slash-${Date.now()}`;
          const actionBlock: ContentBlock = {
            type: "action",
            actionId,
            tool,
            description: `Running ${tool} analysis...`,
            params,
            status: "polling",
            sessionId,
            progress: 0,
            currentStep: "Starting research...",
          };
          const assistantMsg: ChatMessageWithBlocks = {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            content: "Research started! I'll track the progress.",
            blocks: [actionBlock],
            timestamp: new Date(),
          };
          setMessages((prev) => {
            const updated = [...prev, assistantMsg];
            setTimeout(() => saveChat(updated), 1000);
            return updated;
          });
          startResearchPoll(actionId, sessionId);
          return;
        }

        // Strategy scan kicked off via the deterministic path — track it the
        // same way (poll + persisted block + reconcile-on-reload).
        if (tool === "run_strategy_scan" && data.success && data.data?.scanId) {
          beginScanTracking(data.data.scanId as string, params);
          return;
        }

        // MONEY-1121 - report generation started from the DETERMINISTIC path
        // (`/report tax`) must be polled too. `confirmAction` has always done
        // this, so a report kicked off from a confirmation card delivered its
        // link — but a slash command landed on the generic handler below, which
        // rendered tool-narration's "a download link will appear here as soon
        // as it's ready" and then never produced one, because nothing was
        // polling (MONEY-1095 item 4). Mirrors the research branch above.
        if (
          tool === "generate_report" &&
          data.success &&
          data.data?.documentId
        ) {
          const documentId = data.data.documentId as string;
          const actionId = `report-${Date.now()}`;
          const actionBlock: ActionBlock = {
            type: "action",
            actionId,
            tool,
            description: `Generating your ${
              typeof params.type === "string" ? params.type : ""
            } report...`.replace(/\s+/g, " "),
            params,
            status: "polling",
            sessionId: documentId,
            progress: 10,
            currentStep: "Generating your report…",
          };
          const assistantMsg: ChatMessageWithBlocks = {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            content:
              "Generating your report — I'll post the download link here.",
            blocks: [actionBlock],
            timestamp: new Date(),
          };
          setMessages((prev) => {
            const updated = [...prev, assistantMsg];
            setTimeout(() => saveChat(updated), 1000);
            return updated;
          });
          startReportPoll(actionId, documentId);
          return;
        }

        const responseText = data.success
          ? data.response || "Here are the results:"
          : data.error || "Failed to execute command.";

        const blocks: ContentBlock[] =
          data.blocks || parseMessageToBlocks(responseText);

        const assistantMsg: ChatMessageWithBlocks = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: responseText,
          blocks,
          timestamp: new Date(),
        };

        setMessages((prev) => {
          const updated = [...prev, assistantMsg];
          setTimeout(() => saveChat(updated), 1000);
          return updated;
        });
      } catch {
        // MONEY-587 (C1): keep the failure notice in its originating chat only.
        if (isSameConversation()) {
          const errorMsg: ChatMessageWithBlocks = {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            content: "Failed to execute command. Please try again.",
            blocks: [
              {
                type: "error",
                severity: "error",
                title: "Command Error",
                message: "Failed to execute command. Please try again.",
              },
            ],
            timestamp: new Date(),
          };
          setMessages((prev) => [...prev, errorMsg]);
        }
      } finally {
        setIsLoading(false);
      }
    },
    [saveChat, startResearchPoll, beginScanTracking, startReportPoll]
  );

  const value: ChatContextValue = {
    messages,
    isLoading,
    streamingId,
    selectedContext,
    queryType,
    subscriptionAccess,
    currentChatId,
    dashboardStats,
    currentPersonaId,
    pickerRequest,
    requestStockPicker,
    citationMsgId,
    setCitationMsgId,
    sendMessage,
    executeQuickAction,
    setContext,
    setQueryType,
    confirmAction,
    cancelAction,
    clearChat,
    compactChat,
    contextUsage,
    setDashboardStats,
    hideContextSelector: hideCtxSelector,
    addLocalMessage,
    executeToolDirect,
    loadFullReport,
    cancelRequest: useCallback(() => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      setStreamingId(undefined);
    }, []),
    selectResearchOption: useCallback(
      (
        optionId: string,
        tool: string,
        params: Record<string, unknown>,
        actionId?: string
      ) => {
        // Mark the prompt block as selected
        if (actionId) {
          setMessages((prev) =>
            prev.map((m) => ({
              ...m,
              blocks: m.blocks?.map((b) =>
                b.type === "research-prompt" && b.actionId === actionId
                  ? {
                      ...b,
                      status: "selected" as const,
                      selectedOptionId: optionId,
                    }
                  : b
              ),
            }))
          );
        }

        // Trigger the research via confirmAction
        const aid = actionId || `research-${Date.now()}`;
        confirmAction(aid, tool, params);
      },
      [confirmAction]
    ),
    cancelResearchPrompt: useCallback((actionId?: string) => {
      if (actionId) {
        setMessages((prev) =>
          prev.map((m) => ({
            ...m,
            blocks: m.blocks?.map((b) =>
              b.type === "research-prompt" && b.actionId === actionId
                ? { ...b, status: "cancelled" as const }
                : b.type === "action" && b.actionId === actionId
                  ? { ...b, status: "cancelled" as const }
                  : b
            ),
          }))
        );
      }
    }, []),
  };

  return <ChatCtx.Provider value={value}>{children}</ChatCtx.Provider>;
}
