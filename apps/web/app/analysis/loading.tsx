import Sidebar from "@/components/Sidebar";
import { AnalysisSkeleton } from "@/components/skeletons";

/**
 * /analysis loading skeleton (MONEY-394 O).
 *
 * Inline chrome (not `PageLoadingWrapper`) because the hydrated
 * analysis page uses `p-6 pb-24` with **no `max-w` cap** - content
 * spans the full available width. PageLoadingWrapper would clamp it
 * to `max-w-[1600px]`, causing a visible width jump on wide screens
 * at hydration.
 *
 * Header mirrors `apps/web/app/analysis/client.tsx:411-430` exactly:
 *   - h1 'Analysis' + 'RESEARCH LIST' chip on the left
 *   - flex-1 spacer
 *   - emerald pulse-dot + 'N sessions' chip on the right
 *   - 'View and track your stock + mutual fund research sessions.'
 *     paragraph
 * so stages 1 → 2 → 3 are pixel-stable.
 */
export default function AnalysisLoading() {
  return (
    <div className="pf-app min-h-screen" style={{ color: "var(--ink)" }}>
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="p-6 pb-24">
          {/* Header - RESEARCH LIST eyebrow + serif headline + sessions
              counter (placeholder while history loads). Mirrors the
              hydrated client header in client.tsx for pixel-stability. */}
          <div
            className="mono"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1,
              color: "var(--emerald-text)",
              marginBottom: 8,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--emerald)",
                animation: "um-pulse 1.6s infinite",
              }}
            />
            RESEARCH LIST
          </div>
          <div className="flex items-baseline gap-3.5 flex-wrap mb-1">
            <h1
              style={{
                fontSize: 32,
                lineHeight: 1.02,
                letterSpacing: "-1px",
                fontWeight: 800,
                color: "var(--ink)",
                margin: 0,
              }}
            >
              Your research, <span className="ser">on the</span>{" "}
              <span className="hl-gold">record.</span>
            </h1>
            <div className="flex-1" />
            <span
              className="mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: "var(--ink-3)",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--emerald)",
                  boxShadow: "0 0 6px var(--emerald)",
                }}
              />
              <span style={{ color: "var(--ink-4)" }}>— sessions</span>
            </span>
          </div>
          <p
            style={{
              fontSize: 13,
              color: "var(--ink-3)",
              marginBottom: 24,
              maxWidth: "48rem",
            }}
          >
            View and track your stock + mutual fund research sessions.
          </p>

          <AnalysisSkeleton />
        </div>
      </main>
    </div>
  );
}
