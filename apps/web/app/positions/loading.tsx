import { PageLoadingWrapper, PositionsSkeleton } from "@/components/skeletons";

export default function PositionsLoading() {
  return (
    <PageLoadingWrapper title="Positions">
      <PositionsSkeleton />
    </PageLoadingWrapper>
  );
}
