import { PageLoadingWrapper } from "@/components/skeletons";
import { Skeleton } from "@usemoney/ui/skeleton";
import { Card, CardContent, CardHeader } from "@usemoney/ui/card";

export default function AnalysisDetailLoading() {
  return (
    <PageLoadingWrapper title="Research" breadcrumb="Detail">
      {/* Back button + meta chips (title comes from PageLoadingWrapper) */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Skeleton className="h-8 w-8 bg-muted rounded-md shrink-0" />
        <Skeleton className="h-5 w-20 bg-emerald-500/15 dark:bg-emerald-500/25 rounded-full" />
        <Skeleton className="h-5 w-16 bg-muted rounded-full" />
      </div>

      {/* Report column (full width on mobile/tablet, 3/5 on lg+) +
          Chat sidecar (full width / 2/5 on lg+). */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 lg:gap-6">
        <div className="lg:col-span-3 space-y-4">
          <Card className="bg-card/50 border-border">
            <CardHeader>
              <Skeleton className="h-7 w-56 max-w-full bg-muted mb-2" />
              <Skeleton className="h-4 w-72 max-w-full bg-muted" />
            </CardHeader>
            <CardContent>
              {/* Stats - 2-up on mobile, 4-up on sm+ */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
                {[1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-16 bg-muted rounded-md" />
                ))}
              </div>
              <Skeleton className="h-4 w-full bg-muted mb-2" />
              <Skeleton className="h-4 w-5/6 bg-muted mb-2" />
              <Skeleton className="h-4 w-3/4 bg-muted" />
            </CardContent>
          </Card>
          {/* Two more sections - match the streamed research blocks */}
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i} className="bg-card/50 border-border">
              <CardHeader>
                <Skeleton className="h-5 w-40 bg-muted" />
              </CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-4 w-full bg-muted" />
                <Skeleton className="h-4 w-5/6 bg-muted" />
                <Skeleton className="h-4 w-2/3 bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Chat column - collapses below report on mobile */}
        <div className="lg:col-span-2">
          <Card className="bg-card/50 border-border h-[400px] sm:h-[520px] lg:h-[600px]">
            <CardHeader>
              <Skeleton className="h-5 w-32 bg-muted" />
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <Skeleton className="h-10 w-3/4 bg-muted rounded-lg" />
                <Skeleton className="h-10 w-2/3 bg-muted rounded-lg ml-auto" />
                <Skeleton className="h-10 w-3/4 bg-muted rounded-lg" />
                <Skeleton className="h-10 w-1/2 bg-muted rounded-lg ml-auto" />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </PageLoadingWrapper>
  );
}
