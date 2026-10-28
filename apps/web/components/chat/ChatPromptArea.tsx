"use client";

/**
 * ChatPromptArea - MONEY-231 Phase A redesign.
 *
 * Two-row composer:
 *   [ textarea ............................... credits-chip ]
 *   [ + · @-chip · /-chip ........... model-picker · send  ]
 * Hint strip below the toolbar on desktop.
 *
 * The popover, slash menu, @-mention picker, prompt suggestions, model
 * picker, and mobile bottom-sheet are all preserved as composable child
 * components so this rewrite is purely chrome - no contract changes for
 * downstream callers (`useChatContext`, `executeSlashCommand`, etc.).
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useChatContext } from "@/lib/chat/ChatContext";
import { Button } from "@usemoney/ui/button";
import { Textarea } from "@usemoney/ui/textarea";
import SlashCommandMenu from "./SlashCommandMenu";
import StockMentionPicker, {
  MentionBadges,
  canAddMention,
  type MentionedSymbol,
} from "./StockMentionPicker";
import { CreditCounter } from "@/components/credits/CreditCounter";
import PromptSuggestions, { useSuggestions } from "./PromptSuggestions";
import { AtSign, Send, Slash, Square } from "lucide-react";
import PromptOptionsPopover from "./options/PromptOptionsPopover";
import ModelPickerButton from "./options/ModelPickerButton";
import ThinkingToggleButton from "./options/ThinkingToggleButton";
import { toast } from "sonner";
import {
  searchCommands,
  extractCommandPrefix,
  isSlashCommand,
  parseSlashInput,
  executeSlashCommand,
  type SlashCommand,
} from "@/lib/chat/slash-commands";
import { setMyResearchPreferencesAction } from "@/lib/actions/preferences";

interface ChatPromptAreaProps {
  centered?: boolean;
  externalInput?: string;
  onExternalInputConsumed?: () => void;
}

export default function ChatPromptArea({
  centered = false,
  externalInput,
  onExternalInputConsumed,
}: ChatPromptAreaProps) {
  const {
    sendMessage,
    isLoading,
    subscriptionAccess,
    addLocalMessage,
    executeToolDirect,
    clearChat,
    compactChat,
    cancelRequest,
    pickerRequest,
  } = useChatContext();
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [slashMenuVisible, setSlashMenuVisible] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [mentionPickerVisible, setMentionPickerVisible] = useState(false);
  // When the user clicks the `/` chip, the picker should open in
  // command mode (Commands tab only); when they click `@` or type
  // `@`, it opens in mention mode (Recent / Stocks / Funds / Brokers).
  // Cleared when the picker closes so the next `@` open defaults to
  // mention mode.
  const [pickerInitialTab, setPickerInitialTab] = useState<
    "stocks" | "funds" | "commands" | undefined
  >(undefined);
  const [pickerMode, setPickerMode] = useState<"mention" | "command">(
    "mention"
  );
  // Hide the Brokers tab when the picker is opened for an instrument-only flow
  // (the "Analyse a stock/fund" chips). The @ button/keystroke opens with
  // brokers shown (default false).
  const [pickerHideBrokers, setPickerHideBrokers] = useState(false);
  const [mentionedSymbols, setMentionedSymbols] = useState<MentionedSymbol[]>(
    []
  );
  const [suggestionsVisible, setSuggestionsVisible] = useState(false);
  const [suggestionsIndex, setSuggestionsIndex] = useState(0);
  const activeSuggestions = useSuggestions(
    input,
    suggestionsVisible && !slashMenuVisible && !mentionPickerVisible
  );

  const slashResults = useMemo(() => {
    if (!slashMenuVisible) return [];
    const prefix = extractCommandPrefix(input);
    return searchCommands(prefix).slice(0, 8);
  }, [input, slashMenuVisible]);

  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value);
      if (/^\/[a-zA-Z]*$/.test(value)) {
        setSlashMenuVisible(true);
        setSlashMenuIndex(0);
        setSuggestionsVisible(false);
      } else {
        setSlashMenuVisible(false);
        const trimmed = value.trim();
        if (
          trimmed.length >= 3 &&
          !trimmed.startsWith("/") &&
          !trimmed.startsWith("@")
        ) {
          setSuggestionsVisible(true);
        } else {
          setSuggestionsVisible(false);
        }
      }
      if (mentionPickerVisible && !value.includes("@")) {
        setMentionPickerVisible(false);
      }
    },
    [mentionPickerVisible]
  );

  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    const hasRequiredParams = cmd.params?.some((p) => p.required);
    setInput(`/${cmd.name}${hasRequiredParams ? " " : ""}`);
    setSlashMenuVisible(false);
    textareaRef.current?.focus();
  }, []);

  const mentionQuery = useMemo(() => {
    if (!mentionPickerVisible) return undefined;
    const atIndex = input.lastIndexOf("@");
    if (atIndex === -1) return undefined;
    const after = input.slice(atIndex + 1);
    return after.length > 0 ? after : undefined;
  }, [input, mentionPickerVisible]);

  const handleMentionSelect = useCallback(
    (item: MentionedSymbol) => {
      if (!canAddMention(mentionedSymbols, item.type)) {
        toast.error(
          `Maximum ${item.type === "stock" ? 5 : 4} ${item.type === "stock" ? "stocks" : "funds"} per message`
        );
        return;
      }
      if (mentionedSymbols.some((m) => m.symbol === item.symbol)) {
        toast.error(`${item.symbol} already mentioned`);
        return;
      }
      setMentionedSymbols((prev) => [...prev, item]);
      setMentionPickerVisible(false);
      setInput((prev) => {
        const atIndex = prev.lastIndexOf("@");
        if (atIndex === -1) return `${prev} @${item.symbol} `;
        return `${prev.slice(0, atIndex)}@${item.symbol} `;
      });
      textareaRef.current?.focus();
    },
    [mentionedSymbols]
  );

  const handleRemoveMention = useCallback((symbol: string) => {
    setMentionedSymbols((prev) => prev.filter((m) => m.symbol !== symbol));
  }, []);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if ((!input.trim() && mentionedSymbols.length === 0) || isLoading) return;

    const trimmed = input.trim();

    if (isSlashCommand(trimmed)) {
      const parsed = parseSlashInput(trimmed);
      if (parsed) {
        const result = executeSlashCommand(parsed);

        if (result.action === "clear") {
          if (result.response) {
            addLocalMessage(trimmed, result.response);
          }
          setTimeout(() => clearChat(), 500);
          resetAfterSend();
          return;
        }
        if (result.action === "compact") {
          resetAfterSend();
          compactChat();
          return;
        }
        if (result.action === "set_focus") {
          const focusText = result.focusText ?? "";
          setMyResearchPreferencesAction({ researchFocus: focusText })
            .then((res) => {
              if (!res.success) {
                addLocalMessage(
                  trimmed,
                  `Could not save research focus: ${res.error}. Please try again.`
                );
                return;
              }
              const message = focusText
                ? `Research focus saved: **${focusText}**\n\nStockSage will apply this to every research run from now on. Use \`/focus\` (no text) to clear it.`
                : "Research focus cleared. StockSage will use the default Auto behaviour again.";
              addLocalMessage(trimmed, message);
            })
            .catch((err: unknown) => {
              addLocalMessage(
                trimmed,
                `Could not save research focus: ${
                  err instanceof Error ? err.message : "unknown error"
                }`
              );
            });
          resetAfterSend();
          return;
        }
        if (result.handled && result.response) {
          addLocalMessage(trimmed, result.response, result.navigateTo);
          resetAfterSend();
          return;
        }
        if (result.toolExecution) {
          executeToolDirect(
            result.toolExecution.userText,
            result.toolExecution.tool,
            result.toolExecution.params
          );
          resetAfterSend();
          return;
        }
      }
    }

    let messageText = trimmed;
    if (mentionedSymbols.length > 0) {
      const mentionContext = mentionedSymbols
        .map((m) => `@${m.symbol} (${m.name}, ${m.exchange})`)
        .join(", ");
      const symbolsOnly = mentionedSymbols.map((m) => m.symbol).join(" vs ");
      // Always keep the `[Mentioned: …]` context — even when the user sent no
      // text — so the server fast-path can route deterministically. Without it,
      // a bare fund mention became "Analyze <schemeCode>", which the classifier
      // treated as an equity symbol and rejected (MONEY-1073).
      messageText = messageText
        ? `[Mentioned: ${mentionContext}] ${messageText}`
        : `[Mentioned: ${mentionContext}] Analyze ${symbolsOnly}`;
    }

    sendMessage(messageText);
    resetAfterSend();
  };

  const resetAfterSend = useCallback(() => {
    setInput("");
    setSlashMenuVisible(false);
    setMentionPickerVisible(false);
    setSuggestionsVisible(false);
    setMentionedSymbols([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, []);

  // Toolbar `@` chip - types `@` and opens the mention picker on the
  // Stocks tab in mention mode (Commands tab hidden so the top bar
  // stays clean). Mirrors pressing the `@` key directly on the textarea.
  const handleAtChip = useCallback(() => {
    setInput((prev) => {
      const needsSpace = prev.length > 0 && !prev.endsWith(" ");
      return prev + (needsSpace ? " @" : "@");
    });
    setPickerMode("mention");
    setPickerInitialTab("stocks");
    setPickerHideBrokers(false);
    setMentionPickerVisible(true);
    textareaRef.current?.focus();
  }, []);

  // Open the stock/fund picker when another surface (a follow-up chip) requests
  // it via ChatContext. The nonce makes repeated requests re-open it. Brokers
  // tab hidden — these flows scope to an instrument, not a broker account.
  useEffect(() => {
    if (!pickerRequest) return;
    setPickerMode("mention");
    setPickerInitialTab(pickerRequest.tab);
    setPickerHideBrokers(true);
    setSlashMenuVisible(false);
    setSuggestionsVisible(false);
    setMentionPickerVisible(true);
    textareaRef.current?.focus();
  }, [pickerRequest]);

  // Toolbar `/` chip - opens the picker in command mode (Commands
  // tab only - keeps the top bar uncluttered for the slash flow).
  // Picking a command routes through `onCommandSelect` and inserts
  // /<cmd> into the textarea so the slash auto-fill can take over.
  const handleSlashChip = useCallback(() => {
    setPickerMode("command");
    setPickerInitialTab("commands");
    setMentionPickerVisible(true);
    setSlashMenuVisible(false);
    setSuggestionsVisible(false);
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionPickerVisible && e.key === "Escape") {
      e.preventDefault();
      setMentionPickerVisible(false);
      return;
    }

    if (slashMenuVisible && slashResults.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashMenuIndex((prev) =>
          prev < slashResults.length - 1 ? prev + 1 : 0
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashMenuIndex((prev) =>
          prev > 0 ? prev - 1 : slashResults.length - 1
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const selected = slashResults[slashMenuIndex];
        if (selected) handleSlashSelect(selected);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashMenuVisible(false);
        return;
      }
    }

    if (e.key === "@" && !slashMenuVisible && !mentionPickerVisible) {
      // Direct `@` keystroke opens in mention mode (matches @ chip).
      setPickerMode("mention");
      setPickerInitialTab("stocks");
      setPickerHideBrokers(false);
      setMentionPickerVisible(true);
      return;
    }

    if (mentionPickerVisible) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") {
        e.preventDefault();
        return;
      }
    }

    if (suggestionsVisible && activeSuggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSuggestionsIndex((prev) =>
          prev < activeSuggestions.length - 1 ? prev + 1 : 0
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSuggestionsIndex((prev) =>
          prev > 0 ? prev - 1 : activeSuggestions.length - 1
        );
        return;
      }
      if (e.key === "Tab" && activeSuggestions[suggestionsIndex]) {
        e.preventDefault();
        handleSuggestionSelect(activeSuggestions[suggestionsIndex].prompt);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSuggestionsVisible(false);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !mentionPickerVisible) {
      e.preventDefault();
      handleSubmit();
    }
  };

  useEffect(() => {
    if (externalInput !== undefined && externalInput !== "") {
      setInput(externalInput);
      onExternalInputConsumed?.();
      textareaRef.current?.focus();
    }
  }, [externalInput, onExternalInputConsumed]);

  // Auto-resize textarea - caps at 240px (was 160px). Long messages
  // scroll inside the composer instead of pushing the chat history out.
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 240) + "px";
    }
  }, [input]);

  const handleSuggestionSelect = useCallback((prompt: string) => {
    setInput(prompt);
    setSuggestionsVisible(false);
    textareaRef.current?.focus();
  }, []);

  const remainingCredits = subscriptionAccess?.totalCreditsRemaining ?? 0;
  // MONEY-1199 — the allowance must span the same thing `remainingCredits`
  // does: plan AND pack. `creditsLimit` alone is the plan figure, which made
  // the counter read "2750 / 200" once a query pack was bought.
  const creditAllowance =
    (subscriptionAccess?.creditsLimit ?? 0) +
    (subscriptionAccess?.packCreditsLimit ?? 0);
  const hasInput = input.trim().length > 0 || mentionedSymbols.length > 0;

  return (
    <form
      onSubmit={handleSubmit}
      className={`w-full ${centered ? "max-w-3xl mx-auto" : ""}`}
      data-testid="chat-prompt-area"
    >
      <div
        data-walkthrough="dashboard-chat-input"
        className="pf-card relative overflow-visible transition-transform"
        style={{
          padding: 0,
          borderRadius: 14,
          borderWidth: "2px",
          boxShadow: "var(--shadow-soft)",
        }}
      >
        {/* Mention badges (above input row) */}
        {mentionedSymbols.length > 0 && (
          <div className="px-4 pt-3 relative z-10">
            <MentionBadges
              mentions={mentionedSymbols}
              onRemove={handleRemoveMention}
            />
          </div>
        )}

        {/* Mention picker - overlay anchor. Position unchanged. */}
        <StockMentionPicker
          visible={mentionPickerVisible}
          initialTab={pickerInitialTab}
          mode={pickerMode}
          hideBrokers={pickerHideBrokers}
          onSelect={handleMentionSelect}
          onClose={() => {
            setMentionPickerVisible(false);
            setPickerInitialTab(undefined);
            setPickerMode("mention");
            setPickerHideBrokers(false);
          }}
          externalQuery={mentionQuery}
          onCommandSelect={(cmd) => {
            // Strip the trailing `@` (or `@query`) the user typed, then
            // insert `/<cmd>` so the slash menu's auto-fill can take
            // over from there.
            setInput((prev) => {
              const atIndex = prev.lastIndexOf("@");
              const base = atIndex === -1 ? prev : prev.slice(0, atIndex);
              const trimmed = base.replace(/\s+$/, "");
              const sep = trimmed.length === 0 ? "" : " ";
              return `${trimmed}${sep}/${cmd.name}`;
            });
            setMentionPickerVisible(false);
            setPickerInitialTab(undefined);
            setPickerMode("mention");
            setSlashMenuVisible(true);
            textareaRef.current?.focus();
          }}
        />

        {/* Slash + suggestions - overlay anchors. */}
        <SlashCommandMenu
          commands={slashResults}
          selectedIndex={slashMenuIndex}
          onSelect={handleSlashSelect}
          visible={slashMenuVisible}
        />
        <PromptSuggestions
          query={input}
          visible={
            suggestionsVisible && !slashMenuVisible && !mentionPickerVisible
          }
          onSelect={handleSuggestionSelect}
          onClose={() => setSuggestionsVisible(false)}
          selectedIndex={suggestionsIndex}
          onSelectedIndexChange={setSuggestionsIndex}
        />

        {/* Row 1 - textarea + inline credits chip */}
        <div className="flex items-start gap-2 px-4 pt-3.5 pb-1 relative z-10">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask StockSage anything…"
            disabled={isLoading}
            rows={centered ? 2 : 1}
            aria-label="Chat input"
            className="flex-1 bg-transparent border-0 text-[var(--ink)] placeholder:text-[var(--ink-3)] resize-none focus-visible:ring-0 focus-visible:ring-offset-0 p-0 min-h-[22px] sm:text-[15px]"
            style={
              centered
                ? { fontSize: 18, lineHeight: 1.5, minHeight: 56 }
                : undefined
            }
          />
          {subscriptionAccess && (
            <span
              className="hidden sm:inline-flex shrink-0 mt-0.5"
              data-testid="credits-chip"
            >
              <CreditCounter
                remaining={remainingCredits}
                limit={creditAllowance}
                used={subscriptionAccess.creditsUsed}
                // NOT `remaining + used`: that equals plan limit + pack
                // REMAINING, so it under-reports by however many pack credits
                // have been spent. The granted total is plan + pack.
                total={creditAllowance}
                compact
              />
            </span>
          )}
        </div>

        {/* Row 2 - toolbar (dashed separator above, playful idiom) */}
        <div
          className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-2 mt-1 relative z-10"
          style={{ borderTop: "1.5px dashed var(--rule-soft)" }}
        >
          <div className="flex items-center gap-1.5">
            {/* Unified "+" popover - same trigger on all screen sizes.
                The popover content clamps to the viewport on mobile so
                MobilePromptSheet is no longer needed (deleted). */}
            <PromptOptionsPopover size="sm" />
            {/* @-mention chip - playful toolbar button. */}
            <button
              type="button"
              onClick={handleAtChip}
              className="pf-tool-btn"
              aria-label="Mention a stock"
              data-testid="mention-chip"
            >
              <AtSign className="w-3.5 h-3.5" />
            </button>
            {/* /-command chip */}
            <button
              type="button"
              onClick={handleSlashChip}
              className="pf-tool-btn"
              aria-label="Slash command"
              data-testid="command-chip"
            >
              <Slash className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            {!isLoading && <ThinkingToggleButton />}
            {!isLoading && <ModelPickerButton />}
            {isLoading ? (
              <div className="relative h-8 w-8 shrink-0">
                <svg
                  className="absolute inset-0 h-8 w-8 animate-spin"
                  viewBox="0 0 32 32"
                  fill="none"
                  aria-hidden
                >
                  <circle
                    cx="16"
                    cy="16"
                    r="14"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="text-red-600/20"
                  />
                  <path
                    d="M16 2a14 14 0 0 1 14 14"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    className="text-red-500"
                  />
                </svg>
                <Button
                  type="button"
                  size="icon"
                  onClick={cancelRequest}
                  className="absolute inset-0 bg-red-600/80 hover:bg-red-600 h-6 w-6 m-auto rounded-full shrink-0"
                  title="Stop generating"
                  aria-label="Stop generating"
                >
                  <Square className="h-2.5 w-2.5 fill-current" />
                </Button>
              </div>
            ) : (
              <button
                type="submit"
                disabled={!hasInput}
                aria-label="Send message"
                data-testid="send-button"
                data-armed={hasInput ? "true" : "false"}
                className="pf-bs sm shrink-0 disabled:opacity-100"
                style={
                  hasInput
                    ? {
                        background: "var(--emerald)",
                        borderColor: "var(--ink)",
                        color: "#052e1a",
                        padding: "6px 12px",
                      }
                    : {
                        background: "var(--paper-2)",
                        borderColor: "var(--rule-soft)",
                        color: "var(--ink-3)",
                        cursor: "not-allowed",
                        padding: "6px 12px",
                      }
                }
              >
                <Send className="h-3.5 w-3.5" /> Send
              </button>
            )}
          </div>
        </div>
      </div>

      <style jsx>{`
        .pf-tool-btn {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          border: 1.5px solid var(--rule-soft);
          background: var(--paper);
          color: var(--ink-2);
          display: grid;
          place-items: center;
          flex-shrink: 0;
          transition:
            box-shadow 0.12s,
            transform 0.12s,
            color 0.12s,
            border-color 0.12s;
        }
        .pf-tool-btn:hover {
          border-color: var(--ink);
          color: var(--ink);
          box-shadow: 2px 2px 0 var(--ink);
          transform: translate(-1px, -1px);
        }
      `}</style>

      {/* Hint row - desktop only, below the composer chrome. Hidden on
          mobile where the bottom sheet exposes the same actions. */}
      {centered && (
        <div
          className="mono hidden sm:flex justify-center gap-3.5 mt-3"
          style={{
            fontSize: 11,
            letterSpacing: "0.04em",
            color: "var(--ink-3)",
          }}
          aria-hidden
        >
          <span>
            Type <kbd style={{ color: "var(--ink-2)" }}>/</kbd> for commands
          </span>
          <span className="opacity-40">·</span>
          <span>
            <kbd style={{ color: "var(--ink-2)" }}>@</kbd> to mention stocks
          </span>
          <span className="opacity-40">·</span>
          <span>
            <kbd style={{ color: "var(--ink-2)" }}>↩</kbd> to send
          </span>
        </div>
      )}
    </form>
  );
}
