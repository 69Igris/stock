import Sidebar from "@/components/Sidebar";
import { TutorSkeleton } from "@/components/skeletons";

// Chat-shaped fallback for the StockSage route (NOT the portfolio
// DashboardSkeleton — that was the bug where /dashboard?view=chat flashed the
// portfolio layout while loading the chat).
export default function StockSageLoading() {
  return (
    <div className="h-screen bg-background overflow-hidden">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)] flex flex-col">
        <TutorSkeleton />
      </main>
    </div>
  );
}
