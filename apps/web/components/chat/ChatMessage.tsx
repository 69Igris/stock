"use client";

import {
  useMemo,
  useState,
  useCallback,
  useRef,
  useEffect,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import type { ChatMessageWithBlocks, NavigationBlock } from "@usemoney/types";
import MessageRenderer from "./MessageRenderer";
import { StockSageIcon } from "./StockSageIcon";
import ResearchStreamRenderer from "./blocks/ResearchStreamRenderer";
import ResultFeedback from "./ResultFeedback";
import {
  Copy,
  Check,
  ExternalLink,
  RefreshCw,
  MoreHorizontal,
  Share2,
  FileDown,
  Link2,
  Sparkles,
  Zap,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { stripRecommendationLanguage } from "@usemoney/utils/sanitize-recommendation";
import { hasCitations } from "@/components/chat/CitationsRail";

interface ChatMessageProps {
  message: ChatMessageWithBlocks;
  /**
   * MONEY-291 / task #38: true while THIS assistant message is being streamed
   * token-by-token. Drives the blinking caret appended to the live prose.
   */
  isStreaming?: boolean;
  onConfirmAction?: (
    actionId: string,
    tool: string,
    params: Record<string, unknown>
  ) => void;
  onCancelAction?: (actionId: string) => void;
  onResearchStock?: (symbol: string) => void;
  onLoadReport?: (sessionId: string) => void;
  onSelectResearchOption?: (
    optionId: string,
    tool: string,
    params: Record<string, unknown>,
    actionId?: string
  ) => void;
  onCancelResearchPrompt?: (actionId?: string) => void;
  /** MONEY-295: refusal-block suggestion chip click - sends as new message. */
  onSelectSuggestion?: (prompt: string) => void;
  /** MONEY-485: re-run the prompt that produced this assistant answer. */
  onRegenerate?: (messageId: string) => void;
  /**
   * MONEY-778: open the sources rail for THIS message's analysis. Lets a chat
   * with multiple analyses surface each turn's own sources (the rail otherwise
   * only ever followed the latest turn).
   */
  onShowSources?: (messageId: string) => void;
  /**
   * MONEY-778: subscription snapshot for the assistant-header MetaBar chips
   * (plan + live credits), matching the design's StreamedAnswer header. Minimal
   * shape so ChatMessage stays decoupled from the context type.
   */
  subscriptionAccess?: {
    planId?: string;
    totalCreditsRemaining?: number;
  } | null;
}

/** Parse mentioned symbols from user message prefix */
function parseMentions(content: string): {
  mentions: { symbol: string }[];
  cleanContent: string;
} {
  const mentions: { symbol: string }[] = [];

  // Match [Mentioned: @SYM (Name, Exchange), ...] prefix
  const mentionedMatch = content.match(
    /^\[Mentioned:\s*((?:@\w+\s*\([^)]*\),?\s*)+)\]\s*/
  );
  // Match Analyze: @SYM (Name, Exchange), ... (whole message)
  const analyzeMatch = !mentionedMatch
    ? content.match(/^Analyze:\s*((?:@\w+\s*\([^)]*\),?\s*)+)$/)
    : null;

  const matchStr = mentionedMatch?.[1] || analyzeMatch?.[1];
  if (matchStr) {
    const symbolRegex = /@(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = symbolRegex.exec(matchStr)) !== null) {
      mentions.push({ symbol: m[1]! });
    }
  }

  let cleanContent = content;
  if (mentionedMatch) {
    cleanContent = content.slice(mentionedMatch[0].length).trim();
  } else if (analyzeMatch) {
    cleanContent = "";
  }

  return { mentions, cleanContent };
}

/** Format the turnMeta into the mono meta line, e.g.
 *  "StockSage · Portfolio summary · RELIANCE". */
/** Humanize an internal intent / tool id for the meta line: drop the
 *  get_/run_/start_ verb prefix + snake_case, Title-case it, and hide the
 *  generic "general chat" placeholder. So `get_portfolio_summary` →
 *  "Portfolio summary" instead of the raw "L2 GET_PORTFOLIO_SUMMARY". */
function humanizeIntent(intent?: string): string | null {
  if (!intent) return null;
  const cleaned = intent
    .replace(/^(get|run|start|create|open)_/, "")
    .replace(/_/g, " ")
    .trim();
  if (!cleaned || cleaned === "general chat") return null;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function buildMetaLine(message: ChatMessageWithBlocks): string {
  const tm = message.turnMeta;
  const parts: string[] = ["StockSage"];
  const intent = humanizeIntent(tm?.intent);
  if (intent) parts.push(intent);
  if (tm?.symbols && tm.symbols.length > 0) {
    parts.push(tm.symbols.slice(0, 3).join(" · "));
  }
  return parts.join(" · ");
}

/* MONEY-778: assistant-header MetaBar (design ss-stream.jsx:100). */
const PLAN_LABEL: Record<string, string> = {
  FREE: "StockSage Free",
  PRO: "StockSage Pro",
  PREMIUM: "StockSage Premium",
  ULTIMATE: "StockSage Ultimate",
  QUERY_PACK: "StockSage",
};
const META_CHIP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontFamily: '"JetBrains Mono", monospace',
  fontSize: 10,
  fontWeight: 700,
  padding: "2px 8px",
  borderRadius: 999,
  border: "1.5px solid var(--rule-soft)",
  color: "var(--ink-3)",
  background: "var(--paper)",
  whiteSpace: "nowrap",
};

/** First real (navigable, non-toggle) report/page link in this message. */
function findOpenableReportHref(
  message: ChatMessageWithBlocks
): string | undefined {
  for (const block of message.blocks ?? []) {
    if (block.type !== "navigation") continue;
    const nav = block as NavigationBlock;
    const real = nav.links.find((l) => !l.href.startsWith("#"));
    if (real) return real.href;
  }
  return undefined;
}

/** Flatten assistant block content + prose to plain text for copy. */
function messageToPlainText(message: ChatMessageWithBlocks): string {
  const chunks: string[] = [];
  if (message.content) chunks.push(message.content);
  for (const block of message.blocks ?? []) {
    if (block.type === "text") chunks.push(block.content);
    else if (block.type === "card") {
      const head = [block.title, block.value, block.subtitle]
        .filter(Boolean)
        .join(" · ");
      if (head) chunks.push(head);
      for (const it of block.items ?? [])
        chunks.push(`${it.label}: ${it.value}`);
    }
  }
  return chunks.join("\n\n").trim();
}

/** Returns true when a message is ONLY a research-stream block with status
 *  "completed" or "failed". In those cases we skip the full assistant bubble
 *  chrome (avatar, meta, card, action row) and render the stream summary
 *  inline — once `appendResearchResults` adds the real results message, only
 *  ONE SAGE bubble shows per turn. */
function isResearchStreamOnlyMessage(msg: ChatMessageWithBlocks): boolean {
  if (msg.role !== "assistant") return false;
  const blocks = msg.blocks ?? [];
  if (blocks.length !== 1) return false;
  const b = blocks[0];
  return (
    b !== undefined &&
    b.type === "research-stream" &&
    (b.status === "completed" || b.status === "failed")
  );
}

export default function ChatMessage({
  message,
  isStreaming = false,
  onConfirmAction,
  onCancelAction,
  onResearchStock,
  onLoadReport,
  onSelectResearchOption,
  onCancelResearchPrompt,
  onSelectSuggestion,
  onRegenerate,
  onShowSources,
  subscriptionAccess,
}: ChatMessageProps) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const [kebabOpen, setKebabOpen] = useState(false);
  const kebabRef = useRef<HTMLDivElement>(null);
  const kebabBtnRef = useRef<HTMLButtonElement>(null);
  const [kebabPos, setKebabPos] = useState<{
    top: number;
    left: number;
  } | null>(null);

  const { mentions, cleanContent } = useMemo(() => {
    if (!isUser) return { mentions: [], cleanContent: message.content };
    return parseMentions(message.content);
  }, [isUser, message.content]);

  const metaLine = useMemo(
    () => (isUser ? "" : buildMetaLine(message)),
    [isUser, message]
  );
  const reportHref = useMemo(
    () => (isUser ? undefined : findOpenableReportHref(message)),
    [isUser, message]
  );

  // MONEY-587: show 👍/👎 feedback on substantive assistant answers — skip
  // pure error / refusal / navigation / action turns (they carry no analysis
  // worth rating).
  const showFeedback = useMemo(
    () =>
      !isUser &&
      (Boolean(message.content?.trim()) ||
        (message.blocks ?? []).some(
          (b) => !["error", "refusal", "navigation", "action"].includes(b.type)
        )),
    [isUser, message]
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(messageToPlainText(message));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Could not copy to clipboard");
    }
  }, [message]);

  const handleShare = useCallback(async () => {
    setKebabOpen(false);
    try {
      await navigator.clipboard.writeText(
        typeof window !== "undefined" ? window.location.href : ""
      );
      toast.success("Chat link copied");
    } catch {
      toast.error("Could not copy link");
    }
  }, []);

  // Close kebab on outside click or Escape.
  useEffect(() => {
    if (!kebabOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        kebabRef.current &&
        !kebabRef.current.contains(e.target as Node) &&
        kebabBtnRef.current &&
        !kebabBtnRef.current.contains(e.target as Node)
      ) {
        setKebabOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setKebabOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [kebabOpen]);

  // ── Task C: research-stream-only completed/failed → inline pill, no bubble
  if (isResearchStreamOnlyMessage(message)) {
    const block = message.blocks![0]!;
    if (block.type === "research-stream") {
      return (
        <div className="flex gap-3 items-center pl-[46px]">
          <ResearchStreamRenderer block={block} />
        </div>
      );
    }
  }

  // ── User bubble: intentional always-dark ink card (per design). ──────
  if (isUser) {
    return (
      <div className="flex justify-end">
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
          {mentions.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {mentions.map((m) => (
                <span
                  key={m.symbol}
                  className="mono"
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: "1px 7px",
                    borderRadius: 999,
                    background: "rgba(247,243,230,0.12)",
                    color: "#f7f3e6",
                    border: "1px solid rgba(247,243,230,0.25)",
                  }}
                >
                  @{m.symbol}
                </span>
              ))}
            </div>
          )}
          {cleanContent && (
            <p className="whitespace-pre-wrap">{cleanContent}</p>
          )}
        </div>
      </div>
    );
  }

  // ── Assistant bubble: paper + emerald sparkle avatar + meta + actions. ─
  return (
    <div className="group flex gap-3 items-start">
      <StockSageIcon size={34} variant="sparkle" className="mt-0.5" />

      <div className="flex-1 min-w-0">
        {metaLine && (
          <div className="flex items-center justify-between gap-3 mb-1.5">
            {/* MONEY-778: design's MetaBar chips (plan · persona · credits ·
                streaming) replacing the old mono meta line. */}
            <div className="flex items-center gap-1.5 flex-wrap min-w-0">
              <span
                style={{
                  ...META_CHIP,
                  borderColor: "var(--purple)",
                  color: "var(--purple)",
                }}
              >
                <Sparkles size={11} />
                {PLAN_LABEL[subscriptionAccess?.planId ?? ""] ?? "StockSage"}
              </span>
              {message.turnMeta?.persona && (
                <span style={META_CHIP}>{message.turnMeta.persona}</span>
              )}
              {typeof subscriptionAccess?.totalCreditsRemaining ===
                "number" && (
                <span style={META_CHIP}>
                  <Zap size={10} /> {subscriptionAccess.totalCreditsRemaining}{" "}
                  credits
                </span>
              )}
              {isStreaming && (
                <span
                  style={{
                    ...META_CHIP,
                    borderColor: "var(--emerald)",
                    color: "var(--emerald)",
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background: "var(--emerald)",
                      display: "inline-block",
                    }}
                  />
                  streaming
                </span>
              )}
            </div>
            <span
              className="mono shrink-0"
              style={{ fontSize: 10.5, color: "var(--ink-3)" }}
            >
              {message.timestamp
                ? new Date(message.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : ""}
            </span>
          </div>
        )}

        <div
          className="pf-card flat"
          style={{
            padding: "13px 16px",
            borderRadius: 14,
            borderWidth: "1.5px",
            fontSize: 14.5,
            lineHeight: 1.55,
            color: "var(--ink)",
          }}
        >
          {message.blocks && message.blocks.length > 0 ? (
            <MessageRenderer
              blocks={message.blocks}
              onConfirmAction={onConfirmAction}
              onCancelAction={onCancelAction}
              onResearchStock={onResearchStock}
              onLoadReport={onLoadReport}
              onSelectResearchOption={onSelectResearchOption}
              onCancelResearchPrompt={onCancelResearchPrompt}
              onSelectSuggestion={onSelectSuggestion}
              onRetry={
                onRegenerate ? () => onRegenerate(message.id) : undefined
              }
            />
          ) : (
            <p
              className="whitespace-pre-wrap"
              style={{ color: "var(--ink-2)" }}
            >
              {/* MONEY-457: assistant fallback prose path (no block envelope)
                  must also scrub recommendation language. */}
              {stripRecommendationLanguage(message.content)}
              {/* MONEY-291 / task #38: blinking caret while this message is
                  still streaming in — reads as live typing. */}
              {isStreaming && (
                <span className="tok-cursor" aria-hidden="true" />
              )}
            </p>
          )}
        </div>

        {/* Per-message action row — Copy / Open report / Regenerate / ⋯ and
            the 👍/👎 feedback thumbs share ONE wrapping row. The thumbs used to
            sit on a separate line below; ResultFeedback now renders inline via
            `display:contents` and its detail panel drops to its own full-width
            line (see the flex-break inside ResultFeedback). */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <ActionBtn
            label={copied ? "Copied" : "Copy"}
            icon={copied ? Check : Copy}
            onClick={handleCopy}
          />
          {reportHref && (
            <Link href={reportHref}>
              <ActionBtn label="Open report" icon={ExternalLink} />
            </Link>
          )}
          {onRegenerate && (
            <ActionBtn
              label="Regenerate"
              icon={RefreshCw}
              onClick={() => onRegenerate(message.id)}
            />
          )}
          {/* MONEY-778: per-analysis Sources — opens the rail for THIS turn, so
              a chat with multiple analyses can surface each one's sources. */}
          {onShowSources && hasCitations(message) && (
            <ActionBtn
              label="Sources"
              icon={Link2}
              onClick={() => onShowSources(message.id)}
            />
          )}
          <div className="relative" ref={kebabRef}>
            <button
              ref={kebabBtnRef}
              type="button"
              aria-label="More actions"
              onClick={() => {
                if (!kebabOpen && kebabBtnRef.current) {
                  const rect = kebabBtnRef.current.getBoundingClientRect();
                  setKebabPos({ top: rect.bottom + 6, left: rect.left });
                }
                setKebabOpen((v) => !v);
              }}
              className="pf-bf sm"
              style={{
                padding: "5px 8px",
                background: kebabOpen ? "var(--ink)" : undefined,
                color: kebabOpen ? "var(--paper)" : undefined,
              }}
            >
              <MoreHorizontal size={13} />
            </button>
            {kebabOpen &&
              kebabPos !== null &&
              typeof document !== "undefined" &&
              createPortal(
                <div
                  ref={kebabRef}
                  className="pf-card pf-app"
                  style={{
                    position: "fixed",
                    top: kebabPos.top,
                    left: kebabPos.left,
                    width: 232,
                    padding: 6,
                    borderRadius: 11,
                    boxShadow: "var(--shadow-hard)",
                    zIndex: 9999,
                  }}
                >
                  <div
                    className="mono"
                    style={{
                      padding: "6px 10px",
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: "1.5px",
                      color: "var(--ink-3)",
                    }}
                  >
                    MORE ACTIONS
                  </div>
                  <KebabItem
                    icon={Copy}
                    label="Copy as text"
                    sub="Plain-text of this answer"
                    onClick={() => {
                      setKebabOpen(false);
                      void handleCopy();
                    }}
                  />
                  <KebabItem
                    icon={Share2}
                    label="Share link"
                    sub="Copy a link to this chat"
                    onClick={handleShare}
                  />
                  {reportHref && (
                    <Link href={reportHref} className="block">
                      <KebabItem
                        icon={FileDown}
                        label="Open full report"
                        sub="Detailed report page"
                        onClick={() => setKebabOpen(false)}
                      />
                    </Link>
                  )}
                </div>,
                document.body
              )}
          </div>
          {showFeedback && (
            <ResultFeedback
              surface="CHAT"
              refId={message.id}
              model={message.turnMeta?.model}
              tier={message.turnMeta?.tier}
              intent={message.turnMeta?.intent}
              symbols={message.turnMeta?.symbols}
              variantId={message.turnMeta?.variantId}
              className="contents"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ActionBtn({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pf-bf sm"
      style={{ padding: "5px 10px", fontSize: 11.5 }}
    >
      <Icon size={11} /> {label}
    </button>
  );
}

function KebabItem({
  icon: Icon,
  label,
  sub,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  sub: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left flex items-center gap-2.5"
      style={{ padding: "7px 10px", borderRadius: 7, color: "var(--ink)" }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = "var(--rule-softer)")
      }
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span
        className="grid place-items-center shrink-0"
        style={{
          width: 26,
          height: 26,
          borderRadius: 7,
          background: "var(--rule-softer)",
          border: "1.5px solid var(--rule-soft)",
          color: "var(--ink-2)",
        }}
      >
        <Icon size={12} />
      </span>
      <div className="min-w-0">
        <div style={{ fontSize: 12.5, fontWeight: 700 }}>{label}</div>
        <div style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 1 }}>
          {sub}
        </div>
      </div>
    </button>
  );
}
