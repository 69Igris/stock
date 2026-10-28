"use client";

/**
 * ResultFeedback (MONEY-587) — 👍/👎 on a single AI result with an optional
 * message, the way ChatGPT / Claude do it. Reusable across chat messages,
 * research results and the roast page (pass the matching `surface` + `refId`).
 *
 * Flow:
 *   1. Click a thumb → the rating is recorded immediately (optimistic) and a
 *      small panel opens to collect an optional reason + message.
 *   2. The user can pick quick reasons, type a note, and Send — or dismiss
 *      (the thumb stays recorded either way).
 *   3. Clicking the active thumb again clears the rating.
 *
 * The component never blocks the surrounding UI: a failed write just reverts
 * the optimistic state with a quiet toast.
 */

import { useState, useTransition, useCallback } from "react";
import { ThumbsUp, ThumbsDown, X, Send, Check } from "lucide-react";
import { toast } from "sonner";
import {
  submitResultFeedbackAction,
  clearResultFeedbackAction,
} from "@/lib/actions/result-feedback";

type Surface = "CHAT" | "RESEARCH" | "ROAST";
type Rating = "UP" | "DOWN";

interface ResultFeedbackProps {
  surface: Surface;
  /** chat message id / research sessionId / roast sessionId */
  refId: string;
  chatId?: string;
  model?: string;
  tier?: string;
  intent?: string;
  symbols?: string[];
  /**
   * MONEY-800 (B6): the explanation-style bandit arm that produced this answer
   * (echoed from the assistant message metadata). Forwarded on every rating so
   * the thumbs outcome can be attributed back to the arm.
   */
  variantId?: string;
  /** Pre-hydrated existing rating (e.g. on chat reload). */
  initial?: { rating: Rating; comment: string | null } | null;
  className?: string;
}

const DOWN_REASONS = [
  "Inaccurate",
  "Not helpful",
  "Missing data",
  "Too generic",
  "Off-topic",
];
const UP_REASONS = ["Accurate", "Helpful", "Well-sourced", "Clear"];

export default function ResultFeedback({
  surface,
  refId,
  chatId,
  model,
  tier,
  intent,
  symbols,
  variantId,
  initial = null,
  className,
}: ResultFeedbackProps) {
  const [rating, setRating] = useState<Rating | null>(initial?.rating ?? null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [reasons, setReasons] = useState<string[]>([]);
  const [sent, setSent] = useState<boolean>(Boolean(initial?.comment));
  const [pending, startTransition] = useTransition();

  const provenance = { chatId, model, tier, intent, symbols, variantId };

  const submit = useCallback(
    (next: Rating, extra?: { comment?: string; reasons?: string[] }) => {
      startTransition(async () => {
        const res = await submitResultFeedbackAction({
          surface,
          refId,
          rating: next,
          comment: extra?.comment,
          reasons: extra?.reasons,
          ...provenance,
        });
        if (!res.success) {
          // revert optimistic rating
          setRating(initial?.rating ?? null);
          toast.error("Couldn't save your feedback");
        }
      });
    },
    // provenance is derived from stable props; refId/surface identify the row
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [surface, refId]
  );

  const onThumb = useCallback(
    (next: Rating) => {
      if (rating === next) {
        // toggle off
        setRating(null);
        setPanelOpen(false);
        setSent(false);
        startTransition(async () => {
          await clearResultFeedbackAction(surface, refId);
        });
        return;
      }
      setRating(next);
      setReasons([]);
      setComment("");
      setSent(false);
      setPanelOpen(true);
      submit(next); // record the bare rating right away
    },
    [rating, submit, surface, refId]
  );

  const sendMessage = useCallback(() => {
    if (!rating) return;
    submit(rating, { comment: comment || undefined, reasons });
    setSent(true);
    setPanelOpen(false);
  }, [rating, comment, reasons, submit]);

  const toggleReason = (r: string) =>
    setReasons((cur) =>
      cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]
    );

  const quickReasons = rating === "DOWN" ? DOWN_REASONS : UP_REASONS;

  return (
    <div className={className}>
      <div className="flex items-center gap-1.5">
        <FeedbackThumb
          active={rating === "UP"}
          dimmed={rating === "DOWN"}
          onClick={() => onThumb("UP")}
          ariaLabel="Good response"
          Icon={ThumbsUp}
        />
        <FeedbackThumb
          active={rating === "DOWN"}
          dimmed={rating === "UP"}
          onClick={() => onThumb("DOWN")}
          ariaLabel="Bad response"
          Icon={ThumbsDown}
        />
        {sent && !panelOpen && (
          <span
            className="mono inline-flex items-center gap-1"
            style={{ fontSize: 10.5, color: "var(--ink-4)" }}
          >
            <Check size={11} style={{ color: "var(--emerald)" }} /> Thanks
          </span>
        )}
      </div>

      {panelOpen && (
        <>
          {/* Full-width flex break — when ResultFeedback renders inline in a
            `display:contents` wrapper inside the chat action row's flex-wrap,
            this drops the detail panel onto its own line below the 👍/👎 thumbs
            instead of squeezing beside them. A no-op 0-height block on every
            other surface (roast / research). */}
          <div aria-hidden style={{ flexBasis: "100%", height: 0 }} />
          <div
            className="pf-card flat mt-2"
            style={{
              padding: "10px 12px",
              borderRadius: 11,
              borderWidth: "1.5px",
              maxWidth: 420,
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "1px",
                color: "var(--ink-3)",
                marginBottom: 8,
              }}
            >
              {rating === "DOWN"
                ? "WHAT WENT WRONG? (OPTIONAL)"
                : "WHAT WAS GOOD? (OPTIONAL)"}
            </div>

            <div className="flex flex-wrap gap-1.5 mb-2.5">
              {quickReasons.map((r) => {
                const on = reasons.includes(r);
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => toggleReason(r)}
                    className="mono"
                    style={{
                      fontSize: 11,
                      padding: "3px 9px",
                      borderRadius: 999,
                      border: `1.5px solid ${on ? "var(--emerald)" : "var(--rule-soft)"}`,
                      background: on ? "var(--emerald-bg)" : "var(--paper)",
                      color: on ? "var(--emerald-text)" : "var(--ink-2)",
                      cursor: "pointer",
                    }}
                  >
                    {r}
                  </button>
                );
              })}
            </div>

            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value.slice(0, 1000))}
              placeholder={
                rating === "DOWN"
                  ? "Tell us more so StockSage can improve…"
                  : "Anything else? (optional)"
              }
              rows={2}
              className="w-full resize-none"
              style={{
                fontSize: 13,
                lineHeight: 1.45,
                padding: "8px 10px",
                borderRadius: 9,
                border: "1.5px solid var(--rule-soft)",
                background: "var(--paper)",
                color: "var(--ink)",
                outline: "none",
              }}
            />

            <div className="flex items-center gap-2 mt-2">
              <button
                type="button"
                onClick={sendMessage}
                disabled={pending}
                className="pf-bf sm"
                style={{
                  padding: "5px 12px",
                  fontSize: 12,
                  background: "var(--ink)",
                  color: "var(--paper)",
                  opacity: pending ? 0.6 : 1,
                }}
              >
                <Send size={11} /> Send
              </button>
              <button
                type="button"
                onClick={() => setPanelOpen(false)}
                className="pf-bf sm"
                style={{ padding: "5px 10px", fontSize: 12 }}
              >
                <X size={11} /> Dismiss
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FeedbackThumb({
  active,
  dimmed,
  onClick,
  ariaLabel,
  Icon,
}: {
  active: boolean;
  dimmed: boolean;
  onClick: () => void;
  ariaLabel: string;
  Icon: typeof ThumbsUp;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={onClick}
      className="pf-bf sm"
      style={{
        padding: "5px 7px",
        background: active ? "var(--emerald)" : undefined,
        color: active ? "var(--paper)" : dimmed ? "var(--ink-4)" : undefined,
        borderColor: active ? "var(--emerald)" : undefined,
      }}
    >
      <Icon size={12} />
    </button>
  );
}
