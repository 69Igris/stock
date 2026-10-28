import { PageLoadingWrapper, HelpSkeleton } from "@/components/skeletons";

export default function HelpLoading() {
  return (
    <PageLoadingWrapper title="Help">
      <HelpSkeleton />
    </PageLoadingWrapper>
  );
}
