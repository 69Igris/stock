/**
 * Derive former-symbol aliases from dated (symbol, ISIN) observations —
 * MONEY-1177.
 *
 * ## Why this can be derived at all
 *
 * `syncInstruments` upserts on `(symbol, exchange)`, so a rename creates a NEW
 * row and leaves the old one to be deactivated. Nothing anywhere records "this
 * used to be called ZOMATO", and the retired ticker then matches nothing.
 *
 * But every archived bhavcopy carries `(symbol, ISIN)` pairs stamped with a
 * trading date, and ISIN survives a rename — it is exactly what let
 * `resolveInstrumentId` reattach Zomato-era prices to ETERNAL during the
 * MONEY-1175 re-parse. So the rename history is already in the archive; it just
 * has to be read out of it. No external source, no scraping.
 *
 * ## The rule that makes this safe: succession, not coexistence
 *
 * Grouping by ISIN alone is NOT enough. Several symbols legitimately share one
 * ISIN at the same time — rights entitlements (`-RE`), partly-paid variants
 * (`-PP`), and series suffixes like `CITIUSINVT` / `CITIUSINVT-IV`. Calling
 * those "former symbols" would be wrong and would pollute search.
 *
 * The distinction is temporal, and it is crisp:
 *
 *   a RENAME is a SUCCESSION  — the old symbol stops appearing when the new one starts
 *   a VARIANT is a COEXISTENCE — both appear on the same days
 *
 * So a candidate becomes an alias only when its last sighting precedes the
 * current symbol's first sighting. That one test rejects every variant without
 * needing a suffix blocklist, which would be a guess about NSE's naming and
 * would rot.
 *
 * ## What it deliberately cannot see
 *
 * A demerger where the successor got a NEW ISIN (TATAMOTORS -> TMCV) is
 * invisible here — there is no shared key to group on. Those need an explicit
 * seed list; see the caller. TATAMOTORS -> TMPV IS derivable, because TMPV
 * kept INE155A01022.
 */

/** One sighting of a symbol under an ISIN on a given day. */
export interface SymbolObservation {
  isin: string;
  symbol: string;
  exchange: string;
  /** Trading day, ms since epoch. */
  date: number;
}

/** The window over which one symbol was seen under one ISIN. */
export interface SymbolSpan {
  symbol: string;
  firstSeen: number;
  lastSeen: number;
  /** How many sampled files carried it — a one-off is probably a bad parse. */
  observations: number;
}

export interface AliasDecision {
  isin: string;
  exchange: string;
  currentSymbol: string;
  aliases: string[];
  rejected: Array<{ symbol: string; reason: string }>;
}

/**
 * Group key. ISIN is global but instrument rows are per exchange.
 *
 * Deliberately NOT called `isinExchangeKey`: `bhavcopy-sync-logic` already
 * exports a function by that name with a DIFFERENT format (`ISIN@EXCHANGE`),
 * used for the instrument-resolution maps. Two same-named key builders that
 * disagree are one bad import away from a silent mismatch, so this one carries
 * its own name. The trim/uppercase normalisation is copied from it on purpose —
 * archived files do carry padded and lower-cased cells.
 */
export const aliasGroupKey = (isin: string, exchange: string): string =>
  `${isin.trim().toUpperCase()}::${exchange.trim().toUpperCase()}`;

/** Instrument key used for the output map and the seed list. */
export const symbolExchangeAliasKey = (
  symbol: string,
  exchange: string,
): string => `${symbol.trim().toUpperCase()}::${exchange.trim().toUpperCase()}`;

/**
 * A candidate seen in only ONE sampled file is not trusted. A single bad ISIN
 * cell — and the legacy files have plenty of odd rows — would otherwise mint a
 * permanent, searchable alias.
 */
export const MIN_OBSERVATIONS = 2;

/** Collapse raw observations into one span per (isin, exchange, symbol). */
export function buildSymbolSpans(
  observations: readonly SymbolObservation[],
): Map<string, SymbolSpan[]> {
  const byGroup = new Map<string, Map<string, SymbolSpan>>();

  for (const o of observations) {
    if (!o.isin || !o.symbol) continue;
    const key = aliasGroupKey(o.isin, o.exchange);
    let symbols = byGroup.get(key);
    if (!symbols) {
      symbols = new Map();
      byGroup.set(key, symbols);
    }
    const symbol = o.symbol.trim().toUpperCase();
    const existing = symbols.get(symbol);
    if (!existing) {
      symbols.set(symbol, {
        symbol,
        firstSeen: o.date,
        lastSeen: o.date,
        observations: 1,
      });
      continue;
    }
    if (o.date < existing.firstSeen) existing.firstSeen = o.date;
    if (o.date > existing.lastSeen) existing.lastSeen = o.date;
    existing.observations++;
  }

  const out = new Map<string, SymbolSpan[]>();
  for (const [key, symbols] of byGroup) {
    out.set(
      key,
      [...symbols.values()].sort((a, b) => a.firstSeen - b.firstSeen),
    );
  }
  return out;
}

/**
 * Decide, per instrument, which observed symbols are genuine predecessors.
 *
 * @param spans            output of `buildSymbolSpans`
 * @param currentByGroup   isin::exchange -> the ACTIVE instrument's symbol
 * @param activeByExchange exchange -> every symbol currently active on it
 */
export function decideAliases(
  spans: ReadonlyMap<string, SymbolSpan[]>,
  currentByGroup: ReadonlyMap<string, string>,
  activeByExchange: ReadonlyMap<string, ReadonlySet<string>>,
): AliasDecision[] {
  const out: AliasDecision[] = [];

  for (const [key, group] of spans) {
    if (group.length < 2) continue; // only ever one name — nothing to alias

    const currentSymbol = currentByGroup.get(key);
    if (!currentSymbol) continue; // no active instrument holds this ISIN

    const [isin, exchange] = key.split("::") as [string, string];
    const active = activeByExchange.get(exchange) ?? new Set<string>();

    const currentSpan = group.find((s) => s.symbol === currentSymbol);
    // If the current symbol never appears in the sampled archive, the rename
    // happened after our last sample. Treating its start as +Infinity makes
    // every observed symbol a predecessor, which is the correct reading — the
    // per-candidate guards below still apply.
    const currentStart = currentSpan?.firstSeen ?? Number.POSITIVE_INFINITY;

    const aliases: string[] = [];
    const rejected: AliasDecision["rejected"] = [];

    for (const span of group) {
      if (span.symbol === currentSymbol) continue;

      if (span.observations < MIN_OBSERVATIONS) {
        rejected.push({ symbol: span.symbol, reason: "single-observation" });
        continue;
      }
      // Symbol reuse: the exchange has handed this ticker to a DIFFERENT live
      // company. Aliasing it would route searches for the new company to the
      // old one — strictly worse than no alias at all.
      if (active.has(span.symbol)) {
        rejected.push({
          symbol: span.symbol,
          reason: "symbol-active-elsewhere",
        });
        continue;
      }
      // Succession, not coexistence. See the module header.
      if (span.lastSeen >= currentStart) {
        rejected.push({ symbol: span.symbol, reason: "concurrent-variant" });
        continue;
      }
      aliases.push(span.symbol);
    }

    if (aliases.length > 0 || rejected.length > 0) {
      out.push({
        isin,
        exchange,
        currentSymbol,
        aliases: [...new Set(aliases)].sort(),
        rejected,
      });
    }
  }

  return out.sort((a, b) => a.currentSymbol.localeCompare(b.currentSymbol));
}

/**
 * Which former symbol (if any) a query matched, so the UI can explain itself.
 *
 * Without this a user who searches ZOMATO gets a result called ETERNAL and no
 * idea why — which reads like a bug rather than a rename. Exact match only,
 * mirroring the `previousSymbols: { has: … }` lookup the query uses.
 */
export function matchedAlias(
  previousSymbols: readonly string[] | null | undefined,
  query: string,
): string | null {
  if (!previousSymbols?.length) return null;
  const q = query.trim().toUpperCase();
  if (!q) return null;
  return previousSymbols.find((s) => s.trim().toUpperCase() === q) ?? null;
}

/**
 * Append a "(formerly X)" hint to a display name when the hit came from an
 * alias. Returns the name untouched otherwise, so callers can apply it
 * unconditionally.
 */
export function withFormerlyHint(
  name: string,
  previousSymbols: readonly string[] | null | undefined,
  query: string,
): string {
  const alias = matchedAlias(previousSymbols, query);
  return alias ? `${name} (formerly ${alias})` : name;
}

/**
 * Merge derived aliases with an explicit seed list, dropping anything that
 * collides with a live symbol.
 *
 * The seed exists for successors whose ISIN CHANGED, which no amount of
 * ISIN-grouping can recover: TATAMOTORS -> TMCV is a new security, so the only
 * link is human knowledge of the demerger.
 */
export function mergeWithSeed(
  derived: readonly AliasDecision[],
  seed: ReadonlyMap<string, readonly string[]>,
  activeByExchange: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();

  const put = (symbolExchange: string, aliases: readonly string[]): void => {
    const [current = "", exchange = ""] = symbolExchange.split("::");
    const active = activeByExchange.get(exchange) ?? new Set<string>();
    const merged = new Set(out.get(symbolExchange) ?? []);
    for (const a of aliases) {
      if (a === current) continue;
      if (active.has(a)) continue; // never alias a live ticker
      merged.add(a);
    }
    if (merged.size > 0) out.set(symbolExchange, [...merged].sort());
  };

  for (const d of derived)
    put(symbolExchangeAliasKey(d.currentSymbol, d.exchange), d.aliases);
  for (const [k, v] of seed)
    put(symbolExchangeAliasKey(...(k.split("::") as [string, string])), v);

  return out;
}
