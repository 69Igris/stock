# Portfolio Sync · Pairing · Tax · Scaling — Architecture Redesign

> **Status:** Proposed (design-first; no code until phases are approved)
> **Author:** Engineering (deep-dive driven by MONEY-839)
> **Scope:** broker sync, FIFO pairing, capital-gains/tax, holdings↔tradebook
> reconciliation, and the scaling path to 50k users.

---

## 0. Why this exists

MONEY-839 fixed a "tradebook shows 33 of 8,553 trades" bug. Root-causing it (via
QA worker logs) surfaced that the failure was a **symptom of systemic design
debt**, not a one-off:

- **Every sync is a FULL pull + FULL re-pair.** The day `/trades` re-fetches
  today's entire book; the historical backfill re-pulls the whole **730-day**
  window on **every connect/reconnect** (no "already done" guard); the daily
  cron re-syncs all users; and `processPairing` re-pairs **all** of a user's
  trades on every sync — work that scales with _total history_, not the delta.
- **No sync-state / checkpoint** exists. `BrokerConnection.lastSync` is written
  but never read to scope a fetch.
- **Pairing's open lots are redundant** with the broker's Holdings snapshot for
  _display_ (and currently **double-counted** in the tradebook segment
  breakdown).
- **Tax is single-FY, gross-of-charges, on-the-fly.** Real broker charges are
  _computed then dropped_ at a type boundary before persist; there's no
  multi-year rollup, no loss carry-forward, no grandfathering.
- **No holdings↔tradebook reconciliation** — the two are independent sources.
- **The cron is one `userId:"*"` message processed by one worker** that serially
  loops every connection globally → breaks at ~1–2k users (ack-deadline), and
  exceeds the 1-hr container timeout at ~10k.

This document proposes the target architecture and a phased plan.

---

## 1. Core principle — **Holdings = current, Pairing = history**

The load-bearing insight: the broker already gives us current open state; pairing
exists to reconstruct _history_ that the broker's snapshot cannot.

| Surface                                                         | Authoritative source                                | Rationale                                                                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **"What do I hold now"** (open stocks / F&O / MF)               | **`Holding` / `Position` / `MutualFund`** snapshots | Broker-authoritative, current, blended avg cost. No FIFO required.                                                                    |
| **Realized P&L + capital gains (tax)**                          | **FIFO pairing** (CLOSED lots)                      | Holdings has no sell history and no per-lot acquisition dates.                                                                        |
| **Trade history / behavior** (roast, research, future coaching) | **FIFO pairing** (matched lots)                     | Holding-period distribution, churn, win-rate, disposition effect, entry/exit timing — all need the _matched_ history, not a snapshot. |

**Right-sizing pairing (the design change):**

1. **Open-position display → Holdings/Positions/MF.** Stop re-deriving open lots
   via FIFO for display, and stop summing them _with_ Holdings (today's
   double-count: `apps/web/lib/pairing/service.ts` adds OPEN paired lots **and**
   `Holding` rows into the same Equity segment).
2. **Pairing → realized / tax / behavioral engine.** It only does real work for
   symbols **with sells**. A pure-accumulation portfolio produces only open lots
   (which Holdings already has), so pairing there is ~free.
3. **FIFO open lots are retained** — but as the **tax-lot cost-basis ledger**
   (per-lot acquisition dates for LTCG/harvesting) and the **reconciliation
   bridge** vs Holdings — _not_ as the primary display source.

Consequence: incremental pairing becomes natural (re-pair only sell-affected
symbols), the double-count bug is removed, and the realized/tax/behavioral data
becomes a first-class, materialized asset.

---

## 2. Worked example — TCS accumulation + partial sale

Buy TCS once a month for 5 years (60 buy lots); sell 50% (12 of the 24 lots then
held) at the 2-year mark. FIFO matches the **oldest** lots.

Resulting `PairedTradeView` rows (one row per _lot_, the sell is split):

- **12 CLOSED rows** — one per matched buy lot, each carrying that lot's own
  `entryDate` / `entryPrice` / `quantity` / `realizedPnL`, sharing the single
  sell's `exitDate` / `exitPrice`.
- **48 OPEN rows** — the unsold lots = the current TCS holding (should equal
  `Holding.quantity` for TCS).

**The critical tax subtlety — holding period is per lot, even within one sell:**
months 1–11 (held > 12 months) → **LTCG**; month 12 (held = 12 months) →
**STCG**. A single sale spans _both_ tax buckets. The schema already preserves
per-lot `entryDate`/`exitDate`, so this is derivable — but **nothing stores the
LT/ST classification today** (it's recomputed on the fly with a 365-day proxy).

Evidence: `packages/core/src/pairing/algorithm.ts` (SELL loop emits one CLOSED
row per consumed buy lot; post-loop drain emits OPEN/PARTIAL rows). Per-lot cost
basis + acquisition date are preserved through the match. Grouping key =
`(isin|symbol)|exchange|productType|broker|brokerUserId` — i.e. **per-account
FIFO**, not a single cross-broker ladder.

---

## 3. The reconciliation invariant

**Invariant:** per security & account, `Σ open FIFO lots ≈ broker snapshot qty`:

- Delivery equity: `Σ OPEN/PARTIAL PairedTradeView.qty (LONG) ≈ Holding.quantity + Holding.t1Quantity`
- F&O: `Σ signed OPEN/PARTIAL qty ≈ Position.netQuantity` (sign-aware)
- MF: `Σ OPEN/PARTIAL MF qty ≈ MutualFund.units`

Today there is **zero reconciliation** — the sources are independent (and
double-counted). A drift check is valuable (catches missing/failed syncs) but a
_naive equality_ will false-alarm; it must tolerate:

- **Corporate actions** (bonus/split/buyback change Holdings with no trade — there
  is **no `CorporateAction` model** today),
- **Pre-platform holdings** (a Holding with no historical buy trade),
- **T+1** (`Holding.t1Quantity`), **ISIN-vs-symbol** key drift, **LONG/SHORT**
  sign, and **float epsilon** (`QUANTITY_EPSILON = 1e-6`).

Join key: `userId + normalized brokerUserId + (ISIN→symbol fallback) + exchange +
productType-bucket`. Delivery → `Holding`; intraday/F&O → `Position`; funds → `MF`.

Design: a tolerant **compute job** (worker, mirrors roast/research) that emits
per-symbol drift flags / notifications — never blocks sync.

---

## 4. Capital gains · P&L · charges (multi-year)

**What works today:** FIFO per-lot matching; STCG/LTCG split; ₹1.25L LTCG
exemption; **correct IST financial-year math** (`packages/services/src/tax-logic.ts`).

**What's broken for multi-year statements:**

1. **Charges are silently dropped on sync.** `normalizeZerodhaTrade` _computes_
   real brokerage/STT/GST, but they die at the `NormalizedTrade` type boundary
   before `persistTrades`; synced trades fall back to a flat ₹20 default →
   **realized P&L is gross → overstates taxable gains.**
2. **Single-FY only** — no multi-year rollup; **no loss carry-forward**
   (CYLA/BFLA/CFL are hardcoded placeholders) because nothing is materialized.
3. **No grandfathering** (31-Jan-2018 FMV) and **no date-based LTCG rate**
   (everything uses 12.5%, even pre-23-Jul-2024 sells that should be 10%).
4. **On-the-fly only** — recomputed from `PairedTradeView` each read; no stable
   realized-gains ledger to anchor carry-forward, audit, or AIS reconciliation.

**Proposed:** a **materialized `RealizedGain` ledger** (per closed lot per FY) +
charges plumbed end-to-end + a multi-FY rollup + carry-forward + grandfathering +
date-based rates.

---

## 5. Data models (new + changes)

> **Tech-stack verdict: the current stack is enough — to 50k and beyond.**
> MongoDB Atlas + Prisma + Redis + Cloud Run + Pub/Sub maps cleanly to
> trades/lots/gains. The bottlenecks are **algorithmic** (full re-pull/re-pair)
> and **operational** (single-message cron, no sharding) — **not** the stack. No
> data-warehouse / time-series DB / event-store is needed at this scale.

**New model — `BrokerSyncState`** (delta checkpoint, per account × segment):

```prisma
model BrokerSyncState {
  id String @id @default(auto()) @map("_id") @db.ObjectId
  userId String @db.ObjectId
  brokerConnectionId String @db.ObjectId
  connection BrokerConnection @relation(fields:[brokerConnectionId], references:[id], onDelete: Cascade)
  broker BrokerType
  brokerUserId String?
  segment String                         // EQ | FO | CD | COM

  historicalComplete   Boolean  @default(false)  // reconnect skip-guard
  historicalSyncedFrom DateTime?                  // oldest tradeDate reached
  lastTradeWatermark   DateTime?                  // max tradeDate ingested = delta cursor
  lastBrokerTradeId    String?                     // tie-break within same timestamp
  lastFullSyncAt   DateTime?
  lastDeltaSyncAt  DateTime?
  syncInProgress   Boolean @default(false)
  lastSyncStatus   String?   lastError String?   retryCount Int @default(0)
  createdAt DateTime @default(now())  updatedAt DateTime @updatedAt
  @@unique([brokerConnectionId, segment])
  @@index([userId, broker])
}
```

**New model — `RealizedGain`** (materialized tax-lot ledger, per closed lot):

```prisma
model RealizedGain {
  id String @id @default(auto()) @map("_id") @db.ObjectId
  userId String @db.ObjectId
  entryTradeId String? @db.ObjectId
  exitTradeId  String? @db.ObjectId
  symbol String  isin String?  exchange String  segment String
  broker BrokerType?  brokerUserId String?

  quantity   Float
  entryDate  DateTime  exitDate DateTime
  entryPrice Float     exitPrice Float
  buyValue   Float     sellValue Float
  buyCharges  Float @default(0)  sellCharges Float @default(0)
  grossGain  Float     // sellValue - buyValue
  netGain    Float     // grossGain - buyCharges - sellCharges

  holdingDays Int
  gainType    String   // STCG | LTCG | SPECULATIVE | BUSINESS
  fmv31Jan2018 Float?  grandfatheredBasis Float?   // LTCG grandfathering
  financialYear String // "2024-25"
  taxRateAtSale Float? // rate snapshot for the sell date
  computedAt DateTime @default(now())  pairingBatchId String?

  @@unique([userId, exitTradeId, entryTradeId])
  @@index([userId, financialYear])
  @@index([userId, gainType])
  @@index([userId, symbol])
}
```

**New model — `CorporateAction`** (market-wide; powers reconciliation + cost-basis):

```prisma
model CorporateAction {
  id String @id @default(auto()) @map("_id") @db.ObjectId
  symbol String  isin String?  exchange String
  type   String   // SPLIT | BONUS | BUYBACK | DEMERGER | MERGER | DIVIDEND
  exDate DateTime
  ratio  Float?   // split 1:5 → 5 ; bonus 1:1 → 2
  details Json?
  createdAt DateTime @default(now())
  @@index([isin])  @@index([symbol, exchange])  @@index([exDate])
}
```

**Changes to existing models:**

- **Charges plumbed:** add charge fields to `NormalizedTrade`
  (`packages/types/src/broker/index.ts`) so the values `normalizeZerodhaTrade`
  already computes survive to `persistTrades`; populate `Trade.brokerage/stt/gst/
sebiCharges/stampDuty/transactionTax/totalCharges/netAmount`. Carry per-lot
  allocated charges onto `PairedTradeView` (currently has none) → `RealizedGain`.
- **LT/ST on the lot:** optional `gainType`/`holdingDays` on `PairedTradeView`
  (or computed only in `RealizedGain`).

---

## 6. Scaling — now → 1k → 10k → 50k

**The #1 bottleneck is not pairing — it's the cron sync topology.** The cron
publishes a single `userId:"*"` Pub/Sub message that one worker processes by
serially looping **every connection globally** (`syncBrokerConnections({})` →
`for (const connection of connections)`), behind a 600s ack deadline / 3600s
container timeout.

| Tier      | #1 bottleneck                                                                                                                     | Mitigation                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **~1–2k** | Single-message serial sync blows the **600s ack deadline** → redelivery → duplicate full-base syncs (no idempotency)              | **Shard the cron** into N hashed buckets; **idempotency**; wire the **dead-letter** topic (created but unattached) |
| **10k**   | Serial loop **exceeds the 3600s timeout** (~2h); full re-pair ~6M paired-view writes/tick; silent **`take:5000` cap** drops users | **Delta sync** (only recently-auth'd connections); **incremental pairing** (right-sized, §1); remove/raise the cap |
| **50k**   | **Unsharded Atlas** (~150M trades + ~150M paired views); Redis flush-on-every-sync; broker-vendor QPS caps                        | **Atlas shard by `userId`**; read replicas; TTL/cold archival; Redis Cluster; per-broker throttling                |

Note: delta-sync + incremental-pairing erase the _write amplification_, but
**cron sharding + idempotency + dead-letter are additional** and break first — so
they lead the plan.

---

## 7. Phased plan

- **Phase A — Scaling foundation.** Shard the cron (hashed user buckets);
  idempotency/dedupe; wire the dead-letter topic; remove the `take:5000` sweep
  cap; right-size ack/timeout. _(Breaks first at ~1–2k; cheap.)_
- **Phase B — Delta sync + right-sized pairing.** `BrokerSyncState`; reconnect →
  delta window (skip full 730-day re-pull); **open-display from Holdings**; pair
  only sell-affected symbols (incremental). _(The two big wins; approved.)_
- **Phase C — Tax correctness.** Plumb charges end-to-end + allocate per lot;
  materialized `RealizedGain` ledger; multi-FY rollup + loss carry-forward;
  holdings↔tradebook reconciliation job.
- **Phase D — Long-tail correctness + 50k infra.** `CorporateAction` +
  grandfathering + date-based LTCG rates; Atlas sharding + read replicas + TTL
  archival.

Each phase ships with tests: delta watermark + reconnect idempotency;
scoped-symbol pairing; charge allocation; FY rollup + carry-forward;
reconciliation edge cases (corp actions, T+1, sign, epsilon); and the currently
**untested worker historical branch** (extract a pure helper).

---

## 8. Open questions / risks

- **Cross-broker FIFO:** today grouping is per-(broker, account, productType).
  Tax FIFO for the _same ISIN across brokers_ is a separate (per-account vs
  consolidated) policy decision.
- **Grandfathering data source:** need an FMV-as-of-31-Jan-2018 feed for pre-2018
  holdings.
- **Charge accuracy for imports:** CSV imports lack real charges (flat ₹20) —
  parse from broker statements or estimate via SEBI/exchange slabs.
- **Migration:** `BrokerSyncState`/`RealizedGain` need a backfill from existing
  `PairedTradeView` on first deploy; `db push` to QA then prod.
- **Reconciliation UX:** drift flags should inform, not alarm (most drift is
  legitimate: corp actions / pre-platform holdings).

---

_Last updated: 2026-06-18 · supersedes the ad-hoc delta-sync notes in MONEY-839._
