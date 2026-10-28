import { PageLoadingWrapper, TradebookSkeleton } from "@/components/skeletons";

/**
 * /tradebook/export - title "Export trades" + breadcrumb
 * "Portfolio · Tradebook" matches `<TerminalLuxeShell>` in the hydrated
 * page. Skeleton reuses TradebookSkeleton since the export page renders
 * a similar table view.
 */
export default function TradebookExportLoading() {
  return (
    <PageLoadingWrapper
      title="Export trades"
      breadcrumb="Portfolio · Tradebook"
    >
      <TradebookSkeleton />
    </PageLoadingWrapper>
  );
}
