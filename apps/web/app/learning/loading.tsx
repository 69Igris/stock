import { PageLoadingWrapper, LearningSkeleton } from "@/components/skeletons";

export default function LearningLoading() {
  return (
    <PageLoadingWrapper title="Courses">
      <LearningSkeleton />
    </PageLoadingWrapper>
  );
}
