"use client";

/**
 * Shared chrome for every data-engine section on the stock page — MONEY-1204
 * (P14 / 14c.0).
 *
 * ## What it absorbs
 *
 * The loading → error → empty → data ternary was copy-pasted verbatim across
 * `StockNewsTab`, `StockPeersTab`, `StockShareholdingTab` and
 * `StockCorpActionsHistoryCard`. Lane 14c adds nine more sections. Ten copies of
 * a four-state branch is how one of them quietly loses its empty state and
 * starts rendering `null` — which is the bug `stock-tabs-split.test.ts` already
 * has a regression case for.
 *
 * MONEY-1255 finished the job for the EMPTY branch specifically: the box is
 * now {@link SectionEmpty}, exported so the sections that never adopted the
 * whole shell stop re-typing its className, and its body is one shared
 * sentence rather than nineteen. (`StockShareholdingTab` above is gone — it
 * had zero importers and was deleted in the same change.)
 *
 * ## Why it does NOT use `components/empty/EmptyState`
 *
 * That component is the PAGE-level empty: rotated accent square, hard shadow,
 * CTA buttons. The stock page's section-level empty is a quieter dashed box.
 * Both are correct in their own place, and the stock page today uses only the
 * dashed one. Importing the page-level treatment here would put two visual
 * languages side by side inside a single tab — worse than either alone. If the
 * two should converge, that is a design decision for the whole app, not
 * something to settle by picking whichever was nearer to hand.
 *
 * ## Provenance is a first-class prop, not a nicety
 *
 * Every section this wraps reads a table the user has not seen before, and
 * several of them (shareholding, financials, movers, MF portfolio) fall back to
 * a different provider under conditions the user cannot observe. An unlabelled
 * fallback is a silent downgrade. So `source` renders as a visible chip,
 * `fallback` marks it explicitly, and `asOf` is always shown when known — a
 * section that stopped updating three weeks ago is indistinguishable from a
 * quiet market without it.
 *
 * Theme-aware tokens only. Neutrals come from `var(--…)`; accents may use the
 * literal Tailwind palette, which is the established house split in
 * `components/stock/*` (11 of 13 files carry zero hex literals).
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import type { UsQuoteSource } from "@usemoney/core/market-data/tiingo/tiingo-rt-read-logic";

/**
 * Labels for the US quote path's sources — MONEY-1309 follow-up.
 *
 * `Record<UsQuoteSource, string>` and not two more rows in `KNOWN`, because the
 * rows are exactly what keeps failing. `KNOWN` has now been short by omission
 * THREE times: MONEY-1204 (four UPPER_SNAKE discover codes rendered as
 * `NSE_FII_DII_CASH` on screen), MONEY-1207 (P14 put four vendor names back on
 * the stock page through it), and this one — the US quote path shipped with no
 * entry at all, so a US price header rendered `TIINGO RT · 30 Aug 2026` with a
 * `Source: TIINGO RT` tooltip. Each time the fix was "add the missing rows",
 * and each time the next new source arrived with nobody to notice.
 *
 * A `Record` over a real union cannot be short. Add a member to `UsQuoteSource`
 * in core and `yarn workspace @usemoney/web type-check` fails here until it has
 * a label — a compiler check rather than a reviewer's memory. It is spread into
 * `KNOWN` below, so lookup and every existing table guard are unchanged.
 *
 * A blanket "unknown → generic label" default was the other candidate and is
 * REJECTED: MONEY-1213 deliberately leaves an unmapped code rendering raw
 * ("BHAVCOPY", not a polished "Exchange price file") so a missing entry is
 * obviously wrong on sight instead of plausibly right, and
 * `section-shell-labels.test.ts` pins both directions. Exhaustiveness where a
 * union exists, loudness where one does not.
 *
 * Both decode to the generic label for the same reason TICKERTAPE and YAHOO do:
 * the producing party is a data VENDOR, not an authority, and MONEY-1144's rule
 * is that we name exchanges, regulators and issuers — never who we buy from.
 * The live-vs-EOD distinction a reader can actually act on is carried by the
 * `fallback` pill, the provenance tooltip and `DelayedDataNote`, all of which
 * read the same `fallback` flag; it is not this label's job.
 */
const US_QUOTE_SOURCE_LABELS: Record<UsQuoteSource, string> = {
  TIINGO_RT: "Third-party data",
  TIINGO: "Third-party data",
};

export interface SectionProvenance {
  /** Producing source as stored, e.g. "NSE_SHP" / "TICKERTAPE" / "nse-fii-stats". */
  source?: string | null;
  /** ISO timestamp of what the data DESCRIBES (not when it was fetched). */
  asOf?: string | null;
  /** True when `source` is not this section's preferred provider. */
  fallback?: boolean;
  /** One-line note surfaced in the provenance tooltip. */
  note?: string;
}

/**
 * The one empty-state body — MONEY-1255.
 *
 * Nineteen sections across `/stock/[symbol]`, `/mf/[schemeCode]` and
 * `/etf/[symbol]` each wrote their own sentence. Read one at a time they were
 * all defensible; read down the page they were nineteen different voices
 * saying the same thing at three different lengths, and the reader learned to
 * skip the box rather than read it.
 *
 * ## What the sentences were carrying, and where it went
 *
 * Nine of them encoded a real distinction — *we have not fetched it* versus
 * *the exchange genuinely published nothing* — and one
 * (`StockShareholdingSection`) carries a comment recording that the PREVIOUS
 * copy made the wrong one of those two claims and was rewritten for exactly
 * this reason. Flattening that to silence would re-introduce a known defect.
 *
 * So it is DEMOTED, not deleted: the visible body is this constant, and the
 * provenance sentence (plus any coverage window or backfill caveat) moves to
 * `emptyNote`, which renders as the box's tooltip — the same `title=` +
 * `cursor-help` mechanism `ProvenanceChip` already uses a few lines below.
 */
export const SECTION_EMPTY_BODY = "No data available";

export interface SectionEmptyProps {
  /**
   * The demoted provenance: "we have not fetched it" vs "nothing was
   * published", a coverage window, a backfill caveat. Tooltip ONLY — never the
   * visible body, which is always {@link SECTION_EMPTY_BODY}.
   */
  note?: string | null;
  /**
   * A load-bearing affordance rendered under the body — e.g. the Financials
   * panel's "View annual" switch, which is the whole reason that section
   * distinguishes "this period is empty" from "unknown".
   */
  action?: ReactNode;
  /**
   * Escape hatch for the `/discover` lane, which is OUT of MONEY-1255's scope
   * (stock + MF + ETF detail pages only) and still passes its own prose
   * through `SectionShell.emptyMessage`. In-scope sections must leave this
   * undefined; `empty-state-copy.test.ts` fails the build if one does not.
   */
  children?: ReactNode;
  className?: string;
}

/**
 * The section-level empty box. Was copy-pasted verbatim into `StockNewsTab`,
 * `StockPeersTab`, `StockCorpActionsHistoryCard` and — as CSS rather than
 * classNames — `financials-playful.css`'s `.fin-empty-card`.
 */
export function SectionEmpty({
  note,
  action,
  children,
  className = "",
}: SectionEmptyProps) {
  const tip = note?.trim() ? note.trim() : undefined;
  return (
    <div
      title={tip}
      className={
        "rounded-[14px] border-2 border-dashed border-[var(--rule-soft)] " +
        "bg-[var(--paper)] px-6 py-10 text-center text-[13px] italic text-[var(--ink-3)]" +
        (tip ? " cursor-help" : "") +
        (className ? ` ${className}` : "")
      }
    >
      {children ?? SECTION_EMPTY_BODY}
      {action}
    </div>
  );
}

/**
 * The same body at sub-panel weight — for an empty rung INSIDE a section that
 * itself has data (a derivatives panel with no SLB rows, the buy/sell columns
 * of "Funds holding this stock"). No dashed box: two nested boxes read as a
 * broken layout, which is why these were hand-rolled as bare text originally.
 */
export function SectionEmptyInline({
  note,
  className = "",
}: {
  note?: string | null;
  className?: string;
}) {
  const tip = note?.trim() ? note.trim() : undefined;
  return (
    <div
      title={tip}
      className={
        "text-[12.5px] italic text-[var(--ink-3)]" +
        (tip ? " cursor-help" : "") +
        (className ? ` ${className}` : "")
      }
    >
      {SECTION_EMPTY_BODY}
    </div>
  );
}

export interface SectionShellProps extends SectionProvenance {
  title: string;
  Icon?: LucideIcon;
  /** Small right-aligned count/label beside the title. */
  eyebrow?: string;
  loading?: boolean;
  error?: string | null;
  /** True when there is genuinely nothing to show. Comes from the envelope. */
  empty?: boolean;
  /**
   * Legacy prose override for the empty body.
   *
   * The stock / MF / ETF sections no longer pass this — the body is
   * {@link SECTION_EMPTY_BODY} for all of them and the section-specific
   * sentence lives in {@link emptyNote}. It survives ONLY because the
   * `/discover` lane also mounts `SectionShell` and is out of MONEY-1255's
   * scope; deleting the prop would have edited six components the founder's
   * decision did not cover.
   */
  emptyMessage?: ReactNode;
  /**
   * Provenance for the EMPTY state, surfaced as the empty box's tooltip.
   * Defaults to the envelope's {@link SectionProvenance.note} — on an empty
   * section `ProvenanceChip` usually renders nothing (it needs a `source` or
   * an `asOf`, and an empty envelope frequently has neither), so without this
   * the note would have nowhere to appear at all.
   */
  emptyNote?: string | null;
  /** A load-bearing affordance under the empty body — see {@link SectionEmptyProps.action}. */
  emptyAction?: ReactNode;
  /** Rendered while `loading` — pass a shimmer that mirrors the real layout. */
  skeleton?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** Decode a stored source code into something a human reads. */
export function sourceLabel(source: string | null | undefined): string {
  if (!source) return "—";
  const KNOWN: Record<string, string> = {
    // A label names WHAT the reader is looking at — never the filing format we
    // parse, nor the SEBI regulation the disclosure is filed under. "XBRL" is
    // the machine-readable format our ingest reads; "PIT" and "SAST" are
    // rulebook shorthand. A retail investor learns nothing actionable from any
    // of the three, which is the same test MONEY-1144 applied to vendor names.
    NSE_XBRL: "NSE filing",
    NSE_SHP: "NSE shareholding",
    // MONEY-1255 — BSE files its own shareholding pattern, and 2,605 symbols
    // have a BSE row and NO NSE one. Those pages were served entirely from
    // BSE's filing under the "NSE shareholding" label above, because the
    // section returned a CONSTANT source instead of the winning row's. The
    // label is the only thing on the page that says where a number came from,
    // so a missing entry here would put the fix one raw code away from being
    // undone.
    BSE_SHP: "BSE shareholding",
    // The per-category breakdown parsed from the filing NSE attaches to the
    // same payload — a different table, a different fetch, and a different
    // completeness story from the summary row above, hence its own label. No
    // "XBRL": that is the machine format our ingest reads, and MONEY-1213
    // banned format vocabulary from this chip.
    NSE_SHP_XBRL: "NSE shareholding filing",
    NSE_SLB: "NSE securities lending",
    NSE_PIT: "NSE insider trading",
    NSE_SAST: "NSE substantial acquisitions",
    NSE_PLEDGE: "NSE pledge",
    NSE_DEALS: "NSE bulk/block deals",
    NSE_INDICES: "NSE indices",
    // NO VENDOR NAMES. MONEY-1144 removed "TICKERTAPE" and "Yahoo" pills from
    // this page for a reason that has not changed: naming who we buy or scrape
    // data FROM tells the reader nothing they can act on and exposes our supply
    // chain. P14 reintroduced all four through this table — the MONEY-1144
    // guard only ever covered the two old pills, so nothing caught it.
    //
    // What a reader CAN act on is authority, and that distinction survives:
    // an exchange/regulator/issuer is named (NSE, BSE, RBI, AMFI, the AMC's own
    // disclosure), everything else is "third-party". Keep the raw code in the
    // DB and in support tooling; it just does not reach the screen.
    TICKERTAPE: "Third-party data",
    SCREENER: "Third-party data",
    YAHOO: "Third-party data",
    KUVERA: "Third-party data",
    // The US quote path's two sources, spread in from a Record over their own
    // TypeScript union so this table cannot be short by one again. See
    // {@link US_QUOTE_SOURCE_LABELS}.
    ...US_QUOTE_SOURCE_LABELS,
    // MONEY-1213 — there is deliberately NO `BHAVCOPY` / `BHAVCOPY_HIST` entry.
    //
    // "Bhavcopy" is the exchange's own filename for the end-of-day price dump
    // we ingest. It is pipeline vocabulary, and the only surface that ever put
    // it on screen — `StockDeliveryChip`, which led with "EXCHANGE BHAVCOPY /
    // 20/20 SESSIONS REPORTED" — is deleted.
    //
    // Removing the rows is not merely dead-code tidying. `DailyPrice.source`
    // still stores both codes and `getStockDeliveryTrend` still stamps them
    // onto its provenance envelope for the /v1 mobile route, so the value is
    // one `source={…}` away from this function at all times. With an entry it
    // would render as polished product copy the moment someone wires that
    // envelope to a `SectionShell`; without one the UPPER_SNAKE fallback
    // renders the bare code "BHAVCOPY", which is obviously wrong on sight
    // instead of plausibly right. Keep the failure loud.
    // Discover-lane codes (`SRC_*` in discover-sections.service.ts). Four of
    // the six were UPPER_SNAKE and so matched neither the table nor the
    // lowercase-slug fallback below — they rendered on screen as raw
    // `NSE_FII_DII_CASH`. Hence both the entries and the second fallback.
    NSE_FII_DII_CASH: "NSE FII/DII cash",
    RBI_MOSPI_OEA: "RBI / MoSPI / OEA",
    NSE_IPO: "NSE IPO",
    NSE_CIRCULARS: "NSE circulars",
    // `discover-sections.service.ts` mints this one as
    // `${SRC_POSITIONING}-${metric.toLowerCase()}`, so the BASE constant is
    // never the string that reaches this table — the two suffixed forms are.
    // `source-label-coverage.test.ts` scans the CONSTANT, not the template, so
    // the base key satisfied coverage while the values actually rendered fell
    // through to the slug fallback and printed "NSE fao participant oi" on
    // /discover/markets. The base entry stays as the safety net for any future
    // metric; the two live values get real labels.
    "nse-fao-participant": "NSE F&O participants",
    // Suffixes are `PARTICIPANT_METRICS` lower-cased — "oi" and "volume".
    "nse-fao-participant-oi": "NSE F&O participant open interest",
    "nse-fao-participant-volume": "NSE F&O participant volume",
    // MF portfolio lane. The distinction is the point: one is the AMC's own
    // SEBI-mandated disclosure, the other is derived and is the fallback.
    MF_PORTFOLIO: "AMC portfolio disclosure",
    FUND_HOLDING: "Fund holdings (derived)",
    // `StockDocument.sourceType`.
    // "(fetched)" named OUR pipeline step, not where the document came from.
    NSE_FETCH: "NSE",
    UPLOAD: "Uploaded",
    URL: "External link",
    GENERATED: "Generated",
  };
  if (KNOWN[source]) return KNOWN[source];
  // Two naming conventions reach this function, and BOTH need a graceful
  // fallback or a new code ships to screen as a raw slug.
  //
  // 1. Registry family ids, lowercase-hyphen: "nse-fii-stats".
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(source)) {
    return source
      .split("-")
      .map((w, i) => (i === 0 ? w.toUpperCase() : w))
      .join(" ");
  }
  // 2. Stored source codes, UPPER_SNAKE: "NSE_FII_DII_CASH". This branch did
  //    not exist, which is why four discover codes rendered raw. Tokens are
  //    left cased as written — they are overwhelmingly acronyms (NSE, FII,
  //    RBI), and lowercasing them to look tidy would corrupt the one part of
  //    the string that carries meaning.
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(source)) {
    return source.split("_").join(" ");
  }
  return source;
}

/**
 * The wall clock an `asOf` instant belongs to — MONEY-1309 follow-up.
 *
 * A date is a projection of an instant onto SOME timezone, and which one is not
 * a formatting preference — it decides which SESSION the reader is told they
 * are looking at. `formatAsOf` hardcoded IST, correctly, while every source in
 * the table was Indian. A US close is `2026-08-29T20:00:00Z`, which is 01:30 IST
 * on the 30th, so every US quote rendered its session date ONE DAY LATE — and
 * the number beside it was genuinely the 29th's.
 *
 * Derived from the SAME `Record` that supplies the label, so a new member of
 * `UsQuoteSource` gets the right clock and the right label from one edit. A
 * second hand-maintained list of "which sources are American" is precisely what
 * `marketForExchange` in core carries a warning about (MONEY-1093).
 *
 * The zone string is the one `packages/core/market-data/us-market-hours.ts`
 * uses for every session boundary; `Intl` reads the ICU tzdata, so EDT/EST is
 * handled by the platform rather than by an offset we would have to maintain.
 * That module's `usMarketDateKey` answers the same question for HOLIDAY lookups
 * and is deliberately not imported here — a date rendering needs the zone, not
 * the 200-row holiday table, and this is a client component.
 */
const US_QUOTE_SOURCES: ReadonlySet<string> = new Set(
  Object.keys(US_QUOTE_SOURCE_LABELS)
);

/** IANA zone the given provenance source's timestamps should be read in. */
export function marketTimeZoneForSource(
  source: string | null | undefined
): string {
  return source && US_QUOTE_SOURCES.has(source)
    ? "America/New_York"
    : "Asia/Kolkata";
}

/**
 * "14 Aug 2026" — short, unambiguous, no locale surprises.
 *
 * `source` is optional and selects the market clock; omitted means India, which
 * is what every one of the ~20 existing call sites means and keeps them
 * byte-identical. It takes the SOURCE rather than a timezone so a caller cannot
 * pass a date and forget its clock — the chip below already has the source in
 * hand.
 */
export function formatAsOf(
  iso: string | null | undefined,
  source?: string | null
): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: marketTimeZoneForSource(source),
  });
}

/**
 * The provenance chip — source, as-of date, and a `fallback` marker.
 *
 * EXPORTED as of MONEY-1309. It was internal because `SectionShell` was its only
 * caller; the US quote header needs the identical chip and re-implementing it
 * there would put two visual languages on one page for the same fact, which is
 * the exact argument this file already makes against importing the page-level
 * empty state. Same component, same tooltip grammar, same `fallback` meaning.
 */
export function ProvenanceChip({
  source,
  asOf,
  fallback,
  note,
}: SectionProvenance) {
  const label = sourceLabel(source);
  const when = formatAsOf(asOf, source);
  if (!source && !when) return null;

  const tip = [
    source ? `Source: ${label}` : null,
    when ? `As of ${when}` : null,
    fallback
      ? "Fallback source — the preferred one has no data for this stock"
      : null,
    note ?? null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span
      title={tip}
      className={
        "ml-auto flex items-center gap-1.5 font-mono text-[10px] uppercase " +
        "tracking-[1px] text-[var(--text-muted)] cursor-help"
      }
    >
      {fallback && (
        <span className="rounded border border-amber-400/30 bg-amber-400/10 px-1 py-px text-amber-400 normal-case tracking-normal">
          fallback
        </span>
      )}
      {source && <span>{label}</span>}
      {when && <span className="text-[var(--text-dim)]">· {when}</span>}
    </span>
  );
}

export function SectionShell({
  title,
  Icon,
  eyebrow,
  loading = false,
  error = null,
  empty = false,
  emptyMessage,
  emptyNote,
  emptyAction,
  skeleton,
  children,
  className = "",
  ...prov
}: SectionShellProps) {
  return (
    <section className={className}>
      <div className="mb-3 flex items-center gap-2">
        {Icon && <Icon className="h-4 w-4 text-emerald-400" />}
        <h3 className="font-display text-[15px] font-bold tracking-[-0.2px]">
          {title}
        </h3>
        {eyebrow && (
          <span className="ml-2 font-mono text-[10.5px] uppercase tracking-[1px] text-[var(--text-muted)]">
            {eyebrow}
          </span>
        )}
        <ProvenanceChip {...prov} />
      </div>

      {loading ? (
        (skeleton ?? <DefaultSkeleton />)
      ) : error ? (
        <div className="rounded-xl border border-red-400/20 bg-red-400/5 p-6 text-center text-sm text-red-400/80">
          {error}
        </div>
      ) : empty ? (
        // Never `return null` for an empty section. A tab that exists but
        // renders nothing reads as a broken page. What the box SAYS is now one
        // sentence everywhere (MONEY-1255); what it KNOWS — "we have not
        // fetched it" vs "nothing was published", plus any coverage window —
        // rides along in the tooltip instead of being deleted.
        <SectionEmpty
          note={emptyNote ?? prov.note}
          action={emptyAction}
          // Out-of-scope `/discover` prose only; undefined for stock/MF/ETF.
        >
          {emptyMessage}
        </SectionEmpty>
      ) : (
        children
      )}
    </section>
  );
}

function DefaultSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="animate-pulse rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4"
        >
          <div className="mb-2 h-3 w-24 rounded bg-emerald-400/[0.10]" />
          <div className="h-4 w-3/4 rounded bg-white/[0.06]" />
        </div>
      ))}
    </div>
  );
}

export default SectionShell;
