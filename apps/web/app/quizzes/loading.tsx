import { PageLoadingWrapper } from "@/components/skeletons";
import { Skeleton } from "@usemoney/ui/skeleton";

function QuizzesSkeleton() {
  return (
    <div className="space-y-4">
      {/* Hero quiz cards - 1 mobile / 2 sm+ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Skeleton className="h-48 sm:h-56 bg-muted/60 rounded-xl" />
        <Skeleton className="h-48 sm:h-56 bg-muted/60 rounded-xl" />
      </div>
      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <Skeleton className="h-7 w-16 bg-emerald-500/15 dark:bg-emerald-500/25 rounded-md" />
        <Skeleton className="h-7 w-20 bg-muted rounded-md" />
        <Skeleton className="h-7 w-24 bg-muted rounded-md" />
      </div>
      {/* Quiz cards - 1/2/3 responsive */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-44 bg-muted/60 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

export default function QuizzesLoading() {
  return (
    <PageLoadingWrapper title="Quiz">
      <QuizzesSkeleton />
    </PageLoadingWrapper>
  );
}
