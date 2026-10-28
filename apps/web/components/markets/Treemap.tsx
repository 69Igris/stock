"use client";

/**
 * TradingView-style sector heatmap - squarified treemap.
 *
 * Algorithm: Bruls-Huijsen-van Wijk (1999). Produces rectangles whose
 * aspect ratios are close to 1, which keeps labels readable. The
 * alternative (slice-and-dice) creates long stripes that hide the
 * proportional relationship between adjacent items - exactly the
 * "stripes problem" the early prototype hit before we switched.
 *
 * Two-level layout:
 *   1. Outer pass - sectors sized by total mcap of their constituents.
 *   2. Inner pass - within each sector rect, individual stocks sized
 *      by mcap. A small header strip at the top of each sector shows
 *      sector name + aggregate %.
 *
 * Color: red→neutral→emerald gradient, clamped to ±3% so a single
 * crashing tail stock doesn't desaturate the whole grid.
 *
 * Responsiveness: width comes from a ResizeObserver on the wrapper;
 * height is `width / aspect`, clamped so very narrow / very wide
 * viewports still produce a usable grid.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { HeatmapStock } from "@/lib/actions/discover-heatmap";

interface TreemapProps {
  stocks: HeatmapStock[];
  /** Optional sector → aggregate-percent map. When provided we render
   *  the sector's number on the header strip; when omitted, the
   *  Treemap computes its own (mcap-weighted) average. */
  sectorAggregates?: Map<string, number>;
  width: number;
  height: number;
}

interface TreemapWrapperProps {
  stocks: HeatmapStock[];
  sectorAggregates?: Map<string, number>;
  /** CSS aspect ratio (width / height). Default 1.9 mimics TradingView. */
  aspect?: number;
  minHeight?: number;
  maxHeight?: number;
}

interface PlacedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SectorBucket {
  name: string;
  totalMcap: number;
  weightedPct: number;
  stocks: HeatmapStock[];
}

interface OuterTile extends PlacedRect {
  bucket: SectorBucket;
  headerH: number;
}

interface InnerTile extends PlacedRect {
  stock: HeatmapStock;
  sectorPct: number;
}

/** Map a percent change to an RGB color string.
 *  Negative side: dark red (-3% → rgb(180,40,50))
 *  Zero:          near-black neutral (rgb(38,49,58))
 *  Positive side: emerald (+3% → rgb(16,140,90))
 *  We use a power curve so small moves stay visibly distinct from 0%
 *  while the tails still saturate cleanly. */
function pctToColor(pct: number): string {
  if (!Number.isFinite(pct)) return "rgb(38,49,58)";
  const t = Math.max(-1, Math.min(1, pct / 3));
  if (t >= 0) {
    const a = [38, 49, 58];
    const b = [16, 140, 90];
    const f = Math.pow(t, 0.7);
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(
      a[1] + (b[1] - a[1]) * f
    )},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
  }
  const a = [38, 49, 58];
  const b = [180, 40, 50];
  const f = Math.pow(-t, 0.7);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(
    a[1] + (b[1] - a[1]) * f
  )},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

/** Squarified treemap implementation. Returns one rect per item.
 *  Items must already be sorted descending by `value` for best results. */
function squarify<T extends { value: number }>(
  items: T[],
  x: number,
  y: number,
  w: number,
  h: number
): Array<PlacedRect & { item: T }> {
  const out: Array<PlacedRect & { item: T }> = [];
  if (!items.length || w <= 0 || h <= 0) return out;

  const total = items.reduce((s, i) => s + i.value, 0);
  if (total <= 0) return out;

  // Scale items so total area fills the rectangle.
  const scale = (w * h) / total;
  const queue = items
    .map((it) => ({ ...it, _v: it.value * scale }))
    .sort((a, b) => b._v - a._v);

  let X = x;
  let Y = y;
  let W = w;
  let H = h;

  function worst(row: Array<{ _v: number }>, side: number): number {
    let s = 0;
    let max = -Infinity;
    let min = Infinity;
    for (const r of row) {
      s += r._v;
      if (r._v > max) max = r._v;
      if (r._v < min) min = r._v;
    }
    if (s === 0 || side === 0) return Infinity;
    const s2 = s * s;
    const side2 = side * side;
    return Math.max((side2 * max) / s2, s2 / (side2 * min));
  }

  function layoutRow(row: Array<T & { _v: number }>) {
    const sum = row.reduce((s, r) => s + r._v, 0);
    if (W <= H) {
      const rh = sum / W;
      let cx = X;
      for (const it of row) {
        const rw = it._v / rh;
        out.push({ x: cx, y: Y, w: rw, h: rh, item: it });
        cx += rw;
      }
      Y += rh;
      H -= rh;
    } else {
      const rw = sum / H;
      let cy = Y;
      for (const it of row) {
        const rh = it._v / rw;
        out.push({ x: X, y: cy, w: rw, h: rh, item: it });
        cy += rh;
      }
      X += rw;
      W -= rw;
    }
  }

  let row: Array<T & { _v: number }> = [];
  while (queue.length) {
    const next = queue[0];
    if (!next) break;
    const side = Math.min(W, H);
    if (row.length === 0) {
      row.push(next);
      queue.shift();
      continue;
    }
    const wWith = worst([...row, next], side);
    const wWithout = worst(row, side);
    if (wWith <= wWithout) {
      row.push(next);
      queue.shift();
    } else {
      layoutRow(row);
      row = [];
    }
  }
  if (row.length) layoutRow(row);
  return out;
}

/** Group stocks by sector and compute aggregate stats per sector. */
function groupBySector(
  stocks: HeatmapStock[],
  sectorAggregates?: Map<string, number>
): SectorBucket[] {
  const map = new Map<string, SectorBucket>();
  for (const s of stocks) {
    if (!s.sector || !Number.isFinite(s.mcap) || s.mcap <= 0) continue;
    let bucket = map.get(s.sector);
    if (!bucket) {
      bucket = { name: s.sector, totalMcap: 0, weightedPct: 0, stocks: [] };
      map.set(s.sector, bucket);
    }
    bucket.stocks.push(s);
    bucket.totalMcap += s.mcap;
  }
  // Compute weighted percent if not provided.
  for (const bucket of Array.from(map.values())) {
    const provided = sectorAggregates?.get(bucket.name);
    if (provided !== undefined && Number.isFinite(provided)) {
      bucket.weightedPct = provided;
      continue;
    }
    let weightedSum = 0;
    let weightSum = 0;
    for (const s of bucket.stocks) {
      weightedSum += s.changePct * s.mcap;
      weightSum += s.mcap;
    }
    bucket.weightedPct = weightSum > 0 ? weightedSum / weightSum : 0;
  }
  // Sort sectors by total mcap descending so largest blocks land top-left.
  return Array.from(map.values()).sort((a, b) => b.totalMcap - a.totalMcap);
}

function formatMcap(mcap: number): string {
  // Indian convention - express in lakh crore (= 1e7 * 1e5 = 1e12).
  if (mcap >= 1e12) return `₹${(mcap / 1e12).toFixed(2)} L Cr`;
  if (mcap >= 1e7) return `₹${(mcap / 1e7).toFixed(2)} Cr`;
  return `₹${mcap.toLocaleString("en-IN")}`;
}

function Treemap({ stocks, sectorAggregates, width, height }: TreemapProps) {
  const layout = useMemo(() => {
    const buckets = groupBySector(stocks, sectorAggregates);
    if (!buckets.length) {
      return { sectors: [] as OuterTile[], cells: [] as InnerTile[] };
    }
    // Outer squarify by total mcap.
    const outer = squarify(
      buckets.map((b) => ({ value: b.totalMcap, bucket: b })),
      0,
      0,
      width,
      height
    );
    const sectors: OuterTile[] = [];
    const cells: InnerTile[] = [];
    for (const o of outer) {
      const headerH = Math.min(20, Math.max(12, o.h * 0.05));
      const pad = 2;
      const innerY = o.y + headerH;
      const innerH = Math.max(0, o.h - headerH - pad);
      const innerX = o.x + pad;
      const innerW = Math.max(0, o.w - pad * 2);
      sectors.push({
        x: o.x,
        y: o.y,
        w: o.w,
        h: o.h,
        headerH,
        bucket: o.item.bucket,
      });
      const inner = squarify(
        o.item.bucket.stocks.map((st) => ({ value: st.mcap, stock: st })),
        innerX,
        innerY,
        innerW,
        innerH
      );
      for (const c of inner) {
        cells.push({
          x: c.x,
          y: c.y,
          w: c.w,
          h: c.h,
          stock: c.item.stock,
          sectorPct: o.item.bucket.weightedPct,
        });
      }
    }
    return { sectors, cells };
  }, [stocks, sectorAggregates, width, height]);

  const [hover, setHover] = useState<HeatmapStock | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  if (!stocks.length) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-[var(--border-default)] bg-[#080d1a] text-[var(--text-dim)] text-sm"
        style={{ width, height }}
      >
        Heatmap data is warming up. Try again in a minute.
      </div>
    );
  }

  return (
    <div
      className="relative rounded-xl border border-[var(--border-default)] overflow-hidden"
      style={{ width, height, background: "#080d1a" }}
    >
      <svg
        width={width}
        height={height}
        style={{ display: "block" }}
        role="img"
        aria-label="Sector heatmap of NSE equities"
      >
        {/* Stock rectangles */}
        {layout.cells
          .filter((c) => c.w > 0.5 && c.h > 0.5)
          .map((c) => {
            const fill = pctToColor(c.stock.changePct);
            const isHover = hover != null && hover.symbol === c.stock.symbol;
            const showTicker = c.w > 36 && c.h > 24;
            const showPct = c.w > 56 && c.h > 42;
            const fontSize = Math.min(
              16,
              Math.max(9, Math.sqrt(c.w * c.h) / 6.5)
            );
            return (
              <g
                key={c.stock.symbol + c.stock.exchange}
                onMouseEnter={() => setHover(c.stock)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: "pointer" }}
              >
                <Link
                  href={`/stock/${encodeURIComponent(c.stock.symbol)}`}
                  prefetch={false}
                  aria-label={`Open ${c.stock.symbol} detail`}
                >
                  <rect
                    x={c.x}
                    y={c.y}
                    width={Math.max(0, c.w - 1)}
                    height={Math.max(0, c.h - 1)}
                    fill={fill}
                    stroke={isHover ? "#34d399" : "rgba(0,0,0,.4)"}
                    strokeWidth={isHover ? 2 : 1}
                  />
                  {showTicker && (
                    <text
                      x={c.x + c.w / 2}
                      y={c.y + c.h / 2 - (showPct ? 5 : 0)}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill="#f1f5f9"
                      fontFamily="'JetBrains Mono', monospace"
                      fontSize={fontSize}
                      fontWeight={700}
                      style={{
                        pointerEvents: "none",
                        textShadow: "0 1px 2px rgba(0,0,0,.6)",
                      }}
                    >
                      {c.stock.symbol}
                    </text>
                  )}
                  {showPct && (
                    <text
                      x={c.x + c.w / 2}
                      y={c.y + c.h / 2 + fontSize * 0.7}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill="#f1f5f9"
                      fontFamily="'JetBrains Mono', monospace"
                      fontSize={Math.max(8, fontSize * 0.72)}
                      fontWeight={500}
                      opacity={0.92}
                      style={{ pointerEvents: "none" }}
                    >
                      {c.stock.changePct >= 0 ? "+" : ""}
                      {c.stock.changePct.toFixed(2)}%
                    </text>
                  )}
                </Link>
              </g>
            );
          })}

        {/* Sector header strips drawn on top so they sit above the cell labels */}
        {layout.sectors.map((s, i) => {
          if (s.w < 40 || s.headerH < 10) return null;
          const pos = s.bucket.weightedPct >= 0;
          return (
            <g key={`sector-${i}`}>
              <rect
                x={s.x}
                y={s.y}
                width={s.w}
                height={s.headerH}
                fill="rgba(0,0,0,.42)"
                stroke="rgba(255,255,255,.06)"
                strokeWidth={1}
              />
              <text
                x={s.x + 8}
                y={s.y + s.headerH / 2}
                dominantBaseline="middle"
                fill="#cbd5e1"
                fontFamily="'JetBrains Mono', monospace"
                fontSize={Math.min(11, Math.max(9, s.headerH * 0.55))}
                fontWeight={700}
                letterSpacing={1.4}
                style={{
                  textTransform: "uppercase",
                  pointerEvents: "none",
                }}
              >
                {s.bucket.name}
              </text>
              <text
                x={s.x + s.w - 8}
                y={s.y + s.headerH / 2}
                textAnchor="end"
                dominantBaseline="middle"
                fill={pos ? "#4ade80" : "#f87171"}
                fontFamily="'JetBrains Mono', monospace"
                fontSize={Math.min(11, Math.max(9, s.headerH * 0.55))}
                fontWeight={700}
                style={{ pointerEvents: "none" }}
              >
                {pos ? "+" : ""}
                {s.bucket.weightedPct.toFixed(2)}%
              </text>
            </g>
          );
        })}
      </svg>

      {/* Hover tooltip */}
      {hover && (
        <div
          ref={tooltipRef}
          className="absolute top-3 left-3 rounded-lg border border-emerald-400/30 bg-background/95 px-3 py-2.5 pointer-events-none font-mono text-[11.5px] text-[var(--text-primary)] shadow-2xl z-10"
          style={{ minWidth: 200 }}
        >
          <div className="text-[13px] font-bold text-emerald-400">
            {hover.symbol}
          </div>
          <div className="text-[var(--text-dim)] font-sans text-[11.5px] mb-2 truncate max-w-[240px]">
            {hover.name}
          </div>
          <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-1 tabular-nums">
            <span className="text-[var(--text-muted)]">Price</span>
            <span>₹{hover.price.toFixed(2)}</span>
            <span className="text-[var(--text-muted)]">Change</span>
            <span
              className={
                hover.changePct >= 0
                  ? "text-emerald-400 font-bold"
                  : "text-red-400 font-bold"
              }
            >
              {hover.changePct >= 0 ? "+" : ""}
              {hover.changePct.toFixed(2)}%
            </span>
            <span className="text-[var(--text-muted)]">MCap</span>
            <span>{formatMcap(hover.mcap)}</span>
            <span className="text-[var(--text-muted)]">Sector</span>
            <span className="truncate max-w-[140px]">{hover.sector}</span>
          </div>
        </div>
      )}

      {/* Color legend used to live as an absolute pill at the bottom-right
          of the canvas, but on dense layouts (BHARTIARTL block in the
          design feedback) it overlapped real cells. Moved out of the
          Treemap into its own row below - see HeatmapColorLegend export. */}
    </div>
  );
}

/**
 * Standalone color-legend row for the squarified heatmap. Renders the
 * red→neutral→emerald gradient pill with -3% / +3% endcaps. Designed
 * to sit BETWEEN the heatmap card and the lower 3-column section so
 * it never occludes data cells.
 */
export function HeatmapColorLegend() {
  return (
    <div className="flex justify-end my-2">
      <div className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-background/90 px-2.5 py-1.5">
        <span className="font-mono text-[9.5px] tracking-[1px] font-bold text-[var(--text-muted)]">
          −3%
        </span>
        <div
          className="h-1.5 w-[110px] rounded-full"
          style={{
            background:
              "linear-gradient(90deg,rgb(180,40,50),rgb(38,49,58),rgb(16,140,90))",
          }}
        />
        <span className="font-mono text-[9.5px] tracking-[1px] font-bold text-[var(--text-muted)]">
          +3%
        </span>
      </div>
    </div>
  );
}

/**
 * Wrapper that owns the responsive sizing. The parent passes raw stock
 * data; this component measures its container and passes a fixed
 * width/height into the inner SVG Treemap (which has to know exact
 * dimensions to layout).
 */
export function ResponsiveTreemap({
  stocks,
  sectorAggregates,
  aspect = 1.9,
  minHeight = 520,
  maxHeight = 820,
}: TreemapWrapperProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number }>({
    w: 1200,
    h: 560,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = Math.max(360, Math.floor(e.contentRect.width));
        const h = Math.min(
          maxHeight,
          Math.max(minHeight, Math.round(w / aspect))
        );
        setDims({ w, h });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect, minHeight, maxHeight]);

  return (
    <div ref={containerRef} className="w-full">
      <Treemap
        stocks={stocks}
        sectorAggregates={sectorAggregates}
        width={dims.w}
        height={dims.h}
      />
    </div>
  );
}

export default ResponsiveTreemap;
