import { PageLoadingWrapper, WatchlistSkeleton } from "@/components/skeletons";

export default function WatchlistLoading() {
  return (
    <PageLoadingWrapper title="Watchlists" breadcrumb="Workspace">
      <WatchlistSkeleton />
    </PageLoadingWrapper>
  );
}
