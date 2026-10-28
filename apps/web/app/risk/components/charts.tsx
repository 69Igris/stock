"use client";

/**
 * Risk v2 (MONEY-485) — illustrative SVG chart shapes.
 *
 * IMPORTANT: these are ILLUSTRATIVE shapes, not the user's real metrics.
 * The backend (MONEY-487) does not yet compute Monte-Carlo paths,
 * drawdown-event decomposition, or option payoff curves. Every chart
 * here is paired with an "illustrative" caption by its parent so a
 * novice never mistakes the curve for their own data.
 */

/* ── Monte-Carlo fan (illustrative) ──────────────────────────────── */

export function MonteCarloFan() {
  const W = 600;
  const H = 220;
  const ends = { p5: -38, p25: -14, p50: 6, p75: 24, p95: 48 };
  const build = (end: number) => {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      pts.push([t * W, H / 2 - (end / 60) * (H / 2) * Math.pow(t, 0.85)]);
    }
    return pts;
  };
  const series = {
    p5: build(ends.p5),
    p25: build(ends.p25),
    p50: build(ends.p50),
    p75: build(ends.p75),
    p95: build(ends.p95),
  };
  const toPath = (pts: Array<[number, number]>) =>
    pts.map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`)).join(" ");
  const area = (a: Array<[number, number]>, b: Array<[number, number]>) => {
    const fwd = a.map(([x, y]) => `${x},${y}`).join(" L");
    const back = b
      .slice()
      .reverse()
      .map(([x, y]) => `${x},${y}`)
      .join(" L");
    return `M${fwd} L${back} Z`;
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 200 }}>
      <line
        x1="0"
        y1={H / 2}
        x2={W}
        y2={H / 2}
        stroke="var(--rule-soft)"
        strokeDasharray="4 4"
      />
      <path
        d={area(series.p5, series.p95)}
        fill="var(--pop-1)"
        opacity={0.12}
      />
      <path
        d={area(series.p25, series.p75)}
        fill="var(--emerald)"
        opacity={0.16}
      />
      <path
        d={toPath(series.p50)}
        stroke="var(--emerald)"
        strokeWidth={2}
        fill="none"
      />
      <path
        d={toPath(series.p25)}
        stroke="var(--emerald)"
        strokeWidth={1}
        strokeDasharray="3 3"
        fill="none"
        opacity={0.5}
      />
      <path
        d={toPath(series.p75)}
        stroke="var(--emerald)"
        strokeWidth={1}
        strokeDasharray="3 3"
        fill="none"
        opacity={0.5}
      />
      <path
        d={toPath(series.p5)}
        stroke="var(--pop-1)"
        strokeWidth={1}
        fill="none"
        opacity={0.7}
      />
      <path
        d={toPath(series.p95)}
        stroke="var(--emerald)"
        strokeWidth={1}
        fill="none"
        opacity={0.7}
      />
      <g
        fontFamily="JetBrains Mono, monospace"
        fontSize="10"
        fill="var(--ink-3)"
      >
        <text x="6" y="14">
          +50%
        </text>
        <text x="6" y={H / 2 - 2}>
          0
        </text>
        <text x="6" y={H - 4}>
          −50%
        </text>
        <text x={W - 36} y={H - 4}>
          1Y →
        </text>
      </g>
    </svg>
  );
}

/* ── Drawdown waterfall (illustrative) ───────────────────────────── */

export function DrawdownWaterfall() {
  const items = [
    { event: "IT correction", value: -7.2 },
    { event: "Bank selloff", value: -5.4 },
    { event: "FII outflow", value: -3.1 },
    { event: "Recovery", value: 2.8 },
    { event: "Energy drag", value: -2.4 },
  ];
  const W = 760;
  const H = 180;
  const max = 8;
  const step = (W - 40) / items.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 170 }}>
      <line x1="0" y1={H - 40} x2={W} y2={H - 40} stroke="var(--rule-soft)" />
      {items.map((it, i) => {
        const x = 20 + i * step;
        const h = (Math.abs(it.value) / max) * (H - 70);
        const isPos = it.value > 0;
        const y = isPos ? H - 40 - h : H - 40;
        const color = isPos ? "var(--emerald)" : "var(--pop-1)";
        return (
          <g key={it.event}>
            <rect
              x={x}
              y={y}
              width={step - 12}
              height={h}
              fill={color}
              opacity={0.55}
              stroke={color}
            />
            <text
              x={x + (step - 12) / 2}
              y={H - 22}
              textAnchor="middle"
              fontFamily="JetBrains Mono, monospace"
              fontSize="9.5"
              fill="var(--ink-3)"
            >
              {it.event}
            </text>
            <text
              x={x + (step - 12) / 2}
              y={isPos ? y - 4 : y + h + 12}
              textAnchor="middle"
              fontFamily="JetBrains Mono, monospace"
              fontSize="11"
              fontWeight="700"
              fill={color}
            >
              {it.value > 0 ? "+" : "−"}
              {Math.abs(it.value).toFixed(1)}%
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ── Option payoff diagram (illustrative) ────────────────────────── */

export function PayoffDiagram() {
  const W = 400;
  const H = 200;
  const spots: number[] = [];
  for (let s = 18800; s <= 20800; s += 80) spots.push(s);
  const pnl = spots.map((s) => {
    const a = Math.max(s - 19500, 0) * 50;
    const b = -Math.max(20000 - s, 0) * 25;
    const c = Math.max(s / 100 - 24, 0) * 250;
    return a + b + c - 8500;
  });
  const minP = Math.min(...pnl);
  const maxP = Math.max(...pnl);
  const denom = Math.max(Math.abs(minP), maxP, 1);
  const xs = spots.map((_, i) => (i / (spots.length - 1)) * W);
  const ys = pnl.map((p) => H / 2 - (p / denom) * (H / 2 - 10));
  const d = xs
    .map((x, i) => (i === 0 ? `M${x},${ys[i]}` : `L${x},${ys[i]}`))
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 190 }}>
      <line
        x1="0"
        y1={H / 2}
        x2={W}
        y2={H / 2}
        stroke="var(--rule-soft)"
        strokeDasharray="3 3"
      />
      <path
        d={`${d} L${W},${H / 2} L0,${H / 2} Z`}
        fill="var(--emerald)"
        opacity={0.1}
      />
      <path d={d} stroke="var(--emerald)" strokeWidth={2} fill="none" />
      <line
        x1={W * 0.32}
        y1="0"
        x2={W * 0.32}
        y2={H}
        stroke="var(--ink-3)"
        strokeDasharray="2 2"
        opacity={0.6}
      />
      <g
        fontFamily="JetBrains Mono, monospace"
        fontSize="10"
        fill="var(--ink-3)"
      >
        <text x={W * 0.32 + 4} y="14" fill="var(--emerald)">
          spot
        </text>
        <text x="4" y="14">
          profit
        </text>
        <text x="4" y={H - 4}>
          loss
        </text>
      </g>
    </svg>
  );
}
