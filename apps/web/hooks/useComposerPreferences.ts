"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getMyComposerPreferencesAction,
  setMyComposerPreferencesAction,
  type ComposerPreferences,
  type ConnectorPreferences,
  type SourcePreferences,
  type ToolsPreferences,
  type InstrumentBasket,
} from "@/lib/actions/preferences";

interface State {
  prefs: ComposerPreferences | null;
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

type SavePatch = Partial<{
  connectors: Partial<ConnectorPreferences>;
  sources: Partial<SourcePreferences>;
  tools: Partial<ToolsPreferences>;
  pinnedInstruments: Partial<InstrumentBasket>;
  recentInstruments: Partial<InstrumentBasket>;
  model: string | null;
  thinking: boolean;
}>;

/**
 * Companion to useResearchPreferences for every popover sub-view that
 * grew during the redesign - Connectors, Instruments, Sources (web +
 * docs), Tools (indicators / screeners / persona), and the model
 * selector. Single round-trip on first mount; optimistic-style writes
 * that merge with the existing namespaces server-side.
 */
export function useComposerPreferences(): {
  prefs: ComposerPreferences | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  save: (patch: SavePatch) => Promise<void>;
  reload: () => Promise<void>;
} {
  const [state, setState] = useState<State>(INITIAL);
  const isMounted = useRef(false);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    const res = await getMyComposerPreferencesAction();
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

  const save = useCallback(async (patch: SavePatch) => {
    setState((s) => ({ ...s, isSaving: true, error: null }));
    const res = await setMyComposerPreferencesAction(patch);
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
