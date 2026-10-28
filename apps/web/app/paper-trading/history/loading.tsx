import { Skeleton } from "@usemoney/ui/skeleton";

/**
 * Paper history loading skeleton — playful pf-tbl table shell
 * (design: PaperHistoryScreen). Renders inside paper-trading/layout.tsx
 * which already provides Sidebar + sub-nav + per-route h1.
 */
export default function PaperHistoryLoading() {
  return (
    <div className="pf-app">
      <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table className="pf-tbl">
            <thead>
              <tr>
                <th style={{ paddingLeft: 18 }}>OPENED</th>
                <th>CLOSED</th>
                <th>SYM</th>
                <th>SIDE</th>
                <th>STRAT</th>
                <th style={{ textAlign: "right" }}>QTY</th>
                <th style={{ textAlign: "right" }}>P&amp;L</th>
                <th style={{ textAlign: "right" }}>%</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  <td style={{ paddingLeft: 18 }}>
                    <Skeleton className="h-3 w-14 bg-muted" />
                  </td>
                  <td>
                    <Skeleton className="h-3 w-14 bg-muted" />
                  </td>
                  <td>
                    <Skeleton className="h-4 w-20 bg-muted" />
                  </td>
                  <td>
                    <Skeleton className="h-5 w-14 rounded-full bg-emerald-500/15 dark:bg-emerald-500/25" />
                  </td>
                  <td>
                    <Skeleton className="h-5 w-16 rounded-full bg-muted" />
                  </td>
                  <td>
                    <Skeleton className="h-3 w-8 bg-muted ml-auto" />
                  </td>
                  <td>
                    <Skeleton className="h-3 w-20 bg-muted ml-auto" />
                  </td>
                  <td>
                    <Skeleton className="h-3 w-12 bg-muted ml-auto" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
