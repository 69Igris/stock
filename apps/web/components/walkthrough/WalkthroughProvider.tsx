"use client";

import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import {
  getWalkthroughStateAction,
  markWalkthroughSeenAction,
  resetWalkthroughAction,
  snoozeWalkthroughAction,
} from "@/lib/actions/walkthrough";
import {
  CURRENT_WALKTHROUGH_VERSION,
  getActionEventNames,
  getTourByVersion,
  TOUR_LIST,
} from "@/lib/walkthrough/tours";
import { v1CoreStepsStockSageFirst } from "@/lib/walkthrough/tours/v1-core";
import {
  initialState,
  pickEligibleTour,
  selectDurationMs,
  selectIsOnLastStep,
  SNOOZE_DURATION_MS,
  walkthroughReducer,
} from "./state-machine";
import type { TriggerCandidate, EligibilityContext } from "./state-machine";
import type { TourDefinition, WalkthroughContextValue } from "./types";
import WalkthroughSpotlight from "./WalkthroughSpotlight";
import WalkthroughPopover from "./WalkthroughPopover";
import {
  isTermsBlocking,
  onTermsBlockingChange,
} from "@/lib/walkthrough/terms-signal";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";

export const WalkthroughContext = createContext<WalkthroughContextValue | null>(
  null
);

const RESTART_EVENT = "walkthrough:restart";
const TRIGGER_EVENT = "walkthrough:trigger";
const MOBILE_NAV_EVENT = "walkthrough:set-mobile-nav";
const MOBILE_BREAKPOINT_MAX = 1023.98;
// Step-target timeout. The FIRST step of every tour gets a longer window
// because submodule pages (Holdings, Screener, etc.) render a skeleton
// while data loads - the walkthrough's first anchor isn't in the DOM
// for up to several seconds. With the old 2500ms ceiling the tour
// auto-skipped step 1 and landed on step 2, which the user perceived
// as "the flow does not start from 1". Subsequent steps stay at the
// shorter timeout because the surrounding page has already mounted.
const TARGET_TIMEOUT_FIRST_STEP_MS = 10000;
const TARGET_TIMEOUT_LATER_STEP_MS = 2500;
const TARGET_POLL_MS = 100;

function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_MAX}px)`).matches;
}

function setMobileNav(open: boolean) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MOBILE_NAV_EVENT, { detail: { open } }));
}

function targetExists(selector: string): boolean {
  if (typeof document === "undefined") return false;
  const matches = document.querySelectorAll(selector);
  for (const el of Array.from(matches)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
  }
  return false;
}

// Canonicalize a "path?query" string for comparison: drop the transient
// `walkthrough` param and sort the rest so `/dashboard?view=chat` compares
// equal regardless of param order. Used to decide whether a step's
// `navigateTo` already matches the current location before pushing (avoids a
// redundant navigation / render loop). View-distinguishing params (e.g.
// `view=chat` vs no `view`) are preserved, so the overview and chat views of
// `/dashboard` normalize differently.
function normalizeLocation(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete("walkthrough");
  params.sort();
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

export default function WalkthroughProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const posthog = usePostHog();
  const [state, dispatch] = useReducer(walkthroughReducer, initialState);

  const seenVersionsRef = useRef<string[]>([]);
  const snoozedUntilRef = useRef<Record<string, string>>({});
  const planIdRef = useRef<string | null>(null);
  // User's EXPLICITLY-CHOSEN default-landing preference, or "dashboard" when
  // they have not chosen one. Drives the v1-core intro ordering: dashboard-
  // first unless the user deliberately made StockSage their home page.
  // null = not yet loaded. Note this deliberately does NOT mirror the landing
  // default (which is "stocksage") — see the assignment below for why.
  const defaultPageRef = useRef<"dashboard" | "stocksage" | null>(null);
  const stateLoadedRef = useRef(false);
  const trackedStartRef = useRef<string | null>(null);

  // MONEY-1137: reuse the `useUser()` call above rather than adding a second.
  const demo = useIsDemoMode({ user });

  // Load walkthrough state (seen + snoozed) AND the default-landing preference
  // for the authenticated user in a single pass. Both must resolve before we
  // flip `stateLoadedRef` / bootstrap, otherwise the first route-bootstrap can
  // build the v1-core intro with a stale "dashboard" preference and briefly
  // show a StockSage-default user the dashboard-first ordering. We await both
  // together (Promise.all) and set `defaultPageRef` BEFORE
  // `stateLoadedRef.current = true` / `maybeBootstrapByRoute` so the adaptive
  // step ordering is correct on first paint. Both lookups are best-effort:
  // neither throws, and any preference failure falls back to "dashboard"
  // (the signup default).
  useEffect(() => {
    if (stateLoadedRef.current) return;
    if (!isLoaded) return;
    if (!user || demo) {
      stateLoadedRef.current = true;
      return;
    }

    let cancelled = false;
    (async () => {
      const [stateResult, prefResult] = await Promise.all([
        getWalkthroughStateAction().catch(() => null),
        import("@/lib/actions/user")
          .then(({ getDefaultPagePreferenceAction }) =>
            getDefaultPagePreferenceAction()
          )
          .catch(() => null),
      ]);
      if (cancelled) return;
      if (stateResult?.success && stateResult.data) {
        seenVersionsRef.current = stateResult.data.seenVersions;
        snoozedUntilRef.current = stateResult.data.snoozedUntil;
      }
      // Resolve the default-landing preference BEFORE bootstrapping so the
      // adaptive ordering sees the real value on the first route-bootstrap.
      //
      // Keyed on `isExplicit`, NOT on `value`. The landing default is now
      // "stocksage", so `value` alone would select the chat-first intro for
      // every brand-new sign-up — and sign-up lands on /dashboard, which is
      // where this tour triggers, so its first step would immediately navigate
      // them away into an empty chat. The adaptive ordering exists for people
      // who deliberately made StockSage their home; that is what it now reads.
      defaultPageRef.current =
        prefResult?.success && prefResult.isExplicit
          ? prefResult.value
          : "dashboard";
      stateLoadedRef.current = true;
      // Re-evaluate eligibility against the route the user is on NOW — read
      // live from `window.location`, NOT the `pathname` this effect closed over.
      //
      // MONEY-1217. This effect's deps are [isLoaded, user, demo]; `pathname` is
      // captured at mount and never refreshed. The two lookups above take ~1.4s
      // on a cold dashboard, which is easily long enough for someone to click
      // the sidebar — and this provider lives in the ROOT layout, so it does not
      // unmount on navigation and the `cancelled` flag above never fires for a
      // route change. It only covers sign-out.
      //
      // So the stale value reached `maybeBootstrapByRoute("/dashboard")`, which
      // matched the v1-core route trigger, dispatched BOOTSTRAP_ACTIVE, and the
      // navigation effect then saw `navigateTo: "/dashboard"` against a current
      // location of /discover/markets and pushed. The user was yanked back to
      // the dashboard a second after leaving it — on every page, after every
      // login, and only when the backend was slow enough to lose the race.
      //
      // Reading `window.location.pathname` is the same fix MONEY-1082 applied to
      // the discover URL writers: the live location is the only thing that is
      // true at the moment the async work resolves.
      const livePath =
        typeof window === "undefined" ? pathname : window.location.pathname;
      maybeBootstrapByRoute(livePath);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, user, demo]);

  // Best-effort plan lookup for plan-gated tours. Failure → assume FREE.
  //
  // MONEY-1126: this used to be its own `getSubscriptionAction` round trip, a
  // third one on a dashboard render alongside the sidebar's two. It now shares
  // the sidebar's single flight via `plan-cache`, which dedupes concurrent
  // callers and serves the rest of the session from memory.
  //
  // Routing THIS caller through the cosmetic cache is safe precisely because it
  // is cosmetic: `planIdRef` only picks which onboarding tour is eligible. It is
  // never an entitlement decision — those read the server (see
  // `lib/subscription/access.ts`) and stay server-authoritative. `plan-cache`
  // persists to localStorage and can briefly serve whoever was signed in on this
  // browser before, which is fine for choosing a tour and would NOT be fine for
  // unlocking a page.
  useEffect(() => {
    if (!isLoaded || !user || demo) return;
    let cancelled = false;
    import("@/lib/subscription/plan-cache")
      .then(({ fetchPlanCached }) => fetchPlanCached())
      .then((planId) => {
        if (cancelled) return;
        planIdRef.current = planId || "FREE";
      })
      .catch(() => {
        if (!cancelled) planIdRef.current = "FREE";
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, user, demo]);

  // Adapt the v1-core intro ordering to the user's default-landing preference.
  // Non-v1-core tours pass through untouched. When the user lands on StockSage
  // chat by default, lead with the chat steps; otherwise keep the
  // dashboard-first ordering. navigateTo / target / timeout logic is intrinsic
  // to each step, so only the step ordering changes here.
  const withAdaptiveOrdering = useCallback(
    (tour: TourDefinition): TourDefinition => {
      if (tour.version !== CURRENT_WALKTHROUGH_VERSION) return tour;
      if (defaultPageRef.current !== "stocksage") return tour;
      return { ...tour, steps: v1CoreStepsStockSageFirst };
    },
    []
  );

  const eligibilityCtx = (): EligibilityContext => ({
    seenVersions: seenVersionsRef.current,
    snoozedUntil: snoozedUntilRef.current,
    planId: planIdRef.current,
    now: Date.now(),
  });

  const maybeBootstrapByRoute = useCallback(
    (currentPath: string | null) => {
      if (!stateLoadedRef.current) return;
      if (!user || demo) return;
      if (state.phase === "active" || state.phase === "completing") return;
      if (!currentPath) return;
      // Hold off if TermsGate is showing the acceptance modal - the
      // walkthrough must not race the consent dialog.
      if (isTermsBlocking()) return;
      const candidate: TriggerCandidate = {
        kind: "route",
        pathname: currentPath,
      };
      const tour = pickEligibleTour(TOUR_LIST, candidate, eligibilityCtx());
      if (tour) {
        dispatch({
          type: "BOOTSTRAP_ACTIVE",
          tour: withAdaptiveOrdering(tour),
          now: Date.now(),
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, demo, state.phase, withAdaptiveOrdering]
  );

  // Route-triggered tours (e.g., v1-core on /dashboard).
  useEffect(() => {
    maybeBootstrapByRoute(pathname);
  }, [pathname, maybeBootstrapByRoute]);

  // Once TermsGate flips blocking off, re-evaluate route eligibility so the
  // tour bootstraps cleanly post-accept without needing a route change.
  useEffect(() => {
    return onTermsBlockingChange((blocking) => {
      if (!blocking) maybeBootstrapByRoute(pathname);
    });
  }, [pathname, maybeBootstrapByRoute]);

  // Action-triggered tours: listen for every event name declared by any
  // action-trigger tour in the registry.
  useEffect(() => {
    if (!user || demo) return;
    const eventNames = getActionEventNames();
    function handler(event: Event) {
      if (!stateLoadedRef.current) return;
      if (state.phase === "active" || state.phase === "completing") return;
      const candidate: TriggerCandidate = {
        kind: "action",
        eventName: event.type,
      };
      const tour = pickEligibleTour(TOUR_LIST, candidate, eligibilityCtx());
      if (tour) {
        dispatch({
          type: "BOOTSTRAP_ACTIVE",
          tour: withAdaptiveOrdering(tour),
          now: Date.now(),
        });
      }
    }
    for (const name of eventNames) {
      window.addEventListener(name, handler);
    }
    return () => {
      for (const name of eventNames) {
        window.removeEventListener(name, handler);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, demo, state.phase]);

  // Manual-trigger: user clicks "Take the {feature} tour" CTA somewhere
  // and dispatches `walkthrough:trigger` with `{detail: version}`.
  useEffect(() => {
    function onTrigger(event: Event) {
      const detail = (event as CustomEvent<string>).detail;
      if (!detail) return;
      if (state.phase === "active" || state.phase === "completing") return;
      const candidate: TriggerCandidate = {
        kind: "manual",
        targetVersion: detail,
      };
      const tour = pickEligibleTour(TOUR_LIST, candidate, eligibilityCtx());
      if (tour) {
        dispatch({
          type: "BOOTSTRAP_ACTIVE",
          tour: withAdaptiveOrdering(tour),
          now: Date.now(),
        });
      }
    }
    window.addEventListener(TRIGGER_EVENT, onTrigger);
    return () => window.removeEventListener(TRIGGER_EVENT, onTrigger);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  // ?walkthrough=v1-core in the URL - set by "Take the tour again" when
  // the user is on a different page. We arrive at /dashboard with that
  // param; pop it from the URL and force-fire the tour locally.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!user || demo) return;
    const params = new URLSearchParams(window.location.search);
    const version = params.get("walkthrough");
    if (!version) return;
    const tour = getTourByVersion(version);
    if (!tour) return;
    seenVersionsRef.current = seenVersionsRef.current.filter(
      (v) => v !== version
    );
    delete snoozedUntilRef.current[version];
    dispatch({
      type: "BOOTSTRAP_ACTIVE",
      tour: withAdaptiveOrdering(tour),
      now: Date.now(),
    });
    posthog?.capture("walkthrough_restarted", {
      version,
      source: "user-menu",
    });
    // Strip the param from the URL so refreshing the page doesn't re-fire.
    // MONEY-1082: forward `window.history.state` — it carries Next's `__NA`
    // marker, which is what makes the patched replaceState skip its router
    // dispatch. With `{}` this was an ACTION_RESTORE (a real navigation) fired
    // from a provider that never unmounts, so it could re-assert whatever
    // pathname was live when the bootstrap effect finally resolved.
    params.delete("walkthrough");
    const next = params.toString();
    const newUrl =
      window.location.pathname +
      (next ? `?${next}` : "") +
      window.location.hash;
    window.history.replaceState(window.history.state, "", newUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, demo, posthog]);

  // "Take the tour again" reset path - restart specifically the v1-core tour.
  useEffect(() => {
    function onRestart(event: Event) {
      const detail = (event as CustomEvent<string>).detail;
      const version = detail || CURRENT_WALKTHROUGH_VERSION;
      const tour = getTourByVersion(version);
      if (!tour) return;
      // Drop the version from our local cache so eligibility predicates
      // immediately see it as unseen on the next bootstrap attempt.
      seenVersionsRef.current = seenVersionsRef.current.filter(
        (v) => v !== version
      );
      delete snoozedUntilRef.current[version];
      dispatch({
        type: "BOOTSTRAP_ACTIVE",
        tour: withAdaptiveOrdering(tour),
        now: Date.now(),
      });
      posthog?.capture("walkthrough_restarted", {
        version,
        source: "user-menu",
      });
    }
    window.addEventListener(RESTART_EVENT, onRestart);
    return () => {
      window.removeEventListener(RESTART_EVENT, onRestart);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posthog]);

  // Once a tour goes active, capture started analytics + remember locally.
  useEffect(() => {
    if (
      state.phase === "active" &&
      state.tour &&
      trackedStartRef.current !== state.tour.version
    ) {
      trackedStartRef.current = state.tour.version;
      posthog?.capture("walkthrough_started", {
        version: state.tour.version,
      });
    }
  }, [state.phase, state.tour, posthog]);

  /**
   * MONEY-439: persist seen-state as soon as the tour goes active, not
   * only on completion. Without this, closing the tab or navigating away
   * mid-tour leaves `walkthroughVersionsSeen` empty in the DB and the
   * same tour fires again on re-login (worse: on a different device,
   * where there's no in-memory ref to mask the gap). `markWalkthroughSeen`
   * is idempotent server-side so the existing completing-phase write
   * still runs as a no-op safety net. The local ref is updated optimistically
   * so subsequent eligibility checks in this same session immediately
   * skip the tour.
   */
  useEffect(() => {
    if (state.phase !== "active" || !state.tour) return;
    if (!user || demo) return;
    const version = state.tour.version;
    if (seenVersionsRef.current.includes(version)) return;
    seenVersionsRef.current = [...seenVersionsRef.current, version];
    void markWalkthroughSeenAction(version).catch(() => {
      // Best-effort: completion-time call (line ~314) will retry on its own.
    });
  }, [state.phase, state.tour, user, demo]);

  // Completing → persist as seen, capture completion analytics, return to dormant.
  useEffect(() => {
    if (state.phase !== "completing" || !state.tour) return;
    const version = state.tour.version;
    const durationMs = selectDurationMs(state, Date.now());
    let cancelled = false;
    (async () => {
      const result = await markWalkthroughSeenAction(version);
      if (cancelled) return;
      if (result.success) {
        posthog?.capture("walkthrough_completed", { version, durationMs });
        if (result.data) {
          seenVersionsRef.current = result.data.seenVersions;
        } else {
          seenVersionsRef.current = [...seenVersionsRef.current, version];
        }
      }
      dispatch({ type: "COMPLETE_PERSIST_DONE" });
      trackedStartRef.current = null;
    })();
    return () => {
      cancelled = true;
    };
  }, [state.phase, state.tour, posthog, state]);

  const currentStep = useMemo(() => {
    if (state.phase !== "active" || !state.tour) return null;
    return state.tour.steps[state.stepIndex] ?? null;
  }, [state]);

  // Mobile: open MobileHeader's Sheet for sidebar-anchored steps; close otherwise.
  useEffect(() => {
    if (!isMobileViewport()) return;
    if (state.phase === "active" && currentStep) {
      setMobileNav(currentStep.requiresMobileSidebar === true);
    } else {
      setMobileNav(false);
    }
  }, [state.phase, currentStep]);

  // Per-step navigation - some steps anchor a target that only renders on a
  // different page/view than where the tour fired (e.g. the StockSage chat
  // composer lives at /dashboard?view=chat, not the /dashboard overview).
  // When the active step declares `navigateTo` and the current location
  // doesn't already match, push there so the anchor mounts. We read
  // `window.location.search` (not useSearchParams) on purpose: the only
  // dependency that changes between these same-path/different-view steps is
  // `state.stepIndex`, and avoiding useSearchParams sidesteps its Suspense
  // boundary requirement. normalizeLocation makes the comparison idempotent
  // so a matching location never re-pushes.
  useEffect(() => {
    if (state.phase !== "active" || !currentStep) return;
    const navigateTo = currentStep.navigateTo;
    if (!navigateTo) return;
    if (typeof window === "undefined") return;
    const [navPath, navSearch = ""] = navigateTo.split("?");
    const targetNorm = normalizeLocation(navPath, navSearch);
    const currentNorm = normalizeLocation(
      window.location.pathname,
      window.location.search
    );
    if (targetNorm === currentNorm) return;
    router.push(navigateTo);
  }, [state.phase, state.stepIndex, currentStep, router]);

  // Target watcher - if the current step's target hasn't rendered within
  // its timeout we auto-advance so the tour doesn't get stuck on a missing
  // anchor (e.g., feature flag off, lazy chunk). The first step - and any
  // step that navigates to another page/view via `navigateTo` - uses the
  // 10s timeout because the destination renders a loading skeleton before
  // its anchor appears; in-place later steps use a shorter window because
  // the page is already mounted.
  useEffect(() => {
    if (state.phase !== "active" || !currentStep) return;
    const start = Date.now();
    const timeoutMs =
      state.stepIndex === 0 || currentStep.navigateTo
        ? TARGET_TIMEOUT_FIRST_STEP_MS
        : TARGET_TIMEOUT_LATER_STEP_MS;
    let pollId: ReturnType<typeof setTimeout> | null = null;
    function check() {
      if (targetExists(currentStep!.target)) return;
      if (Date.now() - start > timeoutMs) {
        posthog?.capture("walkthrough_step_auto_skipped", {
          version: state.tour?.version,
          stepId: currentStep!.id,
          stepIndex: state.stepIndex,
          reason: "target_not_found",
        });
        dispatch({ type: "NEXT" });
        return;
      }
      pollId = setTimeout(check, TARGET_POLL_MS);
    }
    pollId = setTimeout(check, TARGET_POLL_MS);
    return () => {
      if (pollId) clearTimeout(pollId);
    };
  }, [state.phase, state.stepIndex, currentStep, posthog, state.tour]);

  // Scroll the current step's target into view (centered in its scroll
  // container) once it exists. Handles the case where a nav target lives
  // below the fold inside the mobile Sheet, or off-screen in a long
  // desktop sidebar. Retries while the Sheet/page is still animating.
  useEffect(() => {
    if (state.phase !== "active" || !currentStep) return;
    const target = currentStep.target;
    let cancelled = false;
    let attempts = 0;
    function attempt() {
      if (cancelled) return;
      if (typeof document === "undefined") return;
      const matches = document.querySelectorAll(target);
      for (const el of Array.from(matches)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          try {
            (el as HTMLElement).scrollIntoView({
              behavior: "smooth",
              block: "center",
              inline: "nearest",
            });
          } catch {
            // Older browsers without options arg - fall back to no-op.
          }
          return;
        }
      }
      attempts++;
      if (attempts < 20) setTimeout(attempt, 100);
    }
    // Small initial delay so Sheet open animation can start.
    const initial = setTimeout(attempt, 120);
    return () => {
      cancelled = true;
      clearTimeout(initial);
    };
  }, [state.phase, state.stepIndex, currentStep]);

  const next = useCallback(() => {
    if (state.phase !== "active" || !state.tour) return;
    const last = selectIsOnLastStep(state);
    if (!last) {
      const nextStep = state.tour.steps[state.stepIndex + 1];
      posthog?.capture("walkthrough_step_advanced", {
        version: state.tour.version,
        stepId: nextStep?.id,
        stepIndex: state.stepIndex + 1,
        direction: "next",
      });
    }
    dispatch({ type: "NEXT" });
  }, [state, posthog]);

  const back = useCallback(() => {
    if (state.phase !== "active" || !state.tour) return;
    if (state.stepIndex === 0) return;
    const prevStep = state.tour.steps[state.stepIndex - 1];
    posthog?.capture("walkthrough_step_advanced", {
      version: state.tour.version,
      stepId: prevStep?.id,
      stepIndex: state.stepIndex - 1,
      direction: "back",
    });
    dispatch({ type: "BACK" });
  }, [state, posthog]);

  const skip = useCallback(() => {
    if (state.phase !== "active" || !state.tour) return;
    const step = state.tour.steps[state.stepIndex];
    posthog?.capture("walkthrough_skipped", {
      version: state.tour.version,
      stepId: step?.id,
      stepIndex: state.stepIndex,
    });
    dispatch({ type: "SKIP" });
  }, [state, posthog]);

  const pauseForNow = useCallback(() => {
    if (state.phase !== "active" || !state.tour) return;
    const version = state.tour.version;
    const step = state.tour.steps[state.stepIndex];
    const until = new Date(Date.now() + SNOOZE_DURATION_MS);
    const untilIso = until.toISOString();
    // Optimistic local update + analytics.
    snoozedUntilRef.current[version] = untilIso;
    posthog?.capture("walkthrough_paused", {
      version,
      stepId: step?.id,
      stepIndex: state.stepIndex,
      durationMs: SNOOZE_DURATION_MS,
    });
    void snoozeWalkthroughAction(version, untilIso);
    dispatch({ type: "COMPLETE_PERSIST_DONE" });
    trackedStartRef.current = null;
  }, [state, posthog]);

  const restart = useCallback(() => {
    (async () => {
      await resetWalkthroughAction(CURRENT_WALKTHROUGH_VERSION);
      window.dispatchEvent(
        new CustomEvent(RESTART_EVENT, {
          detail: CURRENT_WALKTHROUGH_VERSION,
        })
      );
    })();
  }, []);

  const value = useMemo<WalkthroughContextValue>(
    () => ({
      phase: state.phase,
      stepIndex: state.stepIndex,
      tour: state.tour,
      currentStep,
      next,
      back,
      skip,
      pauseForNow,
      restart,
    }),
    [state, currentStep, next, back, skip, pauseForNow, restart]
  );

  return (
    <WalkthroughContext.Provider value={value}>
      {children}
      {state.phase === "active" && currentStep && (
        <>
          <WalkthroughSpotlight target={currentStep.target} />
          <WalkthroughPopover
            step={currentStep}
            stepIndex={state.stepIndex}
            totalSteps={state.tour?.steps.length ?? 0}
            onNext={next}
            onBack={back}
            onSkip={skip}
            onPauseForNow={pauseForNow}
          />
        </>
      )}
    </WalkthroughContext.Provider>
  );
}
