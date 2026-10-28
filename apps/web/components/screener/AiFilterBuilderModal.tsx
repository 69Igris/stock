"use client";

/**
 * AiFilterBuilderModal - opens from the screener's "Build with AI"
 * header button (MONEY-202).
 *
 * The user types an investment thesis ("high ROE compounders with low
 * debt") and Gemini Flash returns a structured filter object that the
 * parent merges into the active mode's state. Supports per-mode example
 * chips so users have an on-ramp.
 */

import { useState } from "react";
import { Sparkles, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { generateFiltersFromThesisAction } from "@/lib/actions/ai-filter-builder";
import type { ScreenerModeId } from "@/lib/actions/saved-screens";

const EXAMPLES: Record<ScreenerModeId, readonly string[]> = {
  stocks: [
    "Large-cap quality compounders with ROE > 18% and PE under 25",
    "Small-cap turnarounds with low debt and 30%+ revenue growth",
    "Banking sector stocks with PE between 8 and 15",
  ],
  mf: [
    "Direct large-cap equity funds with 3Y returns > 15% and AUM above ₹5,000 Cr",
    "ELSS funds with low risk and consistent 5Y returns",
    "Flexi-cap funds with expense ratio under 0.6%",
  ],
  etf: [
    "Equity ETFs tracking Nifty IT or Banking with AUM > ₹1,000 Cr",
    "Gold ETFs on NSE with 1Y returns above 12%",
    "Low expense Nifty 50 trackers",
  ],
};

interface AiFilterBuilderModalProps {
  mode: ScreenerModeId;
  onClose: () => void;
  /** Caller merges the returned partial filters into mode state. */
  onApply: (filters: Record<string, unknown>) => void;
}

export function AiFilterBuilderModal({
  mode,
  onClose,
  onApply,
}: AiFilterBuilderModalProps) {
  const [thesis, setThesis] = useState("");
  const [busy, setBusy] = useState(false);

  const handleGenerate = async () => {
    const trimmed = thesis.trim();
    if (trimmed.length < 8) {
      toast.error("Give 1–2 sentences describing what you want");
      return;
    }
    setBusy(true);
    const res = await generateFiltersFromThesisAction({
      mode,
      thesis: trimmed,
    });
    setBusy(false);

    if (!res.success) {
      toast.error(res.error ?? "AI filter builder failed");
      return;
    }
    onApply(res.data.filters as Record<string, unknown>);
    const dropped = res.data.droppedKeys?.length ?? 0;
    toast.success(
      dropped > 0
        ? `Applied ${Object.keys(res.data.filters).length} filters (${dropped} unsupported keys ignored)`
        : `Applied ${Object.keys(res.data.filters).length} filters`
    );
    onClose();
  };

  const modeLabel =
    mode === "stocks" ? "STOCKS" : mode === "mf" ? "MUTUAL FUNDS" : "ETFS";

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[92vw]"
        style={{
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          borderRadius: 14,
          boxShadow: "var(--shadow-soft)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{
            borderBottom: "2px solid var(--ink)",
            background: "var(--paper-2)",
          }}
        >
          <div className="flex items-center gap-2.5">
            <div
              className="grid place-items-center"
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "var(--ink)",
                color: "var(--emerald)",
                transform: "rotate(-3deg)",
              }}
            >
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <div className="text-[16px] font-bold text-[var(--ink)] tracking-[-0.3px]">
                Build with AI
              </div>
              <div className="mono text-[10px] text-[var(--ink-3)] uppercase tracking-[1.2px] mt-0.5">
                {modeLabel}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid place-items-center cursor-pointer"
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "1.5px solid var(--ink)",
              background: "var(--paper)",
              color: "var(--ink)",
            }}
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="p-5">
          <label className="block mono text-[10px] tracking-[1.2px] uppercase text-[var(--ink-3)] mb-1.5">
            Your investment thesis
          </label>
          <textarea
            value={thesis}
            onChange={(e) => setThesis(e.target.value)}
            placeholder="Describe what you want to find - Gemini will translate it into screener filters."
            maxLength={500}
            rows={3}
            autoFocus
            className="pf-input"
            style={{ resize: "none", fontSize: 13 }}
          />
          <div className="mono text-[10px] text-[var(--ink-3)] mt-1.5">
            {thesis.trim().length} / 500
          </div>

          <div className="mt-3">
            <div className="mono text-[10px] tracking-[1.2px] uppercase text-[var(--ink-3)] mb-2">
              Try one of these
            </div>
            <div className="flex flex-col gap-1.5">
              {EXAMPLES[mode].map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setThesis(ex)}
                  className="text-left text-[12px] text-[var(--ink-2)] px-2.5 py-1.5 rounded-[8px] transition-colors hover:text-[var(--emerald-text)] cursor-pointer"
                  style={{ border: "1.5px solid var(--rule-soft)" }}
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>

          {/* Terminal-echo hint - mirrors the playful .pf-codeblock idiom
              used by the strategy DSL preview. Presentational only. */}
          <div className="pf-codeblock mt-3" style={{ fontSize: 10.5 }}>
            <span className="em">⚡ 1 credit</span>{" "}
            <span className="dim">
              · refunded automatically if generation fails or no valid filters
              are produced.
            </span>
          </div>
        </div>
        <div
          className="flex items-center justify-end gap-2 px-5 py-4"
          style={{
            borderTop: "1.5px dashed var(--rule-soft)",
            background: "var(--paper-2)",
          }}
        >
          <button type="button" onClick={onClose} className="pf-bf sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={busy || thesis.trim().length < 8}
            className="pf-bs sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Sparkles className="h-3 w-3" />
                Generate
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
