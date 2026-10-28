"use client";

// Next 15+ : this authenticated app page renders the shared <Sidebar/> shell
// (which reads request-time useSearchParams), so static prerendering bails.
// It was never beneficially static (auth-gated, per-user data) — render it
// dynamically, matching the rest of the app. No user-visible behavior change.
export const dynamic = "force-dynamic";

import { useState, useEffect, useCallback } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { Skeleton } from "@usemoney/ui/skeleton";
import {
  MessageSquarePlus,
  Bug,
  Lightbulb,
  Wrench,
  HelpCircle,
  MoreHorizontal,
  Loader2,
  Send,
  MessageSquare,
  Globe,
  MapPin,
  Image as ImageIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PaginationControls } from "@/components/PaginationControls";
import {
  getUserFeedbackAction,
  submitFeedbackAction,
  type FeedbackItem,
} from "@/lib/actions/feedback";
import {
  ImageDropZone,
  type UploadedImage,
} from "@/components/feedback/ImageDropZone";
import { FeedbackThread } from "@/components/feedback/FeedbackThread";

// ── Types ────────────────────────────────────────────────────────────────────

type FeedbackTypeValue =
  | "BUG"
  | "FEATURE_REQUEST"
  | "IMPROVEMENT"
  | "QUESTION"
  | "OTHER";

const FEEDBACK_TYPES: {
  value: FeedbackTypeValue;
  label: string;
  icon: React.ComponentType<{
    className?: string;
    style?: React.CSSProperties;
  }>;
  color: string;
}[] = [
  { value: "BUG", label: "Bug", icon: Bug, color: "var(--pop-1)" },
  {
    value: "FEATURE_REQUEST",
    label: "Feature request",
    icon: Lightbulb,
    color: "var(--pop-3)",
  },
  {
    value: "IMPROVEMENT",
    label: "Improvement",
    icon: Wrench,
    color: "var(--pop-5)",
  },
  {
    value: "QUESTION",
    label: "Question",
    icon: HelpCircle,
    color: "var(--emerald)",
  },
  {
    value: "OTHER",
    label: "Other",
    icon: MoreHorizontal,
    color: "var(--pop-2)",
  },
];

const TYPE_CONFIG: Record<
  string,
  {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    color: string;
    initial: string;
  }
> = {
  BUG: { label: "Bug", icon: Bug, color: "var(--pop-1)", initial: "B" },
  FEATURE_REQUEST: {
    label: "Feature",
    icon: Lightbulb,
    color: "var(--pop-3)",
    initial: "F",
  },
  IMPROVEMENT: {
    label: "Improvement",
    icon: Wrench,
    color: "var(--pop-5)",
    initial: "I",
  },
  QUESTION: {
    label: "Question",
    icon: HelpCircle,
    color: "var(--emerald)",
    initial: "Q",
  },
  OTHER: {
    label: "Other",
    icon: MoreHorizontal,
    color: "var(--pop-2)",
    initial: "O",
  },
};

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  OPEN: { label: "Open", color: "var(--pop-2)" },
  IN_PROGRESS: { label: "In Progress", color: "var(--pop-3)" },
  PLANNED: { label: "Planned", color: "var(--pop-5)" },
  COMPLETED: { label: "Completed", color: "var(--emerald)" },
  DECLINED: { label: "Declined", color: "var(--pop-1)" },
  DUPLICATE: { label: "Duplicate", color: "var(--ink-3)" },
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

function getShortBrowser(): string {
  if (typeof navigator === "undefined") return "Unknown";
  const ua = navigator.userAgent;
  if (ua.includes("Firefox")) return "Firefox";
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("Chrome")) return "Chrome";
  if (ua.includes("Safari")) return "Safari";
  return "Browser";
}

const PAGE_SIZE = 10;

// ── Page ─────────────────────────────────────────────────────────────────────

export default function FeedbackPage() {
  const pathname = usePathname();

  // View state
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Form state
  const [type, setType] = useState<FeedbackTypeValue>("FEATURE_REQUEST");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAttachments, setShowAttachments] = useState(false);

  // List state
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const imagePaths = images
        .filter((img) => img.status === "uploaded" && img.path)
        .map((img) => img.path!);

      const result = await submitFeedbackAction({
        type,
        title,
        description,
        page: pathname || undefined,
        images: imagePaths.length > 0 ? imagePaths : undefined,
      });
      if (result?.success) {
        toast.success("Feedback submitted! Thank you.");
        setType("FEATURE_REQUEST");
        setTitle("");
        setDescription("");
        setImages([]);
        setShowAttachments(false);
        loadFeedback();
      } else {
        toast.error(result?.error || "Failed to submit feedback");
      }
    } catch {
      toast.error("Something went wrong");
    } finally {
      setIsSubmitting(false);
    }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const isValid =
    title.length >= 5 &&
    description.length >= 10 &&
    !images.some((img) => img.status === "uploading");

  // ── Thread view ────────────────────────────────────────────────────────
  if (selectedId) {
    return (
      <div
        className="min-h-screen"
        style={{ background: "var(--paper)", color: "var(--ink)" }}
      >
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="p-4 sm:p-6 h-[calc(100vh-var(--mobile-header-h))] lg:h-[calc(100vh-var(--topbar-h))]">
            <FeedbackThread
              feedbackId={selectedId}
              onBack={() => {
                setSelectedId(null);
                loadFeedback();
              }}
            />
          </div>
        </main>
      </div>
    );
  }

  // ── List + Submit view ─────────────────────────────────────────────────
  return (
    <div
      className="min-h-screen"
      style={{ background: "var(--paper)", color: "var(--ink)" }}
    >
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="p-4 sm:p-6" style={{ maxWidth: 680, margin: "0 auto" }}>
          {/* ── Page heading ─────────────────────────────────────── */}
          <div
            className="pf-ph is-mobile sm:pf-ph"
            style={{ marginBottom: 24 }}
          >
            <div className="l">
              <div className="eyebrow">
                <span className="d"></span>FEEDBACK · YOUR VOICE MATTERS
              </div>
              <h1>
                Tell us what&apos;s <span className="ser">working</span> &amp;{" "}
                <span className="hl">what&apos;s not.</span>
              </h1>
              <div className="sub">
                Bug reports, feature requests, improvements — we read every
                submission and reply to most.
              </div>
            </div>
          </div>

          {/* ── Submit form ──────────────────────────────────────── */}
          <div
            className="pf-card"
            style={{ padding: 0, overflow: "hidden", marginBottom: 20 }}
          >
            {/* Form header */}
            <div
              style={{
                padding: "14px 20px",
                borderBottom: "1.5px dashed var(--rule-soft)",
                background: "var(--paper-2)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
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
                  Submit feedback
                </div>
                <div
                  className="ser"
                  style={{
                    fontSize: 12.5,
                    color: "var(--ink-3)",
                    marginTop: 1,
                  }}
                >
                  We&apos;ll get back to you via the thread below.
                </div>
              </div>
              <MessageSquarePlus
                className="h-5 w-5"
                style={{ color: "var(--ink-3)" }}
              />
            </div>

            <form onSubmit={handleSubmit}>
              <div
                style={{
                  padding: "18px 20px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 16,
                }}
              >
                {/* Category grid */}
                <div>
                  <div
                    className="mono"
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: 1.5,
                      textTransform: "uppercase",
                      color: "var(--ink-3)",
                      marginBottom: 8,
                    }}
                  >
                    Category
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(5, 1fr)",
                      gap: 6,
                    }}
                  >
                    {FEEDBACK_TYPES.map((t) => {
                      const Icon = t.icon;
                      const active = type === t.value;
                      return (
                        <button
                          type="button"
                          key={t.value}
                          onClick={() => setType(t.value)}
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            gap: 5,
                            padding: "10px 6px",
                            borderRadius: 9,
                            border: active
                              ? `1.5px solid ${t.color}`
                              : "1.5px solid var(--rule-soft)",
                            background: active
                              ? `color-mix(in srgb, ${t.color} 12%, transparent)`
                              : "transparent",
                            color: active ? t.color : "var(--ink-3)",
                            cursor: "pointer",
                            transition: "all 0.12s",
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: 0.3,
                          }}
                        >
                          <Icon
                            className="h-3.5 w-3.5"
                            style={{ color: active ? t.color : "var(--ink-3)" }}
                          />
                          <span
                            style={{
                              whiteSpace: "nowrap",
                              textAlign: "center",
                              lineHeight: 1.2,
                            }}
                          >
                            {t.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Title */}
                <div>
                  <label
                    className="mono"
                    style={{
                      display: "block",
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: 1.5,
                      textTransform: "uppercase",
                      color: "var(--ink-3)",
                      marginBottom: 6,
                    }}
                  >
                    Title
                  </label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Short summary of your feedback"
                    className="pf-input"
                    required
                    minLength={5}
                    maxLength={200}
                  />
                  <div
                    className="mono"
                    style={{
                      fontSize: 10,
                      color:
                        title.length >= 5 ? "var(--emerald)" : "var(--ink-4)",
                      marginTop: 4,
                      textAlign: "right",
                    }}
                  >
                    {title.length}/200
                  </div>
                </div>

                {/* Description */}
                <div>
                  <label
                    className="mono"
                    style={{
                      display: "block",
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: 1.5,
                      textTransform: "uppercase",
                      color: "var(--ink-3)",
                      marginBottom: 6,
                    }}
                  >
                    Description
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe the bug, feature request, or improvement in detail. For bugs, include steps to reproduce."
                    rows={5}
                    className="pf-input resize-none"
                    required
                    minLength={10}
                    maxLength={2000}
                    style={{ lineHeight: 1.5 }}
                  />
                  <div
                    className="mono"
                    style={{
                      fontSize: 10,
                      color:
                        description.length >= 10
                          ? "var(--emerald)"
                          : "var(--ink-4)",
                      marginTop: 4,
                      textAlign: "right",
                    }}
                  >
                    {description.length}/2000
                  </div>
                </div>

                {/* Attachments toggle + drop zone */}
                <div>
                  <button
                    type="button"
                    onClick={() => setShowAttachments((v) => !v)}
                    className="pf-bf sm"
                    style={{ marginBottom: showAttachments ? 10 : 0 }}
                  >
                    <ImageIcon className="h-3.5 w-3.5" />
                    {showAttachments ? "Hide attachments" : "Add screenshots"}
                  </button>
                  {showAttachments && (
                    <ImageDropZone
                      images={images}
                      onImagesChange={setImages}
                      disabled={isSubmitting}
                    />
                  )}
                </div>

                {/* Auto-attached context */}
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: 9,
                    border: "1.5px dashed var(--rule-soft)",
                    background: "var(--paper-2)",
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                    alignItems: "center",
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      fontSize: 9.5,
                      fontWeight: 700,
                      letterSpacing: 1,
                      textTransform: "uppercase",
                      color: "var(--ink-4)",
                      marginRight: 2,
                    }}
                  >
                    Auto-attached:
                  </span>
                  {pathname && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "2px 8px",
                        borderRadius: 999,
                        border: "1.5px solid var(--rule-soft)",
                        background: "var(--paper)",
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        color: "var(--ink-3)",
                        fontWeight: 600,
                      }}
                    >
                      <MapPin className="h-2.5 w-2.5" />
                      {pathname.length > 40
                        ? `…${pathname.slice(-37)}`
                        : pathname}
                    </span>
                  )}
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 8px",
                      borderRadius: 999,
                      border: "1.5px solid var(--rule-soft)",
                      background: "var(--paper)",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      color: "var(--ink-3)",
                      fontWeight: 600,
                    }}
                  >
                    <Globe className="h-2.5 w-2.5" />
                    {getShortBrowser()}
                  </span>
                </div>
              </div>

              {/* Form footer */}
              <div
                style={{
                  padding: "12px 20px",
                  borderTop: "1.5px dashed var(--rule-soft)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: "var(--paper-2)",
                  gap: 8,
                }}
              >
                <span
                  className="ser"
                  style={{ fontSize: 12, color: "var(--ink-4)" }}
                >
                  We read every submission.
                </span>
                <button
                  type="submit"
                  disabled={isSubmitting || !isValid}
                  className="pf-bs"
                  style={{
                    opacity: isSubmitting || !isValid ? 0.45 : 1,
                    cursor:
                      isSubmitting || !isValid ? "not-allowed" : "pointer",
                  }}
                >
                  {isSubmitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  Submit feedback →
                </button>
              </div>
            </form>
          </div>

          {/* ── Submissions list ─────────────────────────────────── */}
          <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
            {/* List header */}
            <div
              style={{
                padding: "12px 20px",
                borderBottom: "1.5px dashed var(--rule-soft)",
                background: "var(--paper-2)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 1.5,
                  textTransform: "uppercase",
                  color: "var(--ink-4)",
                }}
              >
                Your submissions
              </div>
              {total > 0 && (
                <span
                  className="mono"
                  style={{ fontSize: 10, color: "var(--ink-4)" }}
                >
                  {total} total
                </span>
              )}
            </div>

            {/* List body */}
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
              <div style={{ padding: "48px 20px", textAlign: "center" }}>
                <MessageSquarePlus
                  className="h-10 w-10 mx-auto mb-4"
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
                  No feedback yet
                </p>
                <p
                  className="ser"
                  style={{ fontSize: 13, color: "var(--ink-3)" }}
                >
                  Use the form above to submit your first ticket.
                </p>
              </div>
            ) : (
              items.map((item, idx) => {
                const tCfg = TYPE_CONFIG[item.type] || TYPE_CONFIG.OTHER;
                const sCfg = STATUS_CONFIG[item.status] || STATUS_CONFIG.OPEN;
                const isLast = idx === items.length - 1;

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    className="set-row"
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "12px 20px",
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      background: "transparent",
                      border: "none",
                      borderBottom: isLast
                        ? "none"
                        : "1px dashed var(--rule-soft)",
                      cursor: "pointer",
                      transition: "background 0.1s",
                    }}
                  >
                    {/* Type avatar */}
                    <div
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: "50%",
                        border: `1.5px solid ${tCfg.color}`,
                        background: `color-mix(in srgb, ${tCfg.color} 12%, transparent)`,
                        color: tCfg.color,
                        display: "grid",
                        placeItems: "center",
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 800,
                        fontSize: 12,
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
                          gap: 6,
                          marginBottom: 2,
                        }}
                      >
                        <span
                          className="mono"
                          style={{
                            fontSize: 9.5,
                            color: "var(--emerald)",
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
                            color: sCfg.color,
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
                          {timeAgo(item.updatedAt)}
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

                    {/* Reply badge */}
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
                          color: "var(--emerald)",
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 10.5,
                          fontWeight: 700,
                          flexShrink: 0,
                        }}
                      >
                        <MessageSquare className="h-2.5 w-2.5" />
                        {item.replyCount}
                      </span>
                    )}
                  </button>
                );
              })
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div
                style={{
                  padding: "12px 20px",
                  borderTop: "1.5px dashed var(--rule-soft)",
                  background: "var(--paper-2)",
                }}
              >
                <PaginationControls
                  currentPage={page}
                  totalPages={totalPages}
                  onPageChange={setPage}
                  pageSize={PAGE_SIZE}
                  totalItems={total}
                  label="submissions"
                />
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
