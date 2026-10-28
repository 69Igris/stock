import { PageLoadingWrapper, TradebookSkeleton } from "@/components/skeletons";

export default function TradebookImportHistoryLoading() {
  return (
    <PageLoadingWrapper
      title="Import history"
      breadcrumb="Portfolio · Tradebook"
    >
      <TradebookSkeleton />
    </PageLoadingWrapper>
  );
}
