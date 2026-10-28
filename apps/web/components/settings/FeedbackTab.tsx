"use client";

import { useState, useEffect, useCallback } from "react";
import { Skeleton } from "@usemoney/ui/skeleton";
import {
  MessageSquarePlus,
  Bug,
  Lightbulb,
  Wrench,
  HelpCircle,
  MoreHorizontal,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
} from "lucide-react";
import { FeedbackDialog } from "@/components/feedback/FeedbackDialog";
import {
  getUserFeedbackAction,
  type FeedbackItem,
} from "@/lib/actions/feedback";

// ── Config ────────────────────────────────────────────────────────────────────

const TYPE_CONFIG: Record<
  string,
  {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    color: string; // bright accent for border/tint (large-graphic)
    textColor: string; // AA-safe text variant of color
    initial: string;
  }
> = {
  BUG: {
    label: "Bug",
    icon: Bug,
    color: "var(--pop-1)",
    textColor: "var(--pop-1-text)",
    initial: "B",
  },
  FEATURE_REQUEST: {
    label: "Feature",
    icon: Lightbulb,
    color: "var(--pop-3)",
    textColor: "var(--pop-3-text)",
    initial: "F",
  },
  IMPROVEMENT: {
    label: "Improvement",
    icon: Wrench,
    color: "var(--pop-5)",
    textColor: "var(--pop-5-text)",
    initial: "I",
  },
  QUESTION: {
    label: "Question",
    icon: HelpCircle,
    color: "var(--emerald)",
    textColor: "var(--emerald-text)",
    initial: "Q",
  },
  OTHER: {
    label: "Other",
    icon: MoreHorizontal,
    color: "var(--pop-2)",
    textColor: "var(--pop-2-text)",
    initial: "O",
  },
};

const STATUS_CONFIG: Record<
  string,
  { label: string; color: string; textColor: string }
> = {
  OPEN: { label: "Open", color: "var(--pop-2)", textColor: "var(--pop-2-text)" },
  IN_PROGRESS: {
    label: "In Progress",
    color: "var(--pop-3)",
    textColor: "var(--pop-3-text)",
  },
  PLANNED: {
    label: "Planned",
    color: "var(--pop-5)",
    textColor: "var(--pop-5-text)",
  },
  COMPLETED: {
    label: "Completed",
    color: "var(--emerald)",
    textColor: "var(--emerald-text)",
  },
  DECLINED: {
    label: "Declined",
    color: "var(--pop-1)",
    textColor: "var(--pop-1-text)",
  },
  DUPLICATE: {
    label: "Duplicate",
    color: "var(--ink-3)",
    textColor: "var(--ink-3)",
  },
};

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

const PAGE_SIZE = 10;

// ── Component ─────────────────────────────────────────────────────────────────

export function FeedbackTab() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const loadFeedback = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await getUserFeedbackAction({
        skip: page * PAGE_SIZE,
        limit: PAGE_SIZE,
      });
      if (result?.success && result?.data) {
        setItems(result.data.items);
        setTotal(result.data.total);
      }
    } catch {
      // silent
    } finally {
      setIsLoading(false);
    }
  }, [page]);

  useEffect(() => {
    loadFeedback();
  }, [loadFeedback]);

  const handleDialogChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) loadFeedback();
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-5">
      {/* ── Header card ───────────────────────────────────────── */}
      <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
        <div
          style={{
            padding: "16px 22px",
            borderBottom: "1.5px dashed var(--rule-soft)",
            background: "var(--paper-2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 800,
                letterSpacing: -0.3,
                color: "var(--ink)",
              }}
            >
              Feedback &amp; Feature Requests
            </div>
            <div
              className="ser"
              style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 2 }}
            >
              Share bugs, feature requests, and improvements. We review every
              submission.
            </div>
          </div>
          <button onClick={() => setDialogOpen(true)} className="pf-bs sm">
            <MessageSquarePlus className="h-3.5 w-3.5" />
            Submit Feedback
          </button>
        </div>

        {/* ── Submissions list ─────────────────────────────────── */}
        {isLoading ? (
          <div
            style={{
              padding: 16,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                style={{ display: "flex", gap: 10, alignItems: "center" }}
              >
                <Skeleton
                  className="h-9 w-9 rounded-full flex-shrink-0"
                  style={{ background: "var(--rule-softer)" }}
                />
                <div style={{ flex: 1 }}>
                  <Skeleton
                    className="h-4 w-3/4 rounded"
                    style={{ background: "var(--rule-softer)" }}
                  />
                  <Skeleton
                    className="h-3 w-1/2 rounded mt-1.5"
                    style={{ background: "var(--rule-softer)" }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: "40px 22px", textAlign: "center" }}>
            <MessageSquarePlus
              className="h-10 w-10 mx-auto mb-3"
              style={{ color: "var(--ink-4)", opacity: 0.5 }}
            />
            <p
              style={{
                fontWeight: 700,
                color: "var(--ink)",
                fontSize: 14,
                marginBottom: 4,
              }}
            >
              No feedback submitted yet
            </p>
            <p className="ser" style={{ fontSize: 13, color: "var(--ink-3)" }}>
              Share your ideas, report bugs, or request features
            </p>
          </div>
        ) : (
          <>
            <div>
              {items.map((item, idx) => {
                const tCfg = TYPE_CONFIG[item.type] || TYPE_CONFIG.OTHER;
                const sCfg = STATUS_CONFIG[item.status] || STATUS_CONFIG.OPEN;
                const isLast = idx === items.length - 1;

                return (
                  <div
                    key={item.id}
                    style={{
                      padding: "12px 22px",
                      borderBottom: isLast
                        ? "none"
                        : "1px dashed var(--rule-soft)",
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                    }}
                  >
                    {/* Type avatar */}
                    <div
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: "50%",
                        border: `1.5px solid ${tCfg.color}`,
                        background: `color-mix(in srgb, ${tCfg.color} 12%, transparent)`,
                        color: tCfg.textColor,
                        display: "grid",
                        placeItems: "center",
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 800,
                        fontSize: 11,
                        flexShrink: 0,
                      }}
                    >
                      {tCfg.initial}
                    </div>

                    {/* Content */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                          marginBottom: 2,
                        }}
                      >
                        <span
                          className="mono"
                          style={{
                            fontSize: 9.5,
                            color: "var(--emerald-text)",
                            fontWeight: 700,
                            letterSpacing: 0.4,
                          }}
                        >
                          #{item.id.slice(-6).toUpperCase()}
                        </span>
                        <span style={{ color: "var(--ink-4)", fontSize: 10 }}>
                          ·
                        </span>
                        <span
                          className="mono"
                          style={{
                            fontSize: 9.5,
                            color: sCfg.textColor,
                            fontWeight: 700,
                            letterSpacing: 0.5,
                            textTransform: "uppercase",
                          }}
                        >
                          {sCfg.label}
                        </span>
                        <span style={{ color: "var(--ink-4)", fontSize: 10 }}>
                          ·
                        </span>
                        <span
                          className="mono"
                          style={{ fontSize: 9.5, color: "var(--ink-4)" }}
                        >
                          {timeAgo(item.createdAt)}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 13.5,
                          fontWeight: 700,
                          color: "var(--ink)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.title}
                      </div>
                    </div>

                    {/* Reply count */}
                    {item.replyCount > 0 && (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "2px 7px",
                          borderRadius: 999,
                          border: "1.5px solid var(--emerald)",
                          background: "var(--emerald-bg)",
                          color: "var(--emerald-text)",
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 10,
                          fontWeight: 700,
                          flexShrink: 0,
                        }}
                      >
                        <MessageSquare className="h-2.5 w-2.5" />
                        {item.replyCount}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div
                style={{
                  padding: "12px 22px",
                  borderTop: "1.5px dashed var(--rule-soft)",
                  background: "var(--paper-2)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span
                  className="mono"
                  style={{ fontSize: 10.5, color: "var(--ink-3)" }}
                >
                  {total} submission{total !== 1 ? "s" : ""}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button
                    className="pf-bf sm"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    style={{
                      opacity: page === 0 ? 0.4 : 1,
                      cursor: page === 0 ? "not-allowed" : "pointer",
                      padding: "5px 8px",
                    }}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <span className="pf-pill outline" style={{ fontSize: 10 }}>
                    {page + 1} / {totalPages}
                  </span>
                  <button
                    className="pf-bf sm"
                    onClick={() =>
                      setPage((p) => Math.min(totalPages - 1, p + 1))
                    }
                    disabled={page >= totalPages - 1}
                    style={{
                      opacity: page >= totalPages - 1 ? 0.4 : 1,
                      cursor:
                        page >= totalPages - 1 ? "not-allowed" : "pointer",
                      padding: "5px 8px",
                    }}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <FeedbackDialog open={dialogOpen} onOpenChange={handleDialogChange} />
    </div>
  );
}
