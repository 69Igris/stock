"use client";

/**
 * useResearchPlanPreview - MONEY-239 A.
 *
 * Debounced fetch of /api/research/preview-plan that drives the
 * confirmation sheet's task / credit / model estimate. Re-fires when
 * the user toggles a skill in the inline editor.
 *
 * Strategy:
 *   - 250 ms debounce so the live recompute doesn't hammer Redis on
 *     every checkbox click. The endpoint itself is cache-first so
 *     even unthrottled this would be cheap, but the debounce keeps
 *     the UI from "flickering" between estimates as the user
 *     toggles a string of skills.
 *   - Request-id guard so a slower earlier request can't overwrite
 *     a newer estimate.
 *   - `refetch()` for an explicit re-pull when needed (e.g., after
 *     the user picks a different model).
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type {
  ResearchPresetId,
  ResearchSkillId,
} from "@usemoney/services/preferences";

export interface PreviewPlanInput {
  query: string;
  symbols?: string[];
  preset?: ResearchPresetId;
  customSkills?: ResearchSkillId[];
  extraSkills?: ResearchSkillId[];
  removedSkills?: ResearchSkillId[];
  model?: string;
}

export interface PreviewPlanData {
  rewrittenQuery: string;
  effectiveSkills: ResearchSkillId[];
  estimatedTasks: {
    data: number;
    compute: number;
    synthesis: number;
    total: number;
  };
  estimatedCredits: number;
  estimatedRupees: number;
  estimatedSecondsRange: { min: number; max: number };
  modelId: string;
  modelTierLabel: string;
  echo: {
    preset?: ResearchPresetId;
    skillCount: number;
    cacheHit: boolean;
  };
}

interface State {
  data: PreviewPlanData | null;
  isLoading: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 250;
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 20; // 30s ceiling

/**
 * MONEY-240 A - poll /api/research/preview-plan/[jobId]/status until
 * the worker writes the LLM-rewritten brief. The route always
 * returned a deterministic preliminary first, so the panel is already
 * showing useful data while we wait.
 */
async function pollPreviewStatus(
  jobId: string,
  onReady: (data: PreviewPlanData) => void
): Promise<void> {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
    try {
      const res = await fetch(
        `/api/research/preview-plan/${encodeURIComponent(jobId)}/status`
      );
      if (res.status === 202) continue; // still pending
      if (!res.ok) return;
      const json = (await res.json()) as
        | PreviewPlanData
        | { pending: true; jobId: string };
      if ("pending" in json && json.pending) continue;
      onReady(json as PreviewPlanData);
      return;
    } catch {
      // Soft-fail and keep polling - transient network blips are
      // fine. After POLL_MAX_ATTEMPTS we give up and the panel
      // continues showing the preliminary preview indefinitely.
    }
  }
}

export function useResearchPlanPreview(
  input: PreviewPlanInput | null,
  options?: { enabled?: boolean }
): State & { refetch: () => void } {
  const enabled = options?.enabled !== false && input !== null;
  const [state, setState] = useState<State>({
    data: null,
    isLoading: false,
    error: null,
  });
  const reqIdRef = useRef(0);

  const fetchPreview = useCallback(async (body: PreviewPlanInput) => {
    const myReq = ++reqIdRef.current;
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const res = await fetch("/api/research/preview-plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (myReq !== reqIdRef.current) return; // stale
      if (!res.ok && res.status !== 202) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(text || `${res.status}`);
      }
      const json = (await res.json()) as
        | PreviewPlanData
        | { pending: true; jobId: string; preliminary: PreviewPlanData };
      if (myReq !== reqIdRef.current) return; // stale

      // MONEY-240 A - worker-fallback path. Render the preliminary
      // estimate immediately, then poll the status endpoint for the
      // final LLM-rewritten brief.
      if ("pending" in json && json.pending) {
        setState({
          data: json.preliminary,
          isLoading: true,
          error: null,
        });
        await pollPreviewStatus(json.jobId, (final) => {
          if (myReq !== reqIdRef.current) return;
          setState({ data: final, isLoading: false, error: null });
        });
        return;
      }

      setState({
        data: json as PreviewPlanData,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      if (myReq !== reqIdRef.current) return;
      setState((s) => ({
        ...s,
        isLoading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  useEffect(() => {
    if (!enabled || !input) return;
    const handle = setTimeout(() => void fetchPreview(input), DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // Stringify the input so a new identity-equal-but-shallow-different
    // body still triggers a fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, JSON.stringify(input), fetchPreview]);

  const refetch = useCallback(() => {
    if (input) void fetchPreview(input);
  }, [input, fetchPreview]);

  return { ...state, refetch };
}
