"use client";

/**
 * Sectors canvas skeleton — MONEY-1126.
 *
 * Replaces the centred spinner that used to sit in a 460px empty box while
 * `SectorsHeatmap` loaded. A spinner in a big void says "something is
 * happening somewhere"; a skeleton says "the grid and the table are landing
 * here, in this shape".
 *
 * The sectors canvas is TWO surfaces, so this is too:
 *   1. the tile strip + the full-width heatmap canvas, and
 *   2. the RANKED drill-down table beneath it.
 * Rendering only the first would still jump the page by the height of the
 * whole table when data arrives, which is the CLS this exists to avoid. The
 * block heights below are copied from the real render (tile padding, the
 * canvas' `minHeight: 460`, the `pf-tbl` row rhythm) so the swap is close to
 * a no-op for layout.
 *
 * Theme-aware by construction: every fill is a playful CSS-var token
 * (--rule-soft / --rule-softer / --emerald-bg), which is defined per theme,
 * so the skeleton reads correctly in light AND dark. No `bg-white/[...]`,
 * `bg-black/[...]` or hex literals — the same rule
 * `__tests__/screener/results-skeleton-theme.test.ts` enforces on
 * `components/screener/ResultsSkeleton.tsx`, which this mirrors.
 *
 * Note the real heatmap canvas is a deliberately fixed dark island
 * (`background: "#16140e"` in both themes) because `heatColor`'s translucent
 * cell fills are tuned for a dark backdrop. The skeleton does NOT copy that:
 * there are no data colours to carry here, so a normal themed `pf-card`
 * surface is both correct and one less hardcoded colour.
 */

/** Matches the 6-tile strip at the top of the real component. */
const TILE_COUNT = 6;
/** Same `minHeight` the real treemap container uses. */
const HEATMAP_MIN_HEIGHT = 460;
/** ~13 canonical NSE sectors render in RANKED; 12 rows keeps the reserved
 *  height honest without overshooting on a sparse environment. */
const TABLE_ROWS = 12;

/** Deterministic (never random) flex weights for the fake treemap cells, so
 *  the server and client render the identical DOM. Roughly the m-cap spread
 *  of the real sector grid: two dominant blocks, then a long tail. */
const CELL_WEIGHTS = [34, 18, 12, 9, 7, 6, 5, 4, 3, 2] as const;

function Bar({
  width,
  height,
  fill = "var(--rule-soft)",
  radius = 4,
  style,
}: {
  width: number | string;
  height: number;
  fill?: string;
  radius?: number;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: radius,
        background: fill,
        flexShrink: 0,
        ...style,
      }}
    />
  );
}

export function SectorsSkeleton() {
  return (
    <div
      className="animate-pulse"
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
      aria-busy="true"
      aria-label="Loading sector heatmap"
    >
      {/* 1a. Tile strip — same auto-fit grid as the real one. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 10,
        }}
      >
        {Array.from({ length: TILE_COUNT }).map((_, i) => (
          <div key={i} className="pf-card flat" style={{ padding: 12 }}>
            <Bar width="70%" height={11} fill="var(--rule-softer)" />
            <div style={{ height: 6 }} />
            <Bar width="45%" height={16} fill="var(--emerald-bg)" />
            <div style={{ height: 6 }} />
            <Bar width="80%" height={9} fill="var(--rule-softer)" />
          </div>
        ))}
      </div>

      {/* 1b. Heatmap header — title, caption, timeframe switcher, legend. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <Bar width={78} height={14} />
        <Bar width={190} height={10} fill="var(--rule-softer)" />
        <div style={{ flex: 1 }} />
        <Bar width={168} height={30} radius={8} fill="var(--rule-softer)" />
        <Bar width={120} height={12} radius={3} fill="var(--rule-softer)" />
      </div>

      {/* 1c. The treemap canvas itself. */}
      <div className="pf-card" style={{ padding: 8 }}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            minHeight: HEATMAP_MIN_HEIGHT,
          }}
        >
          {CELL_WEIGHTS.map((w, i) => (
            <div
              key={i}
              style={{
                flex: `${w} 1 ${Math.max(140, w * 5)}px`,
                minWidth: 100,
                minHeight: 120,
                borderRadius: 8,
                background:
                  i % 3 === 0 ? "var(--emerald-bg)" : "var(--rule-softer)",
                border: "1px solid var(--rule-soft)",
              }}
            />
          ))}
        </div>
      </div>

      {/* 2a. RANKED section header. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <Bar width={62} height={10} fill="var(--rule-softer)" />
        <Bar width={210} height={16} />
        <div style={{ flex: 1, minWidth: 40 }}>
          <Bar width="100%" height={1.5} fill="var(--rule-soft)" radius={0} />
        </div>
        <Bar width={80} height={10} fill="var(--rule-softer)" />
      </div>

      {/* 2b. The RANKED drill-down table. Omitting this was the CLS: the
             page jumped by the table's full height the moment data landed. */}
      <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
        <div
          className="px-4 py-3"
          style={{ borderBottom: "1.5px solid var(--rule-soft)" }}
        >
          <Bar width={140} height={10} fill="var(--rule-softer)" />
        </div>
        {Array.from({ length: TABLE_ROWS }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 px-4 py-3"
            style={{
              borderBottom:
                i === TABLE_ROWS - 1 ? "0" : "1px dashed var(--rule-soft)",
            }}
          >
            <Bar width={128} height={11} />
            <div style={{ flex: 1 }} />
            <Bar width={44} height={11} fill="var(--rule-softer)" />
            <Bar width={52} height={11} fill="var(--emerald-bg)" />
            <Bar width={72} height={11} fill="var(--rule-softer)" />
            <Bar width={36} height={11} fill="var(--rule-softer)" />
            <Bar width={64} height={11} fill="var(--rule-softer)" />
            <Bar width={54} height={20} radius={6} fill="var(--rule-softer)" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default SectorsSkeleton;
