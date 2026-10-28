"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@usemoney/ui/dialog";
import {
  Bug,
  Lightbulb,
  Wrench,
  HelpCircle,
  MoreHorizontal,
  Loader2,
  Globe,
  MapPin,
} from "lucide-react";
import { toast } from "sonner";
import { submitFeedbackAction } from "@/lib/actions/feedback";

// ── Types ─────────────────────────────────────────────────────────────────────

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
  color: string; // CSS variable key for active border + bg accent (bright)
  textColor: string; // AA-compliant text/icon colour for the active chip
}[] = [
  {
    value: "BUG",
    label: "Bug",
    icon: Bug,
    color: "var(--pop-1)",
    textColor: "var(--pop-1-text)",
  },
  {
    value: "FEATURE_REQUEST",
    label: "Feature",
    icon: Lightbulb,
    color: "var(--pop-3)",
    textColor: "var(--pop-3-text)",
  },
  {
    value: "IMPROVEMENT",
    label: "Improvement",
    icon: Wrench,
    color: "var(--pop-5)",
    textColor: "var(--pop-5-text)",
  },
  {
    value: "QUESTION",
    label: "Question",
    icon: HelpCircle,
    color: "var(--emerald)",
    textColor: "var(--emerald-text)",
  },
  {
    value: "OTHER",
    label: "Other",
    icon: MoreHorizontal,
    color: "var(--pop-2)",
    textColor: "var(--pop-2-text)",
  },
];

// A short browser string — display-only, never sent to the action.
function getShortBrowser(): string {
  if (typeof navigator === "undefined") return "Unknown";
  const ua = navigator.userAgent;
  if (ua.includes("Firefox")) return "Firefox";
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("Chrome")) return "Chrome";
  if (ua.includes("Safari")) return "Safari";
  return "Browser";
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function FeedbackDialog({ open, onOpenChange }: FeedbackDialogProps) {
  const pathname = usePathname();
  const [type, setType] = useState<FeedbackTypeValue>("FEATURE_REQUEST");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resetForm = () => {
    setType("FEATURE_REQUEST");
    setTitle("");
    setDescription("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const result = await submitFeedbackAction({
        type,
        title,
        description,
        page: pathname || undefined,
      });

      if (result?.success) {
        toast.success("Feedback submitted! Thank you.");
        resetForm();
        onOpenChange(false);
      } else {
        toast.error(result?.error || "Failed to submit feedback");
      }
    } catch {
      toast.error("Something went wrong");
    } finally {
      setIsSubmitting(false);
    }
  };

  const isValid = title.length >= 5 && description.length >= 10;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="p-0 overflow-hidden gap-0"
        style={{
          maxWidth: 500,
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          borderRadius: 16,
          boxShadow: "6px 6px 0 var(--ink)",
          color: "var(--ink)",
        }}
      >
        {/* ── Header ───────────────────────────────────────────────── */}
        <DialogHeader className="p-0">
          <div
            style={{
              padding: "16px 22px",
              borderBottom: "2px solid var(--ink)",
              background: "var(--paper-2)",
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 9,
                background: "var(--ink)",
                color: "var(--paper)",
                display: "grid",
                placeItems: "center",
                flexShrink: 0,
                transform: "rotate(-3deg)",
              }}
            >
              <Bug className="h-4 w-4" />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <DialogTitle
                style={{
                  fontSize: 15,
                  fontWeight: 800,
                  letterSpacing: -0.3,
                  color: "var(--ink)",
                  margin: 0,
                }}
              >
                Submit feedback
              </DialogTitle>
              <p
                className="ser"
                style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 1 }}
              >
                Tell us what&apos;s working and what&apos;s not.
              </p>
            </div>
          </div>
        </DialogHeader>

        {/* ── Form body ────────────────────────────────────────────── */}
        <form onSubmit={handleSubmit}>
          <div
            style={{
              padding: "20px 22px",
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
                        color: active ? t.textColor : "var(--ink-3)",
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
                        style={{ color: active ? t.textColor : "var(--ink-3)" }}
                      />
                      <span style={{ whiteSpace: "nowrap" }}>{t.label}</span>
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
                    title.length >= 5 ? "var(--emerald-text)" : "var(--ink-4)",
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
                placeholder="Describe the issue, feature request, or idea in detail. For bugs, include steps to reproduce."
                rows={4}
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
                      ? "var(--emerald-text)"
                      : "var(--ink-4)",
                  marginTop: 4,
                  textAlign: "right",
                }}
              >
                {description.length}/2000
              </div>
            </div>

            {/* Auto-attached context — read-only, display only */}
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
              {/* Page pill */}
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
                  {pathname.length > 30 ? `…${pathname.slice(-27)}` : pathname}
                </span>
              )}
              {/* Browser pill */}
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

          {/* ── Footer ──────────────────────────────────────────────── */}
          <div
            style={{
              padding: "14px 22px",
              borderTop: "1.5px dashed var(--rule-soft)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              background: "var(--paper-2)",
            }}
          >
            <span
              className="ser"
              style={{ fontSize: 12, color: "var(--ink-4)" }}
            >
              We read every submission.
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="pf-bf sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !isValid}
                className="pf-bs sm"
                style={{
                  opacity: isSubmitting || !isValid ? 0.45 : 1,
                  cursor: isSubmitting || !isValid ? "not-allowed" : "pointer",
                }}
              >
                {isSubmitting && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                Submit →
              </button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
