import { PageLoadingWrapper, TradebookSkeleton } from "@/components/skeletons";

export default function TradebookLoading() {
  return (
    <PageLoadingWrapper title="Tradebook" breadcrumb="Portfolio">
      <TradebookSkeleton />
    </PageLoadingWrapper>
  );
}
