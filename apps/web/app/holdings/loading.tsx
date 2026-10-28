import { PageLoadingWrapper, HoldingsSkeleton } from "@/components/skeletons";

export default function HoldingsLoading() {
  return (
    <PageLoadingWrapper title="Holdings" breadcrumb="Portfolio">
      <HoldingsSkeleton />
    </PageLoadingWrapper>
  );
}
