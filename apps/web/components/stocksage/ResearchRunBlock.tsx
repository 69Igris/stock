"use client";

/**
 * ResearchRunBlock (MONEY-490 / MONEY-672, P2b) — the wiring adapter that maps a
 * live research-stream into the StockSage v2 `JobProgress` design.
 *
 * It takes the real `ResearchStreamBlock` fields (status / progress /
 * currentStep / taskProgress) and produces `RunTask[]`, rendering each task's
 * real `resultSummary` via a robust, type-safe `TaskPreview`. Empty results
 * (e.g. `{ annual: [], quarterly: [] }`) resolve to `hasData = false`, so a
 * completed-but-empty step shows an explicit "no data" body instead of a blank
 * green expand — the empty-but-green bug. Renders inside a `.ssx` container.
 */

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  JobProgress,
  stageForProgress,
  type RunStage,
  type RunTask,
  type RunTaskStatus,
} from "./research-run";
import {
  KVTable,
  MetricStrip,
  NewsItemCard,
  type KVRow,
  type MetricItem,
  type NewsItem,
  type SentimentKind,
} from "./primitives";
import { isAdviceAdjacentField } from "@usemoney/utils/sanitize-recommendation";

/* ── Live data shape (subset of ResearchStreamBlock + TaskProgressItem) ── */
export interface ResearchRunTask {
  id: string;
  tool: string;
  type?: string;
  status: string;
  durationMs?: number;
  resultSummary?: unknown;
}
export interface ResearchRunData {
  status: "running" | "completed" | "failed";
  progress: number;
  currentStep?: string;
  tasks: ResearchRunTask[];
  deep?: boolean;
  depth?: string;
}

/* ── tool → phase / icon / label ──────────────────────────────────── */
export function phaseForTool(tool: string): string {
  const t = tool.toLowerCase();
  if (
    /^fetch_|_fetch|news|price|quote|filing|announcement|holding|profile/.test(
      t
    )
  )
    return "Data fetch";
  if (/synth|report|summar|score|assemble/.test(t)) return "Synthesis";
  if (/compute|dcf|valuation|montecarlo|backtest|simulate|var|regime/.test(t))
    return "Computation";
  return "Analysis";
}
export function iconForTool(tool: string): string {
  const t = tool.toLowerCase();
  if (/news|sentiment/.test(t)) return "newspaper";
  if (/price|technical|chart|candle|pattern/.test(t)) return "candle";
  if (/peer|compar/.test(t)) return "scale";
  if (/balance|income|cash|statement|ratio|earning|financ/.test(t))
    return "file";
  if (/profile|business|overview/.test(t)) return "briefcase";
  if (/dcf|valuation|score|quant/.test(t)) return "gauge";
  if (/synth|report|assemble/.test(t)) return "sparkles";
  return "database";
}
export function humanize(tool: string): string {
  return tool
    .replace(/^fetch_/, "fetch ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
export function mapStatus(s: string): RunTaskStatus {
  const t = (s || "").toLowerCase();
  if (/done|complete|success|ok/.test(t)) return "done";
  if (/run|progress|active|polling/.test(t)) return "running";
  if (/fail|error|timeout/.test(t)) return "failed";
  return "pending";
}

/* ── emptiness check (drives the "no data" body) ──────────────────── */
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
export function isNonEmpty(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number" || typeof v === "boolean") return true;
  if (Array.isArray(v)) return v.some(isNonEmpty);
  if (isObj(v)) {
    // MONEY-1274 — `{available:false, reason:"..."}` is the envelope a tool
    // returns when it could NOT produce data, and it must not read as data.
    // Without this it did: `available:false` is a boolean, the scalar branch
    // above returns true for any boolean, and `.some()` short-circuits on the
    // first value — so a tool that produced nothing rendered as a DONE task
    // claiming it had data, skipping the explicit "no data" body MONEY-778
    // added for exactly this case.
    if (v.available === false) return false;
    const vals = Object.values(v);
    if (vals.length === 0) return false;
    return vals.some(isNonEmpty);
  }
  return false;
}

/* ── robust, type-safe preview of an arbitrary resultSummary ──────── */
function fmtScalar(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number")
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}
/* ── MONEY-778: typed task previews (mirror the design's `Preview` kinds in
 * ss-streaming.jsx). Each maps the REAL (untyped) tool result defensively and
 * falls back to the shape-driven render below when extraction is empty, so an
 * unexpected shape never blanks the card. ──────────────────────────────────── */
function toSentiment(v: unknown): SentimentKind | undefined {
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (/pos|bull|up/.test(s)) return "positive";
    if (/neg|bear|down/.test(s)) return "negative";
    if (/neut|flat|mixed/.test(s)) return "neutral";
  }
  if (typeof v === "number") {
    if (v > 0.15) return "positive";
    if (v < -0.15) return "negative";
    return "neutral";
  }
  return undefined;
}
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
function extractArticles(data: unknown): NewsItem[] {
  const root: unknown = isObj(data)
    ? (data.data ?? data.articles ?? data.items ?? data.news ?? data)
    : data;
  const arr: unknown[] = Array.isArray(root)
    ? root
    : Array.isArray(data)
      ? data
      : [];
  const out: NewsItem[] = [];
  for (const a of arr) {
    if (!isObj(a)) continue;
    const title = typeof a.title === "string" ? a.title : "";
    if (!title) continue;
    const url = typeof a.url === "string" ? a.url : "";
    const source =
      typeof a.source === "string" && a.source ? a.source : domainOf(url);
    out.push({
      url,
      domain: domainOf(url) || source,
      title,
      source: source || "—",
      date:
        typeof a.date === "string"
          ? a.date
          : typeof a.publishedAt === "string"
            ? a.publishedAt
            : "",
      sentiment: toSentiment(a.sentiment ?? a.score),
    });
    if (out.length >= 4) break;
  }
  return out;
}
function extractMetricTiles(data: unknown): MetricItem[] {
  if (!isObj(data)) return [];
  // Unwrap a single-symbol wrapper { INFY: {...} } → the inner scalars.
  const vals = Object.values(data);
  const src =
    Object.keys(data).length === 1 && isObj(vals[0])
      ? (vals[0] as Record<string, unknown>)
      : data;
  return Object.entries(src)
    .filter(
      ([k, v]) =>
        !isAdviceAdjacentField(k) &&
        (typeof v === "number" || typeof v === "string")
    )
    .slice(0, 6)
    .map(([k, v]) => ({ label: k, value: fmtScalar(v) }));
}
function isNewsTool(tool: string): boolean {
  return /news|sentiment|filing|announcement/.test(tool.toLowerCase());
}
function isMetricsTool(tool: string): boolean {
  return /dcf|ddm|valuation|scenario|montecarlo|monte_carlo|quant|score|forward/.test(
    tool.toLowerCase()
  );
}

// MONEY-778: exported for unit tests (typed-preview extraction logic).
export {
  toSentiment,
  extractArticles,
  extractMetricTiles,
  isNewsTool,
  isMetricsTool,
};

function TaskPreview({
  data,
  tool,
}: {
  data: unknown;
  tool?: string;
}): ReactNode {
  // Typed previews first (design parity), each guarded so an empty extraction
  // falls through to the generic shape-driven render — no card ever blanks.
  if (tool && isNewsTool(tool)) {
    const articles = extractArticles(data);
    if (articles.length) {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {articles.map((a, i) => (
            <NewsItemCard key={i} item={a} />
          ))}
        </div>
      );
    }
  }
  if (tool && isMetricsTool(tool)) {
    const tiles = extractMetricTiles(data);
    if (tiles.length) return <MetricStrip items={tiles} />;
  }

  if (typeof data === "string") {
    return (
      <p
        style={{
          fontSize: 12.5,
          lineHeight: 1.5,
          color: "var(--ink-2)",
          margin: 0,
        }}
      >
        {data}
      </p>
    );
  }
  if (Array.isArray(data)) {
    const rows = data.slice(0, 5);
    const kv: KVRow[] = rows.map((r, i) => ({
      k: isObj(r) && r.label != null ? String(r.label) : `#${i + 1}`,
      v: isObj(r)
        ? Object.entries(r)
            // MONEY-778: never surface a bare forward value/target/return.
            .filter(([k]) => k !== "label" && !isAdviceAdjacentField(k))
            .slice(0, 1)
            .map(([, val]) => fmtScalar(val))
            .join(" ")
        : fmtScalar(r),
    }));
    return <KVTable rows={kv} />;
  }
  if (isObj(data)) {
    // financial { annual: [...], quarterly: [...] } → latest period strip
    const annual = data.annual;
    const period =
      Array.isArray(annual) && annual.length ? annual[annual.length - 1] : null;
    if (isObj(period)) {
      const items: MetricItem[] = Object.entries(period)
        // MONEY-778: drop advice-adjacent fields (see sanitize-recommendation).
        .filter(
          ([k, v]) =>
            !isAdviceAdjacentField(k) &&
            (typeof v === "number" || typeof v === "string")
        )
        .slice(0, 6)
        .map(([k, v]) => ({ label: k, value: fmtScalar(v) }));
      if (items.length) return <MetricStrip items={items} />;
    }
    // flat object of scalars → KV table. MONEY-778: a research tool-result
    // step showed `expectedValue: 933.35` next to `currentPrice` — a bare
    // forward value that reads as a price target. The prose scrubber can't see
    // structured fields, so we drop advice-adjacent keys here at render time.
    const scalarRows: KVRow[] = Object.entries(data)
      .filter(
        ([k, v]) =>
          !isAdviceAdjacentField(k) &&
          (typeof v === "number" ||
            typeof v === "string" ||
            typeof v === "boolean")
      )
      .slice(0, 10)
      .map(([k, v]) => ({ k, v: fmtScalar(v) }));
    if (scalarRows.length) return <KVTable rows={scalarRows} />;
    // nested object (e.g. { SYMBOL: {...} }) → unwrap first child
    const firstChild = Object.values(data).find(isObj);
    if (firstChild) return <TaskPreview data={firstChild} />;
  }
  return null;
}

/* ── progress → stage (for the lifecycle stepper) ─────────────────── */
/**
 * The stage a run is showing right now.
 *
 * A FAILED run collapses to "FAILED" here; WHERE it failed is derived
 * separately by the stepper from `progress` via `stageForProgress`, so a job
 * that never left the queue is not drawn as a synthesis failure (MONEY-1274).
 */
export function deriveStage(data: ResearchRunData): RunStage {
  if (data.status === "failed") return "FAILED";
  if (data.status === "completed") return "COMPLETED";
  return stageForProgress(data.progress);
}

/* ── the public block ─────────────────────────────────────────────── */
export function ResearchRunBlock({
  data,
  onRetryRun,
  onRetryTask,
}: {
  data: ResearchRunData;
  onRetryRun?: () => void;
  onRetryTask?: (key: string) => void;
}) {
  const done = data.status === "completed";
  const failed = data.status === "failed";
  const [collapsed, setCollapsed] = useState(false);
  // Auto-collapse a completed run after it finishes (re-expandable).
  useEffect(() => {
    if (done) setCollapsed(true);
  }, [done]);

  const tasks: RunTask[] = (data.tasks || []).map((t) => {
    const status = mapStatus(t.status);
    const hasData = status === "done" && isNonEmpty(t.resultSummary);
    return {
      key: t.id,
      label: humanize(t.tool),
      detail: t.durationMs != null ? `${t.tool} · ${t.durationMs}ms` : t.tool,
      icon: iconForTool(t.tool),
      phase: phaseForTool(t.tool),
      status,
      hasData,
      preview: hasData ? (
        <TaskPreview data={t.resultSummary} tool={t.tool} />
      ) : undefined,
    };
  });

  // On a failed run, surface the per-tool ok/failed breakdown from whatever
  // ran before the failure (so the user sees their fetched data is safe).
  const failedDetail = failed
    ? {
        title: "A research step didn't complete",
        detail:
          "Some of the run finished — the fetched data is safe. You can retry the run.",
        tools: tasks
          .filter((t) => t.status === "done" || t.status === "failed")
          .map((t) => ({
            label: t.label,
            ok: t.status === "done",
            key: t.key,
          })),
        onRetryRun,
        onRetryTool: onRetryTask
          ? (key?: string) => key && onRetryTask(key)
          : undefined,
      }
    : undefined;

  return (
    <div className="ssx">
      <JobProgress
        stage={deriveStage(data)}
        progress={Math.round(data.progress)}
        tasks={tasks}
        caption={data.currentStep}
        deep={data.deep}
        depth={data.depth}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
        failed={failedDetail}
        onRetryTask={onRetryTask}
      />
    </div>
  );
}
