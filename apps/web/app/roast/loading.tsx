import Sidebar from "@/components/Sidebar";
import { RoastSkeleton } from "@/components/skeletons";

/**
 * /roast loading skeleton.
 *
 * Renders the same `<RoastSkeleton/>` PageGuard uses as its fallback so
 * stages 1 (loading.tsx) ↔ 2 (PageGuard fallback) ↔ 3 (hydrated) all
 * show the same hero + Roast me again CTA + collapsible config bar +
 * history grid layout. Chrome (Sidebar + max-w-5xl container) mirrors
 * the hydrated page exactly.
 */
export default function RoastLoading() {
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="p-6 pb-24 max-w-5xl mx-auto">
          <RoastSkeleton />
        </div>
      </main>
    </div>
  );
}
