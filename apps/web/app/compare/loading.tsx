import Sidebar from "@/components/Sidebar";
import AnimatedPageLoader from "@/components/AnimatedPageLoader";

export default function CompareLoading() {
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
                {/* Brain/AI icon */}
                <path d="M12 2a4 4 0 0 0-4 4v1H6a4 4 0 0 0-4 4v2a4 4 0 0 0 4 4h1v1a4 4 0 0 0 8 0v-1h1a4 4 0 0 0 4-4v-2a4 4 0 0 0-4-4h-2V6a4 4 0 0 0-4-4Z" />
                <circle cx="9" cy="11" r="1" fill="currentColor" />
                <circle cx="15" cy="11" r="1" fill="currentColor" />
                <path d="M9 15c.83.67 2 1 3 1s2.17-.33 3-1" />
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
                    {/* Activity chart */}
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
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
                color: "text-amber-500",
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
            title="Crunching the Numbers"
            subtitle="Analyzing funds and building comparison"
            steps={[
              { label: "Fetching fund data", delay: 0 },
              { label: "Loading NAV history", delay: 0.5 },
              { label: "Building charts", delay: 1 },
            ]}
          />
        </div>
      </main>
    </div>
  );
}
