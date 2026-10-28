import Sidebar from "@/components/Sidebar";
import { RoastDetailSkeleton } from "@/components/skeletons";

/**
 * /roast/[id] stage-1 loading skeleton.
 *
 * Uses the shared `<RoastDetailSkeleton/>` so stage 1 (this file),
 * stage 2 (PageGuard fallback in client.tsx) and stage 3 (hydrated)
 * all render the same back-arrow + meta strip + progress hero + tiles
 * shape inside the same `p-6 pb-24 max-w-5xl` chrome.
 */
export default function RoastDetailLoading() {
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="p-6 pb-24 max-w-5xl mx-auto">
          <RoastDetailSkeleton />
        </div>
      </main>
    </div>
  );
}
