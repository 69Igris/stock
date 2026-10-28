import {
  PageLoadingWrapper,
  CourseDetailSkeleton,
} from "@/components/skeletons";

export default function CourseDetailLoading() {
  return (
    <PageLoadingWrapper title="Course" breadcrumb="Learning">
      <CourseDetailSkeleton />
    </PageLoadingWrapper>
  );
}
