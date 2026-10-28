"use client";

/**
 * Framer-motion-based skeleton loaders for the Markets page (MONEY-242).
 *
 * Replaces the previous "warming up" / "Loading heatmap..." text with
 * proper shimmering placeholders that mirror the final layout. Better
 * perceived performance + an immediate signal that the data is on its way.
 *
 * Why framer-motion: we already depend on it (12.34.3) so no new bundle
 * cost. The animation respects `prefers-reduced-motion` automatically when
 * the user enables it via OS settings (motion's MotionConfig handles that
 * higher up in the layout).
 */

import { motion } from "framer-motion";

/** Shimmer keyframes used everywhere - single source of truth so the bar
 *  width and gradient stay consistent. */
const SHIMMER = {
  initial: { backgroundPositionX: "-200%" },
  animate: { backgroundPositionX: "200%" },
};

const SHIMMER_TRANSITION = {
  duration: 1.6,
  ease: "linear" as const,
  repeat: Infinity,
};

/** Background CSS shared across every skeleton block. The 200% horizontal
 *  position trick lets us animate `backgroundPositionX` instead of a `<div>`
 *  that grows or moves - keeps the cost on the GPU. */
const SHIMMER_BG: React.CSSProperties = {
  background:
    "linear-gradient(90deg, rgba(255,255,255,.03) 0%, rgba(255,255,255,.08) 50%, rgba(255,255,255,.03) 100%)",
  backgroundSize: "200% 100%",
};

/** Single shimmer bar - used inside other skeletons. */
function Bar({
  width = "100%",
  height = 12,
  className,
  style,
  delay = 0,
}: {
  width?: string | number;
  height?: number;
  className?: string;
  style?: React.CSSProperties;
  delay?: number;
}) {
  return (
    <motion.div
      initial={SHIMMER.initial}
      animate={SHIMMER.animate}
      transition={{ ...SHIMMER_TRANSITION, delay }}
      className={`rounded-md ${className ?? ""}`}
      style={{ width, height, ...SHIMMER_BG, ...style }}
    />
  );
}

/** 6-up index-card grid skeleton - exact shape of the live IndexCard. */
export function IndexCardsSkeleton() {
  return (
    <div className="mb-5 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2.5">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="p-3.5 bg-[var(--gradient-card)] border border-[var(--border-default)] rounded-[10px]"
        >
          <Bar width={56} height={9} delay={i * 0.06} />
          <div className="h-1.5" />
          <Bar width="60%" height={16} delay={i * 0.06 + 0.05} />
          <div className="h-1.5" />
          <Bar width="40%" height={10} delay={i * 0.06 + 0.1} />
          <div className="h-2" />
          <Bar width="100%" height={20} delay={i * 0.06 + 0.15} />
        </div>
      ))}
    </div>
  );
}

/** Heatmap skeleton - fakes a sector-grouped grid with 12 mock rectangles
 *  laid out asymmetrically (similar visual weight to the real squarified
 *  output). Each block fades in with a small stagger so the eye reads it
 *  as "loading the heatmap" not "broken square". */
export function HeatmapSkeleton({ height = 540 }: { height?: number }) {
  // Mock rectangle grid - 4 large + 5 medium + 6 small. Sums to a 16:9-ish
  // canvas. These are intentionally not random so SSR + CSR DOM matches.
  const blocks: Array<{ left: string; top: string; w: string; h: string }> = [
    { left: "0%", top: "0%", w: "32%", h: "55%" },
    { left: "32%", top: "0%", w: "26%", h: "40%" },
    { left: "58%", top: "0%", w: "22%", h: "40%" },
    { left: "80%", top: "0%", w: "20%", h: "40%" },
    { left: "32%", top: "40%", w: "20%", h: "30%" },
    { left: "52%", top: "40%", w: "16%", h: "30%" },
    { left: "68%", top: "40%", w: "14%", h: "30%" },
    { left: "82%", top: "40%", w: "18%", h: "30%" },
    { left: "0%", top: "55%", w: "20%", h: "45%" },
    { left: "20%", top: "55%", w: "18%", h: "45%" },
    { left: "38%", top: "70%", w: "30%", h: "30%" },
    { left: "68%", top: "70%", w: "32%", h: "30%" },
  ];

  return (
    <div
      className="relative overflow-hidden rounded-xl border border-[var(--border-default)]"
      style={{ height, background: "#080d1a" }}
      aria-busy="true"
      aria-label="Loading sector heatmap"
    >
      {blocks.map((b, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.35, delay: i * 0.04 }}
          className="absolute"
          style={{
            left: b.left,
            top: b.top,
            width: `calc(${b.w} - 2px)`,
            height: `calc(${b.h} - 2px)`,
            margin: 1,
          }}
        >
          <motion.div
            initial={SHIMMER.initial}
            animate={SHIMMER.animate}
            transition={{ ...SHIMMER_TRANSITION, delay: i * 0.08 }}
            className="w-full h-full rounded-[3px]"
            style={{
              background:
                "linear-gradient(90deg, rgba(52,211,153,.04) 0%, rgba(52,211,153,.12) 50%, rgba(52,211,153,.04) 100%)",
              backgroundSize: "200% 100%",
              border: "1px solid rgba(52,211,153,.08)",
            }}
          />
        </motion.div>
      ))}

      {/* Centered status text - sits above the shimmer blocks. */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-background/90 border border-emerald-400/20"
        >
          <motion.span
            className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400"
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
            style={{ boxShadow: "0 0 6px #34d399" }}
          />
          <span className="font-mono text-[11px] tracking-[1px] uppercase font-bold text-emerald-400">
            Building heatmap
          </span>
        </motion.div>
      </div>
    </div>
  );
}

/** Movers / sector-heatmap column skeleton - 8 rows of ticker + price. */
export function MoversColumnSkeleton({ title }: { title: string }) {
  return (
    <div className="bg-[var(--gradient-card)] border border-[var(--border-default)] rounded-xl p-4">
      <div className="font-mono text-[11px] tracking-[1.2px] font-bold uppercase mb-3 text-[var(--text-muted)]">
        {title}
      </div>
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center py-2 gap-2"
          style={{
            borderBottom: i < 7 ? "1px solid var(--border-default)" : "none",
          }}
        >
          <Bar width={70} height={10} delay={i * 0.04} />
          <div className="flex-1" />
          <Bar width={56} height={10} delay={i * 0.04 + 0.05} />
          <Bar width={48} height={10} delay={i * 0.04 + 0.1} />
        </div>
      ))}
    </div>
  );
}

/** Re-exported shimmer building block for other surfaces (e.g. screener
 *  cards) to maintain a single consistent loader vocabulary. */
export { Bar as ShimmerBar };
