"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import Link from "next/link";
import { Search, ArrowRight } from "lucide-react";
// TODO: Remove hardcoded fallback once all glossary terms are migrated to content_posts
import { glossaryTerms as hardcodedGlossaryTerms } from "@/app/help/lib/glossary-data";
import { getGlossaryTermsForHelpAction } from "@/lib/actions/content";

// All possible index characters: 0-9, A-Z
const ALL_LETTERS = [
  "#",
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
];

/** Finance category → CSS var accent (text-safe variants; used only as label colour) */
const CAT_ACCENTS: Record<string, string> = {
  RETURNS: "var(--emerald-text)",
  TAX: "var(--pop-2-text)",
  FUNDAMENTAL: "var(--pop-3-text)",
  VALUATION: "var(--pop-5-text)",
  RISK: "var(--pop-1-text)",
  PLANNING: "var(--pop-4-text)",
};

function getLetterKey(term: string): string {
  const first = term[0].toUpperCase();
  if (/\d/.test(first)) return "#";
  return first;
}

export default function GlossaryTab() {
  const [search, setSearch] = useState("");

  /**
   * The DB terms are fetched HERE rather than handed down from the server
   * component.
   *
   * /help is `force-dynamic`, and page.tsx used to `await` this query before
   * rendering anything — ~190ms for 132 rows / 25KB, on every visit. But the
   * data feeds exactly ONE of the six tabs, and the default tab is Prompts, so
   * five out of six visitors paid for a payload they never saw. This component
   * only mounts when the Glossary tab is actually open, so the cost is now
   * paid by the people who asked for it.
   *
   * There is deliberately NO loading state. `hardcodedGlossaryTerms` (139
   * terms) is already in the client bundle and renders immediately; the DB
   * result (132) swaps in when it arrives. A spinner would replace an instant
   * render with a wait, which is the opposite of the point — and a failed
   * fetch leaves a full glossary on screen rather than an error.
   */
  const [dbTerms, setDbTerms] = useState<Array<{
    term: string;
    definition: string;
  }> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getGlossaryTermsForHelpAction()
      .then((fetched) => {
        // An empty result means "nothing published", not "better than the
        // fallback" — keep the bundled list rather than blanking the tab.
        if (!cancelled && fetched.length > 0) setDbTerms(fetched);
      })
      .catch(() => {
        // The fallback is already rendered; a failure changes nothing.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const glossaryTerms = dbTerms ?? hardcodedGlossaryTerms;

  const filtered = useMemo(() => {
    if (!search.trim()) return glossaryTerms;
    const q = search.toLowerCase();
    return glossaryTerms.filter(
      (t) =>
        t.term.toLowerCase().includes(q) ||
        t.definition.toLowerCase().includes(q)
    );
  }, [search, glossaryTerms]);

  // Group by first letter
  const grouped = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const term of filtered) {
      const letter = getLetterKey(term.term);
      if (!map.has(letter)) map.set(letter, []);
      map.get(letter)!.push(term);
    }
    // Sort: # first, then A-Z
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === "#") return -1;
      if (b === "#") return 1;
      return a.localeCompare(b);
    });
  }, [filtered]);

  // Set of letters that have terms (for disabling empty ones in the index)
  const activeLetters = useMemo(() => {
    return new Set(grouped.map(([letter]) => letter));
  }, [grouped]);

  const scrollToLetter = useCallback((letter: string) => {
    const el = document.getElementById(`glossary-${letter}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  return (
    <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
      {/* Main content */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        {/* Link to full public glossary */}
        <Link href="/glossary" style={{ textDecoration: "none" }}>
          <div
            className="pf-card"
            style={{
              padding: "14px 18px",
              background: "rgba(52,211,153,.06)",
              borderColor: "var(--emerald)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              cursor: "pointer",
              transition: "transform .12s, box-shadow .12s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.transform =
                "translate(-1px,-1px)";
              (e.currentTarget as HTMLDivElement).style.boxShadow =
                "4px 4px 0 var(--ink)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.transform =
                "translate(0,0)";
              (e.currentTarget as HTMLDivElement).style.boxShadow =
                "var(--shadow-soft)";
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 800,
                  color: "var(--ink)",
                  marginBottom: 2,
                }}
              >
                View complete glossary
              </div>
              <div
                style={{
                  fontFamily: "Instrument Serif, serif",
                  fontStyle: "italic",
                  fontSize: 13,
                  color: "var(--ink-3)",
                }}
              >
                Browse our comprehensive financial glossary with detailed
                definitions
              </div>
            </div>
            <ArrowRight
              style={{
                width: 16,
                height: 16,
                color: "var(--emerald-text)",
                flexShrink: 0,
              }}
            />
          </div>
        </Link>

        {/* Search bar */}
        <div
          style={{
            padding: "12px 16px",
            borderRadius: 12,
            border: "2px solid var(--ink)",
            background: "var(--paper-3)",
            display: "flex",
            gap: 12,
            alignItems: "center",
          }}
        >
          <Search
            style={{
              width: 18,
              height: 18,
              color: "var(--ink-3)",
              flexShrink: 0,
            }}
          />
          <input
            type="text"
            placeholder="Search terms…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              flex: 1,
              border: 0,
              outline: 0,
              background: "transparent",
              fontFamily: "Inter, sans-serif",
              fontSize: 15,
              color: "var(--ink)",
            }}
          />
        </div>

        {/* A–Z letter nav (wraps on mobile — no horizontal scroll) */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 2,
            padding: 10,
            border: "1.5px solid var(--ink)",
            borderRadius: 12,
            background: "var(--paper-3)",
            justifyContent: "center",
          }}
        >
          {ALL_LETTERS.map((L) => {
            const has = activeLetters.has(L);
            return (
              <button
                key={L}
                type="button"
                disabled={!has}
                onClick={() => has && scrollToLetter(L)}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  background: has ? "transparent" : "transparent",
                  color: has ? "var(--ink-2)" : "var(--ink-4)",
                  border: 0,
                  cursor: has ? "pointer" : "default",
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 12,
                  fontWeight: 700,
                  transition: "background .1s, color .1s",
                }}
                onMouseEnter={(e) => {
                  if (has) {
                    e.currentTarget.style.background = "var(--emerald-bg)";
                    e.currentTarget.style.color = "var(--emerald-text)";
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = has
                    ? "var(--ink-2)"
                    : "var(--ink-4)";
                }}
              >
                {L}
              </button>
            );
          })}
        </div>

        {filtered.length === 0 ? (
          <div
            className="pf-card"
            style={{ padding: 32, textAlign: "center", color: "var(--ink-3)" }}
          >
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              No terms match your search.
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            {grouped.map(([letter, termGroup]) => (
              <div
                key={letter}
                id={`glossary-${letter}`}
                style={{ scrollMarginTop: 16 }}
              >
                {/* Letter heading */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    marginBottom: 12,
                  }}
                >
                  <span
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      background: "var(--emerald)",
                      color: "#fff",
                      border: "1.5px solid var(--ink)",
                      display: "grid",
                      placeItems: "center",
                      fontFamily: "JetBrains Mono, monospace",
                      fontSize: 14,
                      fontWeight: 800,
                      transform: "rotate(-2deg)",
                      flexShrink: 0,
                    }}
                  >
                    {letter}
                  </span>
                  <div
                    style={{
                      flex: 1,
                      height: 1.5,
                      background: "var(--ink)",
                      opacity: 0.12,
                    }}
                  />
                </div>

                {/* Terms grid — auto-fill, stacks on mobile */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fill, minmax(300px, 1fr))",
                    gap: 10,
                    paddingLeft: 8,
                  }}
                >
                  {termGroup.map((t) => {
                    // Try to infer category from term (best effort, for accent colours)
                    const termUpper = t.term.toUpperCase();
                    const cat =
                      termUpper.includes("CAGR") ||
                      termUpper.includes("XIRR") ||
                      termUpper.includes("IRR")
                        ? "RETURNS"
                        : termUpper.includes("TAX") ||
                            termUpper.includes("LTCG") ||
                            termUpper.includes("STCG")
                          ? "TAX"
                          : termUpper.includes("P/E") ||
                              termUpper.includes("P/B") ||
                              termUpper.includes("DCF")
                            ? "VALUATION"
                            : termUpper.includes("RISK") ||
                                termUpper.includes("VAR") ||
                                termUpper.includes("BETA") ||
                                termUpper.includes("DRAWDOWN")
                              ? "RISK"
                              : termUpper.includes("ROE") ||
                                  termUpper.includes("ROCE") ||
                                  termUpper.includes("EPS")
                                ? "FUNDAMENTAL"
                                : termUpper.includes("FIRE") ||
                                    termUpper.includes("SIP")
                                  ? "PLANNING"
                                  : "";
                    const accent = cat
                      ? (CAT_ACCENTS[cat] ?? "var(--ink-3)")
                      : "var(--ink-3)";
                    return (
                      <div
                        key={t.term}
                        className="pf-card"
                        style={{ padding: 16, boxShadow: "none" }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "baseline",
                            gap: 8,
                            marginBottom: 4,
                            flexWrap: "wrap",
                          }}
                        >
                          <div
                            style={{
                              fontSize: 15,
                              fontWeight: 800,
                              letterSpacing: -0.3,
                              color: "var(--ink)",
                            }}
                          >
                            {t.term}
                          </div>
                          {cat && (
                            <span
                              className="mono"
                              style={{
                                marginLeft: "auto",
                                fontSize: 10,
                                fontWeight: 800,
                                color: accent,
                                letterSpacing: 1.2,
                                flexShrink: 0,
                              }}
                            >
                              {cat}
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            fontSize: 13,
                            color: "var(--ink-2)",
                            lineHeight: 1.5,
                          }}
                        >
                          {t.definition}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Right-side alphabetical index — hidden on mobile, shown on desktop */}
      <nav
        className="glossary-alpha-nav"
        style={{
          display: "none",
          flexDirection: "column",
          alignItems: "center",
          gap: 1,
          position: "sticky",
          top: 16,
          alignSelf: "flex-start",
          paddingTop: 56,
          flexShrink: 0,
        }}
      >
        {ALL_LETTERS.map((letter) => {
          const isActive = activeLetters.has(letter);
          return (
            <button
              key={letter}
              type="button"
              disabled={!isActive}
              onClick={() => scrollToLetter(letter)}
              style={{
                width: 24,
                height: 24,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 4,
                border: 0,
                background: "transparent",
                fontSize: 10,
                fontFamily: "JetBrains Mono, monospace",
                fontWeight: 700,
                color: isActive ? "var(--ink-2)" : "var(--ink-4)",
                cursor: isActive ? "pointer" : "default",
                transition: "color .1s, background .1s",
              }}
              onMouseEnter={(e) => {
                if (isActive) {
                  e.currentTarget.style.color = "var(--emerald-text)";
                  e.currentTarget.style.background = "var(--emerald-bg)";
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = isActive
                  ? "var(--ink-2)"
                  : "var(--ink-4)";
                e.currentTarget.style.background = "transparent";
              }}
            >
              {letter}
            </button>
          );
        })}
      </nav>

      <style>{`
        @media (min-width: 768px) {
          .glossary-alpha-nav { display: flex !important; }
        }
      `}</style>
    </div>
  );
}
