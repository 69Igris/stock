"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import { RoastDetailSkeleton } from "@/components/skeletons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@usemoney/ui/alert-dialog";
import {
  Flame,
  Loader2,
  ArrowLeft,
  Trash2,
  Sparkles,
  Plus,
  AlertTriangle,
} from "lucide-react";
import {
  getRoastByIdAction,
  getRoastBySessionIdAction,
  deleteRoastAction,
} from "@/lib/actions/roast-history";
import { getRoastStatusAction } from "@/lib/actions/roast";
import { getChatHistoryByPageAction } from "@/lib/actions/chat-history";
import { ChatProvider, useChatContext } from "@/lib/chat/ChatContext";
import ChatMessageList from "@/components/chat/ChatMessageList";
import ResultFeedback from "@/components/chat/ResultFeedback";
import ChatPromptArea from "@/components/chat/ChatPromptArea";
import RoastResults from "@/components/roast/RoastResults";
import { buildRoastContext } from "@/components/roast/utils";
import { formatRoastPeriod } from "@/components/roast/roast-detail-logic";
import { DemoBanner } from "@/components/DemoBanner";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";
import type { StructuredRoastResult } from "@usemoney/types";

function sanitizeErrorMessage(raw: string | null | undefined): string {
  if (!raw) return "Something went wrong during the roast. Please try again.";
  // Don't leak raw API errors, stack traces, or JSON payloads to the user
  if (
    raw.includes("VertexAI") ||
    raw.includes("status:") ||
    raw.includes("ECONNREFUSED") ||
    raw.includes("got status:") ||
    raw.length > 200
  ) {
    return "The AI service encountered an error. Please try again in a few moments.";
  }
  return raw;
}

// ---------- Chat Panel ----------

function RoastChatPanel() {
  const { messages, clearChat } = useChatContext();

  return (
    <div className="pf-card flat flex flex-col h-[500px] mt-6 p-0 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b-[1.5px] border-dashed border-[var(--rule-soft)] shrink-0">
        <div className="flex items-center gap-2.5">
          <div
            className="h-8 w-8 rounded-[9px] grid place-items-center border-[1.5px] border-[var(--ink)]"
            style={{
              background: "var(--emerald)",
              color: "var(--paper)",
              transform: "rotate(-3deg)",
            }}
          >
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-[var(--ink)]">
              StockSage - Roast Analysis
            </h3>
            <p className="text-xs text-[var(--ink-3)]">
              Ask anything about this roast
            </p>
          </div>
        </div>
        {messages.length > 0 && (
          <button
            type="button"
            className="h-7 w-7 rounded-md grid place-items-center text-[var(--ink-3)] transition-colors hover:text-[var(--ink)] hover:bg-[var(--rule-softer)]"
            onClick={clearChat}
            title="New chat"
          >
            <Plus className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <ChatMessageList />
      </div>

      <div className="border-t-[1.5px] border-dashed border-[var(--rule-soft)] p-3 shrink-0">
        <ChatPromptArea />
      </div>
    </div>
  );
}

// ---------- Progress UI ----------

function RoastProgressView({
  progress,
  currentStep,
}: {
  progress: number;
  currentStep: string | null;
}) {
  return (
    <div className="px-6 py-[120px] text-center">
      {/* 64px pulsing coral flame tile per RoastDetail loading state */}
      <div
        className="w-16 h-16 rounded-2xl mx-auto mb-[18px] flex items-center justify-center border-2 border-[var(--ink)]"
        style={{
          background: "var(--pop-1)",
          boxShadow: "var(--shadow-soft)",
          animation: "rst-pulse 1.4s ease-in-out infinite",
        }}
      >
        <Flame className="h-[30px] w-[30px] text-white" />
      </div>
      <style>{`
        @keyframes rst-pulse {
          0%, 100% { transform: scale(1); }
          50%      { transform: scale(1.06); }
        }
        @keyframes rst-load {
          0%   { margin-left: -60%; }
          100% { margin-left: 100%; }
        }
      `}</style>
      <h2
        className="font-extrabold text-[20px] text-[var(--ink)] mb-2"
        style={{ letterSpacing: "-0.4px" }}
      >
        Roasting…
      </h2>
      <div className="font-mono text-xs text-[var(--ink-3)] tracking-[0.3px] mb-5">
        {currentStep || "analyzing portfolio · scanning angles"}
      </div>
      {/* Animated progress bar */}
      <div
        className="max-w-[320px] mx-auto h-1.5 rounded-full overflow-hidden mb-3 border-[1.5px] border-[var(--ink)]"
        style={{ background: "var(--rule-softer)" }}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: "60%",
            background: "var(--pop-1)",
            animation: "rst-load 2s ease infinite",
          }}
        />
      </div>
      {/* Real progress percentage when available */}
      {progress > 0 && (
        <div className="font-mono text-[11px] text-[var(--ink-3)] tabular-nums">
          {progress}% · usually 1-2 minutes
        </div>
      )}
    </div>
  );
}

// ---------- Main Detail Client ----------

export default function RoastDetailClient({ roastId }: { roastId: string }) {
  const router = useRouter();
  const { user, isLoaded } = useUser();

  const [roastResult, setRoastResult] = useState<StructuredRoastResult | null>(
    null
  );

  // Fire the walkthrough trigger once per page-load when results first render.
  // The provider listens for this event and may auto-fire the v1-roast tour
  // for users who haven't seen it yet.
  const roastTourFiredRef = useRef(false);
  useEffect(() => {
    if (!roastResult || roastTourFiredRef.current) return;
    roastTourFiredRef.current = true;
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("walkthrough:roast-result-shown"));
    }
  }, [roastResult]);
  const [roastMeta, setRoastMeta] = useState<{
    mode: string;
    broker: string | null;
    assetType: string;
    createdAt: Date;
  } | null>(null);
  const [isLoadingRoast, setIsLoadingRoast] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [existingChatId, setExistingChatId] = useState<string | undefined>(
    undefined
  );
  const [isDeleting, setIsDeleting] = useState(false);

  // Async progress state
  const [roastStatus, setRoastStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const [dbId, setDbId] = useState<string | null>(null);

  // Auth + user info for chat
  const isDemoMode = useIsDemoMode({ user });
  const isRealUser = isLoaded && !!user;
  const userName = user?.fullName || user?.firstName || "Trader";

  // Determine if roastId is a UUID (sessionId) or MongoDB ObjectId
  const isSessionId = roastId.includes("-"); // UUIDs have hyphens, ObjectIds don't

  // Load roast data
  useEffect(() => {
    async function load() {
      setIsLoadingRoast(true);

      if (isSessionId) {
        // Async flow: load by sessionId
        const roastRes = await getRoastBySessionIdAction(roastId);

        if (roastRes.success && roastRes.data) {
          setDbId(roastRes.data.id);
          setRoastMeta({
            mode: roastRes.data.mode,
            broker: roastRes.data.broker,
            assetType: roastRes.data.assetType,
            createdAt: roastRes.data.createdAt,
          });

          if (roastRes.data.status === "COMPLETED" && roastRes.data.result) {
            setRoastResult(roastRes.data.result);
            setRoastStatus("COMPLETED");

            // Load chat history
            const chatRes = await getChatHistoryByPageAction(
              `/roast/${roastId}`
            );
            if (chatRes.success && chatRes.data) {
              setExistingChatId(chatRes.data.id);
            }
          } else if (roastRes.data.status === "FAILED") {
            setRoastStatus("FAILED");
            setError(sanitizeErrorMessage(roastRes.data.errorMessage));
          } else {
            // In progress - start polling
            setRoastStatus(roastRes.data.status);
            setProgress(roastRes.data.progress);
            setCurrentStep(roastRes.data.currentStep);
          }
        } else {
          setError(roastRes.error || "Roast not found");
        }
      } else {
        // Legacy flow: load by MongoDB ObjectId
        const [roastRes, chatRes] = await Promise.all([
          getRoastByIdAction(roastId),
          getChatHistoryByPageAction(`/roast/${roastId}`),
        ]);

        if (roastRes.success && roastRes.data) {
          setDbId(roastRes.data.id);
          setRoastResult(roastRes.data.result);
          setRoastStatus("COMPLETED");
          setRoastMeta({
            mode: roastRes.data.mode,
            broker: roastRes.data.broker,
            assetType: roastRes.data.assetType,
            createdAt: roastRes.data.createdAt,
          });
        } else {
          setError(roastRes.error || "Roast not found");
        }

        if (chatRes.success && chatRes.data) {
          setExistingChatId(chatRes.data.id);
        }
      }

      setIsLoadingRoast(false);
    }

    load();
  }, [roastId, isSessionId]);

  // Poll for progress when in-progress
  useEffect(() => {
    if (
      !isSessionId ||
      roastStatus === "COMPLETED" ||
      roastStatus === "FAILED" ||
      !roastStatus
    ) {
      return;
    }

    async function poll() {
      const res = await getRoastStatusAction(roastId);
      if (res?.success && res?.data) {
        setRoastStatus(res?.data.status);
        setProgress(res?.data.progress);
        setCurrentStep(res?.data.currentStep);

        if (res?.data.status === "COMPLETED") {
          // Fetch full result
          const fullRes = await getRoastBySessionIdAction(roastId);
          if (fullRes.success && fullRes.data?.result) {
            setRoastResult(fullRes.data.result);
          }
          if (pollRef.current) clearInterval(pollRef.current);
        } else if (res?.data.status === "FAILED") {
          setError(sanitizeErrorMessage(res?.data.errorMessage));
          if (pollRef.current) clearInterval(pollRef.current);
        }
      }
    }

    pollRef.current = setInterval(poll, 4000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isSessionId, roastStatus, roastId]);

  const chatUserContext = useMemo(() => {
    if (!roastResult) return undefined;
    return buildRoastContext(roastResult);
  }, [roastResult]);

  const handleDelete = useCallback(async () => {
    const idToDelete = dbId || roastId;
    setIsDeleting(true);
    const res = await deleteRoastAction(idToDelete);
    if (res?.success) {
      router.push("/roast");
    } else {
      setError(res?.error || "Failed to delete");
      setIsDeleting(false);
    }
  }, [dbId, roastId, router]);

  const isInProgress =
    roastStatus && roastStatus !== "COMPLETED" && roastStatus !== "FAILED";

  return (
    <PageGuard
      route="/roast"
      fallback={<RoastDetailSkeleton />}
      containerClassName="p-6 pb-24 max-w-5xl mx-auto"
      title=""
    >
      <div className="pf-app min-h-screen">
        <Sidebar />

        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="p-6 pb-24 max-w-5xl mx-auto">
            {isDemoMode && <DemoBanner />}

            {/* Back + meta strip - full hero lives inside RoastResults */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3 min-w-0">
                <button
                  type="button"
                  className="h-8 w-8 rounded-md grid place-items-center text-[var(--ink-3)] transition-colors hover:text-[var(--ink)] hover:bg-[var(--rule-softer)]"
                  onClick={() => router.push("/roast")}
                  aria-label="Back to roast"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                {roastMeta && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className="pf-pill outline capitalize uppercase"
                      style={{ fontSize: 9.5, padding: "2px 7px" }}
                    >
                      {roastMeta.mode}
                    </span>
                    {roastMeta.broker && (
                      <span
                        className="pf-pill outline uppercase"
                        style={{ fontSize: 9.5, padding: "2px 7px" }}
                      >
                        {roastMeta.broker}
                      </span>
                    )}
                    <span
                      className="pf-pill outline capitalize uppercase"
                      style={{ fontSize: 9.5, padding: "2px 7px" }}
                    >
                      {roastMeta.assetType}
                    </span>
                    <span className="text-[11px] text-[var(--ink-3)] font-mono">
                      {new Date(roastMeta.createdAt).toLocaleDateString(
                        "en-IN",
                        {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        }
                      )}
                    </span>
                  </div>
                )}
              </div>

              {/* Delete button (only for completed/failed) */}
              {!isInProgress && dbId && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <button
                      type="button"
                      className="pf-bf danger sm"
                      disabled={isDeleting}
                      style={{
                        opacity: isDeleting ? 0.6 : 1,
                        cursor: isDeleting ? "not-allowed" : "pointer",
                      }}
                    >
                      {isDeleting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                      Delete
                    </button>
                  </AlertDialogTrigger>
                  <AlertDialogContent
                    style={{
                      background: "var(--paper)",
                      border: "2px solid var(--ink)",
                      borderRadius: 16,
                      boxShadow: "var(--shadow-hard)",
                      color: "var(--ink)",
                    }}
                  >
                    <AlertDialogHeader>
                      <AlertDialogTitle
                        style={{
                          fontSize: 18,
                          fontWeight: 800,
                          letterSpacing: "-0.4px",
                          color: "#b91c1c",
                        }}
                      >
                        Delete Roast
                      </AlertDialogTitle>
                      <AlertDialogDescription
                        className="ser"
                        style={{
                          fontSize: 16,
                          color: "var(--ink-2)",
                          lineHeight: 1.4,
                        }}
                      >
                        This will permanently delete this roast and its chat
                        history. This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="pf-bf sm mt-0">
                        Cancel
                      </AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleDelete}
                        className="pf-bf sm danger"
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>

            {/* Loading */}
            {isLoadingRoast && (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-3)]" />
              </div>
            )}

            {/* In-Progress */}
            {!isLoadingRoast && isInProgress && (
              <div className="max-w-4xl">
                <RoastProgressView
                  progress={progress}
                  currentStep={currentStep}
                />
              </div>
            )}

            {/* Failed - playful error state */}
            {!isLoadingRoast && roastStatus === "FAILED" && (
              <div className="max-w-md mx-auto py-[100px] text-center">
                <div
                  className="w-14 h-14 rounded-[14px] mx-auto mb-4 flex items-center justify-center border-[1.5px]"
                  style={{
                    background:
                      "color-mix(in srgb, var(--pop-1) 12%, transparent)",
                    borderColor:
                      "color-mix(in srgb, var(--pop-1) 35%, transparent)",
                  }}
                >
                  <AlertTriangle
                    className="h-[26px] w-[26px]"
                    style={{ color: "var(--pop-1)" }}
                  />
                </div>
                <h2
                  className="font-extrabold text-[18px] text-[var(--ink)] mb-2"
                  style={{ letterSpacing: "-0.3px" }}
                >
                  Couldn&apos;t roast right now
                </h2>
                <p className="text-[13.5px] text-[var(--ink-3)] mb-5 leading-[1.5]">
                  {error ||
                    "Your broker token may have expired or no portfolio data is available. Reconnect to refresh holdings, then try again."}
                </p>
                <div className="flex gap-2 justify-center">
                  <button
                    type="button"
                    onClick={() => router.push("/roast")}
                    className="pf-bf"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => router.push("/brokers")}
                    className="pf-bs"
                    style={{ background: "var(--pop-1)", color: "#fff" }}
                  >
                    Reconnect broker
                  </button>
                </div>
              </div>
            )}

            {/* Error (not found, etc) - generic error variant */}
            {error && !isLoadingRoast && roastStatus !== "FAILED" && (
              <div className="max-w-md mx-auto py-[100px] text-center">
                <div
                  className="w-14 h-14 rounded-[14px] mx-auto mb-4 flex items-center justify-center border-[1.5px]"
                  style={{
                    background:
                      "color-mix(in srgb, var(--pop-2) 12%, transparent)",
                    borderColor:
                      "color-mix(in srgb, var(--pop-2) 35%, transparent)",
                  }}
                >
                  <AlertTriangle
                    className="h-[26px] w-[26px]"
                    style={{ color: "var(--pop-2)" }}
                  />
                </div>
                <h2
                  className="font-extrabold text-[18px] text-[var(--ink)] mb-2"
                  style={{ letterSpacing: "-0.3px" }}
                >
                  Roast not found
                </h2>
                <p className="text-[13.5px] text-[var(--ink-3)] mb-5 leading-[1.5]">
                  {error}
                </p>
                <button
                  type="button"
                  onClick={() => router.push("/roast")}
                  className="pf-bf"
                >
                  Back to Roast
                </button>
              </div>
            )}

            {/* Completed Results + Chat */}
            {roastResult && !isLoadingRoast && roastStatus === "COMPLETED" && (
              <div className="max-w-4xl">
                <RoastResults
                  result={roastResult}
                  periodLabel={
                    roastMeta
                      ? formatRoastPeriod(roastMeta.createdAt)
                      : undefined
                  }
                  onRoastAgain={() => router.push("/roast")}
                />

                {/* MONEY-587: rate this roast (feeds MONEY-592). */}
                <ResultFeedback
                  surface="ROAST"
                  refId={roastId}
                  className="mt-4"
                />

                <ChatProvider
                  userName={userName}
                  isRealUser={isRealUser}
                  isDemoMode={isDemoMode}
                  pagePath={`/roast/${roastId}`}
                  initialChatId={existingChatId}
                  defaultContext="all"
                  hideContextSelector
                  userContext={chatUserContext}
                >
                  <RoastChatPanel />
                </ChatProvider>
              </div>
            )}
          </div>
        </main>
      </div>
    </PageGuard>
  );
}
