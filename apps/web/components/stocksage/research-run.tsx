"use client";

/**
 * StockSage v2 research-run job progress (MONEY-490 / MONEY-672) — ported from
 * the Claude Design handoff (.design-ref/ss-streaming.jsx: JobProgress, TaskCard,
 * FailedInline, StaleBanner, StreamingText).
 *
 * This is PURE PRESENTATION over a real-data-shaped interface — the wiring layer
 * (ResearchProgressRenderer) maps the live `taskProgress` into `RunTask[]` and
 * renders each task's real `resultSummary` into the `preview` node. Fixes the
 * reported bugs by design:
 *   - empty-but-green fetch  → a done task with no data shows an explicit
 *     "no data" body, not a blank green expand (`hasData === false`).
 *   - peer-companies failure → a failed task renders a red status + retry, and
 *     an EMPTY (but not errored) result degrades to "no data" rather than red.
 *   - accordion              → a single `openKey` in JobProgress auto-closes the
 *     previously open card when another opens.
 *
 * Render inside a `.ssx` container for the scoped design tokens.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./primitives";

/* ── Token-by-token streaming text ────────────────────────────────── */
export function StreamingText({
  text,
  streaming,
  speed = 14,
  onDone,
}: {
  text: string;
  streaming: boolean;
  speed?: number;
  onDone?: () => void;
}) {
  const [n, setN] = useState(streaming ? 0 : text.length);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (!streaming) {
      setN(text.length);
      return;
    }
    setN(0);
    let i = 0;
    const id = setInterval(() => {
      i += Math.max(1, Math.round(text.length / 90));
      if (i >= text.length) {
        i = text.length;
        clearInterval(id);
        onDoneRef.current?.();
      }
      setN(i);
    }, speed);
    return () => clearInterval(id);
  }, [text, streaming, speed]);
  const shown = text.slice(0, n);
  return (
    <span>
      {shown}
      {streaming && n < text.length && <span className="tok-cursor" />}
    </span>
  );
}

/* ── Data interface (mapped from the live research taskProgress) ───── */
export type RunStage =
  | "QUEUED"
  | "PLANNING"
  | "RESEARCHING"
  | "ANALYZING"
  | "SYNTHESIZING"
  | "COMPLETED"
  | "FAILED";

export const RUN_STAGE_ORDER: RunStage[] = [
  "QUEUED",
  "PLANNING",
  "RESEARCHING",
  "ANALYZING",
  "SYNTHESIZING",
  "COMPLETED",
];

/**
 * How far a run had got, from its progress alone.
 *
 * Lives here rather than beside `deriveStage` because this module owns the
 * stage vocabulary (`RunStage`, `RUN_STAGE_ORDER`) and `ResearchRunBlock`
 * imports from it — the other direction would be a cycle.
 *
 * MONEY-1274: the stepper used to hard-code SYNTHESIZING for EVERY failure, so
 * a job no worker ever picked up was drawn as "failed at synthesis, four of
 * five stages done". Three QA sessions sat at progress 0 from 2026-08-21 with
 * no plan and no scratchpad entries, and the UI described all three as
 * synthesis failures — which points whoever is debugging at the model instead
 * of at the queue.
 *
 * WHY those three were never picked up is NOT established, and an earlier
 * version of this comment claimed it was. It blamed a 404 at the QA push
 * endpoint, read off an unauthenticated GET of `/health`. That probe is
 * worthless: the PRODUCTION endpoint answers the same 404 while serving
 * normally. Measured 2026-09-05, `stock-research-qa-push` had an undelivered
 * backlog of ZERO, which is what a working push subscription looks like — a
 * failing one accumulates. Research completed normally on 2026-09-03.
 *
 * So the stepper defect below is real and independent; the outage narrative
 * around it was not. Recorded because a confident wrong cause in a comment
 * costs more than no cause at all.
 */
export function stageForProgress(p: number): RunStage {
  // MONEY-778: QUEUED is the stepper's first node — surface it for the very
  // early "waiting for a slot" window so the queue -> plan handoff matches
  // the design.
  if (p < 4) return "QUEUED";
  if (p < 12) return "PLANNING";
  if (p < 68) return "RESEARCHING";
  if (p < 92) return "ANALYZING";
  return "SYNTHESIZING";
}

/**
 * The run-mode badge, from the mode string a block was created with.
 *
 * MONEY-1274 (MONEY-1155 #28). `mode` is CLIENT-ONLY state: it is threaded from
 * the confirm action's `params.mode` at block creation, and `ResearchSession`
 * persists `skill` but no mode/depth column. So any block rebuilt from the DB —
 * after a reload, or navigating back — has no mode at all.
 *
 * The old code defaulted that unknown to `deep: true` + "Comprehensive", which
 * is how an ADVANCED run came to render "DEEP - Comprehensive" (the reported
 * bug) and how a FAST run would render "DEEP", contradicting itself. Returning
 * undefined lets the pill show only what is actually known.
 */
export function modeBadge(mode: string | null | undefined): {
  deep: boolean | undefined;
  depth: string | undefined;
} {
  if (!mode) return { deep: undefined, depth: undefined };
  return {
    deep: mode !== "fast",
    depth: mode.charAt(0).toUpperCase() + mode.slice(1),
  };
}

export type RunTaskStatus = "pending" | "running" | "done" | "failed";

export interface RunTask {
  key: string;
  label: string;
  detail?: string;
  icon?: string;
  /** Grouping header, e.g. "Data fetch" / "Analysis" / "Computation". */
  phase: string;
  status: RunTaskStatus;
  /** Real rendered data for the expanded body. */
  preview?: ReactNode;
  /**
   * Did this step return usable data? When `false` on a DONE task we render an
   * explicit "no data" body instead of a blank green expand (the empty-but-green
   * bug). Defaults to: has a preview.
   */
  hasData?: boolean;
}

export interface FailedTool {
  label: string;
  ok: boolean;
  key?: string;
}

/* ── Single task card (accordion-controlled by the parent) ────────── */
export function TaskCard({
  task,
  isOpen,
  onToggle,
  onRetry,
}: {
  task: RunTask;
  isOpen: boolean;
  onToggle: () => void;
  onRetry?: (key: string) => void;
}) {
  const done = task.status === "done";
  const running = task.status === "running";
  const failed = task.status === "failed";
  const hasData = task.hasData ?? task.preview != null;
  // A done task is expandable if it either has a preview or an explicit no-data
  // body to show; a failed task is expandable to show the error + retry.
  const expandable = (done || failed) && true;

  return (
    <div
      className="pop-in"
      style={{
        border:
          "1.5px solid " +
          (running
            ? "var(--emerald)"
            : failed
              ? "var(--poor)"
              : "var(--rule-soft)"),
        borderRadius: 11,
        overflow: "hidden",
        background: "var(--paper-3)",
      }}
    >
      <button
        onClick={expandable ? onToggle : undefined}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "9px 12px",
          textAlign: "left",
          cursor: expandable ? "pointer" : "default",
        }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
            background: failed
              ? "rgba(232,98,61,.14)"
              : done
                ? "var(--emerald-bg)"
                : "transparent",
            color: failed
              ? "var(--poor)"
              : done
                ? "var(--emerald)"
                : "var(--ink-3)",
            border: done || failed ? "none" : "1.5px solid var(--rule-soft)",
          }}
        >
          {failed ? (
            <Icon name="x" size={13} sw={3} />
          ) : done ? (
            <Icon name="check" size={13} sw={3} />
          ) : running ? (
            <Icon
              name="loader"
              size={13}
              style={{ animation: "ss-spin 1s linear infinite" }}
            />
          ) : (
            <Icon name={task.icon || "wrench"} size={12} />
          )}
        </span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
            {task.label}
          </span>
          {task.detail && (
            <span
              className="num"
              style={{
                display: "block",
                fontSize: 10.5,
                color: "var(--ink-4)",
              }}
            >
              {task.detail}
            </span>
          )}
        </span>
        {running && (
          <span
            className="num"
            style={{ fontSize: 10, color: "var(--emerald)" }}
          >
            running…
          </span>
        )}
        {done && !hasData && (
          <span className="num" style={{ fontSize: 10, color: "var(--ink-4)" }}>
            no data
          </span>
        )}
        {failed && (
          <span className="num" style={{ fontSize: 10, color: "var(--poor)" }}>
            failed
          </span>
        )}
        {expandable && (
          <Icon
            name="chevron"
            size={14}
            style={{
              color: "var(--ink-4)",
              transform: isOpen ? "none" : "rotate(-90deg)",
              transition: ".15s",
            }}
          />
        )}
      </button>
      {expandable && isOpen && (
        <div
          style={{ padding: "0 12px 12px", animation: "ss-fade-up .3s ease" }}
        >
          {failed ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "9px 11px",
                borderRadius: 9,
                border: "1.5px solid var(--rule-soft)",
                background: "rgba(232,98,61,.06)",
              }}
            >
              <Icon name="alert" size={14} style={{ color: "var(--poor)" }} />
              <span style={{ flex: 1, fontSize: 12, color: "var(--ink-2)" }}>
                This step didn&apos;t return — the other steps are unaffected.
              </span>
              {onRetry && (
                <button className="btn sm" onClick={() => onRetry(task.key)}>
                  <Icon name="refresh" size={12} /> Retry
                </button>
              )}
            </div>
          ) : hasData ? (
            task.preview
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "10px 12px",
                borderRadius: 10,
                border: "1.5px dashed var(--rule-soft)",
                background: "var(--rule-softer)",
                color: "var(--ink-3)",
                fontSize: 12.5,
              }}
            >
              <span
                className="num"
                style={{ fontSize: 16, color: "var(--ink-4)" }}
              >
                —
              </span>
              <span>
                No data available for this step from the current sources.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Failed-run inline panel (data-driven) ────────────────────────── */
export function FailedInline({
  title = "A data tool didn't complete",
  detail = "Some of the run finished — the fetched data is safe. You can retry the failed step, or restart the run.",
  tools = [],
  onRetryRun,
  onRetryTool,
  onBack,
}: {
  title?: string;
  detail?: string;
  tools?: FailedTool[];
  onRetryRun?: () => void;
  onRetryTool?: (key?: string) => void;
  onBack?: () => void;
}) {
  return (
    <div
      style={{
        border: "1.5px solid var(--poor)",
        borderRadius: 11,
        padding: 14,
        background: "rgba(232,98,61,.06)",
        marginBottom: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          marginBottom: 8,
        }}
      >
        <Icon name="alert" size={16} style={{ color: "var(--poor)" }} />
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>{title}</span>
      </div>
      <p
        style={{
          fontSize: 13,
          color: "var(--ink-2)",
          lineHeight: 1.55,
          marginBottom: tools.length ? 12 : 0,
        }}
      >
        {detail}
      </p>
      {tools.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 7,
            marginBottom: 12,
          }}
        >
          {tools.map((t, i) => (
            <div
              key={t.key ?? i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "8px 11px",
                borderRadius: 9,
                border: "1.5px solid var(--rule-soft)",
                background: "var(--paper-3)",
              }}
            >
              <span
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  display: "grid",
                  placeItems: "center",
                  background: t.ok
                    ? "var(--emerald-bg)"
                    : "rgba(232,98,61,.14)",
                  color: t.ok ? "var(--emerald)" : "var(--poor)",
                }}
              >
                {t.ok ? (
                  <Icon name="check" size={11} sw={3} />
                ) : (
                  <Icon name="x" size={11} sw={3} />
                )}
              </span>
              <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600 }}>
                {t.label}
              </span>
              {t.ok ? (
                <span
                  className="num"
                  style={{ fontSize: 10.5, color: "var(--ink-4)" }}
                >
                  ok
                </span>
              ) : (
                onRetryTool && (
                  <button className="btn sm" onClick={() => onRetryTool(t.key)}>
                    <Icon name="refresh" size={12} /> Retry tool
                  </button>
                )
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {onRetryRun && (
          <button className="btn sm solid" onClick={onRetryRun}>
            <Icon name="refresh" size={13} /> Retry run
          </button>
        )}
        {onBack && (
          <button className="btn sm" onClick={onBack}>
            <Icon name="chevronL" size={13} /> Back
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Stale / timeout banner ───────────────────────────────────────── */
export function StaleBanner({
  onRefresh,
  syncedAgo,
}: {
  onRefresh?: () => void;
  syncedAgo?: string;
}) {
  return (
    <div className="trust" style={{ marginTop: 0, marginBottom: 12 }}>
      <span className="chip warn">
        <Icon name="clock" size={11} /> Data may be stale
        {syncedAgo ? ` — last synced ${syncedAgo}` : ""}
      </span>
      {onRefresh && (
        <span
          className="chip link"
          onClick={onRefresh}
          style={{ cursor: "pointer" }}
        >
          <Icon name="refresh" size={11} /> Refresh
        </span>
      )}
    </div>
  );
}

/* ── Job progress block ───────────────────────────────────────────── */
export interface JobProgressProps {
  stage: RunStage;
  progress: number;
  tasks: RunTask[];
  caption?: string;
  deep?: boolean;
  depth?: string;
  toolCount?: number;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Failed-run details (rendered when stage === "FAILED"). */
  failed?: {
    title?: string;
    detail?: string;
    tools?: FailedTool[];
    onRetryRun?: () => void;
    onRetryTool?: (key?: string) => void;
    onBack?: () => void;
  };
  onRetryTask?: (key: string) => void;
}

export function JobProgress({
  stage,
  progress,
  tasks,
  caption,
  // MONEY-1274 (#28): NO defaults. `mode` is client-only state — nothing
  // persists it — so a block rebuilt from the DB after a reload knows neither.
  // Defaulting printed "DEEP · Comprehensive" over an Advanced run, and "DEEP"
  // over a fast one. Undefined stays undefined and the pill adapts.
  deep,
  depth,
  toolCount,
  collapsed = false,
  onToggleCollapse,
  failed,
  onRetryTask,
}: JobProgressProps) {
  const isFailed = stage === "FAILED";
  const done = stage === "COMPLETED";
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const tools = toolCount ?? tasks.length;

  // Accordion: a single open card key. Auto-open the latest task that has data.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const autoTouched = useRef(false);
  const latestWithData = [...tasks]
    .reverse()
    .find((t) => t.status === "done" && (t.hasData ?? t.preview != null));
  useEffect(() => {
    if (!autoTouched.current && latestWithData) {
      setOpenKey(latestWithData.key);
    }
  }, [latestWithData?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (key: string) => {
    autoTouched.current = true;
    setOpenKey((k) => (k === key ? null : key));
  };

  if (done && collapsed) {
    return (
      <button
        onClick={onToggleCollapse}
        className="card flat"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "11px 14px",
          background: "var(--paper-3)",
          textAlign: "left",
        }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            background: "var(--emerald-bg)",
            color: "var(--emerald)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <Icon name="check" size={13} sw={3} />
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>
          {doneCount} tasks completed · {tools} tools run
        </span>
        <span className="num" style={{ fontSize: 11, color: "var(--ink-4)" }}>
          expand
        </span>
        <Icon
          name="chevron"
          size={14}
          style={{ color: "var(--ink-4)", transform: "rotate(-90deg)" }}
        />
      </button>
    );
  }

  // Group tasks by phase, preserving first-seen phase order; hide pending-only.
  const phaseOrder: string[] = [];
  for (const t of tasks)
    if (!phaseOrder.includes(t.phase)) phaseOrder.push(t.phase);
  // MONEY-1274 — a failed run marks the stage it ACTUALLY reached, derived from
  // its progress, instead of the hard-coded "SYNTHESIZING" this used to pass.
  //
  // That constant made every failure look late-stage. A job no worker ever
  // picked up — progress 0, no plan, no tasks — was drawn as "failed at
  // synthesis, four of five stages done", which points whoever is debugging at
  // the model and the synthesis step rather than at the queue. Three QA
  // sessions sat like that from 2026-08-21 and the stepper described every one
  // of them as a synthesis failure. (Why they stalled is still unexplained —
  // see stageForProgress above; it is not the push-endpoint outage an earlier
  // comment here asserted.)
  const failedAt = isFailed ? stageForProgress(progress) : stage;
  const curIdx = RUN_STAGE_ORDER.indexOf(failedAt);

  return (
    <div className="card" style={{ overflow: "hidden", marginBottom: 4 }}>
      <div
        style={{
          padding: "12px 14px",
          borderBottom: "2px solid var(--ink)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <span
          className={isFailed ? "" : "live-dot"}
          style={{
            background: isFailed ? "var(--poor)" : undefined,
            width: 8,
            height: 8,
            borderRadius: 99,
            display: isFailed ? "inline-block" : undefined,
          }}
        />
        <span
          className="eyebrow"
          style={{ color: isFailed ? "var(--poor)" : "var(--emerald)" }}
        >
          {isFailed
            ? "Research failed"
            : done
              ? "Research complete"
              : "Research in progress"}
        </span>
        <span style={{ flex: 1 }} />
        {(deep !== undefined || depth) && (
          <span className={"pill sm " + (deep === false ? "ghost" : "violet")}>
            {[deep === undefined ? null : deep ? "DEEP" : "AUTO", depth]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
        {done && onToggleCollapse && (
          <button className="btn sm" onClick={onToggleCollapse}>
            Collapse
          </button>
        )}
      </div>
      <div style={{ padding: 14 }}>
        {/* lifecycle stepper */}
        <div
          className="cr-scroll-x"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            marginBottom: 10,
            overflowX: "auto",
          }}
        >
          {RUN_STAGE_ORDER.map((st, i) => {
            const active = i === curIdx,
              passed = i < curIdx;
            return (
              <span key={st} style={{ display: "contents" }}>
                <span
                  className="num"
                  style={{
                    fontSize: 9.5,
                    fontWeight: 700,
                    letterSpacing: 0.5,
                    padding: "3px 7px",
                    borderRadius: 6,
                    whiteSpace: "nowrap",
                    color: active
                      ? "#fff"
                      : passed
                        ? "var(--emerald)"
                        : "var(--ink-4)",
                    background: active
                      ? isFailed
                        ? "var(--poor)"
                        : "var(--emerald-pure)"
                      : passed
                        ? "var(--emerald-bg)"
                        : "transparent",
                  }}
                >
                  {st}
                </span>
                {i < RUN_STAGE_ORDER.length - 1 && (
                  <span
                    style={{
                      width: 10,
                      height: 1.5,
                      background: passed
                        ? "var(--emerald)"
                        : "var(--rule-soft)",
                      flexShrink: 0,
                    }}
                  />
                )}
              </span>
            );
          })}
        </div>
        {/* progress bar */}
        <div
          style={{
            height: 7,
            borderRadius: 99,
            background: "var(--rule-softer)",
            overflow: "hidden",
            marginBottom: 7,
          }}
        >
          <div
            style={{
              width: progress + "%",
              height: "100%",
              background: isFailed ? "var(--poor)" : "var(--emerald-pure)",
              borderRadius: 99,
              transition: "width .4s ease",
            }}
          />
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 14,
          }}
        >
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{caption}</span>
          <span
            className="num"
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: isFailed ? "var(--poor)" : "var(--emerald)",
            }}
          >
            {progress}%
          </span>
        </div>
        {isFailed && <FailedInline {...failed} />}
        {!isFailed &&
          phaseOrder.map((ph) => {
            const visible = tasks.filter(
              (t) => t.phase === ph && t.status !== "pending"
            );
            if (!visible.length) return null;
            return (
              <div key={ph} style={{ marginBottom: 14 }}>
                <div className="eyebrow" style={{ marginBottom: 7 }}>
                  {ph}
                </div>
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 8 }}
                >
                  {visible.map((t) => (
                    <TaskCard
                      key={t.key}
                      task={t}
                      isOpen={openKey === t.key}
                      onToggle={() => toggle(t.key)}
                      onRetry={onRetryTask}
                    />
                  ))}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
