import { redirect } from "next/navigation";
import { normalizeSectorSlug } from "@/lib/sectors/slug";

/**
 * /discover/sectors → /discover/markets  (MONEY-1092)
 *
 * The sectors surface merged into the markets page. Keeping the path as a
 * redirect rather than deleting it costs one file and covers three real
 * cases:
 *
 *   1. bookmarks and any external link to the old page;
 *   2. the "← Markets" / "Sectors" affordances that shipped pointing here;
 *   3. links of the form
 *      `/discover/sectors?sector=<name>` emitted by the now-deleted text-bar
 *      SectorHeatmap — which were LIVE and broken
 *      the whole time, because the sectors page never read that param.
 *      Forwarding it finally makes them do what they always claimed to.
 *
 * `?sector=` is normalised on the way through so a legacy link carrying a
 * display name ("Financial Services") lands on the same URL a click
 * produces today ("financial-services").
 */
export const dynamic = "force-dynamic";

export default async function SectorsRedirectPage(props: {
  searchParams: Promise<{ sector?: string }>;
}) {
  const { sector } = await props.searchParams;
  const slug = sector ? normalizeSectorSlug(sector) : null;
  redirect(
    slug
      ? `/discover/markets?sector=${encodeURIComponent(slug)}`
      : "/discover/markets"
  );
}
