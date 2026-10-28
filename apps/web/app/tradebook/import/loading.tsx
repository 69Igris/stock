import { PageLoadingWrapper, TradebookSkeleton } from "@/components/skeletons";

/**
 * /tradebook/import inherits /tradebook/loading.tsx's fallback by
 * default - which renders "Tradebook" as the title. The hydrated page
 * uses `breadcrumb="Portfolio · Tradebook"` with title "Import trades",
 * so without this override the user sees a title flash on navigation.
 */
export default function TradebookImportLoading() {
  return (
    <PageLoadingWrapper
      title="Import trades"
      breadcrumb="Portfolio · Tradebook"
    >
      <TradebookSkeleton />
    </PageLoadingWrapper>
  );
}
