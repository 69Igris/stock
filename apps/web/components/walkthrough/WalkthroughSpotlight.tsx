"use client";

import { useEffect, useState } from "react";

const PADDING = 8;
const CORNER_RADIUS = 14;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function readRect(selector: string): Rect | null {
  if (typeof document === "undefined") return null;
  const candidates = document.querySelectorAll(selector);
  for (const el of Array.from(candidates)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    return {
      x: Math.max(0, r.left - PADDING),
      y: Math.max(0, r.top - PADDING),
      width: r.width + PADDING * 2,
      height: r.height + PADDING * 2,
    };
  }
  return null;
}

/**
 * WalkthroughSpotlight — playful re-skin (MONEY-484).
 *
 * Renders a full-viewport SVG scrim (rgba(0,0,0,0.62)) with a rounded
 * cutout over the target element plus a dashed emerald glow ring around
 * it. Design source: WalkthroughOverlayScreen in screens-qa-essentials.jsx.
 *
 * API is unchanged: accepts a `target` CSS selector, auto-follows the
 * element on rAF + resize/scroll.
 */
export default function WalkthroughSpotlight({ target }: { target: string }) {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    let frame = 0;
    function update() {
      setRect(readRect(target));
      frame = requestAnimationFrame(update);
    }
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [target]);

  useEffect(() => {
    function onResize() {
      setRect(readRect(target));
    }
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [target]);

  if (!rect) return null;

  // Ring is slightly larger than the cutout to create a visible gap.
  const ring = {
    x: rect.x - 4,
    y: rect.y - 4,
    width: rect.width + 8,
    height: rect.height + 8,
    rx: CORNER_RADIUS + 2,
  };

  return (
    <div
      aria-hidden
      className="print:hidden"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        pointerEvents: "auto",
        animation: "wt-scrim-in 200ms ease both",
      }}
    >
      <svg
        width="100%"
        height="100%"
        style={{ position: "absolute", inset: 0 }}
        preserveAspectRatio="none"
      >
        <defs>
          <mask id="wt-cutout">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            <rect
              x={rect.x}
              y={rect.y}
              width={rect.width}
              height={rect.height}
              rx={CORNER_RADIUS}
              ry={CORNER_RADIUS}
              fill="black"
            />
          </mask>
        </defs>

        {/* Dark scrim with cutout */}
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="rgba(0,0,0,0.62)"
          mask="url(#wt-cutout)"
        />

        {/* Dashed emerald glow ring around target */}
        <rect
          x={ring.x}
          y={ring.y}
          width={ring.width}
          height={ring.height}
          rx={ring.rx}
          ry={ring.rx}
          fill="none"
          stroke="var(--emerald)"
          strokeWidth="2.5"
          strokeDasharray="6 4"
          style={{ animation: "wt-ring-rotate 12s linear infinite" }}
        />

        {/* Subtle inner glow fill on the exposed area */}
        <rect
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          rx={CORNER_RADIUS}
          ry={CORNER_RADIUS}
          fill="rgba(52,211,153,0.04)"
        />
      </svg>

      {/* Keyframes */}
      <style>{`
        @keyframes wt-scrim-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes wt-ring-rotate {
          from { stroke-dashoffset: 0; }
          to   { stroke-dashoffset: -40; }
        }
      `}</style>
    </div>
  );
}
