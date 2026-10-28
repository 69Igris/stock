import {
  PageLoadingWrapper,
  StockDetailSkeleton,
} from "@/components/skeletons";

export default function StockDetailLoading() {
  return (
    <PageLoadingWrapper title="Stock" breadcrumb="Markets">
      <StockDetailSkeleton />
    </PageLoadingWrapper>
  );
}
