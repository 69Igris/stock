import { PageLoadingWrapper, LessonSkeleton } from "@/components/skeletons";

export default function LessonLoading() {
  return (
    <PageLoadingWrapper title="Lesson" breadcrumb="Learning">
      <LessonSkeleton />
    </PageLoadingWrapper>
  );
}
