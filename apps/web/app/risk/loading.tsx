import Sidebar from "@/components/Sidebar";
import AnimatedPageLoader from "@/components/AnimatedPageLoader";

export default function RiskLoading() {
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="p-6 pb-24">
          <AnimatedPageLoader
            centerIcon={
              <svg
                className="w-16 h-16 text-primary"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                {/* Shield with chart */}
                <path d="M12 2l8 4v6c0 5.25-3.5 9.74-8 11-4.5-1.26-8-5.75-8-11V6l8-4z" />
                <polyline points="8 14 10.5 11 13 13 16 9" />
                <circle cx="16" cy="9" r="1" fill="currentColor" />
              </svg>
            }
            orbitIcons={[
              {
                color: "text-amber-500",
                delay: 0,
                icon: (
                  <svg
                    className="w-6 h-6"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    {/* Alert triangle */}
                    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                ),
              },
              {
                color: "text-blue-500",
                delay: 0.3,
                icon: (
                  <svg
                    className="w-6 h-6"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    {/* Bar chart */}
                    <rect x="3" y="12" width="4" height="9" rx="1" />
                    <rect x="10" y="7" width="4" height="14" rx="1" />
                    <rect x="17" y="3" width="4" height="18" rx="1" />
                  </svg>
                ),
              },
              {
                color: "text-red-500",
                delay: 0.6,
                icon: (
                  <svg
                    className="w-6 h-6"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    {/* Trending down / drawdown */}
                    <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
                    <polyline points="16 17 22 17 22 11" />
                  </svg>
                ),
              },
            ]}
            title="Analyzing Portfolio Risk"
            subtitle="Computing risk metrics and correlations"
            steps={[
              { label: "Concentration", delay: 0 },
              { label: "Value at Risk", delay: 0.5 },
              { label: "Correlations", delay: 1 },
            ]}
          />
        </div>
      </main>
    </div>
  );
}
