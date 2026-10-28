/**
 * Scans Library — server component (MONEY-795 · C2).
 *
 * Surfaces the unified `SCAN_CATALOG` (99 Chartink + research builtin +
 * core screener strategies) as a browseable library. Inline-runnable scans
 * (core fundamental) execute through the existing screener engine; the rest
 * are browse cards that route to the screener / chat (DEFERRED inline path).
 *
 * Structure mirrors `/discover/screener`: server fetches the (static)
 * catalog and hands it to the client, which owns category + search state.
 */

import { getScanCatalogAction } from "@/lib/actions/scans";
import ScansClient from "./client";

// Authed app page renders the shared <Sidebar/> shell (request-time
// useSearchParams), so static prerendering bails — match the rest of the app.
export const dynamic = "force-dynamic";

export const metadata = {
  // Root layout's metadata.title.template (`%s | UseMoney`) adds the suffix.
  title: "Scans",
  description:
    "A library of pre-built market scans — momentum, moving averages, value, volume, and more. Scans surface matching stocks; they are not buy/sell advice.",
};

export default async function ScansPage() {
  const catalog = await getScanCatalogAction();
  const scans = catalog.success ? catalog.data.scans : [];
  const categories = catalog.success ? catalog.data.categories : [];

  return <ScansClient scans={scans} categories={categories} />;
}
