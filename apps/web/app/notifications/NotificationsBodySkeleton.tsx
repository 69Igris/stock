import { Skeleton } from "@usemoney/ui/skeleton";

/**
 * Notifications page body skeleton — no Sidebar / title chrome (those
 * are owned by PageGuard stage 2 / loading.tsx stage 1). Matches the
 * hydrated playful NotificationsClient shape: pf-pill filter chips +
 * a pf-card list with rotated icon tiles. Themed via playful-app.css
 * CSS vars so light/dark stay in sync.
 */
export default function NotificationsBodySkeleton() {
  return (
    <>
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
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
    </>
  );
}
