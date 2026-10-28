"use client";

/**
 * News filter chips matching design Discover.jsx PageNews. Each chip
 * updates the URL search param `filter` and the parent server
 * component re-fetches via getNewsFeedAction. Default "all" maps to
 * the holdings + watchlists feed; the design also lists "My holdings"
 * (uses `holdings` source filter), "Watchlists" (`watchlists`),
 * "Market" (`market`), and "Earnings" (`earnings`).
 */

import { useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { useOwnedRoute } from "@/lib/hooks/useOwnedRoute";

type FilterKey = "all" | "holdings" | "watchlists" | "market" | "earnings";

const CHIPS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "holdings", label: "My holdings" },
  { key: "watchlists", label: "Watchlists" },
  { key: "market", label: "Market" },
  { key: "earnings", label: "Earnings" },
];

export default function FilterChips({
  active = "all",
}: {
  active?: FilterKey | string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const ownedRoute = useOwnedRoute();
  const [pending, startTransition] = useTransition();

  const handle = (k: FilterKey) => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (k === "all") params.delete("filter");
    else params.set("filter", k);
    const qs = params.toString();
    startTransition(() => {
      // MONEY-1082: guarded — `pathname` is captured at render, and the
      // transition means this can land after the user has moved on.
      ownedRoute.replaceRoute(qs ? `${pathname}?${qs}` : pathname);
    });
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        marginBottom: 16,
        flexWrap: "wrap",
      }}
    >
      {CHIPS.map((c) => {
        const isActive = c.key === active;
        return (
          <button
            key={c.key}
            onClick={() => handle(c.key)}
            disabled={pending}
            className={`pf-pill ${isActive ? "" : "outline"}`}
            style={{
              cursor: "pointer",
              fontSize: 11,
              padding: "5px 11px",
              background: isActive ? "var(--ink)" : "transparent",
              color: isActive ? "var(--paper)" : "var(--ink-2)",
              borderColor: "var(--ink)",
              opacity: pending ? 0.6 : 1,
            }}
          >
            {pending && isActive && (
              <Loader2 className="h-3 w-3 animate-spin" />
            )}
            {c.label}
          </button>
        );
      })}
    </div>
  );
}
