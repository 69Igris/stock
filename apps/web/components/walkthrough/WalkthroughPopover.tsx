"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import type { TourStep, WalkthroughPlacement } from "./types";

const POPOVER_WIDTH = 340;
const POPOVER_GAP = 16;

interface Position {
  top: number;
  left: number;
  placement: WalkthroughPlacement;
}

function computePosition(
  selector: string,
  preferred: WalkthroughPlacement
): Position | null {
  if (typeof document === "undefined") return null;
  const candidates = document.querySelectorAll(selector);
  let found: DOMRect | null = null;
  for (const el of Array.from(candidates)) {
    const candidateRect = el.getBoundingClientRect();
    if (candidateRect.width > 0 && candidateRect.height > 0) {
      found = candidateRect;
      break;
    }
  }
  if (!found) return null;
  const rect: DOMRect = found;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const estHeight = 280;
  const isMobile = vw < 1024;

  function overlaps(a: Position, b: DOMRect): boolean {
    return !(
      a.left + POPOVER_WIDTH < b.left ||
      b.right < a.left ||
      a.top + estHeight < b.top ||
      b.bottom < a.top
    );
  }

  function tryPlace(p: WalkthroughPlacement): Position | null {
    let top = 0;
    let left = 0;
    if (p === "top") {
      top = rect.top - estHeight - POPOVER_GAP;
      left = rect.left + rect.width / 2 - POPOVER_WIDTH / 2;
    } else if (p === "bottom") {
      top = rect.bottom + POPOVER_GAP;
      left = rect.left + rect.width / 2 - POPOVER_WIDTH / 2;
    } else if (p === "left") {
      top = rect.top + rect.height / 2 - estHeight / 2;
      left = rect.left - POPOVER_WIDTH - POPOVER_GAP;
    } else {
      top = rect.top + rect.height / 2 - estHeight / 2;
      left = rect.right + POPOVER_GAP;
    }
    if (
      top < 8 ||
      left < 8 ||
      top + estHeight > vh - 8 ||
      left + POPOVER_WIDTH > vw - 8
    ) {
      return null;
    }
    const pos: Position = { top, left, placement: p };
    if (overlaps(pos, rect)) return null;
    return pos;
  }

  const order: WalkthroughPlacement[] = [
    preferred,
    ...(["right", "bottom", "left", "top"] as WalkthroughPlacement[]).filter(
      (p) => p !== preferred
    ),
  ];
  for (const p of order) {
    const pos = tryPlace(p);
    if (pos) return pos;
  }

  // Mobile fallback: pin to viewport opposite side.
  if (isMobile) {
    const targetCenterY = rect.top + rect.height / 2;
    const placeBelow = targetCenterY < vh / 2;
    const top = placeBelow ? vh - estHeight - 24 : 24;
    const left = Math.max(
      8,
      Math.min(vw - POPOVER_WIDTH - 8, (vw - POPOVER_WIDTH) / 2)
    );
    return { top, left, placement: placeBelow ? "bottom" : "top" };
  }

  // Desktop fallback — center on screen.
  return {
    top: Math.max(16, vh / 2 - estHeight / 2),
    left: Math.max(16, vw / 2 - POPOVER_WIDTH / 2),
    placement: preferred,
  };
}

function focusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(selector));
}

/** Arrow pointer rendered on the side facing the target element. */
function ArrowPointer({ placement }: { placement: WalkthroughPlacement }) {
  const base: React.CSSProperties = {
    position: "absolute",
    width: 20,
    height: 20,
    background: "var(--paper)",
    border: "2px solid var(--ink)",
    zIndex: -1,
  };

  if (placement === "right") {
    // Arrow on the left edge pointing left (→ target is to the left)
    return (
      <div
        aria-hidden
        style={{
          ...base,
          left: -10,
          top: 28,
          borderRight: 0,
          borderTop: 0,
          transform: "rotate(45deg)",
        }}
      />
    );
  }
  if (placement === "left") {
    // Arrow on the right edge pointing right
    return (
      <div
        aria-hidden
        style={{
          ...base,
          right: -10,
          top: 28,
          borderLeft: 0,
          borderBottom: 0,
          transform: "rotate(45deg)",
        }}
      />
    );
  }
  if (placement === "bottom") {
    // Arrow on the top edge pointing up
    return (
      <div
        aria-hidden
        style={{
          ...base,
          top: -10,
          left: "50%",
          marginLeft: -10,
          borderBottom: 0,
          borderRight: 0,
          transform: "rotate(45deg)",
        }}
      />
    );
  }
  // top → arrow on the bottom edge pointing down
  return (
    <div
      aria-hidden
      style={{
        ...base,
        bottom: -10,
        left: "50%",
        marginLeft: -10,
        borderTop: 0,
        borderLeft: 0,
        transform: "rotate(45deg)",
      }}
    />
  );
}

export default function WalkthroughPopover({
  step,
  stepIndex,
  totalSteps,
  onNext,
  onBack,
  onSkip,
  onPauseForNow,
}: {
  step: TourStep;
  stepIndex: number;
  totalSteps: number;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  onPauseForNow: () => void;
}) {
  const [position, setPosition] = useState<Position | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let frame = 0;
    function update() {
      setPosition(computePosition(step.target, step.placement));
      frame = requestAnimationFrame(update);
    }
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [step.target, step.placement]);

  // Focus trap — keep keyboard navigation inside the popover.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const root = popoverRef.current;
    if (root) {
      const focusables = focusableElements(root);
      const target =
        focusables.find(
          (el) => el.getAttribute("data-walkthrough-primary") === "true"
        ) ?? focusables[0];
      target?.focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusables = focusableElements(popoverRef.current);
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !root?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [step.id]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onSkip();
      if (e.key === "ArrowRight") onNext();
      if (e.key === "ArrowLeft" && stepIndex > 0) onBack();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNext, onBack, onSkip, stepIndex]);

  if (!position) return null;

  const isFirst = stepIndex === 0;
  const isLast = stepIndex === totalSteps - 1;
  const headlineId = `walkthrough-headline-${step.id}`;
  const bodyId = `walkthrough-body-${step.id}`;

  // Step label from headline — strip HTML-like markers for the mono badge.
  const stepLabel = step.headline.toUpperCase().slice(0, 24);

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headlineId}
      aria-describedby={bodyId}
      className="print:hidden"
      style={{
        position: "fixed",
        zIndex: 70,
        // Snap to whole pixels so the popover never straddles a
        // half-pixel boundary (a classic source of fuzzy text).
        top: `${Math.round(position.top)}px`,
        left: `${Math.round(position.left)}px`,
        width: `${POPOVER_WIDTH}px`,
        background: "var(--paper)",
        border: "2px solid var(--ink)",
        borderRadius: 14,
        boxShadow: "5px 5px 0 var(--ink)",
        // No rotate() on this text-bearing panel — rotating the whole
        // popover renders every glyph on a tilted, non-pixel-aligned
        // raster and reads as blurry. The crisp playful look comes from
        // the solid paper fill + 2px ink border + hard shadow.
        overflow: "visible",
        pointerEvents: "auto",
        // Entrance animation (scale only, no rotation)
        animation: "wt-pop-in 180ms cubic-bezier(0.34,1.56,0.64,1) both",
      }}
    >
      {/* Arrow pointer toward the target */}
      <ArrowPointer placement={position.placement} />

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div
        style={{
          padding: "14px 16px 10px",
          borderBottom: "1.5px dashed var(--rule-soft)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          {/* Step badge */}
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: 1.5,
              color: "var(--emerald-text)",
            }}
          >
            ● STEP {String(stepIndex + 1).padStart(2, "0")} /{" "}
            {String(totalSteps).padStart(2, "0")} · {stepLabel}
          </span>

          {/* Skip tour */}
          <button
            type="button"
            onClick={onSkip}
            style={{
              background: "transparent",
              color: "var(--ink-3)",
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 11,
              textDecoration: "underline",
              border: 0,
              cursor: "pointer",
            }}
            aria-label="Skip walkthrough tour"
          >
            Skip tour
          </button>
        </div>

        {/* Progress dots */}
        <div
          style={{ display: "flex", gap: 4, marginTop: 8 }}
          role="progressbar"
          aria-valuenow={stepIndex + 1}
          aria-valuemin={1}
          aria-valuemax={totalSteps}
          aria-label={`Step ${stepIndex + 1} of ${totalSteps}`}
        >
          {Array.from({ length: totalSteps }).map((_, i) => (
            <span
              key={i}
              style={{
                width: i === stepIndex ? 22 : 14,
                height: 4,
                borderRadius: 99,
                background:
                  i <= stepIndex ? "var(--emerald)" : "var(--rule-soft)",
                transition: "width 0.15s, background 0.15s",
              }}
            />
          ))}
        </div>
      </div>

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div style={{ padding: "16px 18px 12px" }}>
        <h3
          id={headlineId}
          style={{
            fontSize: 20,
            fontWeight: 800,
            letterSpacing: -0.5,
            lineHeight: 1.15,
            color: "var(--ink)",
          }}
        >
          This is{" "}
          <span className="ser" style={{ color: "var(--ink)" }}>
            {step.headline}.
          </span>
        </h3>

        <p
          id={bodyId}
          style={{
            marginTop: 8,
            fontSize: 13.5,
            color: "var(--ink-2)",
            lineHeight: 1.5,
          }}
        >
          {step.body}
        </p>

        {/* Emerald "Try:" tip box */}
        <div
          style={{
            marginTop: 12,
            padding: "9px 11px",
            background: "var(--emerald-bg)",
            border: "1px solid var(--emerald)",
            borderRadius: 7,
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 11,
            color: "var(--emerald-text)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Sparkles size={11} aria-hidden />
          <span>
            Try:{" "}
            <strong>
              &ldquo;
              {step.body.split(".")[0]?.slice(0, 40) ?? "Explore this feature"}
              &rdquo;
            </strong>
          </span>
        </div>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <div
        style={{
          padding: "10px 16px",
          borderTop: "1.5px dashed var(--rule-soft)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: "var(--paper-2)",
          borderBottomLeftRadius: 12,
          borderBottomRightRadius: 12,
        }}
      >
        {/* Back */}
        <button
          type="button"
          onClick={onBack}
          disabled={isFirst}
          className="pf-bf sm"
          style={isFirst ? { opacity: 0.35, cursor: "not-allowed" } : undefined}
        >
          ← Back
        </button>

        <div style={{ display: "flex", gap: 6 }}>
          {/* Pause */}
          <button
            type="button"
            onClick={onPauseForNow}
            className="pf-bf sm"
            title="Pause and remind me later"
          >
            Skip step
          </button>

          {/* Next / Finish */}
          <button
            type="button"
            onClick={onNext}
            data-walkthrough-primary="true"
            className="pf-bs sm"
          >
            {isLast ? "Finish ✓" : "Next →"}
          </button>
        </div>
      </div>

      {/* Entrance keyframe (injected once by the browser) */}
      <style>{`
        @keyframes wt-pop-in {
          from { opacity: 0; transform: scale(0.92); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}
