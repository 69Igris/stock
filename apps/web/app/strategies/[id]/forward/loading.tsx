import {
  PageLoadingWrapper,
  GenericPageSkeleton,
} from "@/components/skeletons";

/**
 * MONEY-1256 — this route had no `loading.tsx`, so nothing rendered while the
 * server responded: the sidebar vanished and the page sat blank under the
 * topbar.
 *
 * The sidebar is rendered PER PAGE rather than by the root layout (see
 * `Sidebar.tsx` — hoisting it fires 19 middleware invocations per mount), so a
 * route with no loading state has no chrome at all until its page resolves.
 * `PageLoadingWrapper` supplies the same Sidebar + offset main the hydrated
 * page uses.
 */
export default function StrategyForwardLoading() {
  return (
    <PageLoadingWrapper>
      <GenericPageSkeleton />
    </PageLoadingWrapper>
  );
}
