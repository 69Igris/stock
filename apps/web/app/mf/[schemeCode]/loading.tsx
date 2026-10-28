import Sidebar from "@/components/Sidebar";
import AnimatedPageLoader from "@/components/AnimatedPageLoader";

export default function MfDetailLoading() {
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
                {/* Line chart / NAV icon */}
                <rect x="2" y="3" width="20" height="18" rx="2" />
                <polyline points="6 16 10 11 14 14 18 8" />
                <circle cx="18" cy="8" r="1.5" fill="currentColor" />
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
            title="Loading Fund Details"
            subtitle="Fetching NAV history and fund information"
            steps={[
              { label: "Fund metadata", delay: 0 },
              { label: "NAV history", delay: 0.5 },
              { label: "Returns & charts", delay: 1 },
            ]}
          />
        </div>
      </main>
    </div>
  );
}
