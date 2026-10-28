"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { useChatContext } from "@/lib/chat/ChatContext";
import {
  TrendingUp,
  Users,
  Newspaper,
  BarChart3,
  Search,
  SlidersHorizontal,
  Flame,
  Plus,
  LineChart,
} from "lucide-react";
import type { ChatMessageWithBlocks } from "@usemoney/types";
import { PERSONA_CHIPS } from "@/lib/gemini/persona-chips";

interface FollowUpChip {
  label: string;
  /**
   * Free-text prompt - falls through the chat classifier. Used for chips
   * where intent is ambiguous + the LLM is the right router. Avoid when
   * a deterministic tool is available (the classifier collapses adjacent
   * portfolio prompts into the cheapest route - see task #46).
   */
  prompt?: string;
  /** Deterministic tool dispatch - bypasses the classifier (preferred) */
  tool?: string;
  params?: Record<string, unknown>;
  /** Navigate to a dedicated page instead of running a chat tool */
  navigateTo?: string;
  /** Open the composer's stock/fund picker (deterministic) instead of sending a
   *  free-text prompt — the classifier otherwise misroutes "analyse a stock"
   *  into "research <the whole sentence>". */
  openPicker?: "stocks" | "funds";
  /** Text shown in the chat history when a tool/navigate chip fires */
  userText?: string;
  icon: React.ComponentType<{ className?: string }>;
}

type ResponseContext =
  | "stock-options"
  | "stock-analysis"
  | "screener"
  | "portfolio"
  | "comparison"
  | "mutual-fund"
  | "generic";

// ============== Icon Mapping ==============

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  TrendingUp,
  Users,
  Newspaper,
  BarChart3,
  Search,
  SlidersHorizontal,
  Flame,
  Plus,
  LineChart,
};

// ============== Persona-Aware Chips ==============

/** Extract stock symbol from "What would you like to know about **SYMBOL**?" */
function extractStockFromMessages(messages: ChatMessageWithBlocks[]): string {
  // Check the last few messages for a stock symbol reference
  for (
    let i = messages.length - 1;
    i >= Math.max(0, messages.length - 4);
    i--
  ) {
    const msg = messages[i];
    if (!msg) continue;
    const boldMatch = msg.content?.match(/\*\*([A-Z][A-Z0-9&]+)\*\*/);
    if (boldMatch?.[1]) return boldMatch[1];
  }
  return "this stock";
}

/**
 * Get chips from persona definitions, interpolating {symbol} placeholders.
 */
function getChipsFromPersona(
  personaId: string,
  messages: ChatMessageWithBlocks[]
): FollowUpChip[] | null {
  const chips = PERSONA_CHIPS[personaId];
  if (!chips || chips.length === 0) return null;

  const symbol = extractStockFromMessages(messages);

  return chips.map((chip) => ({
    label: chip.label,
    prompt: chip.prompt
      ? chip.prompt.replace(/\{symbol\}/g, symbol)
      : undefined,
    tool: chip.tool,
    params: chip.params
      ? // Interpolate {symbol} into any string param values too
        Object.fromEntries(
          Object.entries(chip.params).map(([k, v]) => [
            k,
            typeof v === "string" ? v.replace(/\{symbol\}/g, symbol) : v,
          ])
        )
      : undefined,
    navigateTo: chip.navigateTo,
    userText: chip.userText
      ? chip.userText.replace(/\{symbol\}/g, symbol)
      : undefined,
    icon: ICON_MAP[chip.icon] || Search,
  }));
}

// ============== Legacy Context Detection ==============

function detectContext(messages: ChatMessageWithBlocks[]): ResponseContext {
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");
  if (!lastAssistant) return "generic";

  const content = lastAssistant.content?.toLowerCase() || "";
  const blocks = lastAssistant.blocks || [];
  const blockTypes = blocks.map((b) => b.type);

  if (
    content.includes("what would you like to know about") &&
    (content.includes("equity research") ||
      content.includes("deep valuation") ||
      content.includes("choose an option"))
  ) {
    return "stock-options";
  }

  if (
    content.includes("score:") ||
    content.includes("/100") ||
    content.includes("analysis of") ||
    content.includes("research report") ||
    content.includes("investment score") ||
    content.includes("quality score")
  ) {
    return "stock-analysis";
  }

  if (
    blockTypes.includes("table") &&
    (content.includes("screen") ||
      content.includes("filter") ||
      content.includes("stocks found") ||
      content.includes("results"))
  ) {
    return "screener";
  }

  if (
    content.includes(" vs ") ||
    content.includes("comparison") ||
    content.includes("head to head") ||
    content.includes("compared")
  ) {
    return "comparison";
  }

  if (
    content.includes("portfolio") ||
    content.includes("holdings") ||
    content.includes("positions")
  ) {
    return "portfolio";
  }

  if (
    content.includes("mutual fund") ||
    content.includes("nav") ||
    content.includes("sip")
  ) {
    return "mutual-fund";
  }

  return "generic";
}

function getChipsForContext(
  context: ResponseContext,
  messages: ChatMessageWithBlocks[]
): FollowUpChip[] {
  switch (context) {
    case "stock-options": {
      const symbol = extractStockFromMessages(messages);
      return [
        {
          label: "Equity Research",
          prompt: `Equity research analysis of ${symbol} - quality score, thesis, key metrics`,
          icon: TrendingUp,
        },
        {
          label: "Deep Valuation",
          prompt: `Run a DCF valuation and cash flow quality analysis for ${symbol}`,
          icon: Search,
        },
        {
          label: "Technical Analysis",
          prompt: `Technical analysis of ${symbol} - RSI, MACD, support/resistance`,
          icon: LineChart,
        },
        {
          label: "Peer Comparison",
          prompt: `Compare ${symbol} with its top peers in the same sector`,
          icon: Users,
        },
        {
          label: "Latest News",
          prompt: `Latest news headlines for ${symbol}`,
          icon: Newspaper,
        },
      ];
    }
    case "stock-analysis":
      return [
        {
          label: "Deep dive",
          prompt:
            "Give me a deeper analysis with DCF valuation and cash flow quality",
          icon: TrendingUp,
        },
        {
          label: "Compare with peers",
          prompt: "Compare this stock with its top peers in the same sector",
          icon: Users,
        },
        {
          label: "Latest news",
          prompt: "Show latest news headlines for this stock",
          icon: Newspaper,
        },
        {
          label: "Technical analysis",
          prompt: "Show technical analysis with RSI, MACD, and moving averages",
          icon: LineChart,
        },
      ];
    case "screener":
      return [
        {
          label: "Analyse top result",
          prompt: "Analyse the top stock from these results in detail",
          icon: TrendingUp,
        },
        {
          label: "Refine filters",
          prompt: "Refine the screen with stricter quality filters",
          icon: SlidersHorizontal,
        },
        {
          label: "Different strategy",
          prompt: "Try a different screening strategy - momentum or growth",
          icon: Search,
        },
      ];
    case "portfolio":
      return [
        {
          label: "Roast my portfolio",
          prompt: "Roast my portfolio - give me honest AI feedback",
          icon: Flame,
        },
        {
          label: "Screen similar stocks",
          prompt:
            "Screen for stocks similar to my top holdings - same sector and fundamentals",
          icon: Search,
        },
        {
          label: "Analyse top holding",
          prompt: "Give me a detailed analysis of my largest holding",
          icon: TrendingUp,
        },
        {
          label: "Sector allocation",
          prompt: "Show my portfolio sector allocation breakdown",
          icon: BarChart3,
        },
      ];
    case "comparison":
      return [
        {
          label: "Detailed analysis of winner",
          prompt:
            "Give me a detailed analysis of the better performing stock from the comparison",
          icon: TrendingUp,
        },
        {
          label: "Add another stock",
          prompt: "Add one more competitor to the comparison",
          icon: Plus,
        },
        {
          label: "Sector overview",
          prompt: "Give me an overview of this entire sector",
          icon: BarChart3,
        },
      ];
    case "mutual-fund":
      return [
        {
          label: "Compare funds",
          prompt: "Compare my top mutual funds against their benchmark indices",
          icon: BarChart3,
        },
        {
          label: "SIP calculator",
          prompt: "Project my SIP returns for the next 10 years",
          icon: TrendingUp,
        },
        {
          label: "Category analysis",
          prompt: "Analyse my mutual fund allocation across categories",
          icon: Search,
        },
      ];
    default:
      return [
        {
          // MONEY-240 follow-up (B6): chip used to dispatch a hardcoded
          // RELIANCE prompt regardless of what the user actually wanted
          // to analyse. Now it asks the user to name the stock - which
          // routes through the standard intent classifier + bare-stock
          // confirmation flow that respects the user's saved Deep
          // style + customSkills.
          label: "Analyse a stock",
          openPicker: "stocks",
          icon: TrendingUp,
        },
        {
          label: "Analyse a fund",
          openPicker: "funds",
          icon: BarChart3,
        },
        {
          label: "Screen stocks",
          prompt: "Find undervalued large caps with high ROE and low debt",
          icon: Search,
        },
        {
          label: "Portfolio summary",
          prompt: "Show me my portfolio summary with total value and P&L",
          icon: BarChart3,
        },
      ];
  }
}

// ============== Component ==============

export default function FollowUpChips() {
  const {
    messages,
    executeQuickAction,
    executeToolDirect,
    addLocalMessage,
    isLoading,
    currentPersonaId,
    requestStockPicker,
  } = useChatContext();
  const router = useRouter();

  const chips = useMemo(() => {
    if (messages.length === 0) return [];
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role !== "assistant") return [];

    // Priority 1: Use persona-specific chips if persona is active
    if (currentPersonaId) {
      const personaChips = getChipsFromPersona(currentPersonaId, messages);
      if (personaChips && personaChips.length > 0) return personaChips;
    }

    // Priority 2: Fall back to context-based detection
    const context = detectContext(messages);
    return getChipsForContext(context, messages);
  }, [messages, currentPersonaId]);

  if (chips.length === 0 || isLoading) return null;

  // Dispatch order: tool > navigate > prompt. Deterministic dispatchers
  // bypass the classifier so chips like "Sector Breakdown" no longer
  // collapse into the same dashboard summary as "Roast Portfolio".
  const handleClick = (chip: FollowUpChip) => {
    const userText = chip.userText || chip.label;
    if (chip.openPicker) {
      requestStockPicker(chip.openPicker);
      return;
    }
    if (chip.tool) {
      executeToolDirect(userText, chip.tool, chip.params || {});
      return;
    }
    if (chip.navigateTo) {
      addLocalMessage(userText, `Opening ${chip.label}…`, chip.navigateTo);
      // Brief delay so the user sees the confirmation before the route swap.
      setTimeout(() => router.push(chip.navigateTo!), 200);
      return;
    }
    if (chip.prompt) {
      executeQuickAction(chip.prompt);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 px-1 py-2 max-w-3xl mx-auto w-full">
      <span
        className="mono"
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "1px",
          color: "var(--ink-3)",
        }}
      >
        TRY
      </span>
      {chips.map((chip) => {
        const Icon = chip.icon;
        return (
          <button
            key={chip.label}
            type="button"
            onClick={() => handleClick(chip)}
            disabled={isLoading}
            className="pf-pill outline disabled:opacity-50"
            style={{ fontSize: 11.5, padding: "5px 11px", cursor: "pointer" }}
          >
            <Icon className="h-3 w-3" />
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}
