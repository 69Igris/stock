# XBRL switchover — reconcile report, 2026-08-16 (MONEY-1204 / 14a.4 Step 3b)

Both gates were run against **prod**, read-only. Both say NOT READY, and the
cause is not the one the plan anticipated.

## Verdict: STOP. Do not arm anything.

```
./scripts/ops/run-market-data-job.sh xbrlrecon prod
  reconciling 2142 filing(s)…
  periods XBRL covers that Tickertape does NOT: 2142
  revenue          BLOCKED  match 0/0 … only 0 COMPARABLE pair(s) out of 0
  netIncome        BLOCKED  match 0/0 …
  operatingIncome  BLOCKED  match 0/0 …
  ebitda           BLOCKED  match 0/0 …
  totalAssets      BLOCKED  match 0/0 …
  totalEquity      BLOCKED  match 0/0 …
  VERDICT: NOT ready.

./scripts/ops/run-market-data-job.sh xbrlratios prod
  gate: >= 95% of non-bank ratios within 5%, ANNUAL filings only
  no ANNUAL, non-cumulative XbrlFiling rows matched. That is NOT a pass —
  there is nothing to judge.
```

## The finding: the two sources do not overlap AT ALL

Not "they disagree". Not "they disagree too often". **There is not one period
where both sources have a value**, so there is nothing to compare and the
question the gate exists to answer cannot be asked yet.

Measured on prod the same day:

| Table              | Rows   | periodType                             | Range                                            |
| ------------------ | ------ | -------------------------------------- | ------------------------------------------------ |
| `xbrl_filings`     | 2,142  | **100% QUARTERLY**, `cumulative:false` | 2025-03-31 → 2026-06-30                          |
| `stock_financials` | 32,359 | **100% ANNUAL**                        | 2,123 distinct symbols, `source` 100% TICKERTAPE |

XBRL holds only quarters. `StockFinancials` holds only years. The intersection is
empty, which is exactly what `periods XBRL covers that Tickertape does NOT: 2142`
is reporting — **all 2,142** filings are "coverage gain", and the comparison
population is zero.

`StockFinancials` also carries **zero** `NSE_XBRL` rows, confirming independently
that nothing has ever been armed.

## Why the report reads BLOCKED rather than READY on an empty set

This is the gate working, not failing. `judgeSwitchoverReadiness` requires a
minimum comparable population (`need at least 20 before this means anything`)
before a match rate means anything. Without that floor, `0/0` is trivially 100%
and every field would have read READY on no evidence whatsoever — the
draining-denominator failure MONEY-1196 recorded. An empty comparison must never
be able to authorise a one-way door.

The ratios gate refuses for a second, independent reason and says so separately:
it compares **ANNUAL filings only** (because `StockRatios` has no period
dimension and Tickertape publishes TTM, so a quarterly-derived ROE against a TTM
ROE is a ~75% "disagreement" that is a period mismatch, not a data problem), and
there are **no annual filings at all**.

## What would make it READY

Not a tolerance change. Not a per-field switchover — that is explicitly not
offered, because a row whose `source` says `NSE_XBRL` while some columns are
Tickertape's is un-attributable, the MONEY-1175 state.

**Coverage.** One of:

1. **Extend the P10 XBRL backfill to ANNUAL filings.** The current archive is 15
   months of quarters (2025-03-31 → 2026-06-30) and no years. NSE publishes
   annual results; the F2 backfill simply has not walked them. This is the
   direct fix and it makes BOTH gates answerable at once.
2. **Or give `StockFinancials` quarterly rows to compare against.** Tickertape's
   quarterly endpoint is already read by `financial-data-sync` (the QUARTERLY
   upsert at `financial-data-sync.ts:371`), yet the table holds only ANNUAL —
   worth checking whether that path is running at all, because if it is, its rows
   have gone somewhere else or are being skipped.

Option 2's discrepancy is itself a finding: there is a quarterly writer and no
quarterly rows.

## What was NOT done, deliberately

- `apply` and `createMissing` remain `false`. Neither was flipped.
- `processXbrlProjectionWrite` still has no route, no topic and no scheduler
  entry.
- No reader was pointed at `NSE_XBRL`.
- **14c.8 shipped anyway and is correct as-is**: the source badge reads whatever
  `source` actually says, which today is `TICKERTAPE` on every row. That is the
  spec's 3b branch — ship the badge and the basis wiring, nothing else.

## Step 1 is done and was wider than the ticket

The prerequisite named in `xbrl-projection-writer.ts`'s header — a competing
writer that would silently undo an armed switchover within a week — is closed,
and by five guards rather than the one the ticket named. See
`docs/reference/xbrl-switchover-runbook.md`. That work stands regardless of this
verdict: it protects `StockFinancials`/`StockRatios` from provenance loss whether
or not XBRL ever wins.
