"use client";

/**
 * Login Briefing Card
 *
 * Renders on the dashboard when an unread briefing exists.
 * Shows AI-generated portfolio summary with expandable sections.
 */

import { useEffect, useState, useTransition } from "react";
import {
  getLatestBriefingAction,
  markBriefingViewedAction,
} from "@/lib/actions/briefing";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { X, ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface BriefingSection {
  type: string;
  title: string;
  items: Array<{ label: string; value: string; change?: number }>;
}

interface BriefingData {
  id: string;
  summary: string | null;
  sections: BriefingSection[];
  portfolioValue: number | null;
  dayChange: number | null;
}

export function LoginBriefingCard() {
  const [briefing, setBriefing] = useState<BriefingData | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    getLatestBriefingAction().then((result) => {
      if (result?.success && result?.data) {
        setBriefing(result?.data as unknown as BriefingData);
      }
    });
  }, []);

  if (!briefing) return null;

  const handleDismiss = () => {
    startTransition(async () => {
      await markBriefingViewedAction(briefing.id);
      setBriefing(null);
    });
  };

  return (
    <Card className="relative border-blue-500/20 bg-blue-950/10">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-blue-400" />
            Morning Briefing
          </CardTitle>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={handleDismiss}
            disabled={isPending}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Summary */}
        {briefing.summary && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            {briefing.summary}
          </p>
        )}

        {/* Expandable sections */}
        {briefing.sections.length > 0 && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-between text-xs"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Show less" : "Show details"}
              {expanded ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
            </Button>

            {expanded && (
              <div className="space-y-4">
                {briefing.sections.map((section, i) => (
                  <div key={i}>
                    <h4 className="text-xs font-medium text-muted-foreground mb-1">
                      {section.title}
                    </h4>
                    <div className="space-y-1">
                      {section.items.map((item, j) => (
                        <div
                          key={j}
                          className="flex items-center justify-between text-sm"
                        >
                          <span>{item.label}</span>
                          <div className="flex items-center gap-2">
                            <span className="font-mono">{item.value}</span>
                            {item.change != null && (
                              <span
                                className={cn(
                                  "text-xs font-mono",
                                  item.change >= 0
                                    ? "text-green-500"
                                    : "text-red-500"
                                )}
                              >
                                {item.change >= 0 ? "+" : ""}
                                {item.change.toFixed(1)}%
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
