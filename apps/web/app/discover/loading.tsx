"use client";

/**
 * MONEY-394 M / MONEY-457 - /discover/loading.tsx is the Suspense
 * boundary for the whole /discover segment AND its nested children.
 *
 * The original fix returned `null` for sub-routes to avoid a brief
 * flash of the 'Discover' header before the child loading.tsx took
 * over. But Next.js treats `null` as a valid loading state — it does
 * NOT fall through to the child's loading.tsx. The result was a
 * blank black page for the entire SSR + transition window of /discover/
 * screener and /discover/markets.
 *
 * Fix: render the matching child skeleton inline so the user always
 * sees a structured loading state. Each child's full loading.tsx is
 * imported and rendered directly here — the child's own loading.tsx
 * still wins on direct hits, this only catches segment-transition
 * cases where Next.js mounts the parent loading.tsx first.
 */

import { usePathname } from "next/navigation";
import { PageLoadingWrapper, DiscoverSkeleton } from "@/components/skeletons";
import ScreenerLoading from "./screener/loading";
import MarketsLoading from "./markets/loading";
import ListsLoading from "./lists/loading";
import NewsLoading from "./news/loading";

export default function DiscoverLoading() {
  const pathname = usePathname() ?? "";

  // Sub-routes with their own loading.tsx — render the SAME content
  // here so the user never sees a blank null state during the parent-
  // segment loading window. The child's own loading.tsx will replace
  // this seamlessly once Next.js mounts it.
  if (pathname.startsWith("/discover/screener")) return <ScreenerLoading />;
  // MONEY-1092 - /discover/sectors is now a redirect to /discover/markets,
  // so the skeleton the user should see while it resolves is the MARKETS
  // one. Showing the old sectors skeleton would flash a layout that no
  // longer exists at a URL they are already leaving.
  if (
    pathname.startsWith("/discover/markets") ||
    pathname.startsWith("/discover/sectors")
  )
    return <MarketsLoading />;
  if (pathname.startsWith("/discover/lists")) return <ListsLoading />;
  if (pathname.startsWith("/discover/news")) return <NewsLoading />;

  return (
    <PageLoadingWrapper title="Discover">
      <DiscoverSkeleton />
    </PageLoadingWrapper>
  );
}
