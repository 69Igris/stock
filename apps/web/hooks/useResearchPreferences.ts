"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getMyResearchPreferencesAction,
  setMyResearchPreferencesAction,
  type ResearchPreferences,
  type ResearchPreferencesInput,
} from "@/lib/actions/preferences";

interface State {
  prefs: ResearchPreferences | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
}

const INITIAL: State = {
  prefs: null,
  isLoading: true,
  isSaving: false,
  error: null,
};

/**
 * Hook used by the prompt-options popover (MONEY-220) and any surface that
 * needs to read or mutate the signed-in user's research preferences.
 *
 * Responsibilities:
 *   - Lazy-load on first mount (the popover is the only consumer today; we
 *     don't want every chat dashboard to hit the DB just to render).
 *   - Keep state in sync after a save without re-fetching.
 *   - Expose a stable `save` callback that does optimistic-style merging:
 *     callers pass a partial; the merged value lands in state immediately
 *     and the server action runs in the background.
 */
export function useResearchPreferences(): {
  prefs: ResearchPreferences | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  save: (input: Partial<ResearchPreferencesInput>) => Promise<void>;
  reload: () => Promise<void>;
} {
  const [state, setState] = useState<State>(INITIAL);
  const isMounted = useRef(false);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    const res = await getMyResearchPreferencesAction();
    if (!isMounted.current) return;
    if (res.success) {
      setState({
        prefs: res.data,
        isLoading: false,
        isSaving: false,
        error: null,
      });
    } else {
      setState((s) => ({ ...s, isLoading: false, error: res.error }));
    }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    load();
    return () => {
      isMounted.current = false;
    };
  }, [load]);

  const save = useCallback(async (input: Partial<ResearchPreferencesInput>) => {
    setState((s) => ({ ...s, isSaving: true, error: null }));
    const res = await setMyResearchPreferencesAction(input);
    if (!isMounted.current) return;
    if (res.success) {
      setState((s) => ({
        ...s,
        prefs: res.data,
        isSaving: false,
        error: null,
      }));
    } else {
      setState((s) => ({ ...s, isSaving: false, error: res.error }));
    }
  }, []);

  return {
    prefs: state.prefs,
    isLoading: state.isLoading,
    isSaving: state.isSaving,
    error: state.error,
    save,
    reload: load,
  };
}
