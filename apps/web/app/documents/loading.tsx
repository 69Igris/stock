import { PageLoadingWrapper, DocumentsSkeleton } from "@/components/skeletons";

export default function DocumentsLoading() {
  return (
    <PageLoadingWrapper title="Document Vault" breadcrumb="Tools">
      <DocumentsSkeleton />
    </PageLoadingWrapper>
  );
}
