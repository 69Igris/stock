import Sidebar from "@/components/Sidebar";
import { Skeleton } from "@usemoney/ui/skeleton";

/**
 * /notifications loading skeleton — mirrors the playful NotificationsClient
 * chrome (MONEY-485):
 *   - pf-ph page head (mono eyebrow + display headline + sub-line)
 *   - "Mark all read" + "Clear all" action buttons on the right
 *   - pf-pill filter chips (All / Unread / Mentions / Alerts / System)
 *   - pf-card list with rotated icon tiles + title + summary
 *
 * Container width matches the live page (max-w-[1200px]). Themed via
 * playful-app.css CSS vars so light/dark stay in sync.
 */
export default function NotificationsLoading() {
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-4 sm:px-6 py-5 max-w-[1200px] mx-auto pb-24">
          {/* Page head (pf-ph) */}
          <div className="pf-ph">
            <div className="l">
              <div className="eyebrow">
                <span className="d" aria-hidden />
                ACCOUNT · NOTIFICATIONS
              </div>
              <h1>
                Everything <span className="ser">worth</span>{" "}
                <span className="hl">a ping.</span>
              </h1>
              <div className="sub">Loading your feed…</div>
            </div>
            <div className="r">
              <Skeleton
                className="rounded-lg"
                style={{
                  height: 30,
                  width: 130,
                  background: "var(--rule-softer)",
                  border: "1.5px solid var(--rule-soft)",
                }}
              />
              <Skeleton
                className="rounded-lg"
                style={{
                  height: 30,
                  width: 96,
                  background: "var(--rule-softer)",
                  border: "1.5px solid var(--rule-soft)",
                }}
              />
            </div>
          </div>

          {/* Filter chips (pf-pill shaped) */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 20,
            }}
          >
            {[60, 72, 84, 72, 72].map((w, i) => (
              <Skeleton
                key={i}
                className="rounded-full"
                style={{
                  height: 24,
                  width: w,
                  background: "var(--rule-softer)",
                  border: "1.5px solid var(--rule-soft)",
                }}
              />
            ))}
          </div>

          {/* Notification cards (pf-card rows) */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="pf-card"
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto",
                  alignItems: "center",
                  gap: 14,
                  padding: "14px 16px",
                }}
              >
                <Skeleton
                  style={{
                    height: 36,
                    width: 36,
                    borderRadius: 9,
                    background: "var(--rule-softer)",
                    border: "1.5px solid var(--rule-soft)",
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <Skeleton
                      style={{
                        height: 14,
                        width: "62%",
                        background: "var(--rule-soft)",
                      }}
                    />
                    <Skeleton
                      style={{
                        height: 11,
                        width: 52,
                        marginLeft: "auto",
                        background: "var(--rule-softer)",
                      }}
                    />
                  </div>
                  <Skeleton
                    style={{
                      height: 11,
                      width: "80%",
                      marginTop: 8,
                      background: "var(--rule-softer)",
                    }}
                  />
                </div>
                <Skeleton
                  style={{
                    height: 16,
                    width: 16,
                    background: "var(--rule-softer)",
                    flexShrink: 0,
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
