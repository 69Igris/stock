"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Flame,
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
import { useFireChat } from "../lib/chat/FireActionsContext";
// Import the CLIENT-safe subpaths, not the barrel: the barrel re-exports
// server-side modules (tools.ts pulls @google/genai, the server twin, etc.),
// which shouldn't be bundled into this "use client" component.
import { executeFireTool } from "@usemoney/fire/toolExecutor";
import type { FireSnapshot } from "@usemoney/fire/systemPrompt";
import { fireChatTurnAction } from "@/lib/actions/fire-chat";
import {
  useSideChatHistory,
  useChatIdFromUrl,
} from "@/hooks/useSideChatHistory";
import SideChatHistoryList from "@/components/chat/SideChatHistoryList";
import { FIRE_CHAT_SCOPE } from "@/lib/chat-history/side-chat-scopes";
import { useIsMobile } from "@/hooks/use-mobile";
import { isInsidePortalledOverlay } from "@/lib/ui/portal-overlays";
import ChatLauncherButton from "@/components/chat/ChatLauncherButton";

/* =====================================================================
   AskFirePanel — MONEY-939 (UI) · MONEY-1049 (tool-calling)
   ---------------------------------------------------------------------
   Slide-in "Ask FIRE" chat sidebar for the FIRE Calculator page,
   mirroring the StockSage EmbeddedChatPanel look via the shared playful
   design tokens.

   MONEY-1049 wires it to Gemini function-calling: `handleSend` sends the
   conversation + a live plan snapshot to the `fireChatTurnAction` SERVER
   ACTION (MONEY-1079 — the /api/fire-chat route it used to fetch is
   deleted), executes any returned tool calls against the FIRE page state
   (via FireActionsContext → toolExecutor), then asks the model for a
   natural-language confirmation.
   ===================================================================== */

type ChatRole = "user" | "assistant";

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
}

/** Empty-state suggestion chips (FIRE-specific). */
const SUGGESTIONS = [
  "Can I retire at 45?",
  "What if I save ₹20k more?",
  "Make my plan more conservative",
  "How am I doing right now?",
] as const;

interface FireChatResponse {
  text: string | null;
  functionCalls: {
    id?: string;
    name: string;
    args: Record<string, unknown>;
  }[];
  /** "deterministic" = the server parsed the command without the model, so
      there's no confirmation hop to make (the executor's own message is the
      reply). "llm" (or undefined) = normal Gemini turn. */
  source?: "deterministic" | "llm";
}

/**
 * Run one FIRE chat turn via the SERVER ACTION (MONEY-1079) — no longer a
 * fetch to /api/fire-chat. Server actions can't be aborted mid-flight, so we
 * honour `signal` by discarding the result if the caller aborted while it ran
 * (same observable behaviour the old AbortController gave the loop).
 */
async function postFireChat(
  contents: Content[],
  snapshot: FireSnapshot,
  signal?: AbortSignal
): Promise<FireChatResponse> {
  const result = await fireChatTurnAction(contents, snapshot);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if ("error" in result) {
    throw new Error(result.detail || result.error);
  }
  return result;
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
 * Belt-and-suspenders: convert any LaTeX the model slips in (despite the
 * prompt) into plain text, so formulas stay readable without a math renderer.
 * Conservative — only touches well-known TeX constructs.
 */
function latexToPlain(md: string): string {
  return md
    .replace(/\\\[|\\\]|\\\(|\\\)/g, "") // \[ \] \( \) delimiters
    .replace(/\$\$?/g, "") // $ / $$ delimiters
    .replace(
      /\\(?:text|mathrm|mathbf|mathit|operatorname)\s*\{([^{}]*)\}/g,
      "$1"
    )
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1) / ($2)")
    .replace(/\\times/g, "×")
    .replace(/\\cdot/g, "·")
    .replace(/\\div/g, "÷")
    .replace(/\\approx/g, "≈")
    .replace(/\\%/g, "%")
    .replace(/\\left|\\right/g, "");
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
      {latexToPlain(content)}
    </ReactMarkdown>
  );
}

export default function AskFirePanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const bridge = useFireChat();

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
     delete. The hook is shared with AskScreenerPanel rather than copied. */
  const history = useSideChatHistory(FIRE_CHAT_SCOPE);
  const {
    save: saveHistory,
    load: loadHistory,
    startNew: startNewHistory,
  } = history;
  const [showHistory, setShowHistory] = useState(false);

  /* MONEY-1242 — expand the rail to a full-screen reading surface. FIRE
     projection answers are long and the 380px rail makes them hard to read.
     Off by default; reset on close so reopening is always the familiar rail.
     Below `sm` the panel is already `w-full`, so this only changes anything
     on desktop. */
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

  /* ── Close on outside click (MONEY-1241) ─────────────────────────────
     There was no such handler at all: the only dismiss-by-click surface was
     the mobile backdrop below, which is `sm:hidden`, so on desktop clicking
     away did nothing and Escape was the only way out.

     `pointerdown`, not `click`, so the panel dismisses on press like every
     other popover — and so a click that starts inside and drags out (text
     selection in a long answer) does not close it.

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

  /* ── Send: Gemini tool-calling loop (MONEY-1049) ──────────────────────
     Bounded multi-hop: POST → if the model returns function calls, execute
     each against the live plan, append the model turn (functionCall parts)
     and a user turn (matching functionResponse parts), and POST again —
     repeating until it replies with plain text (or the hop cap). Every
     functionCall is always immediately answered, so `conversationRef`
     never holds orphaned calls. ─────────────────────────────────────── */
  const handleSend = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || isLoading) return;

      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", content: text },
      ]);
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";

      if (!bridge) {
        appendAssistant("The FIRE assistant isn't connected on this page.");
        return;
      }

      setIsLoading(true);
      let convo: Content[] = [
        ...conversationRef.current,
        { role: "user", parts: [{ text }] },
      ];
      const summaries: string[] = [];
      const touchedAssets: string[] = [];
      let allocationChanged = false;
      let finalText: string | null = null;
      let caught: unknown = null;

      try {
        // Cap the tool → response → tool chain so a looping model can't
        // spin. Gemini batches parallel calls natively (a multi-change
        // message normally resolves in 2 hops); 8 gives sequential-caller
        // behaviour room without runaway cost.
        const MAX_HOPS = 8;
        // Per-hop abort + a whole-turn wall clock so a slow/stuck hop can't
        // leave the panel spinning on "thinking…" forever (worst case would
        // otherwise be MAX_HOPS × an unbounded fetch).
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
          let reply: FireChatResponse;
          try {
            reply = await postFireChat(
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
            convo = [
              ...convo,
              { role: "model", parts: [{ text: reply.text ?? "" }] },
            ];
            finalText = reply.text ?? null;
            break;
          }

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

            // Track allocation-changing calls so we can enforce the 100%
            // invariant afterward, preserving what the model set explicitly.
            if (
              call.name === "updateAssetAllocation" ||
              call.name === "addAssetClass"
            ) {
              allocationChanged = true;
              if (typeof call.args.name === "string")
                touchedAssets.push(call.args.name);
            } else if (call.name === "removeAssetClass") {
              allocationChanged = true;
            }

            const result = await executeFireTool(
              call.name,
              call.args,
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

          // Tier 1 (deterministic): no model was called, so there's no
          // confirmation hop to make — the executor's own summary is the
          // reply. Stop here instead of posting back to the LLM (keeps it
          // free + fast). `finalText` stays null → falls back to summaries.
          if (reply.source === "deterministic") break;

          // Yield a macrotask so React commits the state updates and the
          // page re-renders — refreshing liveRef (inputs AND the computed
          // outcomes in the snapshot) before the next hop reads it. Without
          // this the model would goal-seek against stale numbers.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } catch (err) {
        // Tool calls execute as they arrive, so earlier hops' changes are
        // already applied — record the error and fall through to the shared
        // post-processing so partial progress is persisted, not lost.
        // (postFireChat only throws at a hop boundary and executeFireTool
        // never throws, so `convo` holds no orphaned function calls here.)
        caught = err;
      }

      try {
        // Deterministic 100% guarantee: if the turn changed allocations,
        // rebalance the untouched assets so the mix totals exactly 100% —
        // ALSO on the error path, so a failed turn can't leave a broken mix.
        // If rounding shifted anything, tell the user the real final mix
        // (the model's own confirmation may quote pre-rebalance numbers).
        let rebalanceNote = "";
        if (allocationChanged) {
          const before = JSON.stringify(bridge.getSnapshot().assetClasses);
          bridge.rebalanceAllocations(touchedAssets);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const after = bridge.getSnapshot().assetClasses;
          if (JSON.stringify(after) !== before) {
            rebalanceNote = `\n\n**Final mix (rebalanced to 100%):** ${after
              .map((a) => `${a.name} ${a.allocation}%`)
              .join(" · ")}`;
          }
        }

        // Persist whatever hops completed — on errors too, so the next turn's
        // history matches the changes already applied to the page. Capped to
        // bound re-POST cost over a long session (cut only at a safe turn
        // boundary — see capHistory).
        conversationRef.current = capHistory(convo);

        if (caught) {
          const applied =
            summaries.length > 0
              ? ` Changes applied before the error: ${summaries.join(" ")}`
              : "";
          appendAssistant(
            `Sorry, I couldn't finish that: ${
              caught instanceof Error ? caught.message : "unknown error"
            }.${applied}${rebalanceNote}`
          );
        } else {
          appendAssistant(
            (finalText || summaries.join(" ") || "Done.") + rebalanceNote
          );
        }
      } finally {
        setIsLoading(false);
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
    setMessages([]);
    setInput("");
    conversationRef.current = [];
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
      setMessages(restored.messages);
      // Without the tool turns the model would resume blind to the plan edits
      // it already made.
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
          title="Open Ask FIRE"
        >
          <Flame className="h-4 w-4" />
          <span className="hidden sm:inline">Ask FIRE</span>
        </ChatLauncherButton>
      )}

      {/* ── Side panel ──────────────────────────────────────────────────
          Sits BELOW the global topbar+ticker (--topbar-h) so it never
          overlaps the nav chrome — same anchoring as EmbeddedChatPanel — and
          ABOVE the global bottom nav (--mobile-nav-h). Without that second
          subtraction the panel ran to the viewport floor and the bar covered
          its composer, so the chat opened but could not be typed into
          (MONEY-1151). Matching the /stocksage convention, the bar stays
          visible and the panel yields the space. */}
      <div
        ref={panelRef}
        className={cn(
          "fixed right-0 z-50 ease-in-out",
          // MONEY-1242: width animates alongside the existing open/close
          // transform, so expanding slides rather than snapping.
          "transition-[transform,width] duration-300",
          "bg-[var(--paper)] border-l border-[var(--rule-soft)] shadow-2xl",
          // MONEY-1242: rounded on the leading (left) edge only — the panel is
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
                  background: "var(--emerald)",
                  color: "var(--paper)",
                  border: "1.5px solid var(--ink)",
                  transform: "rotate(-3deg)",
                }}
              >
                <Flame className="h-4 w-4" />
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
                  Ask FIRE
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    color: "var(--ink-3)",
                    letterSpacing: "0.5px",
                  }}
                >
                  FIRE planning assistant
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
                  /fire. The full browser is still /chat-history. */}
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
              {/* MONEY-1242 — expand to full screen for long projection
                  answers. Hidden below `sm`, where the panel already fills
                  the viewport and the control would be a no-op. It lives
                  inside the panel so the closed panel's `inert` keeps it out
                  of the tab order. */}
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

          {/* ── History list (MONEY-1245) ───────────────────────────────
              Replaces the transcript rather than overlaying it, so there is
              never a half-visible conversation behind the list. */}
          {showHistory ? (
            <SideChatHistoryList history={history} onOpen={handleOpenHistory} />
          ) : /* ── Messages ──────────────────────────────────────────── */
          isEmpty ? (
            <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 text-center">
              <div
                className="grid place-items-center mb-4"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  background: "var(--emerald)",
                  color: "var(--paper)",
                  border: "1.5px solid var(--ink)",
                  transform: "rotate(-3deg)",
                }}
              >
                <Flame className="h-5 w-5" />
              </div>
              <p
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--ink-2, var(--ink))",
                  maxWidth: 260,
                }}
              >
                Ask FIRE anything about your retirement plan.
              </p>
            </div>
          ) : (
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto px-4 py-5"
              role="log"
              aria-live="polite"
              aria-label="Ask FIRE conversation"
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
                          background: "var(--emerald)",
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
                        background: "var(--emerald)",
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
                {SUGGESTIONS.map((s) => (
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
                placeholder="Ask anything about your FIRE plan…"
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
