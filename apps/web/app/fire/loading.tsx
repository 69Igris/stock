import { PageLoadingWrapper, FireSkeleton } from "@/components/skeletons";

export default function FireLoading() {
  return (
    <PageLoadingWrapper title="FIRE Calculator" breadcrumb="Tools">
      <FireSkeleton />
    </PageLoadingWrapper>
  );
}
