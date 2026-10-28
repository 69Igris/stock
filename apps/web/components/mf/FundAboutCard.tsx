"use client";

/**
 * Fund "About" card for the Fund detail page (MONEY-245, design Image #34).
 *
 * Layout:
 *   [icon] About this fund
 *   [description (left, 2-col span)]   [meta-grid (right, 1-col span)]
 *
 * Meta rows (on the right): Sub-category, Fund Manager, AMC, Launch
 * date, Exit load, Benchmark.
 */

import { Info } from "lucide-react";
import { SECTION_EMPTY_BODY } from "@/components/stock/SectionShell";

interface FundAboutCardProps {
  description: string | null;
  descriptionLoading?: boolean;
  subCategory: string | null;
  fundManager: string | null;
  amcName: string;
  launchDate?: string | null;
  exitLoad?: string | null;
  benchmarkName?: string | null;
}

interface MetaRowProps {
  label: string;
  value: string | null;
}

function MetaRow({ label, value }: MetaRowProps) {
  return (
    <div className="grid grid-cols-2 gap-3 py-2 border-b border-[var(--border-default)] last:border-0">
      <span className="font-mono text-[10.5px] tracking-[1.2px] uppercase font-bold text-[var(--text-muted)]">
        {label}
      </span>
      <span className="text-[13px] text-[var(--text-primary)] font-medium text-right">
        {value || "-"}
      </span>
    </div>
  );
}

export function FundAboutCard({
  description,
  descriptionLoading,
  subCategory,
  fundManager,
  amcName,
  launchDate,
  exitLoad,
  benchmarkName,
}: FundAboutCardProps) {
  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-5">
      <div className="flex items-center gap-2 mb-3">
        <Info className="h-4 w-4 text-[var(--text-secondary)]" />
        <h3 className="font-display text-[16px] font-bold tracking-[-0.2px]">
          About this fund
        </h3>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8">
        {/* Description - left, takes 2 of 3 cols on desktop. */}
        <div className="lg:col-span-2">
          {descriptionLoading ? (
            <div className="space-y-2 animate-pulse">
              <div className="h-3 bg-muted rounded w-full" />
              <div className="h-3 bg-muted rounded w-11/12" />
              <div className="h-3 bg-muted rounded w-9/12" />
            </div>
          ) : description ? (
            <p className="text-[13.5px] text-[var(--text-secondary)] leading-relaxed">
              {description}
            </p>
          ) : (
            // MONEY-1255 — nothing demoted: the old sentence carried no
            // provenance beyond what the generic body already says.
            <p className="text-[13px] text-[var(--text-dim)]">
              {SECTION_EMPTY_BODY}
            </p>
          )}
        </div>

        {/* Meta column on the right. */}
        <div>
          <MetaRow label="Sub-category" value={subCategory} />
          <MetaRow label="Fund Manager" value={fundManager} />
          <MetaRow label="AMC" value={amcName} />
          <MetaRow label="Launch date" value={launchDate ?? null} />
          <MetaRow label="Exit load" value={exitLoad ?? null} />
          <MetaRow label="Benchmark" value={benchmarkName ?? null} />
        </div>
      </div>
    </div>
  );
}

export default FundAboutCard;
