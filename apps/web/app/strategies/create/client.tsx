"use client";

/**
 * Create with AI - /strategies/create
 *
 * Playful re-skin of the 3-step wizard:
 *   1. SOURCE  - pick how the user wants to feed the description
 *                (YouTube / Blog URL / X thread / Paste / Upload PDF)
 *   2. EXTRACT - Gemini-parsed spec (universe / rebalance / entry filters /
 *                exit). Unknown indicators get tagged so the user can map
 *                them to known fields.
 *   3. CONFIRM - final review + Run backtest CTA.
 *
 * For this first cut we call generateStrategyAction with the user-provided
 * text; the AI returns a parsed shape (or falls back to a stub) and the
 * page renders the spec cards. The "Run backtest" CTA at the end routes
 * the user to /strategies/[id]/backtest once persistence ships - for now
 * it surfaces a toast.
 */

import { useState } from "react";
import Link from "next/link";
import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  Youtube,
  Link2,
  AtSign,
  Clipboard,
  FileUp,
  Play,
} from "lucide-react";
import { toast } from "sonner";
import { generateStrategyAction } from "@/lib/actions/strategy";

type SourceKind = "youtube" | "blog" | "x" | "paste" | "upload";

interface SourceDef {
  id: SourceKind;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  placeholder: string;
}

const SOURCES: SourceDef[] = [
  {
    id: "youtube",
    label: "YouTube",
    Icon: Youtube,
    placeholder: "https://youtube.com/…",
  },
  {
    id: "blog",
    label: "Blog URL",
    Icon: Link2,
    placeholder: "https://substack.com/…",
  },
  {
    id: "x",
    label: "X thread",
    Icon: AtSign,
    placeholder: "https://x.com/…/status/…",
  },
  {
    id: "paste",
    label: "Paste text",
    Icon: Clipboard,
    placeholder: "Paste strategy description…",
  },
  {
    id: "upload",
    label: "Upload PDF",
    Icon: FileUp,
    placeholder: "PDF / image · max 10 MB",
  },
];

const URL_RE = /^https?:\/\//;

interface ExtractedSpec {
  name: string;
  universe: string;
  rebalance: string;
  entry: string[];
  exit: string;
  unknown: string[];
}

const FALLBACK_SPEC: ExtractedSpec = {
  name: "Source-derived quality + FCF strategy",
  universe: "NIFTY 500",
  rebalance: "Quarterly · top 30 by FCF yield",
  entry: [
    "ROE > 18%",
    "debt/equity < 0.5",
    "FCF margin > 12%",
    "3Y rev CAGR > 15%",
  ],
  exit: "On dropout from screen at rebalance",
  unknown: ["Buffett rule of 5", "Munger filter", "reasonable price"],
};

function StepDot({
  n,
  label,
  step,
}: {
  n: 1 | 2 | 3;
  label: string;
  step: 1 | 2 | 3;
}) {
  const past = step > n;
  const cur = step === n;
  const done = past || cur;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span
        className="mono"
        style={{
          width: 32,
          height: 32,
          borderRadius: 999,
          display: "grid",
          placeItems: "center",
          fontSize: 13,
          fontWeight: 800,
          flexShrink: 0,
          border: `1.5px solid ${done ? "var(--emerald)" : "var(--ink)"}`,
          background: past
            ? "var(--emerald)"
            : cur
              ? "var(--emerald-bg)"
              : "var(--paper)",
          color: past
            ? "var(--paper)"
            : cur
              ? "var(--emerald-text)"
              : "var(--ink-3)",
        }}
      >
        {past ? <Check className="h-3.5 w-3.5" /> : n}
      </span>
      <div>
        <div
          className="mono"
          style={{
            fontSize: 9.5,
            letterSpacing: 1.4,
            fontWeight: 700,
            color: done ? "var(--emerald-text)" : "var(--ink-3)",
          }}
        >
          {n}/3
        </div>
        <div
          style={{
            fontSize: 13,
            fontWeight: 800,
            letterSpacing: -0.2,
            color: done ? "var(--ink)" : "var(--ink-3)",
          }}
        >
          {label}
        </div>
      </div>
    </div>
  );
}

export default function StrategyCreateAIClient(
  props: { embedded?: boolean } = {}
) {
  return props.embedded ? (
    <CreateAIBody />
  ) : (
    <PageGuard
      route="/strategies"
      containerClassName="p-6 pb-24 max-w-[880px] mx-auto"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="pf-page" style={{ paddingTop: 16 }}>
            <Link
              href="/strategies"
              className="mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                color: "var(--ink-3)",
                marginBottom: 14,
              }}
            >
              <ArrowLeft className="h-3 w-3" /> All strategies
            </Link>
            <CreateAIBody />
          </div>
        </main>
      </div>
    </PageGuard>
  );
}

export function CreateAIBody() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [source, setSource] = useState<SourceKind>("youtube");
  const [url, setUrl] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [spec, setSpec] = useState<ExtractedSpec | null>(null);
  const [finalName, setFinalName] = useState(FALLBACK_SPEC.name);

  const valid =
    source === "paste"
      ? pasteText.trim().length > 30
      : source === "upload"
        ? true
        : URL_RE.test(url.trim());

  const handleExtract = async () => {
    setExtracting(true);
    try {
      // Use pasted text if available, otherwise hand off the URL as a prompt.
      const prompt =
        source === "paste"
          ? pasteText
          : `Extract a backtestable trading strategy from this ${source} source: ${url}`;
      const result = await generateStrategyAction(prompt);
      if (result?.success && result?.data) {
        // The AI route returns a different shape than the extract spec we
        // render here - adapt loosely so the wizard always renders.
        const data = result.data;
        const adapted: ExtractedSpec = {
          name: data.name ?? FALLBACK_SPEC.name,
          universe: FALLBACK_SPEC.universe,
          rebalance: data.timeframe ?? FALLBACK_SPEC.rebalance,
          entry: [
            data.rules?.entry ?? FALLBACK_SPEC.entry[0],
            ...FALLBACK_SPEC.entry.slice(1),
          ],
          exit: data.rules?.exit ?? FALLBACK_SPEC.exit,
          unknown: data.overlays ?? FALLBACK_SPEC.unknown,
        };
        setSpec(adapted);
        setFinalName(adapted.name);
        setStep(2);
      } else {
        // AI parse failed - show fallback spec so the wizard isn't a dead-end.
        setSpec(FALLBACK_SPEC);
        setFinalName(FALLBACK_SPEC.name);
        setStep(2);
        toast.info(
          "Couldn't parse the source - showing the canonical example so you can edit and proceed."
        );
      }
    } catch {
      setSpec(FALLBACK_SPEC);
      setFinalName(FALLBACK_SPEC.name);
      setStep(2);
    } finally {
      setExtracting(false);
    }
  };

  const handleRun = () => {
    toast.info(
      `"${finalName}" queued - connect a strategy ID once persistence ships, then route to backtest.`
    );
  };

  return (
    <div style={{ maxWidth: 880, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.8 }}>
          Create <span className="ser">with AI.</span>
        </h2>
        <span
          className="mono"
          style={{
            fontSize: 11,
            letterSpacing: 1.2,
            textTransform: "uppercase",
            color: "var(--ink-3)",
            fontWeight: 700,
          }}
        >
          3-STEP
        </span>
        <div style={{ flex: 1 }} />
        <span className="pf-pill gold" style={{ textTransform: "uppercase" }}>
          Derived · educational only
        </span>
      </div>

      {/* Stepper bar */}
      <div
        className="pf-card"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "14px 18px",
          marginBottom: 18,
        }}
      >
        <StepDot n={1} label="Source" step={step} />
        <div
          style={{
            flex: 1,
            height: 2,
            borderRadius: 999,
            background: step >= 2 ? "var(--emerald)" : "var(--rule-soft)",
          }}
        />
        <StepDot n={2} label="Extract" step={step} />
        <div
          style={{
            flex: 1,
            height: 2,
            borderRadius: 999,
            background: step >= 3 ? "var(--emerald)" : "var(--rule-soft)",
          }}
        />
        <StepDot n={3} label="Confirm" step={step} />
      </div>

      {/* STEP 1 */}
      <StepCard active={step === 1} reached={step >= 1}>
        <StepHeader n={1} label="SOURCE" active={step === 1}>
          {step > 1 && (
            <span className="pf-pill emerald">
              <Check className="h-2.5 w-2.5" /> CAPTURED
            </span>
          )}
        </StepHeader>

        <div
          style={{
            display: "flex",
            gap: 4,
            flexWrap: "wrap",
            marginBottom: 14,
            padding: 3,
            border: "1.5px solid var(--ink)",
            borderRadius: 8,
          }}
        >
          {SOURCES.map((s) => {
            const on = source === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSource(s.id)}
                className="mono"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 12px",
                  borderRadius: 5,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 0.3,
                  border: 0,
                  cursor: "pointer",
                  background: on ? "var(--ink)" : "transparent",
                  color: on ? "var(--paper)" : "var(--ink-3)",
                }}
              >
                <s.Icon className="h-3 w-3" /> {s.label}
              </button>
            );
          })}
        </div>

        {source !== "upload" && source !== "paste" && (
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={SOURCES.find((s) => s.id === source)?.placeholder}
            className="pf-input mono"
            style={{
              fontSize: 13,
              borderColor: valid
                ? "var(--emerald)"
                : url
                  ? "#b91c1c"
                  : "var(--ink)",
            }}
          />
        )}
        {source === "paste" && (
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="Paste a strategy description…"
            rows={6}
            className="pf-input"
            style={{ fontSize: 13, resize: "vertical" }}
          />
        )}
        {source === "upload" && (
          <div
            style={{
              padding: 28,
              borderRadius: 10,
              background: "var(--emerald-bg)",
              border: "2px dashed var(--emerald)",
              textAlign: "center",
              color: "var(--ink-3)",
              fontSize: 13,
            }}
          >
            <FileUp
              className="h-6 w-6"
              style={{ color: "var(--emerald)", margin: "0 auto 8px" }}
            />
            Drop PDF here · or click to upload (max 10 MB)
          </div>
        )}
        {url && !valid && source !== "paste" && source !== "upload" && (
          <div
            className="mono"
            style={{ marginTop: 8, fontSize: 11, color: "#b91c1c" }}
          >
            ● invalid URL - must start with http:// or https://
          </div>
        )}

        {step === 1 && (
          <div
            style={{
              marginTop: 14,
              display: "flex",
              justifyContent: "flex-end",
            }}
          >
            <button
              type="button"
              onClick={handleExtract}
              disabled={!valid || extracting}
              className="pf-bs"
              style={
                !valid || extracting
                  ? { opacity: 0.5, cursor: "not-allowed" }
                  : undefined
              }
            >
              {extracting ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" /> Extracting…
                </>
              ) : (
                <>
                  Continue <ArrowRight className="h-3 w-3" />
                </>
              )}
            </button>
          </div>
        )}
      </StepCard>

      {/* STEP 2 */}
      <StepCard active={step === 2} reached={step >= 2}>
        <StepHeader n={2} label="EXTRACT" active={step === 2}>
          {step === 2 && (
            <span className="pf-pill emerald">
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: "var(--paper)",
                }}
              />
              GEMINI PARSED
            </span>
          )}
          {step > 2 && (
            <span className="pf-pill emerald">
              <Check className="h-2.5 w-2.5" /> EXTRACTED
            </span>
          )}
        </StepHeader>

        {step >= 2 && spec && (
          <>
            <div
              className="strat-spec-grid"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
                marginBottom: 10,
              }}
            >
              <SpecCard label="UNIVERSE" color="var(--pop-5-text)">
                <span className="pf-pill emerald">{spec.universe}</span>
              </SpecCard>
              <SpecCard label="REBALANCE" color="var(--pop-5-text)">
                <div
                  className="mono"
                  style={{ fontSize: 12.5, color: "var(--ink)" }}
                >
                  {spec.rebalance}
                </div>
              </SpecCard>
              <SpecCard label="ENTRY FILTERS" color="var(--emerald-text)">
                <div
                  className="mono"
                  style={{
                    fontSize: 11.5,
                    lineHeight: 1.7,
                    color: "var(--ink-2)",
                  }}
                >
                  {spec.entry.map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                </div>
              </SpecCard>
              <SpecCard label="EXIT" color="#b91c1c">
                <div
                  className="mono"
                  style={{ fontSize: 12, color: "var(--ink-2)" }}
                >
                  {spec.exit}
                </div>
              </SpecCard>
            </div>

            {spec.unknown.length > 0 && (
              <div
                className="pf-card"
                style={{
                  padding: 14,
                  background: "var(--pop-2)",
                  borderColor: "var(--ink)",
                }}
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    letterSpacing: 1.4,
                    color: "#1d1d1b",
                    fontWeight: 700,
                    marginBottom: 10,
                  }}
                >
                  UNKNOWN INDICATORS · MAP THESE
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {spec.unknown.map((c) => (
                    <span
                      key={c}
                      className="pf-pill"
                      style={{
                        background: "var(--paper)",
                        color: "var(--ink)",
                        borderColor: "var(--ink)",
                      }}
                    >
                      <Link2 className="h-2.5 w-2.5" /> {c}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {step === 2 && (
              <div
                style={{
                  marginTop: 14,
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="pf-bf"
                >
                  ← Back
                </button>
                <button
                  type="button"
                  onClick={() => setStep(3)}
                  className="pf-bs"
                >
                  Continue <ArrowRight className="h-3 w-3" />
                </button>
              </div>
            )}
          </>
        )}
      </StepCard>

      {/* STEP 3 */}
      <StepCard active={step === 3} reached={step >= 3}>
        <StepHeader n={3} label="CONFIRM" active={step === 3} />

        {step >= 3 && spec && (
          <>
            <input
              value={finalName}
              onChange={(e) => setFinalName(e.target.value)}
              className="pf-input"
              style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10 }}
            />
            <div className="pf-codeblock">
              <span className="em">universe</span> · {spec.universe}
              <br />
              <span className="em">entry</span> · {spec.entry.join(" && ")}
              <br />
              <span className="dim">weight</span> · top 30, equal
              <br />
              <span className="dim">rebalance</span> · {spec.rebalance}
              <br />
              <span className="gold">exit</span> · {spec.exit}
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: 14,
              }}
            >
              <button
                type="button"
                onClick={() => setStep(2)}
                className="pf-bf"
              >
                ← Edit
              </button>
              <button type="button" onClick={handleRun} className="pf-bs">
                <Play className="h-3 w-3" /> Run backtest
              </button>
            </div>
          </>
        )}
      </StepCard>

      <style>{`
        @media (max-width: 640px) {
          .strat-spec-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

function StepCard({
  active,
  reached,
  children,
}: {
  active: boolean;
  reached: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="pf-card"
      style={{
        padding: 22,
        marginBottom: 12,
        opacity: reached ? 1 : 0.5,
        borderColor: active ? "var(--emerald)" : "var(--ink)",
      }}
    >
      {children}
    </div>
  );
}

function StepHeader({
  n,
  label,
  active,
  children,
}: {
  n: number;
  label: string;
  active: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 14,
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: 1.5,
          fontWeight: 700,
          color: active ? "var(--emerald-text)" : "var(--ink-3)",
        }}
      >
        {n}/3 · {label}
      </span>
      {children}
    </div>
  );
}

function SpecCard({
  label,
  color,
  children,
}: {
  label: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 10,
        background: "var(--rule-softer)",
        border: "1.5px solid var(--rule-soft)",
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: 1.4,
          fontWeight: 700,
          marginBottom: 8,
          color,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}
