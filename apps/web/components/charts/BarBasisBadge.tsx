"use client";

/**
 * "Mid prices · no volume" — MONEY-1470 (A5).
 *
 * Shown ONLY for `quote_mid`. A `trade` series is the ordinary case and needs
 * no badge: labelling both would train the eye to ignore the label, which is
 * the same as not having one.
 *
 * See `lib/market/bar-basis.ts` for why the basis is read from a response
 * header rather than inferred from the market.
 */
import { useEffect, useState } from "react";
import {
  getBarBasis,
  subscribeBarBasis,
  type BarBasis,
} from "@/lib/market/bar-basis";

export function BarBasisBadge({ className = "" }: { className?: string }) {
  const [basis, setBasis] = useState<BarBasis | null>(getBarBasis);

  // The fetch wrapper that RECORDS the basis is installed by the chart, which
  // is the component that knows the service origin and is the one issuing the
  // requests. The badge only subscribes — installing it here would mean the
  // basis was recorded only while a badge happened to be mounted.
  useEffect(() => subscribeBarBasis(setBasis), []);

  if (basis !== "quote_mid") return null;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300 ${className}`}
      // The tooltip carries the WHY. The badge alone says "mid prices" and a
      // reader's next question is what that costs them.
      title="These bars are built from the midpoint of the bid/ask, because this feed publishes quotes rather than trades. Volume is reported as zero because the feed does not report it — not because nothing traded."
    >
      <span aria-hidden>◐</span>
      Mid prices · no volume
    </span>
  );
}
