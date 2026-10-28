"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  ScanSearch,
  X,
  Plus,
  Send,
  Sparkles,
  Maximize2,
  Minimize2,
  History,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Content, Part } from "@google/genai";
import { cn } from "@usemoney/utils";
import { AI_ADVISORY_DISCLOSURE } from "@/lib/consent/ai-advisory";
import type { ScreenerMode } from "@/components/screener/ModeTabs";
import ChatLauncherButton from "@/components/chat/ChatLauncherButton";
import { useScreenerChat } from "../lib/chat/ScreenerActionsContext";
import { executeScreenerTool } from "../lib/chat/toolExecutor";
import {
  useSideChatHistory,
  useChatIdFromUrl,
} from "@/hooks/useSideChatHistory";
import SideChatHistoryList from "@/components/chat/SideChatHistoryList";
import { screenerChatScope } from "@/lib/chat-history/side-chat-scopes";
import { useIsMobile } from "@/hooks/use-mobile";
import { isInsidePortalledOverlay } from "@/lib/ui/portal-overlays";
import type { ScreenerSnapshot } from "../lib/chat/systemPrompt";

/* =====================================================================
   AskScreenerPanel — MONEY-1077 (UI) · MONEY-1078 (tool-calling)
   ---------------------------------------------------------------------
   Slide-in "Ask Screener" chat sidebar for the Screener page, following
   the AskFirePanel pattern (MONEY-939 UI phase → MONEY-1049 wiring).

   MONEY-1078 wires it to Gemini function-calling: `handleSend` posts the
   conversation + a live screener snapshot to /api/screener-chat, executes
   any returned tool calls against the page state (via
   ScreenerActionsContext → toolExecutor), then asks the model for a
   natural-language confirmation.
   ===================================================================== */

type ChatRole = "user" | "assistant";

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
}

/** Empty-state suggestion chips, per screener mode. */
const SUGGESTIONS: Record<ScreenerMode, readonly string[]> = {
  stocks: [
    "IT stocks with PE under 25",
    "Midcaps with ROE above 20%",
    "Low-debt dividend payers",
    "What does this screen show?",
  ],
  mf: [
    "Best 5Y-return flexi cap funds",
    "Index funds with lowest expense ratio",
    "Low-risk debt funds over ₹1,000 Cr AUM",
    "What does this screen show?",
  ],
  etf: [
    "Gold ETFs by AUM",
    "Nifty 50 ETFs with lowest expense ratio",
    "Best 1Y-return sector ETFs",
    "What does this screen show?",
  ],
};

const MODE_LABEL: Record<ScreenerMode, string> = {
  stocks: "stocks",
  mf: "mutual funds",
  etf: "ETFs",
};

interface ScreenerChatResponse {
  text: string | null;
  functionCalls: {
    id?: string;
    name: string;
    args: Record<string, unknown>;
  }[];
  source?: "llm";
}

/** POST the conversation + live screener snapshot to the chat endpoint. */
async function postScreenerChat(
  contents: Content[],
  snapshot: ScreenerSnapshot,
  signal?: AbortSignal
): Promise<ScreenerChatResponse> {
  const res = await fetch("/api/screener-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, snapshot }),
    signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    throw new Error(
      body.detail || body.error || `Request failed (${res.status})`
    );
  }
  return (await res.json()) as ScreenerChatResponse;
}

/** Max messages kept per chat (~12 exchanges). Each turn re-POSTs the whole
    conversation, so an unbounded history is O(n²) tokens over a long session
    ("New chat" also resets it). */
const MAX_HISTORY = 24;

/**
 * Bound conversation growth by dropping the oldest turns, but ONLY cut at a
 * fresh user-message boundary (a user turn carrying TEXT, not functionResponse
 * parts) so a functionCall is never split from its functionResponse — the
 * tool-loop's core invariant. If the tail has no safe cut point, leave it.
 */
function capHistory(convo: Content[]): Content[] {
  if (convo.length <= MAX_HISTORY) return convo;
  for (let i = convo.length - MAX_HISTORY; i < convo.length; i++) {
    const m = convo[i];
    const isUserText =
      m?.role === "user" &&
      (m.parts ?? []).some(
        (p) => typeof p.text === "string" && p.text.length > 0
      );
    if (isUserText) return convo.slice(i);
  }
  return convo;
}

/**
 * Wait for the screener's refetch to settle after a tool batch.
 *
 * Yielding a macrotask only flushes React — the actual results come from a
 * server action inside `startTransition`, which takes hundreds of ms. Without
 * this wait the next hop would read NEW filters paired with the PREVIOUS
 * result count, so "filter to PE < 10 and tell me how many match" would
 * confidently report the pre-filter number. Bounded so a hung fetch can't
 * stall the turn (the wall clock still applies on top).
 */
async function waitForResults(
  isFetching: () => boolean,
  fetchGeneration: () => number,
  startGeneration: number,
  capMs = 6_000
): Promise<void> {
  const deadline = Date.now() + capMs;
  // Wait for a SETTLE, not for a flag. `isFetching` reads false both before
  // the refetch effect starts and after it finishes, so polling it alone
  // cannot tell those apart — the old fixed 50 ms sleep was the only thing
  // separating them, and losing that race meant snapshotting the PRE-filter
  // count with no staleness marker: exactly the bug this wait exists to
  // prevent. The generation counter only advances when a fetch completes.
  while (fetchGeneration() === startGeneration && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  // A settle happened (or we timed out). If another refetch was queued
  // behind it, ride that one out too.
  while (isFetching() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Ensure the conversation never ENDS on a functionResponse turn.
 *
 * Tool results are sent back as a `user` turn. If a turn exits before the
 * model acknowledges them — a hop timeout, a thrown fetch, or the hop cap —
 * the thread's last entry is that user turn, so the NEXT send appends a
 * second consecutive user turn. Some Gemini paths reject back-to-back user
 * turns outright, and either way the tool results are left unanswered, which
 * skews the model's reading of what happened.
 *
 * Appending a short synthetic model turn closes the exchange honestly: it
 * states the turn was cut short rather than inventing a result.
 */
function closeDanglingToolTurn(convo: Content[]): Content[] {
  const last = convo[convo.length - 1];
  const endsOnToolResult =
    last?.role === "user" && (last.parts ?? []).some((p) => p.functionResponse);
  if (!endsOnToolResult) return convo;
  return [
    ...convo,
    {
      role: "model",
      parts: [
        {
          text: "(That turn was cut short. The changes listed above were applied; nothing further was done.)",
        },
      ],
    },
  ];
}

/** Compact markdown for assistant replies (bold, lists, code, links). */
function AssistantMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      components={{
        p: ({ children }) => <p style={{ margin: "0 0 6px" }}>{children}</p>,
        ul: ({ children }) => (
          <ul style={{ margin: "0 0 6px", paddingLeft: 18 }}>{children}</ul>
        ),
        ol: ({ children }) => (
          <ol style={{ margin: "0 0 6px", paddingLeft: 18 }}>{children}</ol>
        ),
        li: ({ children }) => <li style={{ marginBottom: 2 }}>{children}</li>,
        strong: ({ children }) => (
          <strong style={{ fontWeight: 700 }}>{children}</strong>
        ),
        em: ({ children }) => <em>{children}</em>,
        code: ({ children }) => (
          <code
            className="mono"
            style={{
              background: "var(--rule-softer, rgba(0,0,0,0.06))",
              padding: "1px 5px",
              borderRadius: 4,
              fontSize: 12.5,
            }}
          >
            {children}
          </code>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            style={{ textDecoration: "underline" }}
          >
            {children}
          </a>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export default function AskScreenerPanel({ mode }: { mode: ScreenerMode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const bridge = useScreenerChat();

  /* MONEY-1242/1244 — the expand control is RENDERED CONDITIONALLY, not
     hidden with a class. `.pf-bf` sets `display: inline-flex` in
     playful-app.css, which layout.tsx imports AFTER globals.css — and
     globals.css is where `@tailwind utilities` emits `.hidden` AND the
     responsive `.md\:grid`. Same specificity, later source, no @layer: so
     `.pf-bf` beat BOTH, and the button rendered inline-flex at every width.
     `hidden md:grid` did nothing at all; there was no width at which it
     worked. That cascade is FIXED now — playful-app.css declares `.pf-bf`'s
     `display` through `:where()`, at zero specificity, so display utilities
     win again. Conditional rendering is kept regardless: it also keeps the
     control out of the tab order, which `hidden` alone would not. Breakpoint
     matches the shared hook (768px): below it the panel is already `w-full`,
     so expanding is a literal no-op anyway. */
  const isMobile = useIsMobile();

  /* MONEY-1245 — chat history. This conversation used to live only in
     `conversationRef`, so a refresh lost it and there was nothing to see or
     delete. The hook is shared with AskFirePanel rather than copied. */
  /* Scoped PER MODE (MONEY-1245 follow-up). All three modes used to save under
     the bare "/discover/screener", so stocks, ETF and MF chats piled into one
     undifferentiated list and a resumed ETF chat could replay its screen edits
     onto the stocks screen.

     Switching mode mid-conversation re-scopes the LIST but not the open chat:
     the panel deliberately keeps one conversation across a mode switch, and
     `saveChatHistory`'s update branch never rewrites `pagePath`, so the row
     stays filed under the mode it began in. A chat therefore belongs to where
     it started, which is also where resuming it puts you back. The visible
     consequence is narrow and preferred to the alternative: after a switch,
     the current chat is not in the list being shown. Calling `startNew()` here
     instead would file the two halves of one conversation as two rows with
     duplicated content. */
  const history = useSideChatHistory(screenerChatScope(mode));
  const {
    save: saveHistory,
    load: loadHistory,
    startNew: startNewHistory,
  } = history;
  const [showHistory, setShowHistory] = useState(false);

  /* MONEY-1244 — expand the rail to a full-screen reading surface. Screening
     answers and result tables are wide, and the 380px rail makes them hard to
     read. Off by default; reset on close so reopening is always the familiar
     rail. Below `sm` the panel is already `w-full`, so this only changes
     anything on desktop. */
  const [isExpanded, setIsExpanded] = useState(false);
  useEffect(() => {
    if (!isOpen) setIsExpanded(false);
  }, [isOpen]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const isFirstRunRef = useRef(true);
  /** MONEY-1245: message count at the last successful save, so a re-render
      does not re-POST an unchanged transcript. */
  const lastSavedCountRef = useRef(0);
  // Gemini conversation turns (functionCall + functionResponse parts)
  // accumulated across sends.
  const conversationRef = useRef<Content[]>([]);
  // Synchronous in-flight guard. `isLoading` is captured state, so two
  // Enter presses in the same tick both see `false` and start two loops
  // that interleave writes to conversationRef.
  const sendingRef = useRef(false);
  // Bumped by "New chat". A turn captures this at send time and discards its
  // own output if the value moved while it was in flight.
  const chatEpochRef = useRef(0);

  const isEmpty = messages.length === 0;

  /* ── Close on Escape ─────────────────────────────────────────────── */
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  /* ── Close on outside click (MONEY-1244) ─────────────────────────────
     There was no such handler: the only dismiss-by-click surface was the
     mobile backdrop below, which is `sm:hidden`, so on desktop clicking away
     did nothing and Escape was the only way out.

     `pointerdown`, not `click`, so the panel dismisses on press like every
     other popover — and so a click that starts inside and drags out (text
     selection in an answer) does not close it.

     The toggle is excluded explicitly: it sits OUTSIDE the panel, so without
     this the button would close the panel here and immediately reopen it in
     its own onClick, making it look dead. ───────────────────────────── */
  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (toggleRef.current?.contains(target)) return;
      // Radix renders dropdowns/selects into a PORTAL under document.body, so
      // they are visually on top of this panel but not inside `panelRef`.
      // Without this, pressing an item in the history row's ⋯ menu counted as
      // an outside click and closed the panel under the menu being used.
      if (isInsidePortalledOverlay(target)) return;
      setIsOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [isOpen]);

  /* ── a11y: keep the closed (off-screen) panel `inert` so its controls
     leave the tab order + accessibility tree, and move focus into the panel
     on open / back to the toggle on close. Skip the very first run so we
     never steal focus on initial page load. ─────────────────────────── */
  useEffect(() => {
    if (panelRef.current) panelRef.current.inert = !isOpen;
    if (isFirstRunRef.current) {
      isFirstRunRef.current = false;
      return;
    }
    if (isOpen) {
      textareaRef.current?.focus();
    } else {
      toggleRef.current?.focus();
    }
  }, [isOpen]);

  /* ── Auto-scroll to newest message ───────────────────────────────── */
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  /* ── Auto-resize the textarea (caps at 160px) ────────────────────── */
  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, []);

  const appendAssistant = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "assistant", content },
    ]);
  }, []);

  /* ── Send: Gemini tool-calling loop (MONEY-1078) ──────────────────────
     Bounded multi-hop: POST → if the model returns function calls, execute
     each against the live screener, append the model turn (functionCall
     parts) and a user turn (matching functionResponse parts), and POST
     again — repeating until it replies with plain text (or the hop cap).
     Every functionCall is always immediately answered, so
     `conversationRef` never holds orphaned calls. ───────────────────── */
  const handleSend = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || isLoading || sendingRef.current) return;
      sendingRef.current = true;
      // The thread this turn belongs to. If "New chat" bumps the epoch while
      // we're awaiting Gemini, the post-processing below drops the result.
      const epoch = chatEpochRef.current;

      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", content: text },
      ]);
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";

      if (!bridge) {
        appendAssistant("The Screener assistant isn't connected on this page.");
        sendingRef.current = false; // never leave the guard stuck on
        return;
      }

      setIsLoading(true);
      let convo: Content[] = [
        ...conversationRef.current,
        { role: "user", parts: [{ text }] },
      ];
      const summaries: string[] = [];
      let finalText: string | null = null;
      let caught: unknown = null;

      try {
        // Cap the tool → response → tool chain so a looping model can't
        // spin. Gemini batches parallel calls natively (a multi-filter
        // request normally resolves in 2 hops); 6 leaves room for a
        // sequential caller without runaway cost.
        const MAX_HOPS = 6;
        // Per-hop abort + a whole-turn wall clock so a slow/stuck hop can't
        // leave the panel spinning on "thinking…" forever.
        const HOP_TIMEOUT_MS = 30_000;
        const WALL_CLOCK_MS = 90_000;
        const deadline = Date.now() + WALL_CLOCK_MS;
        for (let hop = 0; hop < MAX_HOPS; hop++) {
          if (Date.now() > deadline) {
            throw new Error(
              "The assistant took too long. Any earlier changes were applied — try again."
            );
          }
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), HOP_TIMEOUT_MS);
          let reply: ScreenerChatResponse;
          try {
            reply = await postScreenerChat(
              convo,
              bridge.getSnapshot(),
              controller.signal
            );
          } catch (e) {
            if (controller.signal.aborted) {
              throw new Error(
                "The assistant timed out on this step. Any earlier changes were applied — try again."
              );
            }
            throw e;
          } finally {
            clearTimeout(timer);
          }

          if (reply.functionCalls.length === 0) {
            // An EMPTY candidate — no text AND no function call — is a real
            // Gemini failure mode (see the thinkingConfig note in the route).
            // NEVER append `{ text: "" }` for it: Vertex rejects empty parts,
            // so the poisoned turn would fail every SUBSEQUENT send in this
            // chat, turning one bad response into a permanently broken thread.
            // Leave history untouched and let the reply below say what
            // happened.
            const replyText = reply.text?.trim() ? reply.text : null;
            if (replyText) {
              convo = [
                ...convo,
                { role: "model", parts: [{ text: replyText }] },
              ];
            }
            finalText = replyText;
            break;
          }

          // Snapshot the settle counter BEFORE the tools mutate state, so
          // the wait below can tell "this hop's refetch finished" from
          // "no refetch has started yet".
          const generationBeforeTools = bridge.fetchGeneration();

          // Execute each call, collecting the model turn parts and the
          // matching functionResponse parts to feed back.
          const modelParts: Part[] = [];
          const responseParts: Part[] = [];
          if (reply.text) modelParts.push({ text: reply.text });

          for (const call of reply.functionCalls) {
            // Echo Gemini's call id (when present) so it can match the
            // response to the call — required for parallel tool calls.
            const idPart = call.id ? { id: call.id } : {};
            modelParts.push({
              functionCall: { ...idPart, name: call.name, args: call.args },
            });

            const result = executeScreenerTool(
              call.name,
              call.args,
              bridge.getActiveMode,
              bridge.actions
            );
            responseParts.push({
              functionResponse: {
                ...idPart,
                name: call.name,
                response: result.ok
                  ? { result: result.message }
                  : { error: result.error },
              },
            });
            summaries.push(result.ok ? result.message : `⚠️ ${result.error}`);
          }

          convo = [
            ...convo,
            { role: "model", parts: modelParts },
            { role: "user", parts: responseParts },
          ];

          // Let React commit AND the results refetch land before the next
          // hop snapshots the page — otherwise the model reasons about the
          // new filters against the old result set.
          await waitForResults(
            bridge.isFetching,
            bridge.fetchGeneration,
            generationBeforeTools
          );

          // Exiting via the hop cap would leave `convo` ending in a
          // functionResponse (user) turn, so the NEXT send would append a
          // second consecutive user turn — which some Gemini paths reject,
          // and which leaves those tool results unacknowledged. Close the
          // exchange with a synthetic model turn instead.
          if (hop === MAX_HOPS - 1) {
            convo = [
              ...convo,
              {
                role: "model",
                parts: [
                  {
                    text: "(Stopped after applying the changes above — the step limit for one message was reached.)",
                  },
                ],
              },
            ];
          }
        }
      } catch (err) {
        // Tool calls execute as they arrive, so earlier hops' changes are
        // already applied — record the error and fall through to the shared
        // post-processing so partial progress is reported, not lost.
        caught = err;
      }

      try {
        // "New chat" pressed while this turn was in flight? Then the thread
        // it belongs to no longer exists. Writing its history back and
        // appending its reply would silently UNDO the reset — the user would
        // see a cleared panel suddenly sprout an answer to a question they
        // just discarded, with the old conversation restored underneath.
        // Drop the output; the tool calls already applied to the page stand,
        // which is correct — they were real edits to the screen.
        if (chatEpochRef.current !== epoch) return;

        // Persist whatever hops completed — on errors too, so the next
        // turn's history matches the changes already applied to the page.
        //
        // But NEVER leave the thread ending on a functionResponse (a `user`
        // turn): the next send would append a second consecutive user turn,
        // which some Gemini paths reject, and those tool results would sit
        // unacknowledged. The hop-cap path already closes the exchange with a
        // synthetic model turn; a hop TIMEOUT or a mid-loop throw exits
        // without doing so, so normalise here for every exit path.
        conversationRef.current = capHistory(closeDanglingToolTurn(convo));

        if (caught) {
          const applied =
            summaries.length > 0
              ? ` Changes applied before the error: ${summaries.join(" ")}`
              : "";
          appendAssistant(
            `Sorry, I couldn't finish that: ${
              caught instanceof Error ? caught.message : "unknown error"
            }.${applied}`
          );
        } else if (finalText) {
          appendAssistant(finalText);
        } else if (summaries.length > 0) {
          // Tools ran but the model added no prose — report what changed.
          appendAssistant(summaries.join(" "));
        } else {
          // Nothing at all came back: the empty-candidate case above. Say so
          // rather than claiming "Done." for a turn that did nothing.
          appendAssistant(
            "I didn't get a usable response for that — nothing was changed. Try rephrasing it."
          );
        }
      } finally {
        // Only clear the in-flight flags if THIS turn still owns them. After
        // "New chat" the user may already have sent a NEW message; that turn
        // bumped nothing but does own sendingRef/isLoading. A stale turn
        // resolving later would otherwise hide the live spinner and disarm
        // the double-send guard, letting two loops interleave writes to
        // conversationRef — the exact race sendingRef exists to prevent.
        if (chatEpochRef.current === epoch) {
          setIsLoading(false);
          sendingRef.current = false;
        }
      }
    },
    [bridge, isLoading, appendAssistant]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(input);
    }
  };

  const handleNewChat = () => {
    // Invalidate any turn still in flight so its result can't land in the
    // fresh thread (see the epoch check in handleSend's post-processing).
    chatEpochRef.current += 1;
    setMessages([]);
    setInput("");
    conversationRef.current = [];
    setIsLoading(false);
    sendingRef.current = false;
    // MONEY-1245: forget the row we were appending to, so this starts a NEW
    // saved chat instead of overwriting the one just left.
    startNewHistory();
    lastSavedCountRef.current = 0;
    // Leave the history list — starting a new chat while still looking at a
    // list of old ones reads as though the button did nothing.
    setShowHistory(false);
    textareaRef.current?.focus();
  };

  /* MONEY-1245 — persist after each COMPLETED turn.
     Saving inside handleSend would capture `messages` from before its own
     setState, so the last exchange would always be one turn behind. Keying
     off `isLoading` falling back to false means we save exactly the state the
     user can see. The count guard stops a re-render re-saving unchanged
     content. */
  useEffect(() => {
    if (isLoading) return;
    if (messages.length === 0) return;
    if (messages.length === lastSavedCountRef.current) return;
    lastSavedCountRef.current = messages.length;
    void saveHistory(messages, conversationRef.current);
  }, [messages, isLoading, saveHistory]);

  /** Replace the panel with a stored chat: transcript AND tool turns. */
  const handleOpenHistory = useCallback(
    async (id: string) => {
      const restored = await loadHistory(id);
      if (!restored) return;
      // Invalidate any in-flight turn so its result cannot land in the
      // restored thread.
      chatEpochRef.current += 1;
      setMessages(restored.messages);
      // Without the tool turns the model would resume blind to the screen
      // edits it already made.
      conversationRef.current = restored.conversation;
      lastSavedCountRef.current = restored.messages.length;
      setShowHistory(false);
      textareaRef.current?.focus();
    },
    [loadHistory]
  );

  /* Resume a chat opened from /chat-history (?chatId=). The panel starts
     closed, so the deep link has to open it as well — restoring a transcript
     into a panel the user cannot see is indistinguishable from nothing
     happening, which is the bug this fixes. */
  const handleResumeFromUrl = useCallback(
    (id: string) => {
      setIsOpen(true);
      void handleOpenHistory(id);
    },
    [handleOpenHistory]
  );
  useChatIdFromUrl(handleResumeFromUrl);

  return (
    <>
      {/* ── Toggle button on the right edge ──────────────────────────── */}
      {!isOpen && (
        <ChatLauncherButton
          ref={toggleRef}
          onClick={() => setIsOpen(true)}
          title="Open Ask Screener"
        >
          <ScanSearch className="h-4 w-4" />
          <span className="hidden sm:inline">Ask Screener</span>
        </ChatLauncherButton>
      )}

      {/* ── Side panel ──────────────────────────────────────────────────
          Sits BELOW the global topbar+ticker (--topbar-h) so it never
          overlaps the nav chrome, and ABOVE the global bottom nav
          (--mobile-nav-h) so the bar can't cover its composer — same anchoring
          as AskFirePanel (MONEY-1151). */}
      <div
        ref={panelRef}
        className={cn(
          "fixed right-0 z-50 ease-in-out",
          // MONEY-1244: width animates alongside the existing open/close
          // transform, so expanding slides rather than snapping.
          "transition-[transform,width] duration-300",
          "bg-[var(--paper)] border-l border-[var(--rule-soft)] shadow-2xl",
          // MONEY-1244: rounded on the leading (left) edge only — the panel is
          // flush to the viewport's right edge, so rounding that side would
          // just cut the background out from under it.
          "sm:rounded-l-2xl overflow-hidden",
          isExpanded ? "w-full" : "w-full sm:w-[380px]",
          isOpen ? "translate-x-0" : "translate-x-full"
        )}
        style={{
          top: "var(--topbar-h, 5.25rem)",
          height:
            "calc(100dvh - var(--topbar-h, 5.25rem) - var(--mobile-nav-h, 0px))",
        }}
      >
        <div className="flex flex-col h-full pf-app">
          {/* ── Header ──────────────────────────────────────────────── */}
          <div
            className="flex items-center justify-between px-4 py-3 shrink-0"
            style={{ borderBottom: "2px solid var(--ink)" }}
          >
            <div className="flex items-center gap-2.5">
              <div
                className="grid place-items-center shrink-0"
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  background: "var(--pop-3)",
                  color: "var(--paper)",
                  border: "1.5px solid var(--ink)",
                  transform: "rotate(-3deg)",
                }}
              >
                <ScanSearch className="h-4 w-4" />
              </div>
              <div className="leading-tight">
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 800,
                    color: "var(--ink)",
                    letterSpacing: "-0.3px",
                  }}
                >
                  Ask Screener
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    color: "var(--ink-3)",
                    letterSpacing: "0.5px",
                  }}
                >
                  screening {MODE_LABEL[mode]}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {/* Shown when there is a conversation to leave OR while the
                  history list is open. The old `messages.length > 0` alone hid
                  it in exactly the state that needs it most: browsing past
                  chats on a fresh panel, where the transcript is empty and the
                  only way back to a blank chat was to close and reopen. */}
              {(messages.length > 0 || showHistory) && (
                <button
                  type="button"
                  onClick={handleNewChat}
                  className="pf-bf sm"
                  title="Start new chat"
                  style={{ padding: "5px 10px" }}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              )}
              {/* MONEY-1245 — past chats for this page, without leaving
                  the screener. The full browser is still /chat-history. */}
              <button
                type="button"
                onClick={() => setShowHistory((v) => !v)}
                className="pf-bf sm"
                title="Chat history"
                aria-label="Chat history"
                aria-pressed={showHistory}
                style={{ padding: "5px 10px" }}
              >
                <History className="h-3.5 w-3.5" />
              </button>
              {/* MONEY-1244 — expand to full screen for wide result tables and
                  long screening answers. Hidden below `sm`, where the panel
                  already fills the viewport and the control would be a no-op.
                  It lives inside the panel so the closed panel's `inert` keeps
                  it out of the tab order. */}
              {!isMobile && (
                <button
                  type="button"
                  onClick={() => setIsExpanded((v) => !v)}
                  className="pf-bf sm"
                  title={
                    isExpanded ? "Exit full screen" : "Expand to full screen"
                  }
                  aria-label={
                    isExpanded ? "Exit full screen" : "Expand to full screen"
                  }
                  aria-pressed={isExpanded}
                  style={{ padding: "5px 10px" }}
                >
                  {isExpanded ? (
                    <Minimize2 className="h-3.5 w-3.5" />
                  ) : (
                    <Maximize2 className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="pf-bf sm"
                aria-label="Close"
                style={{ padding: "5px 8px" }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* ── AI-advisory micro-disclosure (matches StockSage) ──────── */}
          <div
            className="px-4 py-1.5 shrink-0 text-[10px] leading-tight text-[var(--ink-3)]"
            style={{ borderBottom: "1px solid var(--rule-soft)" }}
          >
            {AI_ADVISORY_DISCLOSURE.short}
          </div>

          {/* ── Messages ────────────────────────────────────────────── */}
          {/* ── History list (MONEY-1245) ───────────────────────────────
              Replaces the transcript rather than overlaying it, so there is
              never a half-visible conversation behind the list. */}
          {showHistory ? (
            <SideChatHistoryList history={history} onOpen={handleOpenHistory} />
          ) : isEmpty ? (
            <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 text-center">
              <div
                className="grid place-items-center mb-4"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  background: "var(--pop-3)",
                  color: "var(--paper)",
                  border: "1.5px solid var(--ink)",
                  transform: "rotate(-3deg)",
                }}
              >
                <ScanSearch className="h-5 w-5" />
              </div>
              <p
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--ink-2, var(--ink))",
                  maxWidth: 260,
                }}
              >
                Describe the screen you want in plain English.
              </p>
            </div>
          ) : (
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto px-4 py-5"
              role="log"
              aria-live="polite"
              aria-label="Ask Screener conversation"
            >
              <div className="space-y-5">
                {messages.map((m) =>
                  m.role === "user" ? (
                    <div key={m.id} className="flex justify-end">
                      <div
                        className="max-w-[78%]"
                        style={{
                          padding: "11px 16px",
                          borderRadius: 14,
                          background: "#1d1d1b",
                          color: "#f7f3e6",
                          border: "1.5px solid var(--ink)",
                          boxShadow: "var(--shadow-soft)",
                          fontSize: 14.5,
                          lineHeight: 1.5,
                        }}
                      >
                        <p className="whitespace-pre-wrap">{m.content}</p>
                      </div>
                    </div>
                  ) : (
                    <div key={m.id} className="flex gap-3 items-start">
                      <div
                        className="grid place-items-center shrink-0 mt-0.5"
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: 9,
                          background: "var(--pop-3)",
                          color: "var(--paper)",
                          border: "1.5px solid var(--ink)",
                          transform: "rotate(-3deg)",
                        }}
                      >
                        <Sparkles className="h-4 w-4" />
                      </div>
                      <div
                        className="pf-card flat"
                        style={{
                          padding: "11px 16px",
                          borderRadius: 14,
                          fontSize: 14.5,
                          lineHeight: 1.5,
                          color: "var(--ink)",
                        }}
                      >
                        <AssistantMarkdown content={m.content} />
                      </div>
                    </div>
                  )
                )}
                {isLoading && (
                  <div className="flex gap-3 items-start">
                    <div
                      className="grid place-items-center shrink-0 mt-0.5"
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 9,
                        background: "var(--pop-3)",
                        color: "var(--paper)",
                        border: "1.5px solid var(--ink)",
                        transform: "rotate(-3deg)",
                      }}
                    >
                      <Sparkles className="h-4 w-4" />
                    </div>
                    <div
                      className="pf-card flat mono"
                      style={{
                        padding: "11px 16px",
                        borderRadius: 14,
                        fontSize: 11.5,
                        color: "var(--ink-3)",
                      }}
                    >
                      thinking…
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Suggestion chips (only in the empty state) ────────────── */}
          {isEmpty && (
            <div className="px-4 pb-2 shrink-0">
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS[mode].map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => handleSend(s)}
                    className="pf-pill outline"
                    style={{
                      fontSize: 11.5,
                      padding: "6px 12px",
                      cursor: "pointer",
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Input ───────────────────────────────────────────────── */}
          <div
            className="p-3 shrink-0"
            style={{ borderTop: "2px solid var(--ink)" }}
          >
            <div
              className="flex items-end gap-2 pf-input"
              style={{ padding: "8px 10px" }}
            >
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  resizeTextarea();
                }}
                onKeyDown={handleKeyDown}
                rows={1}
                placeholder={`Describe a ${MODE_LABEL[mode]} screen…`}
                className="flex-1 bg-transparent border-0 resize-none outline-none text-[var(--ink)] placeholder:text-[var(--ink-3)] p-0 min-h-[22px]"
                style={{ fontSize: 14, lineHeight: 1.5, maxHeight: 160 }}
              />
              <button
                type="button"
                onClick={() => handleSend(input)}
                disabled={!input.trim() || isLoading}
                aria-label="Send message"
                className="pf-bs shrink-0 disabled:opacity-40"
                style={{ padding: "7px 10px", borderRadius: 8 }}
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Backdrop on mobile ──────────────────────────────────────── */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 sm:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  );
}
