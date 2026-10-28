import { StrategiesSkeleton, PageLoadingWrapper } from "@/components/skeletons";

export default function StrategyDetailLoading() {
  // MONEY-877: wrap in the shell so this L1 fallback keeps the sidenav instead of a
  // full-width stretched skeleton — the parent strategies/layout.tsx returns bare
  // children, so a bare skeleton here replaces the whole shell on first load.
  return (
    <PageLoadingWrapper>
      <StrategiesSkeleton />
    </PageLoadingWrapper>
  );
}
