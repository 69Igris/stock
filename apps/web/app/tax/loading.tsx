import { PageLoadingWrapper, TaxSkeleton } from "@/components/skeletons";

export default function TaxLoading() {
  return (
    <PageLoadingWrapper title="Tax Report">
      <TaxSkeleton />
    </PageLoadingWrapper>
  );
}
