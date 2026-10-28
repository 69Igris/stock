"use client";

/**
 * MF Portfolio tab — MONEY-1204 (P14 / 14d.1).
 *
 * Renders the AMC's own monthly disclosure when it exists and a labelled
 * third-party reading when it does not. The label is the point: the two sources
 * disagree in ways a reader cannot see, and an unlabelled fallback is a silent
 * downgrade.
 *
 * Uses `SectionShell` for the loading/error/empty/data branch and the provenance
 * chip, so this file only describes the table.
 */

import { useEffect, useState } from "react";
import { PieChart, ArrowDownRight, ArrowUpRight } from "lucide-react";

import { SectionShell } from "@/components/stock/SectionShell";
import { getMfPortfolioSectionAction } from "@/lib/actions/mf-portfolio-section";
import type {
  MfPortfolioSectionData,
  WithProvenance,
} from "@usemoney/services";

interface Props {
  schemeCode: string;
  schemeName?: string;
}

/** `—` for a genuinely undisclosed weight. Never `0.00%`. */
function pct(v: number | null): string {
  return v === null || !Number.isFinite(v) ? "—" : `${v.toFixed(2)}%`;
}

export function MfPortfolioTab({ schemeCode, schemeName }: Props) {
  const [payload, setPayload] =
    useState<WithProvenance<MfPortfolioSectionData> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getMfPortfolioSectionAction({ schemeCode })
      .then((r) => {
        if (cancelled) return;
        if (r.success) setPayload(r.data);
        else setError(r.error ?? "Failed to load portfolio");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [schemeCode]);

  const data = payload?.data;
  const totals = data?.totals;
  const diff = data?.diff;

  return (
    <SectionShell
      title="Portfolio"
      Icon={PieChart}
      loading={loading}
      error={error}
      empty={payload?.empty ?? false}
      source={payload?.source}
      asOf={payload?.asOf}
      fallback={payload?.fallback}
      note={payload?.note}
      eyebrow={
        totals ? `${totals.disclosed + totals.undisclosed} holdings` : undefined
      }
      // MONEY-1255 — demoted. "not published one WE CAN READ" is the precise
      // claim and the reason it survives as a note: the AMC may well have
      // published a PDF our parser cannot open, which is our gap, not theirs.
      emptyNote={
        "We track SEBI-mandated monthly portfolio disclosures for" +
        `${schemeName ? ` ${schemeName}` : " this scheme"}. ` +
        "The AMC has not published one we can read yet."
      }
    >
      <div className="space-y-4">
        {totals && totals.undisclosed > 0 && (
          // Stating the denominator explicitly. "92.4%" alone invites the
          // reader to assume the remaining 7.6% is cash; it is simply not
          // disclosed, which is a different claim.
          <p className="font-mono text-[10.5px] uppercase tracking-[1px] text-[var(--text-muted)]">
            {totals.totalPct.toFixed(1)}% disclosed across {totals.disclosed} of{" "}
            {totals.disclosed + totals.undisclosed} holdings
          </p>
        )}

        {diff &&
          diff.previousPeriod &&
          (diff.entered.length > 0 || diff.exited.length > 0) && (
            <div className="flex flex-wrap gap-3 text-[12.5px]">
              {diff.entered.length > 0 && (
                <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-emerald-400">
                  <ArrowUpRight className="h-3.5 w-3.5" />
                  {diff.entered.length} new
                </span>
              )}
              {diff.exited.length > 0 && (
                <span className="inline-flex items-center gap-1 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-amber-400">
                  <ArrowDownRight className="h-3.5 w-3.5" />
                  {diff.exited.length} exited
                </span>
              )}
              <span className="font-mono text-[10.5px] uppercase tracking-[1px] text-[var(--text-dim)] self-center">
                vs {diff.previousPeriod.toString().slice(0, 10)}
              </span>
            </div>
          )}

        <div className="overflow-x-auto rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)]">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-[var(--border-default)] text-left font-mono text-[10px] uppercase tracking-[1px] text-[var(--text-muted)]">
                <th className="px-4 py-2">Holding</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2 text-right">Weight</th>
              </tr>
            </thead>
            <tbody>
              {(data?.lines ?? []).map((l, i) => (
                <tr
                  key={`${l.name}-${i}`}
                  className="border-b border-[var(--border-default)]/50 last:border-0"
                >
                  <td className="px-4 py-2 text-[var(--text-primary)]">
                    {l.name}
                  </td>
                  <td className="px-4 py-2 text-[var(--text-dim)]">
                    {l.holdingType}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-[var(--text-secondary)]">
                    {pct(l.weightPct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {(data?.unresolvedSchemes.length ?? 0) > 0 && (
          // Shown rather than hidden: "the AMC published holdings we could not
          // attach to this scheme" is useful; an empty tab implying the AMC
          // published nothing is misleading.
          <p className="text-[12px] italic text-[var(--text-dim)]">
            {data!.unresolvedSchemes.length} disclosure(s) from this AMC could
            not be matched to this scheme code.
          </p>
        )}
      </div>
    </SectionShell>
  );
}

export default MfPortfolioTab;
