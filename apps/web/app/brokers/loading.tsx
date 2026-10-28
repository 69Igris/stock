import { PageLoadingWrapper, BrokersSkeleton } from "@/components/skeletons";

export default function BrokersLoading() {
  return (
    <PageLoadingWrapper title="Brokers" breadcrumb="Account">
      <BrokersSkeleton />
    </PageLoadingWrapper>
  );
}
