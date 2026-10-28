import { PageLoadingWrapper, TutorSkeleton } from "@/components/skeletons";

export default function SageTutorLoading() {
  return (
    <PageLoadingWrapper title="StockSage Tutor">
      <TutorSkeleton />
    </PageLoadingWrapper>
  );
}
