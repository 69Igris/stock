import { permanentRedirect } from "next/navigation";
import { normalizeSectorSlug } from "@/lib/sectors/slug";

/**
 * /discover/sectors/[sector] → /discover/markets?sector=…  (MONEY-1092)
 *
 * This route was ORPHANED: nothing in the app linked to it — no `<Link>`,
 * no `router.push`, no redirect — and the only way to reach it was to type
 * the URL. It also had no SEO value to preserve despite its
 * `generateMetadata`, because `/discover(.*)` is auth-gated in
 * `proxy-routes.ts`, so a crawler never rendered it.
 *
 * It is kept as a permanent redirect purely for stray bookmarks. The
 * previous body (a second, differently-computed deep-dive built on a
 * SECOND `getSectorDeepDiveAction` that shared its name with the inline
 * panel's) is deleted — that name collision was how the two surfaces came
 * to report different numbers for the same sector.
 *
 * `permanentRedirect` (308) rather than `redirect` (307): the move is not
 * coming back, and a 308 lets clients update their own bookmarks.
 */
export const dynamic = "force-dynamic";

export default async function SectorDeepDiveRedirectPage(props: {
  params: Promise<{ sector: string }>;
}) {
  const { sector } = await props.params;
  // The param arrives percent-encoded; decode before normalising so
  // "Media%20%26%20Entertainment" folds to the same slug a click produces.
  const decoded = (() => {
    try {
      return decodeURIComponent(sector);
    } catch {
      // A malformed escape sequence shouldn't 500 the redirect.
      return sector;
    }
  })();
  permanentRedirect(
    `/discover/markets?sector=${encodeURIComponent(normalizeSectorSlug(decoded))}`
  );
}
