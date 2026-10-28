"use client";

/**
 * Deep Compare result client (MONEY-550).
 *
 * Polls the async comparison worker job by `sessionId`:
 *   - On mount, calls getComparisonResultAction(sessionId). If COMPLETED, render
 *     immediately; if FAILED, show the error state; otherwise show the progress
 *     view and start polling getComparisonStatusAction every 4s.
 *   - On COMPLETED-via-poll, fetch the full result once and stop polling.
 *
 * Mirrors apps/web/app/roast/[id]/client.tsx (RoastProgressView + poll loop).
 * Renders the ComparisonSession.result via <ComparisonResult>.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { Loader2, GitCompareArrows, AlertTriangle } from "lucide-react";

import { PageGuard } from "@/components/PageGuard";
import { DiscoverSkeleton } from "@/components/skeletons";
import { DemoBanner } from "@/components/DemoBanner";
import { TerminalLuxeShell } from "@/components/terminal-luxe/Shell";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";
import {
  getComparisonStatusAction,
  getComparisonResultAction,
  type ComparisonResult as ComparisonResultDto,
} from "@/lib/actions/comparison";
import ComparisonResult, {
  type ComparisonResultData,
} from "@/components/compare/ComparisonResult";
import {
  decideComparePoll,
  COMPARE_POLL_INTERVAL_MS,
} from "@/lib/compare/poll-logic";

// Terminal statuses written by the worker (workers/src/processors/comparison.ts).
const TERMINAL = new Set(["COMPLETED", "FAILED"]);

/** Scrub a worker error before surfacing it (defense-in-depth — the action
 *  already sanitizes). Never leak stack traces / provider names. */
function sanitizeError(raw: string | null | undefined): string {
  if (!raw)
    return "Something went wrong with the comparison. Please try again.";
  if (
    raw.includes("VertexAI") ||
    raw.includes("status:") ||
    raw.includes("ECONNREFUSED") ||
    raw.length > 240
  ) {
    return "The analysis service encountered an error. Please try again in a few moments.";
  }
  return raw;
}

// ── Progress view (mirrors RoastProgressView) ──────────────────────

function CompareProgressView({
  progress,
  currentStep,
}: {
  progress: number;
  currentStep: string | null;
}) {
  return (
    <div className="px-6 py-[120px] text-center">
      <div
        className="w-16 h-16 rounded-2xl mx-auto mb-[18px] flex items-center justify-center border-2 border-[var(--ink)]"
        style={{
          background: "var(--emerald)",
          boxShadow: "var(--shadow-soft)",
          animation: "cmp-pulse 1.4s ease-in-out infinite",
        }}
      >
        <GitCompareArrows className="h-[30px] w-[30px] text-white" />
      </div>
      <style>{`
        @keyframes cmp-pulse {
          0%, 100% { transform: scale(1); }
          50%      { transform: scale(1.06); }
        }
        @keyframes cmp-load {
          0%   { margin-left: -60%; }
          100% { margin-left: 100%; }
        }
      `}</style>
      <h2
        className="font-extrabold text-[20px] text-[var(--ink)] mb-2"
        style={{ letterSpacing: "-0.4px" }}
      >
        Comparing…
      </h2>
      <div className="font-mono text-xs text-[var(--ink-3)] tracking-[0.3px] mb-5">
        {currentStep || "fetching data · decomposing holdings · analysing"}
      </div>
      <div
        className="max-w-[320px] mx-auto h-1.5 rounded-full overflow-hidden mb-3 border-[1.5px] border-[var(--ink)]"
        style={{ background: "var(--rule-softer)" }}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: "60%",
            background: "var(--emerald)",
            animation: "cmp-load 2s ease infinite",
          }}
        />
      </div>
      {progress > 0 && (
        <div className="font-mono text-[11px] text-[var(--ink-3)] tabular-nums">
          {progress}% · usually 2-4 minutes
        </div>
      )}
    </div>
  );
}

// ── Main client ─────────────────────────────────────────────────────

export default function CompareResultClient({
  sessionId,
}: {
  sessionId: string;
}) {
  const router = useRouter();
  const { user } = useUser();
  const isDemoMode = useIsDemoMode({ user });

  const [record, setRecord] = useState<ComparisonResultDto | null>(null);
  // `record` is the comparison row's `result` payload once COMPLETED.
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // MONEY-553 fix — poll-termination guards (see lib/compare/poll-logic.ts):
  // count consecutive failed polls so a thrown/rejected action (e.g. a stale-
  // deploy UnrecognizedActionError) or a {success:false} return can't keep the
  // interval alive forever; track when polling began for the wall-clock cap.
  const pollFailuresRef = useRef(0);
  const pollStartRef = useRef<number | null>(null);

  // Initial load — read the full record once.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      const res = await getComparisonResultAction(sessionId);
      if (cancelled) return;

      if (!res.success || !res.data) {
        setError(res.error || "Comparison not found");
        setStatus("NOT_FOUND");
        setIsLoading(false);
        return;
      }

      const d = res.data;
      setKind(d.kind);
      setSymbols(d.symbols ?? []);
      setStatus(d.status);
      setProgress(d.progress ?? 0);
      setCurrentStep(d.currentStep);

      if (d.status === "COMPLETED") {
        setRecord(d.result as ComparisonResultDto | null);
      } else if (d.status === "FAILED") {
        setError(sanitizeError(d.errorMessage));
      }
      setIsLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Poll while the job is in-flight. The loop is PROVABLY TERMINATING
  // (lib/compare/poll-logic.ts): it stops on a terminal status, after a streak
  // of failed polls (thrown OR {success:false}), and at a hard wall-clock cap —
  // so a stale-deploy UnrecognizedActionError / demo / not-found can no longer
  // spin the 4s interval forever (the PostHog exception amplifier).
  useEffect(() => {
    if (!status || TERMINAL.has(status) || status === "NOT_FOUND") return;
    if (pollStartRef.current === null) pollStartRef.current = Date.now();

    function stopPolling() {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }

    async function poll() {
      // Map BOTH a thrown/rejected action call AND a {success:false} return to
      // ok:false so the decision logic treats them identically.
      let raw: Awaited<ReturnType<typeof getComparisonStatusAction>> | null =
        null;
      try {
        raw = await getComparisonStatusAction(sessionId);
      } catch {
        raw = null;
      }
      const ok = !!(raw?.success && raw.data);
      if (ok && raw?.data) {
        setProgress(raw.data.progress);
        setCurrentStep(raw.data.currentStep);
      }

      const elapsedMs = pollStartRef.current
        ? Date.now() - pollStartRef.current
        : 0;
      const decision = decideComparePoll(
        { ok, status: raw?.data?.status },
        { consecutiveFailures: pollFailuresRef.current, elapsedMs }
      );
      pollFailuresRef.current = decision.consecutiveFailures;
      if (decision.status) setStatus(decision.status);

      if (decision.action === "stop") {
        if (decision.status === "COMPLETED") {
          const full = await getComparisonResultAction(sessionId).catch(
            () => null
          );
          if (full?.success && full.data) {
            setKind(full.data.kind);
            setSymbols(full.data.symbols ?? []);
            setRecord(full.data.result as ComparisonResultDto | null);
          }
        } else if (decision.status === "FAILED") {
          setError(sanitizeError(raw?.data?.errorMessage));
        }
        stopPolling();
      } else if (decision.action === "stop-error") {
        // Sustained failure / timeout — surface a reload prompt and stop. Reuse
        // the FAILED render (TERMINAL) so the effect doesn't re-arm the interval.
        setError(decision.error ?? "Please reload the page.");
        setStatus("FAILED");
        stopPolling();
      }
      // action === "continue" → leave the interval running.
    }

    pollRef.current = setInterval(poll, COMPARE_POLL_INTERVAL_MS);
    return stopPolling;
  }, [status, sessionId]);

  const onDeepDive = useCallback(
    (query: string) => {
      router.push(`/analysis?q=${encodeURIComponent(query)}`);
    },
    [router]
  );

  const inProgress =
    !!status && !TERMINAL.has(status) && status !== "NOT_FOUND";
  const symbolLabel = symbols.join(" vs ");

  return (
    <PageGuard route="/discover" fallback={<DiscoverSkeleton />}>
      <TerminalLuxeShell
        active="markets"
        title={
          <>
            Deep <span className="ser">compare.</span>
          </>
        }
        breadcrumb="DISCOVER · COMPARE · DEEP"
        onBack={() => router.push("/compare")}
        topbarRight={
          symbolLabel ? (
            <span
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 11,
                color: "var(--ink-3)",
                fontWeight: 700,
                letterSpacing: 0.5,
              }}
            >
              {symbolLabel}
            </span>
          ) : undefined
        }
      >
        {isDemoMode && <DemoBanner />}

        {/* Loading the record */}
        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-3)]" />
          </div>
        )}

        {/* In-progress */}
        {!isLoading && inProgress && (
          <div className="max-w-4xl">
            <CompareProgressView
              progress={progress}
              currentStep={currentStep}
            />
          </div>
        )}

        {/* Failed / not-found */}
        {!isLoading && !inProgress && error && (
          <div className="max-w-md mx-auto py-[100px] text-center">
            <div
              className="w-14 h-14 rounded-[14px] mx-auto mb-4 flex items-center justify-center border-[1.5px]"
              style={{
                background: "color-mix(in srgb, var(--pop-1) 12%, transparent)",
                borderColor:
                  "color-mix(in srgb, var(--pop-1) 35%, transparent)",
              }}
            >
              <AlertTriangle
                className="h-[26px] w-[26px]"
                style={{ color: "var(--pop-1-text)" }}
              />
            </div>
            <h2
              className="font-extrabold text-[18px] text-[var(--ink)] mb-2"
              style={{ letterSpacing: "-0.3px" }}
            >
              {status === "NOT_FOUND"
                ? "Comparison not found"
                : "Couldn't finish the comparison"}
            </h2>
            <p className="text-[13.5px] text-[var(--ink-3)] mb-5 leading-[1.5]">
              {error}
            </p>
            <button
              type="button"
              onClick={() => router.push("/compare")}
              className="pf-bf"
            >
              Back to Compare
            </button>
          </div>
        )}

        {/* Completed */}
        {!isLoading && status === "COMPLETED" && (
          <div className="max-w-4xl">
            <ComparisonResult
              result={record as ComparisonResultData | null}
              kind={kind ?? undefined}
              symbols={symbols}
              onDeepDive={onDeepDive}
            />
          </div>
        )}
      </TerminalLuxeShell>
    </PageGuard>
  );
}
