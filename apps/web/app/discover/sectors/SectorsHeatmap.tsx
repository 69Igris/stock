"use client";

/**
 * Sectors Heatmap — playful (pf-*) re-skin (MONEY-485).
 *
 * Matches the design's Sectors screen: a top strip of sector tiles, the
 * full-width heatmap (sized by m-cap, coloured by timeframe change), a
 * RANKED pf-tbl table, and — when a sector is picked — the full Sector
 * Deep Dive panel below.
 *
 * Behaviour is unchanged from the prior Terminal-Luxe version:
 *   - Multi-timeframe (1D/1W/1M/YTD) via getSectorHeatmapAction, cached
 *     per-timeframe (module-level, TTL'd — see below) so toggling doesn't
 *     refetch and neither does leaving the canvas and coming back.
 *   - Picking a sector (tile, cell, or RANKED row) loads the detail panel
 *     BELOW the heatmap; the full-width grid never shrinks.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Loader2, ArrowRight, Layers } from "lucide-react";
import { heatColor } from "@/lib/sectors/aggregate";
import {
  getSectorHeatmapAction,
  type SectorHeatmapBucket,
} from "@/lib/actions/sector-heatmap";
import SectorDeepDive from "./SectorDeepDive";
import SectorsSkeleton from "./SectorsSkeleton";
import { EmptyState } from "@/components/empty/EmptyState";
import { resolveSectorSlug } from "@/lib/sectors/slug";

type Timeframe = "1D" | "1W" | "1M" | "YTD";

/** Internal marker distinguishing "the query succeeded but returned nothing"
 *  from a real failure. Never rendered — it only picks which state shows. */
const EMPTY_SENTINEL = "__empty__";

/* ------------------------------------------------------------------ *
 * MODULE-LEVEL sector store (MONEY-1126)
 * ------------------------------------------------------------------ *
 * `/discover/markets` opens on the STOCKS canvas, and this component is
 * mounted behind that canvas ternary — so Sectors → Stocks → Sectors is the
 * NORMAL interaction, and every return REMOUNTS this component. Held in a
 * `useRef` (as the per-timeframe cache was), the whole cache died with the
 * unmount and each return refetched from zero behind a full-box spinner.
 * Hoisted to module scope it outlives the unmount, so a return visit paints
 * the grid it was already showing.
 *
 * SAFETY — this store holds ONLY global market data, so it cannot leak
 * between users. A bucket is { name, mcap, change, count, top[] }: a sector
 * name, an aggregate market cap, an m-cap-weighted % change, a stock count
 * and the largest constituents. Nothing user-derived: no ids, no holdings,
 * no positions. `getSectorHeatmapAction` takes a timeframe and nothing else,
 * and the payload it returns is ALREADY cached server-side under
 * `scope: "_global"` (lib/actions/discover-heatmap.ts) — one copy shared by
 * every visitor, signed in or not. A per-tab client copy of a cache the
 * server deliberately shares across all users is strictly narrower than what
 * already exists, and a sign-out tears the JS heap down with the document
 * anyway.
 */

interface SectorCacheEntry {
  buckets: SectorHeatmapBucket[];
  /** Epoch ms this entry was stored. Drives the TTL below. */
  storedAt: number;
  /** SERVER-side staleness for THIS entry (null when freshly computed).
   *  Cached alongside the buckets for the same reason it is kept per
   *  timeframe: restoring buckets without it puts hours-old figures back on
   *  screen with the warning banner silently dropped. */
  staleSince: number | null;
}

/** Client-side freshness window.
 *
 *  Pinned to the server's own cadence: `getHeatmapDataAction` caches with
 *  `ttlSeconds: status.isLive ? 60 : 300`, so 60s is the SHORTEST interval in
 *  which the upstream could produce a different number. Holding a client copy
 *  longer than that risks showing figures the server has already replaced;
 *  holding it for less just re-asks a question the server answers from its
 *  own cache.
 *
 *  Deliberately a flat 60s rather than mirroring the live/closed split: an
 *  entry cached at 09:14 under the 300s "closed" TTL would otherwise survive
 *  four minutes into the live session, which is the one moment of the day the
 *  numbers move fastest. 60s is the conservative floor of the two. */
const SECTOR_CACHE_TTL_MS = 60_000;

/** The non-timeframe inputs to `getSectorHeatmapAction` from THIS call site.
 *  Both are fixed today — the action hard-codes `scope: "all"` internally and
 *  we never pass `topConstituents`, so it stays at its default 6 — but they
 *  are in the key anyway, so that the day either becomes a prop the key moves
 *  with it instead of silently serving one variant's data for another. */
const SECTOR_SCOPE = "all";
const SECTOR_TOP_N = 6;

const sectorCache = new Map<string, SectorCacheEntry>();

function sectorCacheKey(tf: Timeframe): string {
  return `${SECTOR_SCOPE}:${SECTOR_TOP_N}:${tf}`;
}

/** Deliberately NOT a type predicate (`entry is SectorCacheEntry`): a present
 *  entry can be expired, so narrowing the false branch to `undefined` would be
 *  a lie — and the compiler would then reduce the stale-while-revalidate path
 *  below to `never`. Callers pair it with a plain truthiness check. */
function isFreshEntry(entry: SectorCacheEntry): boolean {
  return Date.now() - entry.storedAt < SECTOR_CACHE_TTL_MS;
}

function readSectorCache(tf: Timeframe): SectorCacheEntry | undefined {
  return sectorCache.get(sectorCacheKey(tf));
}

function writeSectorCache(
  tf: Timeframe,
  buckets: SectorHeatmapBucket[],
  staleSince: number | null
): void {
  sectorCache.set(sectorCacheKey(tf), {
    buckets,
    storedAt: Date.now(),
    staleSince,
  });
}

function invalidateSectorCache(tf: Timeframe): void {
  sectorCache.delete(sectorCacheKey(tf));
}

/** The `initialBuckets` array already folded into the store. */
let ssrSeedIdentity: SectorHeatmapBucket[] | null = null;

/**
 * Fold the SSR props into the store, then hand back the 1D entry to seed
 * state from. Preserves the existing SSR behaviour exactly — non-empty
 * `initialBuckets` still paint immediately and still count as "already
 * fetched" for 1D — it just routes them through the store so a later remount
 * can find them.
 *
 * Guarded on the ARRAY IDENTITY rather than a boolean: a remount hands us the
 * same props object the page loaded with (already folded in — skip it, and
 * let it age out on schedule), while a genuinely new server render hands us a
 * new array (current — take it). Re-seeding on every mount would re-stamp
 * page-load data as brand new on every toggle back, and the TTL would never
 * fire.
 */
function seedSectorCacheFromSsr(
  initialBuckets: SectorHeatmapBucket[] | undefined,
  initialStaleSince: number | null
): SectorCacheEntry | undefined {
  if (initialBuckets?.length && ssrSeedIdentity !== initialBuckets) {
    ssrSeedIdentity = initialBuckets;
    writeSectorCache("1D", initialBuckets, initialStaleSince ?? null);
  }
  return readSectorCache("1D");
}

interface SectorsHeatmapProps {
  /** Initial data (SSR or first fetch) - when null, the component loads 1D. */
  initialBuckets?: SectorHeatmapBucket[];
  /** Set when `initialBuckets` came from a stale-fallback SSR serve. Without
   *  it the 1D grid is pre-marked fetched and never refetches, so stale SSR
   *  data renders as live for the whole session. */
  initialStaleSince?: number | null;
  /**
   * MONEY-1092 - the sector slug the parent wants selected.
   *
   * The parent seeds it from `?sector=` at first render and then OWNS it as
   * state, so this component is remounted with the CURRENT selection rather
   * than the page-load one — it lives behind the canvas toggle and unmounts
   * whenever the user switches to the stock treemap.
   *
   * Resolution happens here, not in the parent, because resolving a slug
   * needs the live bucket list and this component owns that. The parent
   * only ever handles slugs and canonical names, never the mapping.
   */
  initialSectorSlug?: string | null;
  /**
   * Fires with the canonical sector name whenever the selection changes,
   * or null when it is cleared. The parent uses this to keep `?sector=`
   * in step with what is on screen.
   */
  onSelectionChange?: (sector: string | null) => void;
  /**
   * MONEY-1126 — reports how many sector buckets are ACTUALLY rendered, so
   * the parent's caption can describe the screen instead of the SSR prop.
   * `initialSectorBuckets` is `[]` whenever the page's 6s `withTimeout`
   * fired, so a caption derived from it read "0 sectors" over a grid of
   * thirteen.
   *
   * `null` means "not known yet" — a fetch is in flight and there is nothing
   * on screen to count. It is distinct from `0`, which is a RESOLVED empty
   * result (pre-open, sparse env) and a truthful thing to print next to the
   * "No sector data yet" empty state.
   */
  onBucketCountChange?: (count: number | null) => void;
}

function formatLakhCr(mcap: number): string {
  const lakhCr = mcap / 100_000_000_000_000;
  if (lakhCr >= 1) return `₹${lakhCr.toFixed(1)} L Cr`;
  const cr = mcap / 10_000_000;
  if (cr >= 1000) return `₹${(cr / 1000).toFixed(1)}K Cr`;
  return `₹${cr.toFixed(0)} Cr`;
}

export default function SectorsHeatmap({
  initialBuckets,
  initialStaleSince = null,
  initialSectorSlug,
  onSelectionChange,
  onBucketCountChange,
}: SectorsHeatmapProps) {
  // Fold the SSR props into the module store and read back what we should
  // open on. A lazy initialiser so it runs once per mount, and FIRST — hook
  // initialisers run top-to-bottom, so everything below sees a seeded store.
  const [seed] = useState(() => {
    const entry = seedSectorCacheFromSsr(initialBuckets, initialStaleSince);
    return { entry, fresh: entry !== undefined && isFreshEntry(entry) };
  });
  const [tf, setTf] = useState<Timeframe>("1D");
  const [selected, setSelected] = useState<string | null>(null);
  // An EXPIRED entry still paints: showing last-minute figures while the
  // refetch runs underneath beats a skeleton, and it is what the server does
  // with its own stale-fallback copy.
  const [buckets, setBuckets] = useState<SectorHeatmapBucket[]>(
    seed.entry?.buckets ?? initialBuckets ?? []
  );
  // Open on the skeleton only when there is genuinely NOTHING to paint and a
  // fetch is coming. A fresh entry — including a fresh EMPTY one — means the
  // effect early-returns, so nothing is in flight to wait for.
  const [loading, setLoading] = useState(
    !seed.fresh &&
      (seed.entry?.buckets.length ?? initialBuckets?.length ?? 0) === 0
  );
  const [error, setError] = useState<string | null>(null);
  // Bumped by "Try again" so the fetch effect re-runs without a remount.
  const [reloadNonce, setReloadNonce] = useState(0);
  // Per-timeframe caching now lives in the MODULE-LEVEL `sectorCache` above,
  // not in refs here. The three refs it replaces (`byTfRef`, `staleByTfRef`,
  // `fetchedTfRef`) all died on unmount, which is exactly the bug: with the
  // Stocks canvas as the default, this component is unmounted and remounted
  // as a matter of routine.
  //
  // Everything the refs got right is preserved by construction:
  //  - It is a plain Map, NOT state. As state the old cache sat in its own
  //    effect's dependency array while the effect wrote it unconditionally
  //    with a fresh object, so an EMPTY-but-successful response produced a
  //    new reference, re-fired the effect and refetched forever with no
  //    backoff. A module Map is not reactive, so that cannot recur.
  //  - Staleness is stored per ENTRY, i.e. still per timeframe. Held
  //    globally it desynced on the cached early return: view a stale 1D,
  //    switch to a fresh 1W, switch back and the banner had been cleared —
  //    stale data on screen with no warning.
  //  - An entry is written on EVERY success including an empty one, so an
  //    empty result is still remembered as "fetched and empty" rather than
  //    retried indefinitely (now: until the TTL lapses, which is how the
  //    grid picks itself up shortly after 09:15 without a reload).
  const [staleSince, setStaleSince] = useState<number | null>(
    seed.entry ? seed.entry.staleSince : null
  );

  useEffect(() => {
    const cached = readSectorCache(tf);
    if (cached && isFreshEntry(cached)) {
      setBuckets(cached.buckets);
      // Everything that describes the CURRENT view has to be restored here,
      // not just the buckets. Each of these was a separate bug:
      //
      //  - staleness: held globally, a stale 1D switched away from and back
      //    to rendered with no warning at all.
      //  - error: never cleared, so a failed 1W left the "couldn't refresh"
      //    banner permanently over correctly-cached 1D data.
      //  - loading: this branch returns early, so if the user switched away
      //    from an in-flight fetch and back to a cached timeframe, the
      //    abandoned request's `.finally` bailed on `cancelled` and NOTHING
      //    ever cleared the flag — the spinner overlay covered the grid and
      //    swallowed every click until a reload.
      setStaleSince(cached.staleSince);
      setError(null);
      setLoading(false);
      return;
    }
    // Expired but present: paint it and revalidate underneath. Beats both a
    // blank grid and leaving the PREVIOUS timeframe's numbers sitting under
    // a "1W" header while the new ones load. (On mount this is a no-op —
    // `buckets` was already seeded from the same array.)
    if (cached) {
      setBuckets(cached.buckets);
      setStaleSince(cached.staleSince);
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSectorHeatmapAction({ timeframe: tf })
      .then((res) => {
        if (cancelled) return;
        if (!res.success || !res.data) {
          // MONEY-1092 - distinguish FAILED from EMPTY. The action used to
          // fold a successful-but-empty response into an error string, so
          // the UI could not tell "the query broke" from "the market has
          // no data yet" and showed the same alarming box for both.
          setError(res.success ? EMPTY_SENTINEL : res.error);
          return;
        }
        setBuckets(res.data.buckets);
        const staleAt = res.data.stale
          ? (res.data.staleSince ?? Date.now())
          : null;
        // Unconditional on success — INCLUDING an empty bucket list. That is
        // what remembers "fetched and empty" and stops the retry loop.
        writeSectorCache(tf, res.data.buckets, staleAt);
        setStaleSince(staleAt);
      })
      // Same missing-`.catch` defect the deep-dive had: a transport-level
      // rejection (function timeout) left `loading` true forever.
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof Error && err.message
            ? err.message
            : "Couldn't reach the server."
        );
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tf, reloadNonce]);

  // MONEY-1092 - apply `?sector=` once, as soon as there are buckets to
  // resolve it against. Guarded by a ref rather than by `selected === null`
  // so that clearing the panel does not re-open it from the stale URL on
  // the next render.
  const appliedInitialSlugRef = useRef(false);
  useEffect(() => {
    if (appliedInitialSlugRef.current) return;
    if (!initialSectorSlug || buckets.length === 0) return;
    appliedInitialSlugRef.current = true;
    const resolved = resolveSectorSlug(
      initialSectorSlug,
      buckets.map((b) => b.name)
    );
    // An unknown slug is treated as "no selection", not an error - a stale
    // bookmark should show the full heatmap rather than dead-end.
    if (resolved) setSelected(resolved);
  }, [initialSectorSlug, buckets]);

  // MONEY-1126 — tell the parent how many buckets are ON SCREEN. Its caption
  // used to count `initialSectorBuckets`, the SSR prop, which is `[]`
  // whenever the page's 6s `withTimeout` fired — so it announced "0 sectors"
  // above a fully-rendered grid. Reported from here because this component is
  // the only thing that knows what actually resolved.
  useEffect(() => {
    if (!onBucketCountChange) return;
    if (buckets.length > 0) {
      onBucketCountChange(buckets.length);
      return;
    }
    // Nothing to count. Only a SETTLED empty result is a real zero; while a
    // fetch is in flight the answer is simply unknown, and the parent must
    // omit the count rather than print a misleading "0 sectors".
    onBucketCountChange(loading ? null : 0);
  }, [buckets.length, loading, onBucketCountChange]);

  const totalMcap = useMemo(
    () => buckets.reduce((s, b) => s + b.mcap, 0),
    [buckets]
  );
  const sel = useMemo(
    () => buckets.find((b) => b.name === selected) ?? null,
    [buckets, selected]
  );

  // Picking a sector opens the inline deep-dive below; the full-width grid
  // never shrinks. (An `onSectorPick` prop used to be carried here for the
  // standalone /discover/sectors page to route into the screener. MONEY-1092
  // turned that page into a redirect and deleted its client, leaving the prop
  // with no caller, so it is gone — the inline panel is the only picked-sector
  // affordance now.)
  const pick = (name: string | null) => {
    setSelected(name);
    // Notify the parent so it can mirror the selection into `?sector=`.
    // Called from a click handler, never an effect — that ordering is what
    // keeps the URL write on the right side of the MONEY-1082 guard.
    onSelectionChange?.(name);
  };

  // MONEY-1126 — a skeleton in the shape of BOTH halves of this canvas (tile
  // heatmap + RANKED table), not a spinner in a 460px void. The old box
  // reserved the heatmap's height and none of the table's, so the page jumped
  // by ~600px the moment data landed.
  if (loading && buckets.length === 0) {
    return <SectorsSkeleton />;
  }

  // MONEY-1092 - the error surface only takes over when there is NOTHING to
  // render. The previous `if (error || ...)` collapsed an already-painted
  // grid into an error box whenever a TIMEFRAME SWITCH failed: the user had
  // working 1D data on screen, clicked 1W, the refetch failed, and the 1D
  // grid they were reading vanished. Now a failed switch keeps the last good
  // grid and reports the failure inline (see the banner below).
  const hasNothingToShow = !loading && buckets.length === 0;
  if (hasNothingToShow) {
    const isEmpty = error === EMPTY_SENTINEL || error === null;
    return (
      <EmptyState
        icon={isEmpty ? Layers : AlertCircle}
        muted={isEmpty}
        color="var(--pop-2)"
        title={
          isEmpty ? "No sector data yet" : "Couldn't load the sector heatmap"
        }
        description={
          isEmpty
            ? "Sector aggregates appear once the day's quotes land, shortly after 09:15 IST."
            : "The market heatmap didn't come back. This is usually temporary."
        }
        action={{
          label: "Try again",
          onClick: () => {
            invalidateSectorCache(tf);
            setReloadNonce((n) => n + 1);
          },
        }}
      />
    );
  }

  // Ranked by m-cap weight (matches the design's RANKED table ordering).
  const ranked = [...buckets].sort((a, b) => b.mcap - a.mcap);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* SERVER-side stale: the action's recompute failed and it served the
          last-known-good copy. This is a DIFFERENT mechanism from the
          client-side banner below (which fires on a failed fetch), and it
          had no UI at all — the flag was set on the server, dropped in
          transit, and never rendered, so hours-old market data reached the
          user looking exactly like live data. On a financial surface that
          is the worse failure, so it gets an explicit timestamp. */}
      {staleSince !== null && buckets.length > 0 && (
        <div
          className="pf-card flat"
          style={{
            padding: "8px 12px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12,
            color: "var(--ink-2)",
          }}
        >
          <AlertCircle
            className="h-3.5 w-3.5"
            style={{ color: "var(--pop-2)", flexShrink: 0 }}
          />
          <span>
            Live data unavailable — showing figures as of{" "}
            <span className="mono">
              {new Date(staleSince).toLocaleTimeString("en-IN", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            .
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="pf-bf sm"
            onClick={() => {
              invalidateSectorCache(tf);
              setReloadNonce((n) => n + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* CLIENT-side stale: a refetch failed but we still have a usable grid
          from an earlier timeframe — degrade, never dead-end, but never pass
          old numbers off as current either. */}
      {error && error !== EMPTY_SENTINEL && buckets.length > 0 && (
        <div
          className="pf-card flat"
          style={{
            padding: "8px 12px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12,
            color: "var(--ink-2)",
          }}
        >
          <AlertCircle
            className="h-3.5 w-3.5"
            style={{ color: "var(--pop-2)", flexShrink: 0 }}
          />
          <span>
            Couldn&apos;t refresh — showing the last figures that loaded.
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="pf-bf sm"
            onClick={() => {
              invalidateSectorCache(tf);
              setReloadNonce((n) => n + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Top strip — 6 sector tiles */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 10,
        }}
      >
        {buckets.slice(0, 6).map((s) => {
          const pos = s.change >= 0;
          return (
            <button
              key={s.name}
              onClick={() => pick(s.name)}
              className="pf-card flat"
              style={{
                padding: 12,
                textAlign: "left",
                cursor: "pointer",
                borderColor:
                  selected === s.name ? "var(--emerald)" : "var(--ink)",
              }}
            >
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--ink-3)",
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {s.name.replace("Nifty ", "")}
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 16,
                  fontWeight: 800,
                  marginTop: 4,
                  color: pos ? "var(--emerald-text)" : "#b91c1c",
                }}
              >
                {pos ? "▲" : "▼"} {Math.abs(s.change).toFixed(2)}%
              </div>
              <div
                className="mono"
                style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 4 }}
              >
                {formatLakhCr(s.mcap)} · {s.count} stocks
              </div>
            </button>
          );
        })}
      </div>

      {/* Heatmap header — title + timeframe switcher + legend */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 800, color: "var(--ink)" }}>
          Heatmap
        </div>
        <span
          className="mono"
          style={{ fontSize: 10.5, color: "var(--ink-3)" }}
        >
          sized by m-cap · coloured by {tf} change
        </span>
        <div style={{ flex: 1 }} />
        {/* Timeframe toggle */}
        <div
          style={{
            display: "flex",
            gap: 3,
            padding: 3,
            border: "1.5px solid var(--ink)",
            borderRadius: 8,
            background: "var(--paper)",
          }}
        >
          {(["1D", "1W", "1M", "YTD"] as const).map((t) => {
            const active = tf === t;
            return (
              <button
                key={t}
                onClick={() => setTf(t)}
                className="mono"
                style={{
                  padding: "5px 10px",
                  borderRadius: 5,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 0.3,
                  cursor: "pointer",
                  background: active ? "var(--ink)" : "transparent",
                  color: active ? "var(--paper)" : "var(--ink-3)",
                }}
              >
                {t}
              </button>
            );
          })}
        </div>
        {/* Legend */}
        <div
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 10.5,
            color: "var(--ink-3)",
          }}
        >
          <span
            style={{
              width: 14,
              height: 10,
              borderRadius: 2,
              background: "rgba(248,113,113,.5)",
            }}
          />
          <span>−5%</span>
          <span
            style={{
              width: 14,
              height: 10,
              borderRadius: 2,
              background: "rgba(248,113,113,.16)",
            }}
          />
          <span
            style={{
              width: 14,
              height: 10,
              borderRadius: 2,
              background: "rgba(120,120,120,.18)",
            }}
          />
          <span
            style={{
              width: 14,
              height: 10,
              borderRadius: 2,
              background: "rgba(52,211,153,.16)",
            }}
          />
          <span
            style={{
              width: 14,
              height: 10,
              borderRadius: 2,
              background: "rgba(52,211,153,.45)",
            }}
          />
          <span>+5%</span>
        </div>
      </div>

      {/* Full-width treemap — never shrinks when a sector is picked.
          The treemap canvas is intentionally a fixed deep-ink island in
          BOTH themes: heatColor's translucent green/red cell fills and
          light fg colors are tuned to read on a dark backdrop (this is a
          data-viz surface, not page chrome). Matches the design's
          SectorHeatmap (var(--ink) backdrop in its cream-default theme). */}
      <div
        className="pf-card"
        style={{ padding: 8, position: "relative", background: "#16140e" }}
      >
        {loading && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(0,0,0,0.3)",
              borderRadius: 14,
              zIndex: 10,
            }}
          >
            <Loader2
              className="h-5 w-5 animate-spin"
              style={{ color: "var(--emerald)" }}
            />
          </div>
        )}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            minHeight: 460,
          }}
        >
          {buckets.map((s) => {
            const c = heatColor(s.change);
            const w = (s.mcap / totalMcap) * 100;
            const big = w > 8;
            const isSelected = selected === s.name;
            return (
              <button
                key={s.name}
                onClick={() => pick(isSelected ? null : s.name)}
                style={{
                  flex: `${s.mcap} 1 ${Math.max(140, w * 5)}px`,
                  minWidth: 100,
                  background: c.bg,
                  border: isSelected
                    ? "2px solid var(--emerald)"
                    : `1px solid ${s.change >= 0 ? "rgba(52,211,153,.25)" : "rgba(248,113,113,.25)"}`,
                  borderRadius: 8,
                  padding: big ? 14 : 10,
                  color: c.fg,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: big ? 13.5 : 12,
                      fontWeight: 800,
                      color: c.fg,
                    }}
                  >
                    {s.name.replace("Nifty ", "")}
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: 10,
                      color: c.fg,
                      opacity: 0.7,
                      marginTop: 2,
                    }}
                  >
                    {formatLakhCr(s.mcap)}
                  </div>
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: big ? 18 : 14,
                    fontWeight: 800,
                    color: c.fg,
                  }}
                >
                  {s.change >= 0 ? "+" : ""}
                  {s.change.toFixed(2)}%
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* RANKED — sectors by m-cap weight + timeframe change */}
      <div className="pf-sec-h">
        <span className="n">RANKED</span>
        <h3>
          Sectors by <span className="ser">m-cap weight.</span>
        </h3>
        <span className="rule" />
        <span className="meta">change = {tf}</span>
      </div>
      <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table className="pf-tbl">
            <thead>
              <tr>
                <th style={{ paddingLeft: 18 }}>SECTOR</th>
                <th style={{ textAlign: "right" }}>WEIGHT</th>
                <th style={{ textAlign: "right" }}>{tf}</th>
                <th style={{ textAlign: "right" }}>M-CAP</th>
                <th style={{ textAlign: "right" }}>STOCKS</th>
                <th>TOP CONSTITUENT</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ranked.map((r) => {
                const weight = totalMcap > 0 ? (r.mcap / totalMcap) * 100 : 0;
                const pos = r.change >= 0;
                return (
                  <tr key={r.name}>
                    <td style={{ paddingLeft: 18, fontWeight: 700 }}>
                      {r.name.replace("Nifty ", "")}
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {weight.toFixed(1)}%
                    </td>
                    <td
                      className={`num ${pos ? "pos" : "neg"}`}
                      style={{ textAlign: "right", fontWeight: 700 }}
                    >
                      {pos ? "+" : ""}
                      {r.change.toFixed(2)}%
                    </td>
                    <td
                      className="num"
                      style={{ textAlign: "right", color: "var(--ink-3)" }}
                    >
                      {formatLakhCr(r.mcap)}
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {r.count}
                    </td>
                    <td>
                      {r.top[0] ? (
                        <span className="tk">{r.top[0].symbol}</span>
                      ) : (
                        <span style={{ color: "var(--ink-3)" }}>—</span>
                      )}
                    </td>
                    <td style={{ width: 70 }}>
                      <button
                        className="pf-bf sm"
                        style={{ padding: "3px 8px", fontSize: 11 }}
                        onClick={() => pick(r.name)}
                      >
                        Drill <ArrowRight size={11} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Full Sector Deep Dive panel — loads its own data. */}
      {sel && (
        <SectorDeepDive sectorName={sel.name} onClose={() => pick(null)} />
      )}
    </div>
  );
}
