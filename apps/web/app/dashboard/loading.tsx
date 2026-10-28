import Sidebar from "@/components/Sidebar";
import { DashboardSkeleton } from "@/components/skeletons";

export default function DashboardLoading() {
  return (
    <div className="h-screen bg-background overflow-hidden">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)] flex flex-col">
        <DashboardSkeleton />
      </main>
    </div>
  );
}
