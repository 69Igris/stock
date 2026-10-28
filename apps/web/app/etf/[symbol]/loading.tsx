/**
 * ETF Detail Loading skeleton (MONEY-457).
 *
 * Mirrors `/mf/[schemeCode]/loading.tsx` so the segment-transition
 * experience between MF and ETF detail pages is consistent. Orbit
 * icons are tinted amber to match the ETF pill colour in the header.
 */

import Sidebar from "@/components/Sidebar";
import AnimatedPageLoader from "@/components/AnimatedPageLoader";

export default function EtfDetailLoading() {
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="p-6 pb-24">
          <AnimatedPageLoader
            centerIcon={
              <svg
                className="w-16 h-16 text-amber-400"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                {/* Basket / ETF icon: container with stacked items */}
                <path d="M3 8h18l-2 12H5L3 8z" />
                <path d="M8 8V4a4 4 0 1 1 8 0v4" />
                <line x1="8" y1="13" x2="16" y2="13" />
                <line x1="8" y1="17" x2="16" y2="17" />
              </svg>
            }
            orbitIcons={[
              {
                color: "text-emerald-500",
                delay: 0,
                icon: (
                  <svg
                    className="w-6 h-6"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    {/* Trending up */}
                    <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
                    <polyline points="16 7 22 7 22 13" />
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
                color: "text-violet-500",
                delay: 0.6,
                icon: (
                  <svg
                    className="w-6 h-6"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    {/* Pie chart */}
                    <circle cx="12" cy="12" r="10" />
                    <path
                      d="M12 2a10 10 0 0 1 0 20"
                      fill="currentColor"
                      opacity="0.3"
                    />
                    <path d="M12 2v10l7 4" />
                  </svg>
                ),
              },
            ]}
            title="Loading ETF Details"
            subtitle="Fetching price history and fund composition"
            steps={[
              { label: "ETF metadata", delay: 0 },
              { label: "Price history", delay: 0.5 },
              { label: "Holdings & sector mix", delay: 1 },
            ]}
          />
        </div>
      </main>
    </div>
  );
}
