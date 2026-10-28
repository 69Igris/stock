"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { buildDcfContextLine } from "../dcf-display";
import Sidebar from "@/components/Sidebar";
import { Skeleton } from "@usemoney/ui/skeleton";
import { toast } from "sonner";
import {
  ArrowLeft,
  Loader2,
  Sparkles,
  Plus,
  Trash2,
  RotateCcw,
  AlertTriangle,
} from "lucide-react";
import Link from "next/link";
import { PageGuard } from "@/components/PageGuard";
import { AnalysisSkeleton } from "@/components/skeletons";
import { DemoBanner } from "@/components/DemoBanner";
import { ResearchRunBlock } from "@/components/stocksage/ResearchRunBlock";
import type { TaskProgressItem } from "@usemoney/types";
import ResearchReport from "@/components/analysis/ResearchReport";
import type { DataSourceItem } from "@/components/analysis/ResearchReport";
import ResultFeedback from "@/components/chat/ResultFeedback";
import AnalysisSegmentsRenderer, {
  type SegmentResult,
} from "@/components/analysis/AnalysisSegmentsRenderer";
import ResearchModal, {
  type ResearchEntity,
} from "@/components/analysis/ResearchModal";
import type { StructuredReport } from "@/components/analysis/types";
import {
  getResearchResultAction,
  getResearchStatusAction,
  deleteResearchAction,
} from "@/lib/actions/research";
import { useIsDemoMode, useIsDemoModeReady } from "@/lib/hooks/useIsDemoMode";
import { stripRecommendationLanguage } from "@usemoney/utils/sanitize-recommendation";
import {
  getAnalysisStatusAction,
  getAnalysisResultAction,
} from "@/lib/actions/analysis";
import { isAnalysisSessionId } from "@/lib/analysis/session-routing";
import { getChatHistoryByPageAction } from "@/lib/actions/chat-history";
import { ChatProvider, useChatContext } from "@/lib/chat/ChatContext";
import ChatMessageList from "@/components/chat/ChatMessageList";
import ChatPromptArea from "@/components/chat/ChatPromptArea";
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

interface Props {
  sessionId: string;
}

/** Sanitize error messages for display - hide technical/internal details */
function sanitizeErrorMessage(raw: string): string {
  if (!raw) return "Something went wrong. Please try again.";
  // Known safe messages: pass through
  if (raw.includes("not listed on Indian exchanges")) return raw;
  if (raw.includes("Please try again")) return raw;
  if (raw.includes("only supports Indian")) return raw;
  // Technical patterns → generic message
  if (/prisma|mongodb|database|connection|timeout|ECONNREFUSED/i.test(raw))
    return "A temporary service error occurred. Please try again.";
  if (/api.*key|unauthorized|forbidden|401|403/i.test(raw))
    return "A service configuration error occurred. Please contact support.";
  if (/rate.?limit|429|too many requests/i.test(raw))
    return "Service is temporarily busy. Please try again in a few minutes.";
  if (/gemini|vertex|google.*ai|model/i.test(raw))
    return "AI analysis service is temporarily unavailable. Please try again.";
  if (/ENOMEM|heap|stack|internal server/i.test(raw))
    return "A temporary error occurred. Please try again.";
  // If message is short and doesn't look technical, pass through
  if (raw.length < 200 && !/error|exception|stack|trace/i.test(raw)) return raw;
  return "Something went wrong during the analysis. Please try again.";
}

/** Map research tool names to human-readable labels */
const TOOL_LABELS: Record<string, string> = {
  fetch_stock_price: "Stock Price",
  fetch_company_profile: "Company Profile",
  fetch_key_ratios: "Key Ratios",
  fetch_financial_statements: "Financial Statements",
  fetch_income_statement: "Income Statement",
  fetch_cash_flow: "Cash Flow Statement",
  fetch_balance_sheet: "Balance Sheet",
  fetch_peer_companies: "Peer Companies",
  fetch_corporate_actions: "Corporate Actions",
  fetch_shareholding_pattern: "Shareholding Pattern",
  fetch_news: "Latest News",
  fetch_analyst_recommendations: "Analyst Recommendations",
  fetch_earnings_data: "Earnings Data",
  fetch_dividend_data: "Dividend History",
  compute_dcf: "DCF Valuation",
  compute_health_score: "Financial Health Score",
  compute_scenario_analysis: "Scenario Analysis",
  compute_growth_metrics: "Growth Metrics",
  compute_valuation: "Valuation Analysis",
  compute_technical_analysis: "Technical Analysis",
  compute_comparative_valuation: "Comparative Valuation",
  synthesize_report: "Report Synthesis",
  compare_stocks: "Stock Comparison",
  validate_report: "Quality Validation",
  screen_stocks: "Stock Screening",
};

/** Extract data sources from the research plan, deduplicated by tool name */
function extractDataSources(
  plan: unknown,
  sessionCompleted: boolean
): DataSourceItem[] {
  if (!plan || typeof plan !== "object") return [];
  const p = plan as Record<string, unknown>;
  // Standard research sessions expose `tasks` (one entry per tool call).
  // L3/L4 comprehensive sessions expose `segments` (one entry per analytical
  // segment, each containing nested tool runs). Fall through to segments when
  // tasks is absent so the chat streaming block and the analysis page agree
  // on which sources ran - without this, L3 sessions look "0 of N completed"
  // in the chat block while the page shows them all green.
  let tasks = p.tasks;
  if (!Array.isArray(tasks)) {
    const segments = p.segments;
    if (Array.isArray(segments)) {
      tasks = segments.flatMap((seg) => {
        if (!seg || typeof seg !== "object") return [];
        const s = seg as Record<string, unknown>;
        const segTasks = s.tasks;
        if (Array.isArray(segTasks)) return segTasks;
        // Segment without nested tasks - surface the segment itself as a
        // single tool entry keyed by its name/id.
        const tool = String(s.name || s.id || "");
        if (!tool) return [];
        return [{ tool, type: s.type || "compute", status: s.status }];
      });
    }
  }
  if (!Array.isArray(tasks)) return [];

  // Group by tool name → count occurrences and pick best status
  const grouped = new Map<
    string,
    { type: string; count: number; hasCompleted: boolean; hasFailed: boolean }
  >();

  for (const t of tasks) {
    if (!t || typeof t !== "object") continue;
    const task = t as Record<string, unknown>;
    const tool = String(task.tool || "");
    if (!tool) continue;

    const existing = grouped.get(tool);
    const status = String(task.status || "pending");
    if (existing) {
      existing.count++;
      if (status === "completed") existing.hasCompleted = true;
      if (status === "failed") existing.hasFailed = true;
    } else {
      grouped.set(tool, {
        type: String(task.type || "data_fetch"),
        count: 1,
        hasCompleted: status === "completed",
        hasFailed: status === "failed",
      });
    }
  }

  return Array.from(grouped.entries()).map(([tool, info]) => {
    // If session completed successfully, mark all as completed
    // (the plan doesn't persist task status updates)
    let status: DataSourceItem["status"] = "pending";
    if (sessionCompleted) {
      status = info.hasFailed ? "failed" : "completed";
    } else if (info.hasCompleted) {
      status = "completed";
    } else if (info.hasFailed) {
      status = "failed";
    }

    return {
      tool,
      label:
        TOOL_LABELS[tool] ||
        tool
          .replace(/_/g, " ")
          .replace(/\b\w/g, (c: string) => c.toUpperCase()),
      type: info.type as DataSourceItem["type"],
      status,
      count: info.count,
    };
  });
}

/**
 * Build a rich userContext string from the research report.
 * This gets injected into the system prompt so StockSage knows everything
 * about this stock and stays focused on it.
 */
function buildReportContext(symbol: string, report: StructuredReport): string {
  const parts: string[] = [];

  parts.push(
    `You are discussing THIS SPECIFIC research report on ${symbol} (the data below IS the report the user is viewing). Ground EVERY answer in the specific scores, metrics, strengths, risks, and findings listed below — cite the actual numbers, never speak generically. ONLY answer questions about ${symbol} or closely related topics (sector peers, market context); politely redirect if the user asks about unrelated stocks. Do NOT re-fetch or re-derive anything already given below; if the user wants depth beyond this report, offer to run a deeper analysis.`
  );
  parts.push("");

  // Score & analysis.
  // MONEY-457: `recommendation` (BUY / SELL / HOLD / STRONG_BUY token)
  // is intentionally NOT included in the chat context — feeding it to
  // the AI primes follow-up answers with the same verdict framing.
  // Likewise the named PRICE TARGETS block (Target Low/Mid/High) is
  // dropped: a labelled "target" with delta to current price is a
  // research recommendation per SEBI RA Regulations 2014 and UseMoney
  // is not a registered RA/IA. Current price stays because it's
  // observable market data, not a target.
  parts.push(`ANALYSIS SUMMARY FOR ${symbol}:`);
  if (typeof report.score === "number")
    parts.push(`- Score: ${report.score}/100`);
  if (typeof report.confidence === "number")
    parts.push(`- Confidence: ${report.confidence}%`);
  if (report.summary)
    parts.push(`- Summary: ${stripRecommendationLanguage(report.summary)}`);

  if (report.priceTarget?.current) {
    parts.push("");
    parts.push("PRICE CONTEXT:");
    parts.push(
      `- Current Price: ₹${report.priceTarget.current.toLocaleString("en-IN")}`
    );
  }

  // Key metrics
  if (report.keyMetrics && report.keyMetrics.length > 0) {
    parts.push("");
    parts.push("KEY METRICS:");
    for (const m of report.keyMetrics) {
      parts.push(
        `- ${m.label}: ${m.value}${m.verdict ? ` (${m.verdict})` : ""}`
      );
    }
  }

  // Strengths
  if (report.strengths && report.strengths.length > 0) {
    parts.push("");
    parts.push("STRENGTHS:");
    for (const s of report.strengths) {
      parts.push(`- ${s}`);
    }
  }

  // Risks
  if (report.risks && report.risks.length > 0) {
    parts.push("");
    parts.push("RISKS:");
    for (const r of report.risks) {
      parts.push(`- ${r}`);
    }
  }

  // Catalysts
  if (report.catalysts && report.catalysts.length > 0) {
    parts.push("");
    parts.push("CATALYSTS:");
    for (const c of report.catalysts) {
      parts.push(`- ${c.event} (${c.timeline}, impact: ${c.impact})`);
    }
  }

  // Technicals
  if (report.technicals) {
    parts.push("");
    parts.push("TECHNICALS:");
    parts.push(`- Trend: ${report.technicals.trend}`);
    if (report.technicals.support)
      parts.push(
        `- Support: ₹${report.technicals.support.toLocaleString("en-IN")}`
      );
    if (report.technicals.resistance)
      parts.push(
        `- Resistance: ₹${report.technicals.resistance.toLocaleString("en-IN")}`
      );
    if (report.technicals.rsi) parts.push(`- RSI: ${report.technicals.rsi}`);
  }

  // Sections (advanced mode) - include content summaries
  if (report.sections && report.sections.length > 0) {
    parts.push("");
    parts.push("DETAILED SECTIONS:");
    for (const section of report.sections) {
      parts.push(`\n### ${section.title}`);
      if (section.content) {
        // Truncate very long sections to keep within reasonable token budget.
        // MONEY-457: scrub recommendation language so the chat AI is not
        // primed with BUY/SELL/HOLD verdicts pulled from historical reports.
        const rawContent = stripRecommendationLanguage(section.content);
        const content =
          rawContent.length > 500
            ? rawContent.slice(0, 500) + "..."
            : rawContent;
        parts.push(content);
      }
      if (section.metrics && section.metrics.length > 0) {
        for (const m of section.metrics) {
          parts.push(
            `- ${m.label}: ${m.value}${m.trend ? ` (${m.trend})` : ""}${m.verdict ? ` [${m.verdict}]` : ""}`
          );
        }
      }
      if (section.dcf) {
        // Synthesizer can emit null scalars; buildDcfContextLine guards each
        // (../dcf-display.ts, unit-tested) and returns null when none render.
        const dcfLine = buildDcfContextLine(section.dcf);
        if (dcfLine) parts.push(dcfLine);
      }
    }
  }

  return parts.join("\n");
}

/**
 * Build a rich userContext string from a comparison report.
 * Extracts per-stock scores, metrics, strengths, risks, and the verdict
 * so StockSage can reference real data when discussing the comparison.
 */
function buildComparisonReportContext(
  displaySymbol: string,
  report: StructuredReport
): string {
  const parts: string[] = [];

  parts.push(
    `You are discussing a detailed comparison of ${displaySymbol}. Use the data below to answer questions with specific numbers and analysis. ONLY discuss these stocks or closely related topics (sector peers, market context). Politely redirect if the user asks about unrelated stocks.`
  );
  parts.push("");

  // Comparison overview.
  // MONEY-457: cm.winner ("STOCK_A_PREFERRED" / a symbol) and cm.verdict
  // (prose like "Reliance is preferred over Tata Motors") are research
  // recommendations under SEBI RA Regulations 2014, equivalent to a
  // stock-level BUY/SELL call. We drop the winner label entirely and
  // scrub the verdict prose before injecting it into the chat context;
  // the per-stock SCORES below stand on their own as factual data.
  if (report.comparisonMeta) {
    const cm = report.comparisonMeta;
    parts.push("COMPARISON OVERVIEW:");
    if (cm.verdict)
      parts.push(`- Notes: ${stripRecommendationLanguage(cm.verdict)}`);
    if (cm.sameSector !== undefined)
      parts.push(`- Same Sector: ${cm.sameSector ? "Yes" : "No"}`);
    if (cm.stockScores && cm.stockScores.length > 0) {
      parts.push("- Individual Scores:");
      for (const ss of cm.stockScores) {
        parts.push(`  • ${ss.symbol}: ${ss.score}/100`);
      }
    }
    parts.push("");
  }

  // Score & analysis (overall).
  // MONEY-457: see comment in buildReportContext — recommendation token
  // is dropped from the chat context so follow-up Q&A is not primed with
  // a BUY/SELL/HOLD verdict.
  if (typeof report.score === "number" || report.summary) {
    parts.push("OVERALL ANALYSIS:");
    if (typeof report.score === "number")
      parts.push(`- Score: ${report.score}/100`);
    if (typeof report.confidence === "number")
      parts.push(`- Confidence: ${report.confidence}%`);
    if (report.summary)
      parts.push(`- Summary: ${stripRecommendationLanguage(report.summary)}`);
    parts.push("");
  }

  // Score breakdown
  if (report.scoreBreakdown && report.scoreBreakdown.length > 0) {
    parts.push("SCORE BREAKDOWN:");
    for (const sb of report.scoreBreakdown) {
      parts.push(
        `- ${sb.criterion}: ${sb.score}/${sb.maxScore}${sb.comment ? ` - ${sb.comment}` : ""}`
      );
    }
    parts.push("");
  }

  // Key metrics
  if (report.keyMetrics && report.keyMetrics.length > 0) {
    parts.push("KEY METRICS:");
    for (const m of report.keyMetrics) {
      parts.push(
        `- ${m.label}: ${m.value}${m.verdict ? ` (${m.verdict})` : ""}`
      );
    }
    parts.push("");
  }

  // Strengths
  if (report.strengths && report.strengths.length > 0) {
    parts.push("STRENGTHS:");
    for (const s of report.strengths) {
      parts.push(`- ${s}`);
    }
    parts.push("");
  }

  // Risks
  if (report.risks && report.risks.length > 0) {
    parts.push("RISKS:");
    for (const r of report.risks) {
      parts.push(`- ${r}`);
    }
    parts.push("");
  }

  // Catalysts
  if (report.catalysts && report.catalysts.length > 0) {
    parts.push("CATALYSTS:");
    for (const c of report.catalysts) {
      parts.push(`- ${c.event} (${c.timeline}, impact: ${c.impact})`);
    }
    parts.push("");
  }

  // Technicals
  if (report.technicals) {
    parts.push("TECHNICALS:");
    parts.push(`- Trend: ${report.technicals.trend}`);
    if (report.technicals.support)
      parts.push(
        `- Support: ₹${report.technicals.support.toLocaleString("en-IN")}`
      );
    if (report.technicals.resistance)
      parts.push(
        `- Resistance: ₹${report.technicals.resistance.toLocaleString("en-IN")}`
      );
    if (report.technicals.rsi) parts.push(`- RSI: ${report.technicals.rsi}`);
    parts.push("");
  }

  // Detailed sections - include full content for comparison reports (they have per-stock breakdowns)
  if (report.sections && report.sections.length > 0) {
    parts.push("DETAILED SECTIONS:");
    for (const section of report.sections) {
      parts.push(`\n### ${section.title}`);
      if (section.content) {
        // Allow more content for comparisons since they contain per-stock data
        // MONEY-457: scrub recommendation language before injecting prose
        // into the chat context.
        const rawContent = stripRecommendationLanguage(section.content);
        const content =
          rawContent.length > 1000
            ? rawContent.slice(0, 1000) + "..."
            : rawContent;
        parts.push(content);
      }
      if (section.metrics && section.metrics.length > 0) {
        for (const m of section.metrics) {
          parts.push(
            `- ${m.label}: ${m.value}${m.trend ? ` (${m.trend})` : ""}${m.verdict ? ` [${m.verdict}]` : ""}`
          );
        }
      }
      if (section.dcf) {
        // Synthesizer can emit null scalars; buildDcfContextLine guards each
        // (../dcf-display.ts, unit-tested) and returns null when none render.
        const dcfLine = buildDcfContextLine(section.dcf);
        if (dcfLine) parts.push(dcfLine);
      }
      // Include tabular data (comparison tables)
      if (section.columns && section.rows && section.rows.length > 0) {
        parts.push(`  Columns: ${section.columns.join(" | ")}`);
        for (const row of section.rows.slice(0, 15)) {
          parts.push(`  ${row.join(" | ")}`);
        }
      }
    }
    parts.push("");
  }

  // Price context (current price only).
  // MONEY-457: target low/mid/high removed — see comment in
  // buildReportContext. Current price stays because it's observable
  // market data, not a target.
  if (report.priceTarget?.current) {
    parts.push("PRICE CONTEXT:");
    parts.push(
      `- Current Price: ₹${report.priceTarget.current.toLocaleString("en-IN")}`
    );
    parts.push("");
  }

  return parts.join("\n");
}

export default function AnalysisDetailClient({ sessionId }: Props) {
  const { user, isLoaded } = useUser();
  const router = useRouter();

  const isDemoMode = useIsDemoMode({ user });
  const demoModeReady = useIsDemoModeReady();
  const isRealUser = isLoaded && !!user;
  const userName = user?.fullName || user?.firstName || "Trader";

  const [report, setReport] = useState<StructuredReport | null>(null);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [dataSources, setDataSources] = useState<DataSourceItem[]>([]);
  const [researchMeta, setResearchMeta] = useState<{
    totalSteps?: number;
    skill?: string;
  }>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isResearchRunning, setIsResearchRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [taskProgress, setTaskProgress] = useState<TaskProgressItem[]>([]);
  const [currentStep, setCurrentStep] = useState("");
  const [researchStatus, setResearchStatus] = useState("");
  const [existingChatId, setExistingChatId] = useState<string | undefined>();
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRetrying] = useState(false);
  // L3/L4 comprehensive analysis renders its { segments } here (the flat
  // ResearchReport handles L1/L2). Kept separate so the page isn't empty for
  // chat-triggered comprehensive analyses.
  const [segments, setSegments] = useState<SegmentResult[] | null>(null);
  // Rerun opens the mode-select modal (pre-seeded) instead of auto-running.
  const [rerunModalOpen, setRerunModalOpen] = useState(false);
  const [rerunEntity, setRerunEntity] = useState<ResearchEntity | null>(null);
  const [rerunCompare, setRerunCompare] = useState<ResearchEntity[]>([]);
  const [deepDiveQuery, setDeepDiveQuery] = useState<string | null>(null);
  const chatSectionRef = useRef<HTMLDivElement>(null);
  const [originalQuery, setOriginalQuery] = useState("");
  const [originalSymbols, setOriginalSymbols] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  // MONEY-457: one-shot guard for the COMPLETED / FAILED toast. Polls
  // run every 3s, but the status API can take longer than 3s — so
  // two polls can be in flight simultaneously and both come back with
  // COMPLETED status. clearInterval only stops *future* polls, not the
  // ones already awaiting. Without this ref, both in-flight polls fire
  // their own toast. We reset the ref whenever a new research run
  // starts (isResearchRunning flips true → false → true is the retry
  // path).
  const completionToastFiredRef = useRef(false);
  // Ref to the latest loadResult so the polling effect can call it without
  // listing it as a dep - prevents the effect from re-mounting (and spawning
  // duplicate intervals) when loadResult's identity changes between renders.
  const loadResultRef = useRef<(() => Promise<boolean>) | null>(null);

  // Load existing chat history for this session
  useEffect(() => {
    getChatHistoryByPageAction(`/analysis/${sessionId}`).then((res) => {
      if (res?.success && res?.data) {
        setExistingChatId(res?.data.id);
      }
    });
  }, [sessionId]);

  const handleDelete = async () => {
    setIsDeleting(true);
    const res = await deleteResearchAction(sessionId);
    if (res?.success) {
      toast.success("Research deleted");
      router.push("/analysis");
    } else {
      toast.error(res?.error || "Failed to delete research");
      setIsDeleting(false);
    }
  };

  // Rerun → open the mode-select modal pre-seeded with this session's
  // symbol(s), instead of silently re-running in quick mode. The user picks
  // the depth (auto / quick / deep / comprehensive) and the modal runs it.
  const handleRetry = () => {
    const retrySymbols = originalSymbols.length > 0 ? originalSymbols : symbols;
    const cleanSymbols = retrySymbols.map((s) => s.replace(/\.(NS|BO)$/, ""));
    if (cleanSymbols.length === 0) return;
    if (cleanSymbols.length > 1) {
      setRerunCompare(
        cleanSymbols.map((s) => ({
          symbol: s,
          name: s,
          type: "stock" as const,
        }))
      );
      setRerunEntity(null);
    } else {
      setRerunCompare([]);
      setRerunEntity({
        symbol: cleanSymbols[0]!,
        name: displaySymbol || cleanSymbols[0]!,
        type: entityType === "comparison" ? "stock" : entityType,
      });
    }
    setRerunModalOpen(true);
  };

  useEffect(() => {
    if (!isLoaded) return;
    if (!demoModeReady) return;
    if (!user && !isDemoMode) {
      router.push("/home");
    }
  }, [isLoaded, demoModeReady, user, router, isDemoMode]);

  const isAnalysisSession = isAnalysisSessionId(sessionId);

  // Load research result (or L3 / L4 analysis result)
  const loadResult = useCallback(async () => {
    try {
      const res = isAnalysisSession
        ? await getAnalysisResultAction(sessionId)
        : await getResearchResultAction(sessionId);
      if (res?.success && res?.data) {
        const rawReport = res?.data.report as Record<string, unknown>;
        // L3/L4 comprehensive analysis persists { segments: [...] } (no flat
        // score/summary/sections). Render those via AnalysisSegmentsRenderer
        // instead of forcing them through the StructuredReport gate below,
        // which would null them out and leave the page empty.
        if (
          isAnalysisSession &&
          Array.isArray(rawReport?.segments) &&
          rawReport.segments.length > 0
        ) {
          setSegments(rawReport.segments as unknown as SegmentResult[]);
          setReport(null);
          setSymbols(res?.data.symbols);
          setResearchStatus("COMPLETED");
          setIsResearchRunning(false);
          setIsLoading(false);
          return true;
        }
        let parsed: StructuredReport;
        if (rawReport?.content && typeof rawReport.content === "object") {
          // Report wrapped in { content: structuredObject }
          parsed = rawReport.content as StructuredReport;
        } else if (
          rawReport?.content &&
          typeof rawReport.content === "string"
        ) {
          // Report wrapped in { content: "json string" } - try to parse
          try {
            const inner = JSON.parse(rawReport.content as string);
            parsed =
              typeof inner === "object" && inner !== null
                ? (inner as StructuredReport)
                : (rawReport as StructuredReport);
          } catch {
            parsed = rawReport as StructuredReport;
          }
        } else {
          parsed = rawReport as StructuredReport;
        }
        // Validate minimum viable structure before rendering
        const hasMinimumStructure =
          parsed &&
          (typeof parsed.score === "number" ||
            typeof parsed.summary === "string" ||
            (Array.isArray(parsed.sections) && parsed.sections.length > 0));
        if (!hasMinimumStructure) {
          setReport(null);
          setErrorMessage(
            "This research session has incomplete results. Please run the analysis again."
          );
          setResearchStatus("FAILED");
          setIsLoading(false);
          // Stop polling - the session is terminal even if it claims COMPLETED.
          // Without this, polling loops forever on a session whose report is
          // structurally invalid, producing the 7-POSTs-in-3s pattern in QA.
          setIsResearchRunning(false);
          return true;
        }

        setReport(parsed);
        setSymbols(res?.data.symbols);
        const resData = res?.data as Record<string, unknown>;
        setResearchMeta({
          totalSteps: (resData.totalSteps as number) ?? undefined,
          skill: (resData.skill as string) ?? undefined,
        });
        if (resData.plan) {
          setDataSources(extractDataSources(resData.plan, true));
        }
        setIsResearchRunning(false);
        setIsLoading(false);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [sessionId, isAnalysisSession]);

  // Mirror the latest loadResult into a ref so effects can call it without
  // depending on its identity in their dep arrays.
  useEffect(() => {
    loadResultRef.current = loadResult;
  }, [loadResult]);

  // Initial load - check status first, then either show report or start polling
  useEffect(() => {
    const init = async () => {
      const loaded = await loadResult();
      if (loaded) return;

      const statusRes = isAnalysisSession
        ? await getAnalysisStatusAction(sessionId)
        : await getResearchStatusAction(sessionId);
      if (statusRes?.success && statusRes?.data) {
        const statusData = statusRes?.data as Record<string, unknown>;
        const status = statusData.status as string;
        const prog = (statusData.progress as number) ?? 0;
        const step =
          (statusData.currentStep as string) ||
          (statusData.currentSegment != null
            ? `Segment ${statusData.currentSegment}/${statusData.totalSegments}`
            : "");
        setResearchStatus(status);
        setProgress(prog);
        setCurrentStep(step);
        setTaskProgress((statusData.taskProgress as TaskProgressItem[]) ?? []);

        // Capture original query/symbols for retry
        if (statusData.query) setOriginalQuery(statusData.query as string);
        if (statusData.symbols) {
          setOriginalSymbols(statusData.symbols as string[]);
          if (!symbols.length) setSymbols(statusData.symbols as string[]);
        }

        if (status === "FAILED") {
          setIsLoading(false);
          setErrorMessage((statusData.errorMessage as string) || "");
          toast.error("Research failed");
          return;
        }

        if (status === "COMPLETED") {
          await loadResult();
          return;
        }

        setIsResearchRunning(true);
        setIsLoading(false);
      } else {
        setIsLoading(false);
        toast.error("Research session not found");
      }
    };

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- symbols.length is intentionally excluded; we only want to set symbols once on mount
  }, [sessionId, loadResult]);

  // Polling for in-progress research.
  // Deps are intentionally minimal: only `isResearchRunning` and `sessionId`.
  // The analysis-session prefix check is recomputed inline (cheap, pure
  // string check via `isAnalysisSessionId`) and `loadResult` is accessed
  // through `loadResultRef` so this effect doesn't re-mount on every
  // render - re-mounts were spawning duplicate intervals (7+ POSTs/3s
  // observed in QA).
  useEffect(() => {
    if (!isResearchRunning) return;

    // MONEY-457: reset the one-shot toast guard when a new poll cycle
    // starts. Covers the retry path where a user reruns research on the
    // same session and the second completion toast should fire.
    completionToastFiredRef.current = false;

    const localIsAnalysisSession = isAnalysisSessionId(sessionId);
    let cancelled = false;

    const intervalId = setInterval(async () => {
      if (cancelled) return;
      const statusRes = localIsAnalysisSession
        ? await getAnalysisStatusAction(sessionId)
        : await getResearchStatusAction(sessionId);
      if (cancelled || !statusRes?.success || !statusRes?.data) return;

      const statusData = statusRes?.data as Record<string, unknown>;
      const status = statusData.status as string;
      const prog = (statusData.progress as number) ?? 0;
      const step = (statusData.currentStep as string) || "";
      setResearchStatus(status);
      setProgress(prog);
      setCurrentStep(step);
      setTaskProgress((statusData.taskProgress as TaskProgressItem[]) ?? []);

      if (status === "COMPLETED") {
        clearInterval(intervalId);
        pollRef.current = null;
        await loadResultRef.current?.();
        // MONEY-457: ref + sonner `id` form a belt-and-suspenders against
        // the "two polls in flight, both see COMPLETED" race that was
        // stacking multiple "Research analysis is ready" toasts.
        if (!completionToastFiredRef.current) {
          completionToastFiredRef.current = true;
          toast.success("Research analysis is ready!", {
            id: `research-complete-${sessionId}`,
          });
        }
      } else if (status === "FAILED") {
        clearInterval(intervalId);
        pollRef.current = null;
        setIsResearchRunning(false);
        const pollData = statusData as Record<string, unknown>;
        if (pollData.query) setOriginalQuery(pollData.query as string);
        if (pollData.symbols) setOriginalSymbols(pollData.symbols as string[]);
        if (pollData.errorMessage)
          setErrorMessage(pollData.errorMessage as string);
        if (!completionToastFiredRef.current) {
          completionToastFiredRef.current = true;
          toast.error("Research failed", {
            id: `research-failed-${sessionId}`,
          });
        }
      }
    }, 1500); // 1.5s: match the chat poll so /analysis research streams smoothly

    pollRef.current = intervalId;

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      if (pollRef.current === intervalId) pollRef.current = null;
    };
  }, [isResearchRunning, sessionId]);

  const isComparison = symbols.length > 1;
  const displaySymbol = isComparison
    ? symbols.map((s) => s.replace(/\.(NS|BO)$/, "")).join(" vs ")
    : symbols[0]?.replace(/\.(NS|BO)$/, "") || "";
  const detailExchange = !isComparison
    ? symbols[0]?.endsWith(".BO")
      ? "BSE"
      : symbols[0]?.endsWith(".NS")
        ? "NSE"
        : null
    : null;

  // Entity type detection for header pill - mirrors the list-page logic so
  // /analysis and /analysis/[sessionId] agree on whether the session is a
  // stock, mutual fund, ETF, or comparison.
  const entityType: "stock" | "mf" | "etf" | "comparison" = isComparison
    ? "comparison"
    : (() => {
        const s = (symbols[0] || "").toUpperCase();
        const q = (originalQuery || "").toUpperCase();
        if (
          q.includes("[MUTUAL_FUND]") ||
          /MF\b/.test(s) ||
          q.includes("MUTUAL FUND")
        )
          return "mf";
        if (/ETF\b/.test(s) || q.includes("ETF") || /BEES\b/.test(s))
          return "etf";
        return "stock";
      })();

  // Build rich context from full report for the chat
  const chatUserContext = useMemo(() => {
    if (!report || !displaySymbol) return undefined;
    if (isComparison) {
      return buildComparisonReportContext(displaySymbol, report);
    }
    return buildReportContext(displaySymbol, report);
  }, [report, displaySymbol, isComparison]);

  return (
    <PageGuard
      route="/analysis"
      fallback={<AnalysisSkeleton />}
      containerClassName="p-6 pb-24"
    >
      <div className="pf-app min-h-screen" style={{ color: "var(--ink)" }}>
        <Sidebar />

        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="p-6 pb-24">
            {isDemoMode && <DemoBanner />}

            {/* Header bar - two rows on mobile */}
            <div className="mb-6 space-y-3">
              {/* Row 1: Back, symbol, action icons */}
              <div className="flex items-center gap-3">
                <button
                  className="pf-bf sm"
                  onClick={() => router.back()}
                  title="Back"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </button>
                {displaySymbol && (
                  <h1
                    className="flex items-center gap-2 min-w-0 truncate"
                    style={{
                      fontSize: 24,
                      fontWeight: 800,
                      letterSpacing: "-0.5px",
                      color: "var(--ink)",
                      margin: 0,
                    }}
                  >
                    <span
                      className="mono"
                      style={{ color: "var(--emerald-text)" }}
                    >
                      {displaySymbol}
                    </span>
                    {detailExchange && (
                      <span
                        className="pf-pill outline shrink-0"
                        style={{ fontSize: 9.5, padding: "2px 8px" }}
                      >
                        {detailExchange}
                      </span>
                    )}
                    {/* Entity-type pill - design Analysis.jsx convention */}
                    {entityType === "mf" && (
                      <span
                        className="pf-pill emerald shrink-0"
                        style={{ fontSize: 9.5, padding: "2px 8px" }}
                      >
                        Mutual Fund
                      </span>
                    )}
                    {entityType === "etf" && (
                      <span
                        className="pf-pill coral shrink-0"
                        style={{ fontSize: 9.5, padding: "2px 8px" }}
                      >
                        ETF
                      </span>
                    )}
                    {entityType === "comparison" && (
                      <span
                        className="pf-pill violet shrink-0"
                        style={{ fontSize: 9.5, padding: "2px 8px" }}
                      >
                        Comparison · {symbols.length}
                      </span>
                    )}
                  </h1>
                )}
                <div className="ml-auto flex items-center gap-2 shrink-0">
                  {/* Retry button - visible when report loaded or failed */}
                  {(report || researchStatus === "FAILED") &&
                    !isResearchRunning && (
                      <button
                        className="pf-bf sm"
                        style={{ padding: "6px 9px" }}
                        onClick={handleRetry}
                        disabled={isRetrying}
                        title="Re-run analysis"
                      >
                        {isRetrying ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <button
                        className="pf-bf danger sm"
                        style={{ padding: "6px 9px" }}
                        disabled={isDeleting}
                        title="Delete research"
                      >
                        {isDeleting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
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
                          Delete Research
                        </AlertDialogTitle>
                        <AlertDialogDescription
                          className="ser"
                          style={{
                            fontSize: 16,
                            color: "var(--ink-2)",
                            lineHeight: 1.4,
                          }}
                        >
                          This will permanently delete this research session and
                          its chat history. This action cannot be undone.
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
                </div>
              </div>

              {/* Row 2: Status badges */}
              <div className="flex items-center gap-2 flex-wrap pl-1">
                {isResearchRunning && (
                  <span
                    className="pf-pill inline-flex items-center"
                    style={{
                      background: "var(--emerald)",
                      color: "var(--paper)",
                      borderColor: "var(--emerald)",
                    }}
                  >
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    {researchStatus}
                  </span>
                )}
                {report && (
                  <>
                    <span className="pf-pill emerald">Completed</span>
                    {researchMeta.totalSteps &&
                      (() => {
                        const isAdvancedReport =
                          (researchMeta.totalSteps ?? 0) >= 10 ||
                          (report?.sections && report.sections.length > 0) ||
                          (report?.scoreBreakdown &&
                            report.scoreBreakdown.length > 0);
                        return isAdvancedReport ? (
                          <span className="pf-pill violet">Advanced</span>
                        ) : (
                          <span className="pf-pill outline">Quick</span>
                        );
                      })()}
                    {researchMeta.totalSteps && (
                      <span className="pf-pill outline">
                        {researchMeta.totalSteps} data points
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Loading skeleton */}
            {isLoading && (
              <div className="space-y-6">
                {/* Report skeleton */}
                <div className="pf-card" style={{ padding: 24 }}>
                  <div className="space-y-6">
                    {/* Score + Symbol header */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <Skeleton className="h-16 w-16 rounded-full" />
                        <div>
                          <Skeleton className="h-6 w-32 mb-2" />
                          <Skeleton className="h-4 w-48" />
                        </div>
                      </div>
                      <Skeleton className="h-8 w-24 rounded-full" />
                    </div>
                    {/* Summary section */}
                    <div className="space-y-2">
                      <Skeleton className="h-5 w-28" />
                      <Skeleton className="h-3 w-full" />
                      <Skeleton className="h-3 w-full" />
                      <Skeleton className="h-3 w-3/4" />
                    </div>
                    {/* Metrics grid */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      {[1, 2, 3, 4].map((i) => (
                        <div
                          key={i}
                          style={{
                            background: "var(--paper-2)",
                            border: "1.5px solid var(--rule-soft)",
                            borderRadius: 10,
                            padding: 12,
                          }}
                        >
                          <Skeleton className="h-3 w-16 mb-2" />
                          <Skeleton className="h-6 w-20" />
                        </div>
                      ))}
                    </div>
                    {/* Analysis sections */}
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="space-y-2">
                        <Skeleton className="h-5 w-36" />
                        <Skeleton className="h-3 w-full" />
                        <Skeleton className="h-3 w-full" />
                        <Skeleton className="h-3 w-2/3" />
                      </div>
                    ))}
                  </div>
                </div>
                {/* Chat panel skeleton */}
                <div className="pf-card" style={{ padding: 24 }}>
                  <Skeleton className="h-5 w-32 mb-4" />
                  <Skeleton className="h-32 w-full rounded-lg" />
                </div>
              </div>
            )}

            {/* In-progress — StockSage v2 streaming research-run (design): the
                lifecycle stepper + per-task cards that fill with real data as
                the worker reports progress, identical to the chat surface. */}
            {isResearchRunning && !isLoading && (
              <div className="ssx">
                <ResearchRunBlock
                  data={{
                    status: "running",
                    progress,
                    currentStep: currentStep || "Researching…",
                    tasks: taskProgress.map((t) => ({
                      id: t.id,
                      tool: t.tool,
                      type: t.type,
                      status: t.status,
                      durationMs: t.durationMs,
                      resultSummary: t.resultSummary,
                    })),
                  }}
                />
              </div>
            )}

            {/* Completed - report (L1/L2) or segments (L3/L4) above, chat below */}
            {(report || segments) && !isLoading && (
              <>
                {/* Full-width report */}
                {report ? (
                  <ResearchReport
                    report={report}
                    symbol={displaySymbol}
                    sessionId={sessionId}
                    dataSources={dataSources}
                    onDeepDive={(query) => {
                      setDeepDiveQuery(query);
                      // Scroll chat section into view
                      setTimeout(() => {
                        chatSectionRef.current?.scrollIntoView({
                          behavior: "smooth",
                          block: "start",
                        });
                      }, 100);
                    }}
                  />
                ) : segments ? (
                  <AnalysisSegmentsRenderer
                    segments={segments}
                    symbol={displaySymbol}
                    sessionId={sessionId}
                    onDeepDive={(query) => {
                      setDeepDiveQuery(query);
                      setTimeout(() => {
                        chatSectionRef.current?.scrollIntoView({
                          behavior: "smooth",
                          block: "start",
                        });
                      }, 100);
                    }}
                  />
                ) : null}

                {/* MONEY-587: rate this research result (feeds MONEY-592). */}
                <ResultFeedback
                  surface="RESEARCH"
                  refId={sessionId}
                  symbols={symbols}
                  className="mt-5"
                />

                {/* Full-width chat below the report */}
                <div className="mt-8" ref={chatSectionRef}>
                  <ChatProvider
                    userName={userName}
                    isRealUser={isRealUser}
                    isDemoMode={isDemoMode}
                    pagePath={`/analysis/${sessionId}`}
                    initialChatId={existingChatId}
                    defaultContext="stock_analysis"
                    hideContextSelector
                    userContext={chatUserContext}
                  >
                    <BottomChatPanel
                      symbol={displaySymbol}
                      deepDiveQuery={deepDiveQuery}
                      onDeepDiveConsumed={() => setDeepDiveQuery(null)}
                    />
                  </ChatProvider>
                </div>
              </>
            )}

            {/* Failed state */}
            {!isLoading &&
              !isResearchRunning &&
              !report &&
              researchStatus === "FAILED" && (
                <div
                  className="pf-card"
                  style={{
                    borderColor: "var(--neg-text)",
                    padding: "64px 24px",
                    textAlign: "center",
                  }}
                >
                  <div
                    style={{
                      width: 64,
                      height: 64,
                      borderRadius: 14,
                      background: "#b91c1c",
                      border: "1.5px solid var(--ink)",
                      boxShadow: "3px 3px 0 var(--ink)",
                      transform: "rotate(-3deg)",
                      margin: "0 auto 18px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <AlertTriangle
                      className="h-8 w-8"
                      style={{ color: "#fff" }}
                    />
                  </div>
                  <h3
                    style={{
                      fontSize: 20,
                      fontWeight: 800,
                      letterSpacing: "-0.3px",
                      color: "var(--ink)",
                      marginBottom: 8,
                    }}
                  >
                    Research Failed
                  </h3>
                  <p
                    style={{
                      fontFamily: "Instrument Serif, serif",
                      fontStyle: "italic",
                      fontSize: 16,
                      color: "var(--ink-3)",
                      marginBottom: 8,
                    }}
                  >
                    Something went wrong during the analysis.
                  </p>
                  {errorMessage && (
                    <p
                      style={{
                        fontSize: 13,
                        color: "#b91c1c",
                        marginBottom: 16,
                        maxWidth: 420,
                        marginLeft: "auto",
                        marginRight: "auto",
                      }}
                    >
                      {sanitizeErrorMessage(errorMessage)}
                    </p>
                  )}
                  <div className="flex items-center justify-center gap-3 mt-4">
                    <Link href="/analysis" className="pf-bf">
                      <ArrowLeft className="h-4 w-4" />
                      Back
                    </Link>
                    {originalQuery && (
                      <button
                        className="pf-bs"
                        onClick={handleRetry}
                        disabled={isRetrying}
                      >
                        {isRetrying ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RotateCcw className="h-4 w-4" />
                        )}
                        Retry Analysis
                      </button>
                    )}
                  </div>
                </div>
              )}
          </div>
        </main>
      </div>

      {/* Rerun mode-select modal (pre-seeded with this session's symbols) */}
      <ResearchModal
        open={rerunModalOpen}
        onOpenChange={setRerunModalOpen}
        entity={rerunEntity}
        compareEntities={rerunCompare.length >= 2 ? rerunCompare : undefined}
      />
    </PageGuard>
  );
}

/**
 * Full-width chat panel at the bottom of the page.
 * Rendered inside ChatProvider so it can access chat context.
 */
function BottomChatPanel({
  symbol,
  deepDiveQuery,
  onDeepDiveConsumed,
}: {
  symbol: string;
  deepDiveQuery?: string | null;
  onDeepDiveConsumed?: () => void;
}) {
  const { messages, clearChat, sendMessage } = useChatContext();

  // Auto-send deep dive query when it arrives
  useEffect(() => {
    if (deepDiveQuery) {
      sendMessage(deepDiveQuery);
      onDeepDiveConsumed?.();
    }
  }, [deepDiveQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="pf-card flex flex-col h-[500px]"
      style={{ padding: 0, overflow: "hidden" }}
    >
      {/* Header - playful StockSage banner */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{
          padding: "12px 16px",
          borderBottom: "2px solid var(--ink)",
          background: "var(--paper-2)",
        }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "var(--emerald)",
              color: "var(--paper)",
              display: "grid",
              placeItems: "center",
              border: "1.5px solid var(--ink)",
              transform: "rotate(-3deg)",
              flexShrink: 0,
            }}
          >
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div
              className="mono"
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 1,
                color: "var(--ink-3)",
                textTransform: "uppercase",
              }}
            >
              StockSage
            </div>
            <h3
              className="truncate"
              style={{
                fontSize: 14,
                fontWeight: 800,
                color: "var(--ink)",
                letterSpacing: "-0.2px",
              }}
            >
              {symbol || "Analysis"}
            </h3>
          </div>
        </div>
        {messages.length > 0 && (
          <button
            className="pf-bf sm shrink-0"
            style={{ padding: "6px 9px" }}
            onClick={clearChat}
            title="New chat"
          >
            <Plus className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <ChatMessageList />
      </div>

      {/* Input */}
      <div
        className="shrink-0"
        style={{ borderTop: "2px solid var(--ink)", padding: 12 }}
      >
        <ChatPromptArea />
      </div>
    </div>
  );
}
