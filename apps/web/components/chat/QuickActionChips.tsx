"use client";

import { useChatContext } from "@/lib/chat/ChatContext";
import {
  TrendingUp,
  Briefcase,
  Flame,
  Search,
  Target,
  Sparkles,
} from "lucide-react";
import { EmptyState } from "@/components/empty/EmptyState";

const QUICK_ACTIONS = [
  {
    label: "Market pulse",
    prompt:
      "Market overview - how are Nifty 50, Sensex, and Bank Nifty performing today? Show sector heatmap, FII/DII flow summary, and top 5 gainers/losers with percentage moves.",
    icon: TrendingUp,
    fillOnly: false,
  },
  {
    label: "How's my portfolio?",
    prompt:
      "How's my portfolio doing this quarter? Show XIRR, total P&L, sector allocation, and top/bottom performers.",
    icon: Briefcase,
    fillOnly: false,
  },
  {
    label: "Roast my holdings",
    prompt:
      "Roast my portfolio - score my holdings on diversification, concentration risk, sector allocation, and quality. Flag any red flags and suggest specific improvements.",
    icon: Flame,
    fillOnly: false,
  },
  {
    label: "Research a stock",
    prompt: "Research ",
    icon: Search,
    fillOnly: true,
    placeholder: "Type a stock symbol, e.g. Research RELIANCE",
  },
  {
    label: "FIRE status",
    prompt:
      "Show my FIRE scenarios with detailed projections - years to FIRE, monthly SIP needed, corpus growth chart, and withdrawal sustainability analysis at 4% rate adjusted for Indian inflation.",
    icon: Target,
    fillOnly: false,
  },
];

interface QuickActionChipsProps {
  onFillInput?: (text: string) => void;
  /** Render as the empty-state hero (no messages yet) */
  asEmptyState?: boolean;
}

export default function QuickActionChips({
  onFillInput,
  asEmptyState = false,
}: QuickActionChipsProps) {
  const { executeQuickAction, isLoading } = useChatContext();

  const handleClick = (action: (typeof QUICK_ACTIONS)[number]) => {
    if (action.fillOnly && onFillInput) {
      onFillInput(action.prompt);
    } else {
      executeQuickAction(action.prompt);
    }
  };

  if (asEmptyState) {
    return (
      <div className="flex flex-col items-center gap-6 w-full max-w-2xl mx-auto">
        <EmptyState
          icon={Sparkles}
          title="Ask StockSage your first question."
          description="Your AI-powered research assistant is ready to help with your portfolio, analyse stocks, plan for FIRE, or answer any investing question."
          card={false}
        />
        {/* Quick chips */}
        <div className="flex flex-wrap justify-center gap-2">
          {QUICK_ACTIONS.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.label}
                type="button"
                onClick={() => handleClick(action)}
                disabled={isLoading}
                className="pf-pill outline disabled:opacity-50"
                style={{
                  fontSize: 11.5,
                  padding: "6px 12px",
                  cursor: "pointer",
                }}
              >
                <Icon className="h-3 w-3" />
                {action.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {QUICK_ACTIONS.map((action) => {
        const Icon = action.icon;
        return (
          <button
            key={action.label}
            type="button"
            onClick={() => handleClick(action)}
            disabled={isLoading}
            className="pf-pill outline disabled:opacity-50"
            style={{ fontSize: 11.5, padding: "5px 11px", cursor: "pointer" }}
          >
            <Icon className="h-3 w-3" />
            {action.label}
          </button>
        );
      })}
    </div>
  );
}
