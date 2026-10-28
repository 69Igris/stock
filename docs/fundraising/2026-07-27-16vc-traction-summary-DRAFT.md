# UseMoney AI — Traction Summary

**As of July 27, 2026** `[refresh numbers on send day]` · [usemoney.ai](https://usemoney.ai) · deepshaswat@gmail.com

> ⚠️ **DRAFT — for Shaswat's review.** Delete this block and the bottom checklist before sending.

---

## Snapshot

| Metric                             | Value             | Note                                                                                      |
| ---------------------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| Registered users                   | **629**           | +37% in July, m/m `[VERIFY on send day]`                                                  |
| Weekly active users                | **~225–240**      | signed-in, bot-filtered                                                                   |
| Paying subscribers                 | **4**             | Premium (₹999/mo) + Pro (₹999/yr) mix `[VERIFY mix — audited subscription MRR is ₹1,998]` |
| Revenue collected since March beta | **~$400 (≈₹33K)** | `[VERIFY vs Dodo]`                                                                        |
| Current monthly collections        | **~$100 (≈₹8K)**  | incl. annual-plan purchases `[VERIFY vs Dodo]`                                            |
| Paid marketing spend to date       | **₹0**            | 100% organic                                                                              |
| Broker integrations live           | **6**             | Zerodha audited & approved                                                                |
| Non-dilutive credits secured       | **$65K**          | $55K GCP + $10K Anthropic                                                                 |

## Growth story

- **Beta launched March 2026** — every user since acquired organically (content-led; no GTM motion started yet, deliberately: product quality first, then scale).
- **Registrations grew ~37% in July** on content alone — early proof the top of funnel responds when we publish.
- **UX redesign in progress** after direct feedback from the Razorpay Rise team — current flow is too complex for early users; connect-broker-first onboarding ships as part of it.

## Product shipped (solo) — the traction most numbers miss

- **6 Indian broker integrations** (Zerodha, Upstox, Groww, Angel One, Dhan, Fyers) behind one adapter layer, AES-256-GCM encrypted credentials — including passing **Zerodha's compliance audit**, which most multi-broker tools never do.
- **FIFO trade-pairing engine + tax analytics** — every trade reconciled into verified P&L and tax lots.
- **Research agent: 118 tools / 38 skills**, citation-backed answers on stocks & mutual funds; multi-stock/fund comparison.
- **22K passing test cases; ~30 PRs merged in the last 20 days** — solo founder velocity.

## External validation

- **Anthropic Depth program**: selected from the Boundless VC × Anthropic Bangalore cohort — **50 companies narrowed to 12**, 1–2 rounds remaining; received $10K Anthropic credits + architecture teardown support.
- **$55K Google Cloud credits** granted.
- **Zerodha integration audited and approved** — real-money broker access, not a demo.
- **Clean cap table**: 100% founder-owned, zero SAFEs, zero debt (declined an equity-for-credits offer to keep it clean).

## What we measure (and our 90-day targets)

We hold ourselves to institutional reporting standards — every externally quoted number traces to a dated internal truth pack. The metrics that matter for this business, and where we're driving them by ~Oct 31:

| North-star metric                          | Today                                | 90-day target                     |
| ------------------------------------------ | ------------------------------------ | --------------------------------- |
| Broker-connected users (activation + moat) | early — instrumentation ships Jul 31 | ≥40% of new signups; 150+ total   |
| W1 / W4 retention of connected users       | being instrumented                   | W1 ≥40% · W4 ≥25%                 |
| Weekly actives                             | ~225–240                             | +10% WoW for 8+ consecutive weeks |
| Paying subscribers                         | 4                                    | 25 by Aug 31 → 100–150            |
| AI engagement + eval accuracy              | instrumenting                        | public eval scorecard by Sep      |

Our honest read: top-of-funnel is moving; the current sprint is entirely about **activation (connect a broker) → weekly habit → paid** — connect-first onboarding, full funnel instrumentation, and the three analyses that create the "aha" (performance attribution, factor exposure, stress scenarios).

## Next 60–90 days

- **Jul 31** — instrumented funnel + connect-broker-first onboarding live
- **Aug** — memory layer beta (agent personalizes on your trade history, P&L, mistakes over 3–6 months); attribution / factor / stress trio
- **Sep** — **US market data + mutual funds integrated** (SnapTrade, read-side) → India↔US/NRI corridor at 10x ARPU; research core unchanged, only ingestion pipelines change
- **Q4** — Strategy Builder: backtests in **<24 hours** vs 3–6 month industry norm; SEBI advisory-license path begins

---

> ⚠️ **BEFORE SENDING — delete this section**
>
> 1. Reconcile **~$400 total / ~$100 monthly** against Dodo. Audited Jul 26 truth pack: 4 paying, ₹1,998 subscription MRR. The table above deliberately says "collected" / "collections" (cash, incl. annual plans) rather than "MRR" — that's the only framing where ~$100/mo is defensible. If the Dodo numbers don't support it, swap the two revenue rows for: `MRR ₹1,998 (~$24)` and `~₹33K collected since March`.
> 2. Refresh **registered users** and the July growth % on send day (was 629 / +37% on Jul 26).
> 3. WAU ~225–240 is your bot-filtered signed-in number from the Jul 26 deep-dive — re-pull if you rerun the truth pack (MONEY-920) first.
> 4. Optional: attach or link the demo video here too.
