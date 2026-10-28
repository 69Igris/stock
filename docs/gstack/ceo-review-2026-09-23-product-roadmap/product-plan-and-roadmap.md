# UseMoney — full product plan & roadmap (23-Sep-2026)

Status: ACTIVE — under /plan-ceo-review (Step 0 decided; sections 1–11 pending). Built 23-Sep-2026 because no single current
product roadmap existed — the last one is `docs-archive/2026-05-q2-roadmap-and-walkthrough.md`
(11-May, stale). Sections 1–8 CONSOLIDATE what was planned as of 23-Sep. The review has
since CHANGED scope — see the decision ledger (bottom); every change there carries the
founder's answer.

Sources (all read 23-Sep): archive-docs/reports/\* (the five 22-Sep plans, SnapTrade,
crypto, doc-ingest, pitch, data-rights, harness, cross-pack); repo `docs/prompts/design-v2/`
(W00–W15, M00–M22, A01–A02), `docs/fundraising/`, `docs/quant/`, `docs/personalization/`,
`docs/architecture/`; `~/Developer/UseMoneyAI/` PDFs (Momentum Sprint, one-pager);
Linear (initiatives I-1 6-Month Goal, I-2 Quant Platform, all projects, cycles 12–13);
PROD Mongo `tradebook` + PostHog project 272942, measured read-only 23-Sep ~13:00 IST.

---

## 1. North star and where we actually are

**Goal (founder, 2-Jul, Linear I-1 da8f3eb3):** 1,000 paid · 50,000 free · VC-ready by 2027-01-05.
It appears in NONE of the 14 current plan docs.

| Metric                 | 2-Jul baseline                 | Pitch deck (22-Sep)    | PROD truth (23-Sep)                                                                                                                       | Needed by 5-Jan                           |
| ---------------------- | ------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Registered users       | 459 (under-count; DB had ~599) | 665                    | **668** — 520 of them Mar–Apr, unverified for bots/tests                                                                                  | 50,000 → **~3,300 signups/week × 15 wks** |
| Signups / week         | —                              | —                      | **2–5** (Aug 20/mo, Sep 12 MTD)                                                                                                           | ~3,300 (≈1,000× today)                    |
| Paying users           | 4                              | "8"                    | **1–3 external.** No non-zero payment since 23-May; 0 subs linked to a Dodo subscription → nothing renews; expired subs still read ACTIVE | 1,000 → ~66/week                          |
| MRR                    | ₹1,998                         | not stated             | **≈ ₹0–1,249**                                                                                                                            | —                                         |
| Lifetime revenue       | —                              | "~$400"                | **₹22,381 ≈ $260** (≈$230 ex-internal)                                                                                                    | —                                         |
| Broker-connected users | ~1                             | "7 live India brokers" | **0** — 9 Zerodha connections, all NEEDS_REAUTH, 0 synced in 30d; only Zerodha ever connected                                             | —                                         |
| Real weekly visitors   | 225–240                        | —                      | **~15–70** (India or engaged); raw prod-host 77–237                                                                                       | —                                         |
| Feature use, 30d       | —                              | —                      | 16 chats / 8 users · 4 research / 2 users · 0 roasts                                                                                      | —                                         |
| Product analytics      | —                              | —                      | **none**: no signup/connect/research/roast/LLM events in PostHog; no bot cohort; QA+preview hosts pollute the project                     | —                                         |

**Where engineering went (last 30 days):** 101 commits across 37 tickets. By commit-message
keyword: Datadog/monitor 163, Tiingo 151, feed 146, XBRL 135, EDGAR 132, Databento 95, lake 93;
pricing+paywall+activation+PostHog+Dodo **11 combined**. Linear agrees: every I-1 goal project
except Eng Standards is stalled; Cycle 12's completions are all data-lake work; none of the
34 design-v2 product prompts has started.

## 2. The product as it exists (built and reachable)

Web (Next.js, Vercel): dashboard, holdings/positions/tradebook with FIFO pairing, CSV import,
6 India broker adapters (scheduled sync narrowed to Zerodha-only since 11-Sep, MONEY-1379),
MF tracking, FIRE planner, AI chat (Gemini default; Claude for paid/allowlist), StockSage
research agent, portfolio roast, risk analysis, tax analysis, screener/discovery, learning
content, notifications, demo mode, Dodo billing. Paper trading: listed as a core FREE feature
in CLAUDE.md but "removed after SEBI Nov-2024 advisory" per the quant report and pitch A9 —
**unresolved which is true**.

Data platform (the last 30 days): GCS+BigQuery lake (silver 84.8M rows, gold 0 — Dataform
never run on prod), chart tiles serving prod charts, US Tiingo EOD + realtime, SEC EDGAR
engine, Databento intraday (189M rows), NSE XBRL fundamentals (ratios arm flags OFF), AMFI/AMC
MF feeds, Datadog monitors/SLOs/LLM-Obs.

Not built: mobile app (no `apps/mobile`), SnapTrade/US brokers, persona engine, strategy
lab v2 (legacy `/strategies` shows hardcoded numbers), MCP/B2B, referral, share cards,
lifecycle email/push, `/yt` landing pages.

## 3. Positioning, personas, pricing — as the docs state them (conflicting)

- **Positioning** has drifted through 5 versions: "unified portfolio intelligence" →
  "AI quant trading platform" (YC-App.md) → "AI copilot replaces 5 tools" → "AI investing
  copilot for 14 crore, built on Claude, Hindi YouTube" → (Aug-19 one-pager, latest)
  "Personalised AI for investment & wealth management", moat = the money graph (verified
  holdings + paired trades) + trust-as-a-feature, plus an India↔US/NRI corridor at 10× ARPU.
- **Personas:** 3 levels × 4 types (PERSONALIZATION-STRATEGY.md); design-v2 adds NRI and
  LRS-resident; fundraising adds Hindi-first Tier 2–3 and RIA/MFD "agent seats".
- **Pricing: 7 versions.** Live code `plans.ts`: Free 5 credits · Pro ₹249/mo · Premium
  ₹1,499/mo. Second code file `plan-config.ts`: Pro ₹999 LIFETIME · Premium ₹999/mo (the
  two code files disagree — single-source rule broken). Decks: ₹999/yr, ₹999/mo, Ultimate
  ₹3,999, Agent seat ₹4,999; free is "forever" in one doc, "6 months only" in another. US
  price: TBD. Momentum Sprint said kill the lifetime tier — still in code.

## 4. Workstreams on file (consolidated)

> Snapshot as of 23-Sep BEFORE the review. Where it disagrees with the decision ledger or the **Approved roadmap** at the end, the ledger wins.

| #   | Workstream                                                                     | Source                          | Status 23-Sep                                                              | Next dated item                                                                         |
| --- | ------------------------------------------------------------------------------ | ------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| W1  | Data platform / warehouse (Plan 1)                                             | data-platform-plan-v2.3         | S/A/B mostly done; gold 0 rows; 11-step run order open on `fix/MONEY-1522` | "data in warehouse + showcase" by **Fri 25-Sep**; B6 audit ≥11-Oct; grid ends ~Jan-2027 |
| W2  | apps/api surfaces D2–D5 + C4 event consumers (Plan 2)                          | product-surfaces-plan           | not started, no tickets                                                    | —                                                                                       |
| W3  | News & events C2/C3 + claude-algo migration (Plan 3)                           | news-events-plan                | not started; blocked on `algo-worker@` grant                               | —                                                                                       |
| W4  | US full-stack, 33 tasks (Plan 4)                                               | us-fullstack-plan               | all TBD; 8-week undated grid                                               | ~~L1 licence decision (wk 5)~~ SUPERSEDED by D5.1 (licence in place)                    |
| W5  | US brokers via SnapTrade P18–P29 (Plan 5)                                      | us-broker stub + snaptrade plan | no code, no tickets; Indian-entity self-serve unconfirmed                  | pitch promises **Oct**                                                                  |
| W6  | Crypto P30–P33                                                                 | crypto addendum                 | not started; needs licensed aggregator                                     | —                                                                                       |
| W7  | Doc ingest v2                                                                  | doc-ingest plan                 | realtime OFF, paid PDF readers OFF (MONEY-1511)                            | "~22-Sep go-live" — missed                                                              |
| W8  | Design-v2 product program: web W00–W15, mobile M00–M22, api A01–A02            | repo docs/prompts/design-v2     | **0 of 34 started**; bundle committed                                      | README order W00→W12→W01→W02→W03→M00…                                                   |
| W9  | Personalization persona engine                                                 | Linear P-60, W14                | 0/15                                                                       | due **31-Oct**                                                                          |
| W10 | Strategy lab / backtesting                                                     | Linear P-51, W03–W05            | 0 done; `/strategies` fake numbers live                                    | due 31-Dec                                                                              |
| W11 | B2B APIs & MCP                                                                 | Linear P-49, W13                | 0/11; MONEY-936 licence gate Urgent                                        | due 30-Nov                                                                              |
| W12 | Growth Engine (content, funnel, bot filter)                                    | Linear P-48                     | 1/31; last completion 3-Jul                                                | —                                                                                       |
| W13 | GTM — US launch & growth (waitlist, Reddit, PH, content OS, USD pricing)       | Linear P-75                     | 41 backlog, 0 started; not linked to I-1                                   | due 31-Dec                                                                              |
| W14 | Billing & GST                                                                  | Linear P-17, cycle 13           | 8 tickets queued for cycle 13 (27-Sep)                                     | —                                                                                       |
| W15 | Onboarding & Activation / Account & Subscription                               | Linear P-29 / P-30              | stalled since May / Aug                                                    | due **30-Sep**                                                                          |
| W16 | Mobile (React Native/Expo)                                                     | Linear P-36 + M00–M22           | untouched since 10-Jul                                                     | 27-Feb-2027                                                                             |
| W17 | Fundraise                                                                      | Linear P-50 + pitch docs        | apps all closed 18-Aug, outcomes unrecorded                                | **Dodo×Antler Pitch Day 26-Sep** (deck due 23-Sep eve); Antler Embark Oct               |
| W18 | Data licensing (NSE/BSE ~₹2.5–3.5L/yr, Tiingo redistribution $250/mo)          | data-rights audit               | no owner, no purchase scheduled                                            | —                                                                                       |
| W19 | claude-algo agentic harness (separate repo)                                    | harness report                  | analysis only                                                              | —                                                                                       |
| W20 | Eng Standards / security (incl. MONEY-821 IDOR: research trusts client userId) | Linear P-43                     | 6/26                                                                       | —                                                                                       |

## 5. Roadmap as currently documented (chronological)

> Snapshot as of 23-Sep BEFORE the review. Where it disagrees with the decision ledger or the **Approved roadmap** at the end, the ledger wins.

- 25-Sep — Plan 1 showcase (cost-aware backtest over `spread_cost_daily`).
- 26-Sep — Dodo × Antler Pitch Day.
- 27-Sep — Cycle 13 starts (Billing & GST only).
- 30-Sep — Linear due: Onboarding & Activation, Account & Subscription, smallcase, Fundraise close.
- Oct — SnapTrade build (pitch); Antler Embark cohort; D4 load test; ~11-Oct B6 index audit → Atlas M40→M30.
- 31-Oct — Personalization P-60 due; In-House Data Engine P-67 due.
- Nov — DPDP consent-manager deadline (unverified); B2B P-49 due 30-Nov.
- "Next 90 days" (pitch): SnapTrade US brokers, Expo mobile app, news-to-holdings alerts.
- 31-Dec — Gemini flash promo ends; GTM P-75, Institutional Research due.
- ~Jan-2027 — end of data-platform 16-week grid. **5-Jan-2027 — the goal.**

Founder priority order on record (22-Sep): warehouse → US full-stack. **SUPERSEDED 23-Sep by D2-ALLOC (dual India + US).**

## 6. Licence and compliance gates on what users may see

> Snapshot as of 23-Sep BEFORE the review. Where it disagrees with the decision ledger or the **Approved roadmap** at the end, the ledger wins.

- **India display:** bhavcopy is not a production licence. Charts, EOD prices, screeners,
  valuations are RED/AMBER until NSE+BSE licences are bought; Yahoo is "replace before
  commercial launch"; index values RED; MF holdings RED; AMFI NAV AMBER. India is the only
  market with paying users.
- **US display:** Tiingo COMMERCIAL = internal use only → US prices founder-only until the
  $250/mo plan (MONEY-1262); StockSage quoting US prices counts.
- **News:** publisher snippets RED; Tiingo news RED under quoted package.
- **Advice:** targets/buy-sell/personalised advice need SEBI RA/IA; forward predictions
  "close to advice". AA data needs a regulated FIU. No dated SEBI plan exists; pitch says
  "RIA in progress", review says not.
- **SnapTrade:** no storing/redistributing broker market data; sub-processor disclosure.
- **Crypto:** Coinbase forbids display; others need written consent.
- **DPDP:** privacy/consent owner unassigned.

## 7. Contradictions to resolve

Resolution status: #3 paper trading → open (Section 1+). #4 US brokers → D2/D5.2 (SnapTrade, eligibility assumed). #6 Tiingo → D5.1. #8 mobile → D6.3. #1 pitch claims → open, see wk0 row. Others open.

1. Pitch traction claims (8 paying, ~$400, 7 live brokers) vs PROD (1–3, ~$260, 0 connected).
2. Two plan-config files with different prices; 7 pricing versions in docs.
3. Paper trading: core free feature vs removed.
4. US brokers: pitch "Oct" vs no ticket; ConnectTrade-primary (1-Sep) vs SnapTrade-only (12-Sep).
5. Broker counts 6 / 7 / 8 / 10 across docs.
6. Tiingo redistribution: "decided 23-Aug" vs "open" in Plan 4 L1.
7. C4 news consumers built while news display is RED.
8. Mobile promised in 90 days; no mobile plan; India-mobile vs US-track order undecided.
9. `YC-App.md` false claims not quarantined; content plan stale (May).
10. "Built on Claude" vs Gemini default.
11. GTM P-75 outside I-1; Quant projects marked Backlog while most active.

## 8. Gaps no plan covers (checked by grep across all doc homes)

> Snapshot as of 23-Sep BEFORE the review. Where it disagrees with the decision ledger or the **Approved roadmap** at the end, the ledger wins.

Funnel math from the goal; a ratified price/paywall; activation + retention plan and
metrics; product analytics; referral / share loops; lifecycle email/push; channel plan
and budget; mobile timing vs the deadline; customer support; hiring; SEBI execution plan;
India data-licence purchase; privacy owner; an explicit engineering-allocation decision
between the data platform and consumer surfaces.

---

## Decision ledger

| ID and owner                              | Contract and evidence                                                                                     | Current                                                                                                                                                                                                                                                 | Proposed | Status                                         | Exact approval and scope                                                                                                                                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R0 Review target (founder)                | User answer 23-Sep: "full product plan and roadmap — find and build if does not exist"                    | this consolidated doc                                                                                                                                                                                                                                   | —        | approved                                       | Build + review the full product plan (this file)                                                                                                                                                                                                                  |
| R0b Checkpoint mode (founder)             | User answer 23-Sep                                                                                        | off                                                                                                                                                                                                                                                     | —        | approved                                       | Keep off                                                                                                                                                                                                                                                          |
| D2-ALLOC (founder)                        | see Pending decision rows                                                                                 | dual India+US                                                                                                                                                                                                                                           | —        | approved (custom)                              | "dual india + us; … SNaptrade and expand Indian brokers"                                                                                                                                                                                                          |
| D3-MODE (founder)                         | —                                                                                                         | SELECTIVE EXPANSION, D2 never reduced                                                                                                                                                                                                                   | —        | approved                                       | "Selective expansion" + "scope not to be reduced"                                                                                                                                                                                                                 |
| E1 revenue loop repair                    | 0 subs renew                                                                                              | in scope                                                                                                                                                                                                                                                | —        | approved                                       | D4.1 "Add to scope"                                                                                                                                                                                                                                               |
| E2 measurement                            | 0 product events                                                                                          | in scope                                                                                                                                                                                                                                                | —        | approved                                       | D4.2 "Add to scope"                                                                                                                                                                                                                                               |
| E3 broker connection health               | 9/9 NEEDS_REAUTH                                                                                          | in scope                                                                                                                                                                                                                                                | —        | approved                                       | D4.3 "Add to scope"                                                                                                                                                                                                                                               |
| E4 roast card + referral                  | no acquisition loop                                                                                       | in scope                                                                                                                                                                                                                                                | —        | approved                                       | D4.4 "Add to scope"                                                                                                                                                                                                                                               |
| E5 ratified pricing + USD tiers           | 7 price lists; SnapTrade ~$2/connected user/mo, paid-only (snaptrade-multi-broker-plan-sep2026.md §scope) | in scope                                                                                                                                                                                                                                                | —        | approved                                       | D4.5 "Add to scope"                                                                                                                                                                                                                                               |
| E6 India display licence                  | founder cost $3–4k/MONTH                                                                                  | GATED TO A TRIGGER: keep scraped + archive/replay; buy when raise closes or India MRR hits a set level; owner + exposed-surface list required                                                                                                           | —        | approved                                       | D4.6b "Gate to a trigger" (supersedes D4.6)                                                                                                                                                                                                                       |
| D5.1 US licence (founder)                 | MONEY-1262; CLAUDE.md "WE ARE ON COMMERCIAL TODAY"                                                        | —                                                                                                                                                                                                                                                       | —        | approved                                       | Founder: "I have data and license is in place". Consequences: (a) CLAUDE.md Tiingo section is stale → update; (b) code gate US_MARKET_ALLOWED_EMAILS still founder-only → widening it is a US-track deploy step (not settable in cloudbuild specs, test-enforced) |
| D5.2 SnapTrade eligibility (founder)      | snaptrade plan §6 unconfirmed entity                                                                      | —                                                                                                                                                                                                                                                       | —        | approved                                       | "Assume it works" — no week-1 go/no-go; entity rejection is an ACCEPTED risk (recorded, owner founder)                                                                                                                                                            |
| D5.3 Data platform after 25-Sep (founder) | Plan 1 run order; B6 ≥11-Oct                                                                              | maintenance only                                                                                                                                                                                                                                        | —        | approved                                       | "Maintenance only": finish run-order steps the US track needs + B6 audit + Atlas M40→M30; then on-call. Plans 2–3 wait                                                                                                                                            |
| D5.4 5-Jan goal (founder)                 | ~3,300 signups/wk needed vs 2–5                                                                           | 1k/50k stretch + committed target from E2 funnel (date amended to 24-Oct by D7.2)                                                                                                                                                                       | —        | approved                                       | "Restate from the funnel"                                                                                                                                                                                                                                         |
| D6.1 Sequence (founder)                   | spec review Clarity #3                                                                                    | Loop fixes first: Wk0 showcase+pitch · Wk1–2 E2,E1(+cycle-13 Billing/GST),E5,US gate widen,E6 trigger,DP maintenance · Wk3–5 E3 then India brokers; goal 10-Oct · Wk4–6 E4 · Wk6–13 SnapTrade P18+FX02+MONEY-217+W08/W10+US brokers · Wk14–15 hardening | —        | approved; wk3–5 slot REOPENED by D6.2 evidence | "Loop fixes first"                                                                                                                                                                                                                                                |
| D6.1b Re-sequence (founder)               | D6.2 evidence                                                                                             | E3 wk3–4; SnapTrade from wk4 (18-Oct), E4 stays wk4–6                                                                                                                                                                                                   | —        | approved (supersedes D6.1 wk3–13)              | Option label "Pull SnapTrade to wk3"; approved CONTENT of that option: "Wk3–4: E3. Wk4 onward: SnapTrade P18. E4 stays wk4–6"                                                                                                                                     |
| D7.1 E6 trigger (founder)                 | D4.6b needed a value                                                                                      | buy India licence when India MRR ≥ ~₹3L/month (≈ licence cost) OR raise closes, whichever first; owner founder                                                                                                                                          | —        | approved                                       | "MRR ≥ licence cost"                                                                                                                                                                                                                                              |
| D7.2 Goal date (founder)                  | E2 ships wk1–2                                                                                            | committed 5-Jan target set 24-Oct from 2–3 wks of E2 data (amends D5.4's 10-Oct)                                                                                                                                                                        | —        | approved                                       | "Move to 24-Oct"                                                                                                                                                                                                                                                  |
| D9 Wk-4 priority (founder)                | round-3 Reviewer Concern                                                                                  | E3 > SnapTrade > E4; E4 slips first (up to 2 wks, into wk6–8); SnapTrade holds its wk6 exit check                                                                                                                                                       | —        | approved                                       | "E3 > SnapTrade > E4"                                                                                                                                                                                                                                             |
| D10.1 Dodo webhook net (founder)          | Sec 2 WebhookMissing/StateDivergence; MONEY-1063                                                          | daily Dodo↔Subscription reconcile: auto-grant access Dodo says is paid, alert on other mismatches; test drops a webhook and proves next-day recovery                                                                                                    | —        | approved                                       | "Daily reconcile + alert"                                                                                                                                                                                                                                         |
| D10.2 Existing payers (founder)           | Sec 2 UnlinkedSubscription                                                                                | grandfather: honour paid period exactly, then one-click invite to a renewing sub at their old price                                                                                                                                                     | —        | approved                                       | "Grandfather + invite"                                                                                                                                                                                                                                            |
| D10.3 Loop absence monitors (founder)     | Sec 2 SilentNoRun/SilentZero/GateMismatch                                                                 | standing monitors via apply-monitors.sh: sweeper ran daily, reconcile ran daily, signup event >0/48h, US-gate probe for a test account; each preflights its series                                                                                      | —        | approved                                       | "Add loop absence monitors"                                                                                                                                                                                                                                       |
| D11.1 MONEY-821 IDOR (founder)            | Sec 3                                                                                                     | fix in wk1: derive userId from Clerk session in startResearchAction + sweep all server actions for client-passed userId; test: A with B's id refused                                                                                                    | —        | approved                                       | "Fix in wk1"                                                                                                                                                                                                                                                      |
| D11.2 Referral guard (founder)            | Sec 3                                                                                                     | credit only on referee activation (broker connect or first roast); cap 10/referrer/month; block same-device + same-email-domain pairs; log each grant                                                                                                   | —        | approved                                       | "Reward on activation + caps"                                                                                                                                                                                                                                     |
| D11.3 Compliance owners (founder)         | Sec 3                                                                                                     | founder owns privacy/DPDP sub-processor disclosure (SnapTrade, Gemini, Claude, DD LLM Obs) + GST/LUT for USD tiers, with counsel/CA, due before wk9 exit check; Claude drafts the privacy sub-processor section                                         | —        | approved                                       | "Founder, before wk9"                                                                                                                                                                                                                                             |
| D12 Duplicate subscriptions (founder)     | Sec 4; MONEY-865 design doc                                                                               | added to E1 (wk1–2): idempotency key on checkout, upgrades via Dodo changePlan, test: two concurrent checkouts → one subscription                                                                                                                       | —        | approved                                       | "Add to E1"                                                                                                                                                                                                                                                       |
| D13 Paper trading (founder)               | Sec 10; CLAUDE.md vs quant report §1 / pitch A9                                                           | REMOVED: E5 free tier excludes it; fix CLAUDE.md, one-pagers, pitch                                                                                                                                                                                     | —        | approved                                       | "Removed; fix the docs"                                                                                                                                                                                                                                           |
| D14 Delight touches (founder)             | Sec 11                                                                                                    | ALL 5 added (~30 min each): last-synced + sync now (E3) · blurred paywall preview (E1/E5) · referral progress (E4) · remembered INR/USD toggle (W10) · demo-portfolio empty state                                                                       | —        | approved                                       | D14.1 + D14.2: all ticked                                                                                                                                                                                                                                         |
| D15.1 Pitch numbers (founder)             | §1 PROD vs deck                                                                                           | founder owns deck wording; facts in §1                                                                                                                                                                                                                  | —        | approved                                       | "I'll handle it"                                                                                                                                                                                                                                                  |
| D15.2 Sweeper dry-run (founder)           | Sec 9                                                                                                     | E1 sweeper ships log-only ~3 days, list reviewed, then armed via APPLY-style flag                                                                                                                                                                       | —        | approved                                       | "3-day dry-run first"                                                                                                                                                                                                                                             |
| D15.3 Live test purchase (founder)        | Sec 9                                                                                                     | after each E1/D12 money-path deploy: one live ₹ purchase, confirm webhook + access + renewal date, refund                                                                                                                                               | —        | approved                                       | "Yes, founder live test"                                                                                                                                                                                                                                          |
| D6.2 India broker expansion (founder)     | adapters coded for Upstox/Angel/Dhan/Fyers/Groww                                                          | GATED ON EXTERNAL APPROVAL per broker; engineering re-enables a broker only when its approval lands                                                                                                                                                     | —        | approved                                       | "Indian brokers are blocked by individual broker approval; US brokers can be onboarded without those restrictions"                                                                                                                                                |
| D6.3 Mobile (founder)                     | pitch "90 days"; P-36 27-Feb                                                                              | after 5-Jan; pitch line to be updated                                                                                                                                                                                                                   | —        | approved                                       | "After 5-Jan"                                                                                                                                                                                                                                                     |

Approval readiness: PASS — checked rows R0, R0b, D2-ALLOC, D3-MODE, E1–E5 (D4.1–D4.5), E6 (D4.6b), D5.1–D5.4, D6.1b, D6.2, D6.3, D7.1, D7.2, D9, D10.1–D10.3, D11.1–D11.3, D12, D13, D14, D15.1–D15.3, D8 — each cites the founder's verbatim answer. No pending remedies remain.

---

## Step 0 — CEO review (23-Sep-2026)

### 0A Premise challenge

The stated problem ("no roadmap") is a proxy. The real problem: **the goal and the
engineering allocation have diverged, and there is no working paid loop.** 50k free by
5-Jan needs ~3,300 signups/week against 2–5 today (~1,000×); 1,000 paid needs ~66/week
against 0 non-zero payments since 23-May. No roadmap closes a 1,000× gap in 15 weeks, and
none of the 14 plans tries. Meanwhile the loop that turns a visitor into renewing revenue is
broken at three joints, each measured: connect (0 of 9 broker links healthy), pay (0 subs
linked to a Dodo subscription → nothing renews; 33 pending/10 failed payments), and measure
(no product events). Do-nothing cost: the Jan goal misses by 2–3 orders of magnitude, the
fundraise narrative rests on numbers PROD contradicts, and the warehouse finishes with no
users to serve.

### 0B Existing leverage

| Sub-problem   | Already exists                                                                                           | Gap                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| "Aha" moment  | Portfolio roast, AI chat, StockSage, CSV import                                                          | 0 roasts in 30d; no share card                                                   |
| Connect       | Zerodha OAuth + adapters, 6 brokers coded                                                                | re-auth broken for all 9 users                                                   |
| Pay + renew   | Dodo integration, `plans.ts`, webhooks                                                                   | subs not linked for renewal; 2 conflicting price files; expired subs read ACTIVE |
| Measure       | PostHog installed, Datadog LLM Obs                                                                       | zero product/funnel events, no bot cohort                                        |
| Acquire       | landing site, `/stock` + `/mf` pages (SEO surface), Momentum Sprint playbook, GTM P-75 tickets 1410–1450 | nothing executed since Jul                                                       |
| Build program | design-v2 34 prompts, bundle committed                                                                   | 0 started                                                                        |
| Data          | lake, tiles, XBRL, US feeds                                                                              | largely built; display licences not bought                                       |

### 0C Dream state

```
CURRENT (23-Sep)                THIS PLAN (as documented)            12-MONTH IDEAL (Sep-2027)
668 users, 1-3 paying,   --->   warehouse done, US full-stack,  ---> A renewing paid base with a
0 connected brokers,            SnapTrade/mobile/alerts promised,    measured funnel; India loop
no funnel data, 7 prices        no growth/activation/pricing work    proven then US corridor on
                                                                     top; licensed data; mobile
```

The documented plan moves the DATA toward the ideal and moves USERS/REVENUE not at all.

### Pending decision rows

| ID and owner                                           | Contract and evidence                                                                                                          | Current             | Proposed                                                                                                                 | Status                | Exact approval and scope                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D2-ALLOC Engineering allocation 26-Sep→5-Jan (founder) | Founder order 22-Sep "warehouse → US full-stack"; PROD 23-Sep: 0 connected, 0 renewing, 0 funnel events; 30d commits ~all data | A: documented order | B: loop-first India, freeze data platform to maintenance after 25-Sep; C: dual-track India loop + US CSV-import corridor | **approved (custom)** | Founder answer 23-Sep to D2: "dual india + us; data for US is already live and plan to integrate US brokers using SNaptrade and expand Indian brokers". Scope: dual track 26-Sep→5-Jan = (1) India track incl. EXPANDING India brokers beyond Zerodha, (2) US track incl. SnapTrade US broker integration (Plan 5 / P18+). Not option C as offered (C excluded SnapTrade). Silent on: data-platform post-25-Sep level, loop fixes (connect/pay/measure), mobile — those stay pending. |

## Answered: D2-ALLOC

Answer (verbatim): "dual india + us; data for US is already live and plan to integrate US brokers using SNaptrade and expand Indian brokers".
Constraint carried forward, not re-litigated: US data is ingested live, but DISPLAY to non-founder users is licence-gated (Tiingo COMMERCIAL = internal use; `US_MARKET_ALLOWED_EMAILS` founder-only; $250/mo redistribution plan MONEY-1262). ~~The US track therefore has a hard prerequisite: the L1 licence purchase~~ — SUPERSEDED by D5.1 (founder: licence in place).

## (superseded payload) currentDecision (D2-ALLOC)

Commitment comparison:
Commitment | Source/approval or pending | Current | A | B | C
Plan 1 finishes Fri 25-Sep showcase | founder 22-Sep | yes | yes | yes | yes
Data platform after 25-Sep | pending | full 16-wk grid | full grid | maintenance only (B6/M40→M30 cost cut + on-call); Plans 2–3 parked | maintenance; Plan 3 parked
US full-stack (Plan 4) | founder order 22-Sep | next | next, 8 wks | after loop gate (~mid-Nov) | W12+W09+CSV import only, no SnapTrade
SnapTrade Oct (pitch promise) | pitch 22-Sep | promised | build Oct | deferred to after loop gate | deferred
India paid loop (reauth fix, Dodo renewal link, one price, funnel events, onboarding, roast share/referral) | pending | not planned | not planned | weeks 1–6 | weeks 1–6, ~60% capacity
Mobile (M00–M14) | pitch "90 days" | promised | not scheduled | after loop gate | not scheduled
Licence purchase (NSE/BSE display) | unowned | unowned | unowned | decided in wk 1 | decided in wk 1

Question: D2 — D2-ALLOC: What does engineering work on from 26-Sep to the 5-Jan goal?
Header: Allocation
A) Documented order: warehouse then US
Keep the 22-Sep order: finish the data-platform grid, then US full-stack (Plan 4) and the SnapTrade build the pitch promised for October. Effort XL, risk high. ✅ Honors the plan you locked on 22-Sep and the investor promises ✅ The data investment compounds and the US corridor carries the highest ARPU ❌ Nothing in it fixes connect, pay or measure, so the 1k-paid goal gets no closer
B) Loop-first India (recommended)
Ship the Friday showcase, then put the data platform on maintenance (only the Atlas cost cut and on-call). Spend 6 weeks making India connect, pay, renew and measure, then gate US on the loop's numbers. Effort L, risk medium. ✅ Aims engineering at the three measured breaks: 0 connected, 0 renewing, 0 events ✅ Reuses built surfaces (roast, Zerodha, Dodo, PostHog), so it's mostly fixes, not new systems ❌ Breaks the pitch's October SnapTrade promise and pauses a warehouse that is 80% done
C) Dual-track India loop + light US
Split capacity: about 60% on the India loop, about 40% on a CSV-import-only US corridor (W12, W09, import), with no SnapTrade. Effort XL, risk high. ✅ Keeps a US story alive for Antler and the NRI corridor ✅ CSV import avoids SnapTrade entity and licence risk ❌ One engineer on two tracks halves the speed of both. US prices still can't be shown until the $250/mo Tiingo plan

## Mode (D3)

SELECTIVE EXPANSION — founder answer 23-Sep ("Selective expansion"), then interrupt: "change
selection option to scope not to be reduced". Applied as: D2-ALLOC scope is a floor; NO
deferral/cut questions will be asked; only additions are offered, each A) add B) defer to
TODOS C) skip.

### 0G HOLD checks (observations only — no cuts proposed, per founder rule)

- Complexity: D2 scope spans India broker expansion + SnapTrade US + US display for one
  engineer in 15 weeks. Recorded as a capacity RISK for Section 1/10, not a cut.
- Minimum set to hit D2's own intent: SnapTrade needs P18 rail + FX Decision 02 + MONEY-217
  RBI fetcher (~~Tiingo L1 purchase~~ superseded by D5.1); India broker expansion needs the 5 coded
  adapters re-enabled in `SYNC_ENABLED_BROKERS` (MONEY-1379 narrowed it to Zerodha).
- Invariant kept: licence gates (section 6) are not optional.

### Expansion candidates (pending, each asked separately)

| #   | Proposal                                                                                                                                     | Effort       | Risk             | Why                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------- | -------------------------------------------------------------------- |
| E1  | Revenue loop repair: link paid subs to Dodo subscriptions so they renew, expire past-period subs, one plan-config source, fix annual=30d bug | M            | med (money path) | 0 subs renew; 1–3 real payers                                        |
| E2  | Measurement: server-side funnel events (signup→connect→aha→pay), bot cohort, prod-host filter, weekly KPI (MONEY-904/902/907)                | S            | low              | zero product events; every later decision is blind                   |
| E3  | Broker connection health: re-auth nudges + one-tap re-connect so linked users stay linked (India + SnapTrade)                                | M            | med              | 9 of 9 Zerodha links NEEDS_REAUTH; expansion without this repeats it |
| E4  | Growth loop: shareable roast card + referral-for-credit (MONEY-1417/1447)                                                                    | M            | low              | no acquisition loop exists; 2–5 signups/week                         |
| E5  | Ratified pricing: one India list + USD tiers for the US track (MONEY-1419), retire lifetime tier                                             | S            | med              | 7 conflicting price lists; US price TBD                              |
| E6  | ~~India display licence purchase scheduled~~ → gated to trigger (D4.6b); cost corrected to $3–4k/MONTH                                       | S (decision) | high if skipped  | India charts/screener RED/AMBER while charging users                 |

Not offered (already promised elsewhere, raise later if wanted): Expo mobile app, persona engine, strategy lab, B2B MCP.

### D2 rationale (founder, 23-Sep, mid-turn)

"reason because data is low cost for US and data feed of Indian is not stable as it is scraped
instead of 3rd party feed due to high cost". Recorded as context for D2; not re-litigated.
Fact for E6 — CORRECTED by founder 23-Sep: "cost of india is $3-4k/month not per year".
India licensed data ≈ $36–48k/yr vs US Tiingo redistribution $250/mo ($3k/yr) — India is
12–16× the US cost. (data-rights audit's ₹2.5–3.5L/yr figure is superseded by the founder's quote.)
The E6 question was asked on the wrong premise ("same order as US"); E6 reopened below.

### Answered: D4.1–D4.4 (founder, 23-Sep)

| #                                                                | Decision                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------- |
| E1 Revenue loop repair                                           | ACCEPTED — add to scope                                 |
| E2 Measurement                                                   | ACCEPTED — add to scope                                 |
| E3 Broker connection health                                      | ACCEPTED — add to scope                                 |
| E4 Growth loop (roast card + referral)                           | ACCEPTED — add to scope                                 |
| E5 Ratified pricing (one India list, USD tiers, retire lifetime) | ACCEPTED — add to scope                                 |
| E6 India display licence                                         | ACCEPTED on a wrong cost premise → REOPENED (see D4.6b) |

## Working roadmap after Step 0 (accepted scope only)

- Floor (D2): dual track 26-Sep→5-Jan — India (expand brokers beyond Zerodha) + US
  (SnapTrade US brokers on live Tiingo/EDGAR data). ~~US display prerequisite: Tiingo L1~~ superseded by D5.1 (licence in place; code+flag gates remain).
- Added: E1 revenue loop repair · E2 measurement · E3 broker connection health ·
  E4 roast card + referral · E5 ratified pricing incl. USD tiers · E6 gated to trigger (D4.6b/D7.1).
- Plan 1 finishes its 25-Sep showcase (unchanged). Data-platform level after 25-Sep: maintenance only (D5.3).

## Approved roadmap (week plan, after D2–D6.1b) — dates anchored wk1 = Sun 27-Sep

| Week  | Dates         | Work (in priority order; first item slips last)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Exit check                                                                                                                                                                                                  |
| ----- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | 24–26 Sep     | Plan 1 showcase (Fri 25) · Dodo×Antler Pitch Day (Sat 26) · deck numbers: founder owns (D15.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | showcase ran on prod                                                                                                                                                                                        |
| 1–2   | 27 Sep–10 Oct | 1 E2 funnel events + bot cohort + host filter + weekly KPI (first, so data accrues) · 2 E1 renewal link / expire subs / one plan source / annual bug · 3 E5 India list + USD tiers, retire lifetime · 4 US display: founder sets `US_MARKET_ALLOWED_EMAILS` in Vercel (Claude hands a NAME=value table; standing no-Vercel rule) · engineer widens the `us-stocks-listing` PostHog flag; update CLAUDE.md Tiingo section (D5.1a) · 5 E6: record exposed-surface list (trigger = India MRR ≥ ~₹3L/mo or raise, owner founder — D7.1) · 6 founder: file approval applications with Upstox, Angel One, Groww, Dhan, Fyers (D6.2) · 7 data platform maintenance: run-order steps US needs · cycle-13 Billing & GST tickets ride with E1 where they overlap, rest slip first | funnel events visible; a test renewal completes end-to-end; US page visible to a non-founder test account; `plans.ts` is the only price source and the lifetime tier is gone; E6 exposed-surface list filed |
| —     | 24 Oct        | committed 5-Jan target from 2–3 wks of E2 data (D5.4 + D7.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | target recorded here                                                                                                                                                                                        |
| 3–4   | 11–24 Oct     | E3 connection health for India links (expiry detect, nudge, one-tap reconnect) · B6 index audit (≥11-Oct) → Atlas M40→M30                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | reconnect path works on a real expired Zerodha token; B6 audit done                                                                                                                                         |
| 4–13  | 18 Oct–26 Dec | SnapTrade: wk4–6 P18 rail + paid gate in front of connect + USD checkout (E5 prices) · wk6–7 FX Decision 02 + MONEY-217 RBI fetcher · wk7–9 W08 connect/import · wk9–11 W10 mixed holdings + E3 reconnect for SnapTrade links · wk11–13 more US brokers (P19+)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | wk6 rail connects a sandbox account · wk7 FX values match spot/RBI · wk9 first external US user connected · wk11 mixed holdings live                                                                        |
| 4–6   | 18 Oct–7 Nov  | E4 roast share card + referral-for-credit (after E2, so it's measured)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | referral signups counted                                                                                                                                                                                    |
| any   | on approval   | India broker N re-enabled in `SYNC_ENABLED_BROKERS` when its approval lands (D6.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | live sync with a real account                                                                                                                                                                               |
| 14–15 | 27 Dec–5 Jan  | launch hardening, measure vs committed target                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | KPI review                                                                                                                                                                                                  |

After 5-Jan: mobile (D6.3), Plans 2–3, lake release.
Accepted risks (founder): SnapTrade entity eligibility unverified (D5.2); India display on scraped data until the E6 trigger fires (D4.6b).

## Reviewer Concerns (spec review round 3, unresolved)

- ~~Week 4 overlap~~ RESOLVED by D9 (E3 > SnapTrade > E4).

## Open, not deferred (owned by review sections)

~~MONEY-821~~ D11.1 · ~~SnapTrade/DPDP disclosure~~ D11.3 · ~~GST on USD tiers~~ D11.3 · ~~paper-trading truth~~ D13 (FREE feature vs removed).

## D8 — documents approved (founder, 23-Sep): "Approve, continue". Review depth: strategy-level

(capability rows + "implementation owner must prove \_\_\_"), since the request is a product plan/roadmap.

## 0I Temporal interrogation (what the implementer hits, by phase)

| Phase                   | What they need / will hit                                                                                                                                                                                                        | Human-team | CC + gstack |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------- |
| Hour 1 — foundations    | PROD truth numbers (§1), the ledger, `plans.ts` vs `plan-config.ts`, Dodo subscription model, `SYNC_ENABLED_BROKERS`, `US_MARKET_ALLOWED_EMAILS` + `us-stocks-listing` flag                                                      | 1 day      | 1 hr        |
| Hours 2–3 — core        | E1: which existing Payment rows map to which Dodo subscription (none linked today — backfill or grandfather?); E2: event names and where server-side capture lives; E5: what happens to the 1–3 existing payers on retired tiers | 3 days     | half day    |
| Hours 4–5 — integration | E3: Zerodha tokens expire DAILY by design — "reconnect" is a daily habit, not an error, so the UX is a morning re-login flow; SnapTrade: FX Decision 02 vs `FxRate` unique key (cross-pack C3)                                   | 1 week     | 1–2 days    |
| Hour 6+ — polish/tests  | money-path tests (renewal, expiry, USD checkout), referral abuse limits, funnel event absence alarms                                                                                                                             | 1 week     | 1 day       |

Feasibility blockers: none new beyond the week-4 overlap (Reviewer Concerns). Pending choices carried: E1 treatment of existing payers (implementation owner must prove no current payer loses access).

## Section 1 — Architecture (findings)

Diagram: see chat record 23-Sep (connection-health layer shared by India + SnapTrade; subscription state machine; E2 events from every box).

- OK: E3 is ONE shared connection-health layer. Owner must prove SnapTrade's disabled-connection signal feeds the same state machine as Zerodha's daily expiry.
- WARNING: Subscription state machine ACTIVE → PAST_DUE → EXPIRED is new; today nothing leaves ACTIVE. Only Dodo webhook or the expiry sweeper may move it, never the client. Owner must prove webhook and sweeper cannot race into a wrong terminal state.
- WARNING: Dodo webhook is a single point of failure for the paid loop; MONEY-1063 (webhook vs callback divergence) open. Remedy decided in Section 2.
- Rollback: E1/E3/E5 behind flags with a return-to-current path; US gate rollback = one env var.
- Platform: E2 events named by user outcome (broker_connected, first_aha, subscription_renewed) — the spine for persona/B2B/mobile later.
- Feasibility: week-4 overlap resolved by D9.

## Section 2 — Error & Rescue map (strategy level)

Capability map recorded in chat 23-Sep. Gaps and dispositions:

- WebhookMissing, StateDivergence → D10.1 daily reconcile + alert.
- UnlinkedSubscription → D10.2 grandfather + invite.
- SilentNoRun, SilentZero, GateMismatch → D10.3 absence monitors.
- UpstreamError (SnapTrade), FxMissing → owner must prove: retry with backoff then degrade to "sync delayed" + last-synced time; value shown with "FX as of" date. No catch-alls; log attempted op + user + connection id.
- TelemetryDropped → correct as fire-and-forget, never blocks the user.
- ReferralAbuse → Section 3.
  Week plan impact: D10.1–D10.3 land inside wk1–2 alongside E1/E2 (same code areas).

## Section 3 — Security & threat model

Threat table recorded in chat 23-Sep. Dispositions: IDOR → D11.1; referral farming → D11.2; privacy/DPDP + GST → D11.3.
Owner must prove: SnapTrade user tokens use the existing AES-256-GCM per-user pattern; SnapTrade/holdings text enters LLM prompts through the existing sanitisation path; US display stays enforced server-side (quote, stream, /v1) and D10.3 probes it.

## Section 4 — Data flow & interaction edge cases

- Async ordering (Subscription shared by webhook, D10.1 reconcile, E1 sweeper). Invariant: never EXPIRED while Dodo reports paid-through ≥ now. Violating schedule: sweeper reads stale periodEnd, webhook renews, sweeper writes EXPIRED. Owner must prove expiry is ONE conditional update (`updateMany where currentPeriodEnd < now`), not read-then-write; regression test pauses the sweeper between read and write, lands the webhook, asserts ACTIVE.
- Duplicate subscriptions → D12.
- Owner must prove: stale pending payments get a TTL (33 pending in PROD); reconnect during a running sync keeps the sync claim valid across the token swap; abandoned SnapTrade OAuth leaves no "connected" row; referral attribution is first-touch, one grant.

## Section 5 — Code quality (strategy level)

- DRY: two price files (`plans.ts`, `plan-config.ts`) → E5 makes `plans.ts` the single source (exit check). Referral should extend the existing `InviteToken` + credit ledger, not add a parallel model. E3 is one connection-health module for all rails. Absence monitors reuse `apply-monitors.sh` rows — no new script.
- Over-engineering risk: none of E1–E5 needs a new service; all live in `packages/services` / `packages/core` beside existing billing and broker code.
- Under-engineering risk: money paths — covered by D10.1, D12, Section 4 conditional-update rule.
  No issues requiring a decision.

## Section 6 — Tests (approved coverage carried forward, not re-asked)

| New thing         | Type                   | Happy                                        | Failure                                          | Edge                                         |
| ----------------- | ---------------------- | -------------------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| E1 renewal link   | integration            | webhook renews → ACTIVE, new end date        | webhook lost → D10.1 reconcile restores next day | annual period = 365d, not 30 (the PROD bug)  |
| E1 sweeper        | unit + ordering        | past-end sub → EXPIRED                       | —                                                | paused-sweeper/webhook race → ACTIVE (Sec 4) |
| D12 checkout      | integration            | one sub                                      | two concurrent checkouts → one sub               | upgrade via changePlan, no second sub        |
| D10.2 grandfather | unit                   | paid period honoured to the day              | —                                                | payer with past endDate not re-granted       |
| E2 events         | unit                   | each outcome event fires once server-side    | capture failure never blocks the request         | bot/QA host excluded                         |
| E3 reconnect      | integration            | expired token → nudge → reconnect → sync     | nudge email bounce → in-app card persists        | reconnect mid-sync                           |
| E5 pricing        | unit                   | only `plans.ts` read (grep/source-scan test) | —                                                | lifetime tier absent                         |
| D11.1 IDOR        | security unit          | own userId works                             | A with B's id refused                            | all server actions scanned                   |
| D11.2 referral    | unit                   | reward on referee activation                 | self-referral / same device refused              | 11th reward in a month refused               |
| SnapTrade rail    | contract + integration | sandbox connect → holdings                   | 5xx → backoff then "sync delayed"                | FX missing → "FX as of"                      |
| US gate           | E2E probe (D10.3)      | non-founder test account sees US page        | env and flag mismatch → monitor fires            | —                                            |

2am-Friday test: the Section 4 race test plus the D10.1 dropped-webhook test. Chaos test: kill the sweeper cron for 2 days → D10.3 absence monitor fires. Flakiness risk: time-based sweeper tests must inject the clock (repo rule MONEY-1402). LLM changes: none in scope.

## Section 7 — Performance

Scale is tiny (668 users). Reconcile: one Dodo list call per day, paged. SnapTrade sync rides the existing sharded scheduled sync (`syncBucket`, MONEY-1379), so no new fan-out. Indexes: owner must prove `Subscription(status, currentPeriodEnd)` for the sweeper and `BrokerConnection(status)` for E3. No issues requiring a decision.

## Section 8 — Observability

Covered by D10.3 (absence monitors) + E2 (weekly KPI). Day-1 dashboard panels: signups, broker_connected, first_aha, paid, renewed, reconnect rate, referral grants, SnapTrade sync failures. Runbooks: webhook mismatch alert → check D10.1 log then Dodo dashboard; reconnect-rate drop → check Zerodha login flow. Debuggability: every money-state change logs subscription id, old/new status, source (webhook | reconcile | sweeper). No issues requiring a decision.

## Section 9 — Deployment & rollout

- Migrations: Mongo `db push` adds fields, not values — any new `Subscription` / `BrokerConnection` field is ABSENT on old rows; never filter `{field: null}` (CLAUDE.md, MONEY-1050/1234/1235). Owner must prove a backfill or absent-tolerant reads.
- Flags: E1 sweeper, D10.1 auto-grant, E3 nudges, E4 referral, SnapTrade connect each behind a flag; arm-flag discipline (literal string, per-call read, present-and-"false").
- Order: E2 first (so the rest is measured) → E1 + D12 + D10 → E5 → US gate (founder env + PH flag).
- Rollback: flag off; the sweeper is the only destructive writer, so it ships log-only for ~3 days, then armed (D15.2).
- Post-deploy: Dodo test-mode purchase on QA, then one live ₹ purchase + renewal check by the founder, refunded (D15.3).
  No issues requiring a decision.

## Section 10 — Long-term trajectory

- Reversibility: E1/E2/E5 4/5 (flags); SnapTrade 3/5 (BrokerType + users' data expectations); E6 trigger 5/5.
- Debt: data platform paused mid-grid (gold 0 rows) by D5.3 — refresh CLAUDE.md "WIRED BUT NOT ARMED" notes at resume.
- Retrospective: accepted cherry-picks are mutually load-bearing (E3→broker growth, E2→24-Oct goal, E1→paid growth); nothing load-bearing rejected.
- After 5-Jan: mobile (D6.3) → Plans 2–3 → lake release; E2 outcome events feed persona engine P-60.
- Paper trading → D13 (removed; docs fixed).

## Section 11 — Design & UX

UI scope: reconnect card (E3), paywall/checkout INR+USD (E1/E5/D12), share card + referral (E4), US connect + mixed holdings (W08/W10). Flow and state-coverage table recorded in chat 23-Sep. Owner must prove the PARTIAL state for reconnect (1 of N brokers expired) and pending-payment "confirming" state.
Recommend: /plan-design-review before wk1 (paywall) and wk7 (US screens); /design-review on live after each.
Delight touches → D14 (all 5 accepted).

---

# Review outputs (Stage 1)

## NOT in scope

Deferred: none. Rejected: none. Excluded by founder decisions (not deferrals):

- Mobile / Expo app — after 5-Jan (D6.3).
- Data platform full grid, Plans 2–3 (apps/api, news engine), lake release — maintenance only (D5.3).
- India licensed data purchase — until India MRR ≥ ~₹3L/mo or raise (D7.1).
- SnapTrade eligibility pre-check — skipped, accepted risk (D5.2).
- Not offered this review: persona engine, strategy lab v2, B2B/MCP, crypto, doc-ingest realtime.

## What already exists (reused)

| Sub-problem    | Existing                                                                             | Reused?                                             |
| -------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Billing        | Dodo integration, webhooks, `plans.ts`, MONEY-865 design doc                         | yes — E1/D12 fix and extend                         |
| Broker connect | Zerodha OAuth + 5 coded India adapters, encrypted creds, sharded sync (`syncBucket`) | yes — E3 layer on top; India re-enable per approval |
| US data        | Tiingo EOD/realtime, EDGAR, tiles, licence-gated reads                               | yes — widen gates only                              |
| Aha            | roast, StockSage, chat, demo mode                                                    | yes — share card, blurred preview, demo empty state |
| Referral       | `InviteToken`, credit ledger                                                         | yes — extend, no parallel model                     |
| Monitoring     | `apply-monitors.sh` absence rows (MONEY-1399 kinds)                                  | yes — D10.3                                         |
| Analytics      | PostHog installed, flags in use                                                      | yes — E2 adds events + cohort                       |
| Build prompts  | design-v2 W08/W10 (US), cross-pack order                                             | yes — SnapTrade block follows them                  |

## Dream state delta

From "668 users, 1–3 payers, 0 connected, blind" → by 5-Jan: a measured funnel, subscriptions that renew and self-heal, broker links that recover, a referral loop, and US holdings via SnapTrade for paying users. Still short of the 12-month ideal on: licensed India data, mobile, persona engine, and a proven acquisition channel at scale (only E4 targets the free-user number).

## Error & Rescue Registry (strategy level — capability rows)

| Capability      | Failure mechanism         | User impact              | Safeguard (approved)                 | Verify owner                      |
| --------------- | ------------------------- | ------------------------ | ------------------------------------ | --------------------------------- |
| Renewal         | webhook lost/out of order | paid, no access          | D10.1 daily reconcile + auto-grant   | implementer: dropped-webhook test |
| Renewal         | declined card             | lapse                    | Dodo retry + PAST_DUE state          | implementer                       |
| Existing payers | unlinked subs             | silent lapse             | D10.2 grandfather + invite           | implementer                       |
| Expiry          | sweeper dead              | expired subs stay ACTIVE | D10.3 absence monitor                | implementer                       |
| Expiry          | sweeper/webhook race      | renewed user expired     | conditional update (Sec 4)           | implementer: paused-race test     |
| Checkout        | duplicate sub             | double billing           | D12 idempotency + changePlan         | implementer                       |
| Funnel          | renamed/dropped event     | founder sees 0           | D10.3 signup-absence monitor         | implementer                       |
| Connection      | token expiry (daily)      | stale holdings           | E3 nudge + reconnect                 | implementer                       |
| SnapTrade       | 5xx / FX missing          | stale/incomplete values  | backoff → "sync delayed"; "FX as of" | implementer must prove            |
| US gate         | env ≠ flag                | blank US page            | D10.3 gate probe                     | founder (env) + implementer       |
| Referral        | farming                   | credit leak              | D11.2 activation reward + caps       | implementer                       |
| Research        | IDOR                      | cross-user billing/data  | D11.1 wk1 fix                        | implementer                       |

## Failure Modes Registry

```
CODEPATH (capability) | FAILURE MODE          | RESCUED?     | TEST?       | USER SEES?           | LOGGED?
----------------------|-----------------------|--------------|-------------|----------------------|--------
renewal               | webhook lost          | Y (D10.1)    | Y (planned) | ≤1 day delay         | Y
renewal               | declined card         | Y (Dodo)     | owner       | PAST_DUE notice      | Y
existing payers       | unlinked              | Y (D10.2)    | Y (planned) | invite email         | Y
expiry sweeper        | not running           | Y (D10.3)    | chaos test  | nothing (alerted)    | Y
expiry sweeper        | race with webhook     | Y (Sec 4)    | Y (planned) | nothing              | Y
checkout              | duplicate             | Y (D12)      | Y (planned) | one charge           | Y
funnel events         | silent zero           | Y (D10.3)    | Y (planned) | nothing (alerted)    | Y
connection            | token expired         | Y (E3)       | Y (planned) | reconnect card       | Y
SnapTrade             | upstream 5xx          | owner        | owner       | "sync delayed"       | owner
SnapTrade             | entity rejected       | N (accepted risk D5.2) | N | US track blocked     | —
US gate               | env/flag mismatch     | Y (D10.3)    | Y probe     | nothing (alerted)    | Y
referral              | farming               | Y (D11.2)    | Y (planned) | —                    | Y
research              | IDOR                  | Y (D11.1)    | Y (planned) | refused              | Y
```

CRITICAL GAPS (RESCUED=N AND TEST=N AND silent): 0. The SnapTrade-entity row is N/N but visible (it blocks the track loudly) and is a founder-accepted risk.

## Scope Expansion Decisions

CEO plan: ~/.gstack/projects/UseMoney-AI-stockbook-monorepo/ceo-plans/2026-09-23-full-product-roadmap.md

- Accepted (11): E1, E2, E3, E4, E5, E6 (gated), + D14 delight ×5 (last-synced, blurred paywall preview, referral progress, INR/USD memory, demo empty state). Also accepted remedies: D10.1–3, D11.1–3, D12, D13.
- Deferred: none. Skipped: none.

## Diagrams

1. System architecture — Section 1 (chat record) and below.
2. Data flow with shadow paths:

```
signup ─► event(E2) ─► connect ─► token ─► sync ─► holdings ─► aha ─► paywall ─► Dodo ─► webhook ─► Subscription
  │nil email→Clerk rejects  │OAuth abandoned→no row   │expired→E3 card   │5xx→"delayed"  │lost→D10.1 reconcile
```

3. State machine — Subscription:

```
 PENDING ─pay ok(webhook|reconcile)─► ACTIVE ─renew─► ACTIVE
    │ttl                              │ card declined          │ periodEnd<now (conditional update only)
    ▼                                 ▼                        ▼
 ABANDONED                        PAST_DUE ─retry ok─► ACTIVE   EXPIRED ─re-subscribe─► PENDING
 invalid: client→any state; EXPIRED while Dodo paid-through ≥ now (prevented by conditional update + D10.1)
```

Connection (E3): HEALTHY ─token expiry─► NEEDS_REAUTH ─nudge─► (user reconnects) ─► HEALTHY; NEEDS_REAUTH 30d (SnapTrade disabled) ─► REMOVED. 4. Error flow: failure → structured log (op, user, id) → rescue (retry | degrade | reconcile) → user message → absence monitor if silent. 5. Deployment sequence: E2 → D11.1 → E1+D12+D10.1/2 → E5 → D10.3 → US gate (founder env + PH flag) → E3 → SnapTrade P18 → E4. 6. Rollback: flag off per feature → sweeper is the only destructive writer (log-only 3 days first, D15.2) → US gate: reset env var → pricing: `plans.ts` revert.

## Stale Diagram Audit

Files this plan will touch carry no ASCII diagrams known to be affected. CLAUDE.md prose (Tiingo "COMMERCIAL today", paper trading as FREE feature) is stale → covered by D5.1a and D13.

## Implementation Tasks

Strategy-level: next action + owner + verification. Effort ratios assumed: features ~30x, bug fix ~20x, tests ~50x.

- [ ] **T1 (P1, human: ~3d / CC: ~3h)** — analytics — E2 funnel events + bot cohort + prod-host filter + weekly KPI
  - Surfaced by: Step 0 / §1 — "no product events in PostHog"
  - Files: to be determined
  - Verify: events visible for a test signup→connect→roast on prod host; QA host excluded
- [ ] **T2 (P1, human: ~4h / CC: ~30m)** — security — D11.1 derive userId from session in startResearchAction + sweep server actions
  - Surfaced by: Section 3 — MONEY-821
  - Files: apps/web/lib/actions/research.ts (+ sweep)
  - Verify: test — user A with user B's id is refused
- [ ] **T3 (P1, human: ~1w / CC: ~1d)** — billing — E1 + D12 + D10.1 + D10.2 revenue loop
  - Surfaced by: Section 2/4 — WebhookMissing, UnlinkedSubscription, duplicate subs, sweeper race
  - Files: packages/core/src/payments/_, packages/core/src/subscription/_, docs/architecture/MONEY-865-paid-tier-change.md (design)
  - Verify: dropped-webhook recovery test; paused-sweeper race test; two concurrent checkouts → one sub; annual = 365d
- [ ] **T4 (P1, human: ~2d / CC: ~2h)** — pricing — E5 single source + USD tiers + retire lifetime (free tier excludes paper trading, D13)
  - Surfaced by: §3 — 7 price lists
  - Files: packages/core/src/subscription/plans.ts, packages/core/src/payments/plan-config.ts
  - Verify: source-scan test — only plans.ts read; lifetime tier absent
- [ ] **T5 (P1, founder + CC: ~1h)** — US display — founder sets `US_MARKET_ALLOWED_EMAILS` in Vercel (Claude supplies NAME=value); widen `us-stocks-listing` flag; update CLAUDE.md Tiingo section
  - Surfaced by: D5.1
  - Files: CLAUDE.md
  - Verify: non-founder test account sees a US price
- [ ] **T6 (P1, human: ~1d / CC: ~1h)** — observability — D10.3 absence monitors (sweeper, reconcile, signup, US-gate probe)
  - Surfaced by: Section 2
  - Files: scripts/ops/datadog/apply-monitors.sh
  - Verify: `apply-monitors.sh prod --only=verify` exits 0; killing the sweeper fires the monitor
- [ ] **T7 (P2, human: ~1w / CC: ~1–2d)** — brokers — E3 connection health (India first, SnapTrade hook later)
  - Surfaced by: §1 — 9/9 NEEDS_REAUTH
  - Files: to be determined
  - Verify: real expired Zerodha token → card → reconnect → sync
- [ ] **T8 (P2, human: ~8w / CC: ~2w)** — US brokers — SnapTrade P18 rail + paid gate + USD checkout + FX02 + MONEY-217 + W08/W10
  - Surfaced by: D2, D6.1b
  - Files: archive-docs snaptrade plan P18; docs/prompts/design-v2/web/W08, W10
  - Verify: wk6 sandbox connect; wk9 first external US user; wk11 mixed holdings
- [ ] **T9 (P2, human: ~1w / CC: ~1–2d)** — growth — E4 roast share card + referral with D11.2 guards
  - Surfaced by: Step 0 — no acquisition loop
  - Files: to be determined
  - Verify: referral credit only after referee activation; 11th/month refused
- [ ] **T10 (P2, human: ~1d / CC: ~2.5h)** — UX — D14 five delight touches
  - Surfaced by: Section 11
  - Files: to be determined
  - Verify: each visible on its screen
- [ ] **T11 (P2, human: ~2h / CC: ~15m)** — docs — D13 paper trading removed: fix CLAUDE.md, one-pagers, pitch
  - Surfaced by: Section 10
  - Files: CLAUDE.md, docs/fundraising/\*
  - Verify: grep "paper trading" shows no live-feature claims
- [ ] **T12 (P1, founder)** — ops/legal — file India broker approval applications (D6.2); D11.3 privacy/DPDP + GST/LUT before wk9; E6 exposed-surface list
  - Surfaced by: D6.2, D11.3, D7.1
  - Files: —
  - Verify: applications filed; counsel/CA sign-off recorded here
- [ ] **T13 (P2)** — review — run /plan-eng-review, then /plan-design-review before wk1 paywall work
  - Surfaced by: Section 11 + review chaining
  - Files: —
  - Verify: both show CLEAR on the dashboard

## Completion Summary

```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | SELECTIVE EXPANSION (D2 never reduced)      |
  | System Audit         | 30d: ~all commits data-platform; PROD 668   |
  |                      | users, 1–3 payers, 0 connected, 0 events    |
  | Step 0               | dual India+US; E1–E6; data plat maintenance |
  | Section 1  (Arch)    | 4 issues found                              |
  | Section 2  (Errors)  | 14 error paths mapped, 5 GAPS (all remedied)|
  | Section 3  (Security)| 5 issues found, 2 High severity             |
  | Section 4  (Data/UX) | 7 edge cases mapped, 1 unhandled (→ D12)    |
  | Section 5  (Quality) | 0 issues requiring decision                 |
  | Section 6  (Tests)   | Diagram produced, 0 gaps                    |
  | Section 7  (Perf)    | 0 issues found                              |
  | Section 8  (Observ)  | 0 gaps found (covered by D10.3/E2)          |
  | Section 9  (Deploy)  | 3 risks flagged                             |
  | Section 10 (Future)  | Reversibility: 4/5, debt items: 2           |
  | Section 11 (Design)  | 4 surfaces, 5 delight touches accepted      |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (5 items)                           |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 12 rows, 0 CRITICAL GAPS                    |
  | Failure modes        | 13 total, 0 CRITICAL GAPS                   |
  | TODOS.md updates     | 0 items proposed                            |
  | Scope proposals      | 11 proposed, 11 accepted (SEL)              |
  | CEO plan             | written                                     |
  | Outside voice        | codex: unavailable (not installed; no fallback tool) |
  | Lake Score           | N/A (no coverage-scored questions)          |
  | Diagrams produced    | 6 (arch, data flow, state x2, error, deploy/rollback) |
  | Stale diagrams found | 0 (2 stale prose items → D5.1a, D13)        |
  | Unresolved decisions | 0                                           |
  +====================================================================+
```

## Unresolved Decisions

None. All 31 ledger rows carry the founder's answer (D15.1–D15.3 settled the last three).

# ENGINEERING REVIEW — /plan-eng-review (23-Sep-2026)

Target: this plan, engineering depth on weeks 1–2 (E1, E2, E5, D10.1–D10.3, D11.1, D12, US gate); later weeks (E3, SnapTrade, E4) at architecture level. Report file: this file. Branch: fix/MONEY-1544.

## Factual corrections from code (no behaviour change; evidence quoted by code-mapping agents, spot-checked)

| #   | Plan said                                                   | Code says                                                                                                                                                                                                                                                                                                                                               | Evidence                                                                           | Conf                |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------- |
| C1  | D12: upgrades create a 2nd Dodo sub; build MONEY-865 design | MONEY-865 is BUILT: `applyDodoUpgradeInPlace` → `changePlan` `proration_billing_mode: "prorated_immediately"`; 2-min in-flight dedupe on `changeplan:` rows. Residual gap: plain `createCheckoutAction` sends NO idempotency key                                                                                                                        | apps/web/lib/actions/subscription.ts:277, :198, :695, :1108                        | 9                   |
| C2  | E1: "0 subs linked to Dodo — nothing renews"                | Code links: grants write `dodoSubscriptionId`; renewal/cancel/expiry webhooks read it. PROD's 7 unlinked rows are legacy one-time/coupon grants → a DATA gap (D10.2), not a code gap                                                                                                                                                                    | packages/services/src/subscription-grants.service.ts:108, :319–322, :856           | 8                   |
| C3  | E1 sweeper: expire when `currentPeriodEnd < now`            | No `currentPeriodEnd` field. Paid grants write `endDate: null`; period end lives in `nextBillingDate` (from webhook) and `proEntitlementEndDate` (PRO only). Without a webhook an ACTIVE paid row stays paid FOREVER — the failure is revenue leak, not lockout                                                                                         | schema.prisma:100–177; subscription-grants.service.ts:319–322                      | 9                   |
| C4  | (not in plan)                                               | Two entitlement gates disagree: `resolveEntitlementPlan` checks `endDate` expiry; `buildSubscriptionAccess` checks only `status !== "ACTIVE"`, no date                                                                                                                                                                                                  | packages/services/src/subscription-logic.ts:766                                    | 8                   |
| C5  | E1: "annual plan recorded as 30 days" bug                   | Not found in code: `buildProEntitlementFields` uses 365; `determineEndDate` has 0 prod callers. Likely cause of the PROD row: `resolveCheckoutPeriod` defaults to monthly when `billingPeriod` is absent. → investigate, not fix                                                                                                                        | subscription-logic.ts:623; plan-config.ts:288                                      | 6                   |
| C6  | E5: "two price files"                                       | THREE sources: synced Dodo catalog (checkout's source of truth), canonical `plans.ts`, and `plan-config.ts` (`WEBHOOK_PLANS` stale PREMIUM price 999, used by webhook grant; its own `PLAN_CONFIG` dead outside tests)                                                                                                                                  | plan-display.ts:68; plan-config.ts:32,:54,:135; subscription-grants.service.ts:114 | 9                   |
| C7  | (not in plan)                                               | `dodoSubscriptionId` unindexed; every webhook does `findFirst({ where: { dodoSubscriptionId } })`                                                                                                                                                                                                                                                       | schema.prisma:176–177                                                              | 8                   |
| C8  | D10.1: new daily job                                        | Reusable template exists: Vercel cron `vercel.json` + `verifyCronAuth` (`/api/cron/sync-products` daily; `/api/cron/apply-scheduled-plan-changes` hourly with conditional `updateMany`)                                                                                                                                                                 | apps/web/vercel.json; apps/web/app/api/cron/apply-scheduled-plan-changes/route.ts  | 9                   |
| C9  | E2: "PostHog has zero server capture"                       | Server capture helper exists: `captureServiceEvent` (no-op without key); natural emit points: Clerk `handleUserCreated`, `handleOAuthCallbackAction`, `processRoast` (workers), `provisionPaymentCompleted`                                                                                                                                             | packages/services/src/analytics.ts:21; app/api/webhooks/clerk/route.ts:374         | 9                   |
| C10 | D11.1: "sweep server actions for client userId"             | Sweep result: `startResearchAction` old-convention branch (research.ts:183–185, caller registry.ts:503); `job-service.ts` ("use server") exports `startJob/cancelJob/getJob(jobId)` with NO owner check and `getJobForUser/getUserJobs(userId)`; `clearFeatureFlagsCache()` no auth, clears ALL. Reachability from clients unverified (no .tsx imports) | research.ts:183; job-service.ts:1,:60,:148,:161; feature-flags.ts:651              | 9 code / 6 exposure |
| C11 | E4 referral: "extend InviteToken + credit ledger"           | InviteToken is admin-issued; credit models track SPEND only (no grant ledger); zero referral code in repo                                                                                                                                                                                                                                               | schema.prisma:400–419, :4463, :4495                                                | 9                   |

## Scope Challenge record

feature answers: none proposed (founder rule D3: D2 scope never reduced); structure: A "Original arrangement" (eng D2, 23-Sep); accepted scope: new `Subscription.currentPeriodEnd` + backfill from nextBillingDate/proEntitlementEndDate; new sweeper cron route + service (log-only 3 days per D15.2); new daily reconcile cron route + service (D10.1); new E2 analytics module; plan-config.ts retained beside plans.ts; pending remedies: R1 C1, R2 C4, R3 C5, R4 C7, R5 C10.
Required proof carried (approved contract, no new question): every writer of a period (webhook grant, callback grant, `applyDodoRenewal`, `applyDodoUpgradeInPlace`) also writes `currentPeriodEnd`; test per writer. Mongo `db push` leaves the field ABSENT on old rows → backfill before the sweeper arms; sweeper must skip rows with the field absent (never `{currentPeriodEnd: null}`).
Search check: patterns are in-repo (Vercel cron + verifyCronAuth, conditional updateMany, captureServiceEvent) — [Layer 1]; no web search run.
TODOS cross-reference: no TODOS.md in repo.
Distribution check: no new artifact (no binary/package/container).

## Eng decision ledger

### R1: C1 plain-checkout idempotency

Finding: 1, P2, conf 9, apps/web/lib/actions/subscription.ts:695/:1108, eng-review
Plan baseline: D12 approved "idempotency key on checkout, upgrades via changePlan, test: two concurrent checkouts → one subscription" (CEO D12). changePlan part already built (C1).
Runtime evidence: createCheckoutAction creates PENDING Payment + `subscriptions.create` with no idempotency key; upgrade path has 2-min dedupe.
Comparison grid: R1 | Current: none on plain checkout | A: key per (userId, productId) 10-min window, reuse existing pending checkout URL | B: reuse the 2-min `changeplan:` dedupe pattern for plain checkout
State: approved — covered by exact prior approval CEO D12 ("idempotency key on checkout"); no question needed. Mechanism to be chosen by implementer; required proof: two concurrent checkouts → one Dodo subscription.
Actual answer: CEO D12 "Add to E1"
Accepted scope: idempotent plain checkout + concurrency test.

### R2: C4 entitlement gate disagreement

Finding: 2, P1, conf 8, packages/services/src/subscription-logic.ts:766, eng-review
Plan baseline: not in plan.
Runtime evidence: resolveEntitlementPlan checks endDate expiry; buildSubscriptionAccess checks only status.
Comparison grid: R2 | Current: two gates | A: buildSubscriptionAccess delegates to resolveEntitlementPlan (one rule), tests assert both agree on every status×date case | B: keep both, add a parity test only | C: leave as is
State: approved
Actual answer: D3 "A) One rule"
Accepted scope: buildSubscriptionAccess delegates to resolveEntitlementPlan; tests assert both agree on every status×date case (incl. currentPeriodEnd).

### R3: C5 annual-period investigation

Finding: 3, P2, conf 6, subscription-logic.ts:623 / resolveCheckoutPeriod
Plan baseline: E1 "fix annual=30d bug" (CEO D4.1).
Runtime evidence: no code writes a 30-day annual end; PROD row cause unknown.
Comparison grid: R3 | Current: E1 includes a fix for an unlocated bug | A: replace with a bounded investigation (read the PROD row's Payment + metadata, ≤2h) then fix only if located | B: keep "fix" wording
State: approved
Actual answer: D4 "A) Investigate first"
Accepted scope: replace E1 "fix annual=30d bug" with a ≤2h read-only PROD investigation of the row's Payment + metadata; fix only the located cause, with a regression test.

### R4: C7 dodoSubscriptionId index

Finding: 4, P2, conf 8, schema.prisma:176–177
Plan baseline: not in plan.
Runtime evidence: unindexed; every webhook + the new reconcile look up by it.
Comparison grid: R4 | Current: no index | A: add @@index([dodoSubscriptionId]) (+ push via setup-infra db) | B: skip at current scale
State: approved
Actual answer: D5 "A) Add the index"
Accepted scope: @@index([dodoSubscriptionId]) on Subscription; push via setup-infra.sh {env} --only db before the prod→QA sync.

### R5: C10 unauthenticated "use server" exports

Finding: 5, P1, conf 9 code / 6 reachability, job-service.ts:60/148/161, feature-flags.ts:651
Plan baseline: D11.1 approved "sweep all server actions for client-passed userId" — covers getJobForUser/getUserJobs/getActiveJobs/cleanupOldJobs/processImportJob (client-passed userId). NOT covered: jobId-only functions with no owner check and clearFeatureFlagsCache (no userId param).
Comparison grid: R5 | Current: exported, unchecked | A: move job-service + clearFeatureFlagsCache out of "use server" modules (server-only helpers), add a source-scan test that no "use server" export takes userId or skips auth | B: add owner/admin checks inside each | C: leave (not imported by client code)
State: approved
Actual answer: D6 "A) Move out + scan test"
Accepted scope: move job-service.ts exports and clearFeatureFlagsCache into server-only (non-"use server") modules; source-scan test: no "use server" export takes userId or skips auth.

### R6: CRITICAL regression — chat `run_research` after D11.1

Finding: 6, P1, conf 9, apps/web/lib/chat-tools/registry.ts:503 (`startResearchAction(userId, …)`); apps/web/**tests**/actions/research-symbol-validation.test.ts:48 pins old convention
Plan baseline: D11.1 approved "derive userId from Clerk session … test: A with B's id refused" — no regression contract for the chat tool caller.
Runtime evidence: chat tool runner passes session-derived userId via the old first-arg branch (research.ts:183–185).
Comparison grid: R6 | Current: none | A: chat caller switches to the session convention; keep behaviour: chat research starts for the signed-in user; intentional change: first-arg userId no longer honoured; assertions: (1) chat run_research starts a session owned by the caller, (2) a foreign userId as first arg is ignored/refused, (3) research-symbol-validation tests rewritten to the new convention | B: keep the old branch for server-internal callers only via a non-exported internal function
State: approved
Actual answer: D7 "A) Chat uses session"
Accepted scope: chat caller (registry.ts:503) switches to the session convention; assertions: chat run_research starts a session owned by the caller; a foreign first-arg userId is ignored/refused; research-symbol-validation tests rewritten to the new convention.

## Eng Sections — findings

**Section 1 Architecture.** Findings 1–5 → R1–R5 (all approved). Production failure scenarios: webhook lost → D10.1 reconcile; sweeper expires a payer whose period writer skipped currentPeriodEnd → carried proof (every writer writes it; absent-field skip); Dodo API down during reconcile → job fails loudly, D10.3 absence monitor fires next day; chat research after IDOR fix → R6. No new artifact to distribute.
**Section 2 Code quality.** No new decisions. E5 × D2(Original) resolved by reading: plan-config.ts keeps non-price helpers; its price fields (stale `WEBHOOK_PLANS.PREMIUM.price: 999`, dead Dodo `PLAN_CONFIG`) must read from plans.ts — E5 exit check proves it. `captureServiceEvent` swallowing errors is correct for telemetry.
**Section 3 Tests.** Coverage diagram in chat record 23-Sep: 1/17 new/changed paths covered, 16 gaps (3 E2E), all carried as required proof of approved rows (R1–R6, E1, E2, E5, D10.1–2, D11.1, D15.2). CRITICAL regression → R6. LLM evals: none in scope.
**Section 4 Performance.** Sweeper: `updateMany` on (status, currentPeriodEnd) — existing `@@index([status])` suffices to ~100k rows. Reconcile: one paged Dodo list per day. Webhook lookups → R4 index. No N+1 introduced. No issues requiring a decision.

Eng approval readiness: PASS — R1 (CEO D12), R2 (D3), R3 (D4), R4 (D5), R5 (D6), R6 (D7), structure (eng D2 "Original arrangement"). Carried required proof cites its approved row. No pending remedies.

## Eng outputs

**NOT in scope (eng):** none cut or deferred. Excluded by earlier founder decisions: see "NOT in scope" above.
**What already exists (reused):** MONEY-865 changePlan upgrade + 2-min dedupe (C1); Dodo linkage on new grants (C2); hourly conditional-update cron + daily cron template + verifyCronAuth (C8); captureServiceEvent (C9); apply-monitors.sh absence rows; getAuthenticatedUser session helper.
**Failure modes (eng):** 11 capability rows from CEO registry, plus: currentPeriodEnd writer skipped → sweeper expires a payer (RESCUED by carried proof + absent-field skip; TEST planned); chat research after IDOR fix (R6, TEST planned); anonymous job cancel/flag wipe (R5, TEST planned). CRITICAL GAPS: 0.
**Note (no decision):** apps/web/app/api/cron/apply-scheduled-plan-changes/route.ts header says "Cloud Scheduler" but the job is registered in apps/web/vercel.json — fix the comment when touching the file.

## Eng Implementation Tasks

- [ ] **ET1 (P1, human: ~2d / CC: ~3h)** — billing — add `Subscription.currentPeriodEnd` + backfill; write it in webhook grant, callback grant, applyDodoRenewal, applyDodoUpgradeInPlace
  - Surfaced by: Scope Challenge (Original arrangement) + carried proof
  - Files: packages/database/prisma/schema.prisma, packages/services/src/subscription-grants.service.ts, apps/web/lib/actions/subscription.ts
  - Verify: one test per writer asserts currentPeriodEnd; backfill dry-run count on QA
- [ ] **ET2 (P1, human: ~2d / CC: ~3h)** — billing — sweeper cron route + service, log-only flag (D15.2), conditional updateMany, skip absent field
  - Surfaced by: Section 1 / CEO Sec 4 race
  - Files: apps/web/app/api/cron/<sweeper>/route.ts (new), packages/services/src/<sweeper>.service.ts (new), apps/web/vercel.json
  - Verify: paused-race test → ACTIVE; log-only writes 0 rows
- [ ] **ET3 (P1, human: ~2d / CC: ~3h)** — billing — daily reconcile cron route + service (D10.1)
  - Files: apps/web/app/api/cron/<reconcile>/route.ts (new), packages/services/src/<reconcile>.service.ts (new), apps/web/vercel.json
  - Verify: dropped-webhook test → next-day re-grant; other mismatch → alert, no write
- [ ] **ET4 (P1, human: ~1d / CC: ~1h)** — billing — R2 one entitlement rule
  - Files: packages/services/src/subscription-logic.ts
  - Verify: parity test over every status × date case
- [ ] **ET5 (P2, human: ~2h / CC: ~15m)** — billing — R3 read-only PROD investigation of the annual row
  - Files: —
  - Verify: cause recorded here; regression test if a fix is made
- [ ] **ET6 (P2, human: ~30m / CC: ~10m)** — schema — R4 `@@index([dodoSubscriptionId])` + push per env
  - Files: packages/database/prisma/schema.prisma
  - Verify: setup-infra.sh qa --only db shows the index
- [ ] **ET7 (P1, human: ~4h / CC: ~30m)** — billing — R1 idempotent plain checkout
  - Files: apps/web/lib/actions/subscription.ts
  - Verify: two concurrent checkouts → one Dodo subscription
- [ ] **ET8 (P1, human: ~1d / CC: ~1h)** — security — D11.1 + R6: session-only startResearchAction; chat caller switched; tests rewritten
  - Files: apps/web/lib/actions/research.ts, apps/web/lib/chat-tools/registry.ts, apps/web/**tests**/actions/research-symbol-validation.test.ts, apps/web/**tests**/actions/research.test.ts
  - Verify: A-with-B's-id refused; chat run_research works
- [ ] **ET9 (P1, human: ~1d / CC: ~1h)** — security — R5 move job-service + clearFeatureFlagsCache out of "use server"; source-scan test
  - Files: apps/web/lib/jobs/job-service.ts, apps/web/lib/jobs/import-processor.ts, apps/web/lib/actions/feature-flags.ts, apps/web/lib/actions/import-job.ts
  - Verify: scan test fails on a planted "use server" export taking userId
- [ ] **ET10 (P1, human: ~1d / CC: ~2h)** — analytics — E2 module over captureServiceEvent at 4 emit points (Clerk user.created, OAuth callback, processRoast, provisionPaymentCompleted); bot cohort + host filter in PostHog
  - Files: packages/services/src/analytics.ts, apps/web/app/api/webhooks/clerk/route.ts, apps/web/lib/actions/broker-connection.ts, workers/src/processors/roast.ts, packages/services/src/payment-provisioning.service.ts
  - Verify: each event fires once server-side; capture failure never throws
- [ ] **ET11 (P1, human: ~1d / CC: ~1h)** — pricing — E5: plans.ts single source; plan-config price fields delegate; retire lifetime SKU for new buyers
  - Files: packages/core/src/subscription/plans.ts, packages/core/src/payments/plan-config.ts
  - Verify: source-scan test — no price literal read outside plans.ts / Dodo catalog

# DESIGN REVIEW — /plan-design-review (23-Sep-2026)

Scope (founder): existing live design + onboarding AND the plan's new UI. Focus D1: all 7 passes, existing + new.
Designer binary: BROKEN on this install (~/.claude/skills/gstack/design/dist/design is a bare Bun runtime; "Script not found"). Fix: /gstack-upgrade. Mockups replaced by ASCII wireframes + live demo screenshots (usemoney.ai demo, founder-offered).
Step 0: design completeness 3/10. No DESIGN.md; de-facto system = docs/design/v2-bundle (Playful: cream paper #f7f3e6, ink #1d1d1b, 2px ink borders, 4px 4px 0 hard shadow, gold highlighter, JetBrains Mono numbers, DM Sans body, Instrument Serif flourish, radius 6/8/12/14/pill, AA-safe -text twins).
Live-flow audit (code, file:line in chat record 23-Sep): ~20 screens to first data; "Skip · use demo" calls finish() not demo (welcome/client.tsx:636–640, verified); "Go PRO" → /settings?upgrade= but settings reads only ?tab= (settings/client.tsx:147, verified); goals/risk/styles collected, never read; 7 of 8 brokers "coming soon" while tour says 6 and PRO says "all 8"; dashboard has no reauth banner; ₹0 tiles as empty state; PageAccessModal dead; roast has no share; mobile nav has no Dashboard; 853 hex literals / 6,930 inline styles / 3 button systems; contrast: --text-muted 2.55:1, warning/emerald fills used as text; fonts loaded twice (next/font + @import incl. Inter); wizard overlay has no dialog role/focus trap.

## Design decision ledger

| ID        | Issue                                                                               | Decision                                                                                                                                                                                                                                                                                                                           | Answer                                                         |
| --------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| DS-IA1    | ~20 screens to first data                                                           | ONE first-run screen /start: 3 paths (Connect Zerodha · Upload statement/CSV · Explore demo), honest "coming soon — notify me" row for other brokers, optional experience chips; v2 first-sync "Portfolio ready" screen; tour cut to ~3 steps shown only after data exists; terms modal kept; goals/risk/style no longer collected | D2 "A) One first-run screen"                                   |
| DS-IA2    | Upgrade intent lands on Account tab                                                 | ONE /upgrade screen for every upgrade intent (Go PRO, premium walls, credit-out): blurred preview of the user's own result (D14), one recommended plan, monthly/annual toggle, INR/USD by market, straight to checkout; delete dead PageAccessModal                                                                                | D3 "A) One /upgrade screen"                                    |
| DS-IA3    | No reauth warning on dashboard                                                      | Mount existing BrokerReauthBanner at dashboard top (above stats) + keep elsewhere; it is E3's single reconnect surface with one-tap reconnect and "last synced X ago"                                                                                                                                                              | D4 "A) Dashboard top + everywhere"                             |
| DS-IA4    | Mobile nav has no Dashboard                                                         | Adopt v2 tab bar (shell2.jsx TABS_V2): Home · Portfolio · Sage (raised centre) · Discover · You; Brokers moves under Portfolio/You                                                                                                                                                                                                 | D5 "A) Adopt v2 tab bar"                                       |
| DS-ST1    | ₹0 tiles as empty state                                                             | Zero-holdings dashboard = one hero "Your money isn't here yet." + same 3 paths as /start + StockSage chip row; stats render only when data exists                                                                                                                                                                                  | D6 "A) Empty hero with 3 paths"                                |
| DS-ST2    | Demo contradicts itself                                                             | One demo fixture drives every surface (broker count, holdings, connected card, roast, charts) + test asserting agreement; demo shows only brokers real users can connect today (Zerodha + CSV)                                                                                                                                     | D7 "A) One coherent demo dataset"                              |
| DS-ST3    | Missing error/partial states                                                        | State table below is binding for implementation                                                                                                                                                                                                                                                                                    | D8 "A) Specify all states"                                     |
| DS-JRN1   | Roast gated on broker sync                                                          | canRoast = "has holdings" (broker, CSV or manual); verdict names the source; tradebook-only insights hidden without a tradebook                                                                                                                                                                                                    | D9 "A) Roast any holdings source"                              |
| DS-SLOP1  | Off-palette demo banner + Premium label                                             | v2 gold DemoBanner strip (shell2.jsx:89); Premium label uses a pop token + its -text twin                                                                                                                                                                                                                                          | D10 "A) Use v2 gold strip + tokens"                            |
| DS-JRN2   | Hero over-claims, demo below fold                                                   | Honest copy ("Zerodha today, any broker by statement"); "Take a Tour" in first viewport beside "Start free"; right column shows a real product frame                                                                                                                                                                               | D11 "A) Honest hero + demo in view"                            |
| DS-SYS1   | No DESIGN.md                                                                        | Generate DESIGN.md from v2 colors_and_type.css (colors + -text twins, radius 6/8/12/14/pill, shadow-hard/soft, type scale, fonts) + add spacing tokens; name the v2 screen as build spec for each new screen                                                                                                                       | D12 "A) DESIGN.md from v2 + cite it"                           |
| DS-SYS2   | Font conflict (DM Sans via next/font vs Inter @import; JetBrains Mono loaded twice) | KEEP CURRENT — founder decision; gap documented (DESIGN.md records DM Sans as shipped UI font; @import noted as known debt)                                                                                                                                                                                                        | D13 "keep current - it should be fine"                         |
| DS-A11Y1  | Contrast failures                                                                   | --text-muted → v2 ink-3 #6b6b62; fill-as-text → -text twins; lint/test flags var(--pop-N)/var(--emerald) used as text color                                                                                                                                                                                                        | D14 "A) AA tokens + lint rule"                                 |
| DS-A11Y2  | No visible focus                                                                    | Global :focus-visible (2px ink outline + 2px offset; gold in dark) on pf buttons, inputs, links; audit 76 outline:none; /start + /upgrade get dialog roles + focus order                                                                                                                                                           | D15 "A) Global focus ring"                                     |
| DS-RESP1  | v2 new screens are mobile-only                                                      | /start: 3 path cards in a row (max-w 960) + broker row below; first-sync/ready: centred 560px card, steps left / totals right ≥1024px; share: 480px modal; US connect: 2-col (choices                                                                                                                                              | trust/consent); mobile <768px = v2 exactly; 44px touch targets | D16 "A) Desktop rule per screen" |
| DS-UNRES1 | US tier-gate undesigned                                                             | GateInline card in place of connect ("US brokers are part of PRO · $X/mo"), one CTA → /upgrade?market=US with USD preselected; never a modal                                                                                                                                                                                       | D17 "A) Inline gate → /upgrade"                                |
| DS-TODO1  | Token debt                                                                          | Added to TODOS.md (P3, after 5-Jan)                                                                                                                                                                                                                                                                                                | D18 "A) Add to TODOS.md"                                       |
| —         | Outside design voice                                                                | Skipped (Codex not installed; founder declined subagent)                                                                                                                                                                                                                                                                           | D19 "B) Skip"                                                  |

Resolved by prior decisions (no new question): web referral mockup rewards on SUBSCRIBE but D11.2 rewards on ACTIVATION (broker connect or first roast) — build to D11.2; v2 credit counts disagree web (100/500) vs mobile (50/250) — E5 single price/credit source decides.

### Binding state table (DS-ST3)

| Screen                       | Loading                                                                   | Empty                                                                                                    | Error                                                                                      | Success                                                               | Partial                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| /start first-run             | —                                                                         | n/a                                                                                                      | —                                                                                          | routes to path                                                        | —                                                                                                                                                                       |
| India OAuth (Zerodha)        | "Opening Zerodha…"                                                        | —                                                                                                        | Denied/cancelled: "No problem — nothing was shared." [Try again] [Upload CSV instead]      | → first-sync                                                          | —                                                                                                                                                                       |
| First sync                   | v2 5-step ProgressSteps (FirstSyncScreen)                                 | 0 holdings returned: "Zerodha returned no holdings. Using a different account?" [Reconnect] [Upload CSV] | "Sync failed · we kept nothing half-done." [Retry] + support link                          | v2 FirstReadyScreen "Every rupee, accounted for."                     | "Holdings in, tradebook still syncing · we'll finish in the background" → continue to ready                                                                             |
| Dashboard                    | skeleton tiles (no ₹0)                                                    | DS-ST1 hero                                                                                              | per-card inline "Couldn't load · retry"                                                    | stats + banner if stale                                               | DS-IA3 reauth banner + "last synced X ago"                                                                                                                              |
| /upgrade + checkout          | Dodo redirect "Opening secure checkout…"                                  | —                                                                                                        | Payment failed: "Your card wasn't charged. Try another method." [Retry] [UPI]              | "You're PRO, officially." (v2)                                        | Pending: "Confirming with your bank… we'll email you" (D10.1 reconcile heals)                                                                                           |
| Roast                        | v2 5-step run                                                             | no data → /start paths                                                                                   | "Couldn't roast right now · no credit used" [Retry]                                        | v2 verdict + share sheet                                              | Quota used: "Free plan: 1 roast/month · next on {date}" [Upgrade]                                                                                                       |
| Share card                   | render spinner                                                            | —                                                                                                        | render fail → text + copy link                                                             | v2 RoastShareSheet (score + one-liner only)                           | —                                                                                                                                                                       |
| Referral                     | —                                                                         | 0 invites: "Invite one friend — you both get a month of PRO when they connect or roast." [Copy code]     | copy fail toast                                                                            | v2 invite list                                                        | pending rows "joined · not activated yet"                                                                                                                               |
| US connect (SnapTrade)       | v2 consent → sync                                                         | —                                                                                                        | v2 UsOAuthScreen fail phase                                                                | "8 positions, in."                                                    | "You can leave — we finish in the background"                                                                                                                           |
| CSV / statement import (D22) | progress + filename                                                       | zero holdings found: "We didn't find holdings in this file · try another statement"                      | format not recognised: "We don't read {broker} files yet · send it to us" + supported list | → same "Portfolio ready" screen                                       | "212 of 230 rows imported · 18 skipped [see why]"; duplicates: "4 already in your portfolio"                                                                            |
| Notify-me (D28)              | —                                                                         | —                                                                                                        | —                                                                                          | toast "We'll tell you when {broker} is live" (account email, one tap) | —                                                                                                                                                                       |
| Dashboard first paint (D28)  | neutral skeleton; server decides has-data so the empty hero never flashes | —                                                                                                        | —                                                                                          | —                                                                     | —                                                                                                                                                                       |
| Referral cap (D28)           | —                                                                         | —                                                                                                        | —                                                                                          | —                                                                     | "You've hit this month's 10 rewards · invites still work"                                                                                                               |
| Roast mid-run failure (D28)  | —                                                                         | —                                                                                                        | "Couldn't finish · no credit used" [Retry]                                                 | —                                                                     | —                                                                                                                                                                       |
| Mixed holdings               | skeleton                                                                  | no US → connect card                                                                                     | —                                                                                          | v2 UsPortfolioScreen                                                  | FX stale >24h: DataGapBanner "FX rate from {date} · values approximate"; US sync failed while India ok (D28): per-market chip "US sync delayed", India renders normally |

### Live demo evidence (usemoney.ai "Take a Tour", headless Playwright 1440x900 + iPhone 13, 23-Sep)

- Demo contradicts itself: desktop header "0 BROKERS · LIVE" beside ₹10,93,670 portfolio; "Top holdings" says "No holdings yet — connect a broker"; Connected brokers card empty; mobile header says "3 BROKERS"; /brokers shows Zerodha AND Groww as LIVE though Groww is "coming soon" for real users.
- Plans tab shows Pro ₹1,999/yr (strike ₹4,999), Premium ₹14,999/yr (strike ₹30,000); /pricing shows Pro ₹249/mo (strike ₹499), Premium ₹14,990 — covered by E5 (one price source; exit check) — applied, no new question.
- Off-palette: demo banner saturated blue; Premium label purple.
- Mobile first viewport = demo banner + greeting + controls; portfolio value peeks at the fold; bottom nav HOLDINGS·SCREENER·+·BROKERS·MORE (no Home/Dashboard).
- Marketing hero: claims "every broker, every holding"; right column of first viewport is empty space; demo entry ("Take a Tour") is below the fold.
  Screenshots: scratchpad demo/\*.png (session-local).

### Outside design voice (Claude subagent, founder-requested after D19; NOT outside-model coverage) — findings PENDING founder decision

| ID                             | Sev      | Finding                                                                                                                                                                                                                                | Proposed fix                                                                                                                                                                                                                                                                | Status                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OV-1 (REOPENS DS-IA3)          | critical | Zerodha tokens expire daily by design (packages/core/src/brokers/config.ts:22–23 `tokenRefreshStrategy: "daily"`, verified) → the dashboard-top alert banner shows nearly every morning for every connected user and becomes wallpaper | Split: routine daily expiry = quiet inline chip "Data from yesterday's close · Refresh" beside last-synced; alert banner only for revoked grant / refresh failing >N days; define E3 reconnect-rate against daily expiry                                                    | APPROVED D20 "A) Chip for daily, banner for failures" — daily expiry = inline chip "Data from yesterday's close · Refresh"; alert banner only when grant revoked or refresh failing 2+ days; E3 metric counts daily refreshes separately. SUPERSEDES DS-IA3 banner-on-any-expiry                                    |
| OV-2 (touches DS-RESP1/DS-IA1) | high     | /start = 3 equal cards = generic card-grid first impression; demo weighted equal to Connect                                                                                                                                            | One primary block "Connect Zerodha" (ink fill + hard shadow) → secondary "Upload statement/CSV" → text link "Just look around →" → coming-soon row; same for empty dashboard hero                                                                                           | APPROVED D21 "A) One primary, then secondary" — headline → primary "Connect Zerodha" (ink fill + hard shadow) → secondary "Upload statement/CSV" → text link "Just look around →" → coming-soon row; same on empty hero; desktop keeps vertical order, max-w 640. SUPERSEDES DS-RESP1 "3 cards in a row" for /start |
| OV-3                           | critical | CSV/statement import (main entry for non-Zerodha users) has no states                                                                                                                                                                  | Add state-table row: uploading · format not recognised · partial parse "212 of 230 imported · 18 skipped [why]" · duplicates merged · zero holdings · success → same Ready screen                                                                                           | APPROVED D22 "A) Add CSV states"                                                                                                                                                                                                                                                                                    |
| OV-4                           | high     | /upgrade blur has nothing to blur for users with no result                                                                                                                                                                             | Empty variant: blurred sample demo roast labelled "Example"                                                                                                                                                                                                                 | APPROVED D24 "A) Blurred Example result" — no own result → blur the demo roast with an "Example" tag + "Connect to see yours"; never an empty blur                                                                                                                                                                  |
| OV-5                           | high     | "One recommended plan" + INR/USD selection rule unspecified                                                                                                                                                                            | Name the recommended plan + credit copy after E5; currency rule (market/holdings/remembered toggle)                                                                                                                                                                         | APPROVED D25 "B) Premium recommended; currency by IP" — /upgrade recommends PREMIUM (Pro one tap away); price currency chosen by IP geolocation (₹ for India IPs, $ otherwise); credit copy from E5 single source. Note: the D14 INR/USD toggle stays a holdings DISPLAY preference, not the price currency         |
| OV-6                           | high     | Pending payment vanishes after leaving /upgrade → re-pay risk (D12)                                                                                                                                                                    | Persistent header chip "Payment confirming"; /upgrade shows pending instead of checkout while APPROVED D23 "A) Persistent pending state" — header chip "Payment confirming · we'll email you"; /upgrade shows pending card, no checkout button; clears on webhook/reconcile | pending                                                                                                                                                                                                                                                                                                             |
| OV-7                           | high     | Journey after "Portfolio ready" has no single next action                                                                                                                                                                              | Ready screen primary CTA = "Roast my portfolio"; tour secondary; demo→real "Make this mine" → /start keeping chosen path; terms modal placement relative to /start                                                                                                          | APPROVED D26 "A) Roast first + demo→real + terms first" — Ready primary CTA "Roast my portfolio" (secondary "Take me to my money"); tour only after first roast; demo banner CTA "Make this mine" → sign-up → /start; terms modal once, BEFORE /start                                                               |
| OV-8                           | medium   | Share not designed for India/desktop                                                                                                                                                                                                   | Ordered actions WhatsApp · Download image · Copy link; share link opens public roast page with "Roast yours" CTA                                                                                                                                                            | APPROVED D27 "A) India-first actions + public roast page" — WhatsApp · Download image · Copy link (X under more); link opens public page: score + one-liner only (no holdings) + "Roast yours" CTA carrying the referral code (D11.2)                                                                               |
| OV-9                           | medium   | Missing states: notify-me capture, skeleton→hero flash, referral cap reached, roast mid-run failure, US sync failed while India ok                                                                                                     | Add rows to state table                                                                                                                                                                                                                                                     | APPROVED D28 "A) Add all five rows"                                                                                                                                                                                                                                                                                 |
| OV-10                          | medium   | "Brokers under Portfolio/You" ambiguous                                                                                                                                                                                                | Pick one tab                                                                                                                                                                                                                                                                | APPROVED D29 "A) Under Portfolio" — Portfolio tab header entry "Brokers · N connected"; reconnect chip links there                                                                                                                                                                                                  |
| OV-11                          | medium   | No motion spec                                                                                                                                                                                                                         | DESIGN.md: press-down (shadow 4→0), ProgressSteps, count-up on Ready; reduced-motion respected; nothing else animates                                                                                                                                                       | APPROVED D30 "A) Three motions in DESIGN.md" — press-down, ProgressSteps, count-up on Ready; ease-out ≤200ms (count-up ≤800ms); prefers-reduced-motion disables all; nothing else animates                                                                                                                          |
| OV-12                          | medium   | Hard shadow on every panel → stacked-cards look                                                                                                                                                                                        | DESIGN.md rations hard shadow to interactive/primary + hero numbers; data panels use rules/hairlines                                                                                                                                                                        | APPROVED D31 "A) Ration the hard shadow" — shadow-hard only on buttons, primary path blocks, hero numbers; data panels 1px rule-soft, no shadow; new screens now, existing via TODO sweep                                                                                                                           |

Litmus (subagent): brand in first screen NO · one anchor NO(/start) YES(Ready) · scannable YES · one job mostly · cards necessary NO · motion NO · premium w/o shadows NO. Hard rejections: /start card grid; stacked-cards dashboard; empty hero with no primary action. Subagent's hierarchy/visual-weight score ≈5/10.

### Live /design-review 23-Sep (report-only)

Design score C+, AI slop B, 14 findings (5 high). 10 map to existing decisions (DS-ST2, DS-JRN2, DS-SLOP1, D31, DS-IA4, E5, D13, DS-A11Y2); 4 NEW (F-4 marketing mobile shows app nav, F-10 One Tap in demo, F-11 StockSage chats spinner, F-13 two h1) → TODOS.md. Report: ~/.gstack/projects/UseMoney-AI-stockbook-monorepo/designs/design-audit-20260923/design-audit-usemoney.ai.md

## Design outputs

**NOT in scope (design):** visual mockup generation (designer binary broken — fix via /gstack-upgrade); /design-consultation (D12 chose DESIGN.md-from-v2); font unification (D13 declined); token-debt sweep (TODO, D18).
**What already exists:** v2 bundle screens — s-firstrun.jsx (connect/OAuth/sync/ready), s-account.jsx (PlanScreenV2, InviteScreenV2, brokers reauth), s-roast.jsx (RoastShareSheet), s-us.jsx (fork/connect/OAuth/import/portfolio/LRS), shell2.jsx (TABS_V2, DemoBanner); live BrokerReauthBanner (role=alert); walkthrough popover a11y; demo mode /api/demo/start.

## Design Implementation Tasks

- [ ] **DT1 (P1, human: ~1w / CC: ~1d)** — onboarding — /start first-run (DS-IA1) + first-sync/ready (v2 s-firstrun) + 3-step post-data tour; remove quiz steps 1–4 | Files: apps/web/app/welcome/client.tsx, components/TermsGate.tsx, lib/walkthrough/tours/v1-core.ts | Verify: new user reaches data in ≤5 screens; demo path starts demo
- [ ] **DT2 (P1, human: ~3d / CC: ~4h)** — paywall — /upgrade (DS-IA2) with blurred own result + GateInline for US (DS-UNRES1); delete PageAccessModal; repoint all Go PRO links | Files: app/(marketing)/pricing/client.tsx, app/(marketing)/home/client.tsx, app/invite/[token]/client.tsx, components/PageGuard.tsx | Verify: every upgrade link lands on /upgrade
- [ ] **DT3 (P1, human: ~1d / CC: ~1h)** — dashboard — reauth banner at top (DS-IA3) + empty hero (DS-ST1) | Files: components/dashboard/DashboardOverview.tsx, components/BrokerReauthBanner.tsx | Verify: expired token shows banner; zero holdings shows hero, no ₹0
- [ ] **DT4 (P1, human: ~2d / CC: ~2h)** — demo — one coherent demo fixture + agreement test (DS-ST2); v2 gold DemoBanner (DS-SLOP1) | Verify: broker count, holdings, connected card agree; only Zerodha+CSV shown
- [ ] **DT5 (P1, human: ~1d / CC: ~2h)** — roast — roast any holdings source (DS-JRN1) + v2 share sheet (E4) | Files: app/roast/client.tsx | Verify: CSV-only user completes a roast
- [ ] **DT6 (P2, human: ~1d / CC: ~1h)** — mobile — v2 tab bar (DS-IA4) | Files: components/GlobalMobileBottomNav.tsx | Verify: Home reachable from every page
- [ ] **DT7 (P2, human: ~1d / CC: ~1h)** — marketing — honest hero + Take a Tour in first viewport (DS-JRN2) | Files: app/(marketing)/home/client.tsx | Verify: demo button visible at 1440×900 and 390×844 without scrolling
- [x] **DT8 (P1, human: ~1d / CC: ~1h)** — design system — DESIGN.md from v2 (DS-SYS1) — WRITTEN 23-Sep at repo root (uncommitted) | Files: DESIGN.md (new) | Verify: tokens match styles/colors_and_type.css
- [ ] **DT9 (P1, human: ~2d / CC: ~2h)** — a11y — AA tokens + fill-as-text lint (DS-A11Y1); global focus ring + outline:none audit (DS-A11Y2) | Files: apps/web/app/globals.css, apps/web/styles/playful-app.css | Verify: lint fails on a planted var(--pop-2) text; keyboard tab through /start and /upgrade shows focus
- [ ] **DT10 (P2)** — states — build to the binding state table (DS-ST3) and desktop rules (DS-RESP1) on every new screen | Verify: /design-review after implementation

## Design Completion Summary

```
  +====================================================================+
  |         DESIGN PLAN REVIEW — COMPLETION SUMMARY                    |
  +====================================================================+
  | System Audit         | no DESIGN.md; v2 bundle = de facto spec;    |
  |                      | live demo + code audit; designer broken     |
  | Step 0               | 3/10; focus: all 7 passes, existing + new   |
  | Pass 1  (Info Arch)  | 2/10 → 9/10 after fixes (OV-2 primary path) |
  | Pass 2  (States)     | 3/10 → 9/10 after fixes                     |
  | Pass 3  (Journey)    | 4/10 → 9/10 after fixes                     |
  | Pass 4  (AI Slop)    | 6/10 → 8/10 after fixes                     |
  | Pass 5  (Design Sys) | 3/10 → 8/10 (motion+shadow rules; font gap declined) |
  | Pass 6  (Responsive) | 4/10 → 9/10 after fixes                     |
  | Pass 7  (Decisions)  | 30 resolved, 0 pending (1 declined: D13)    |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (4 items)                           |
  | What already exists  | written                                     |
  | TODOS.md updates     | 1 item proposed (accepted)                  |
  | Approved Mockups     | 0 generated (designer broken), 0 approved   |
  | Decisions made       | 30 added to plan (18 + 12 outside-voice)    |
  | Decisions pending    | 0                                           |
  | Overall design score | 2/10 → 8/10                                 |
  +====================================================================+
```

Pass 5 stops at 8, not 10: DESIGN.md will document the DM Sans / Inter @import duplication rather than fix it (founder: keep current).

# DX REVIEW — /plan-devex-review (23-Sep-2026)

Target: this plan. Product type: platform/API (apps/api /v1, planned MCP) + internal build loop. Evidence: DX audit subagent (file:line in chat record 23-Sep).

```
TARGET DEVELOPER PERSONA (D1: "A) Founder + Claude Code")
Who:       solo founder + Claude Code sessions running 20+ hours autonomously
Context:   ships every roadmap item E1–E5, SnapTrade, design DT1–DT10 before 5-Jan
Tolerance: setup is fine; slow feedback, lost context and unsafe deploys are not
Expects:   fast verify loop, one findable source of truth, safe QA→prod promotion + rollback
```

## Developer Perspective (D2 narrative, founder-corrected)

Starting E1: Claude must find truth across a 3,090-line root CLAUDE.md (~2,175 lines env-var incident notes), 24 more CLAUDE.md files, archive-docs, design-v2, docs/quant and ~200 memory files. The change is minutes; the gate is not: `yarn verify:push` = prisma generate + coverage-check + python tests + type-check + full build (web needs 4 GB heap) + full serialized suite (~22 min) → est. 25–35 min per push (not measured), restarted by any unrelated failure; no affected-only path. **Founder corrections:** `main` deploys to QA, `release` deploys to prod; data is ingested into prod and back-synced to QA; Claude sessions routinely run 20+ hours — so gate cycles and context re-loads compound across a long unattended run. Rollback of Vercel is manual in the dashboard (Claude barred from Vercel).

## Benchmark + target (D3)

Clock: "change done → verified push". Today: est. 25–35 min full gate every push (estimate). Peer practice (reported, not measured here): turbo `--filter=...[origin/main]` / Nx affected verify only changed packages + dependents. **Target (D3 "B) Competitive: 5–10 min"):** affected-only build + tests + type-check on pushes to feature branches/main (QA); FULL verify:push required before merging to `release` (prod).

## DX decision ledger

| ID          | Decision                                                                                                                                                                                                                  | Answer                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| DX-GATE     | Branch-aware verify:push: push to feature/main → turbo `--filter=...[origin/main]` build + test + type-check (affected); push to release → today's full gate; marker records mode; hook refuses a fast marker for release | D4 "A) Branch-aware verify:push"                   |
| DX-MODE     | DX EXPANSION (each addition opt-in)                                                                                                                                                                                       | D5 "A) DX EXPANSION"                               |
| DX-CTX      | Root CLAUDE.md → index ≤600 lines (product, stack, rules, where-things-live map, one-line env table); env/incident essays moved VERBATIM to docs/reference/<system>.md, linked; test fails if root CLAUDE.md > 600 lines  | D6 "A) Index CLAUDE.md + per-system docs"          |
| DX-LOCAL    | KEEP: local dev intentionally runs against the full QA stack (DB, Pub/Sub, workers); no local sandbox                                                                                                                     | D7 "Local setup uses all QA db pubsub workers etc" |
| DX-ERR      | `new Error(msg, { cause })` convention naming problem + likely fix; lint flags `${err.message}` interpolation in throws; broker adapters + apps/api first, all new SnapTrade code                                         | D8 "A) Error cause + lint"                         |
| DX-ROLLBACK | scripts/ops/rollback.sh {service                                                                                                                                                                                          | job} {qa                                           | prod} (Cloud Run traffic → previous revision; jobs re-setup with previous image; isolated gcloud config) + docs/reference/rollback.md (Vercel promote-previous steps run by founder only) | D9 "A) Rollback script + runbook" |
| DX-TICKET   | `yarn ticket:start MONEY-n` (branch + ticket context file) — DEFERRED to TODOS.md                                                                                                                                         | D10 "B) Defer to TODOS"                            |
| DX-NIGHTLY  | GitHub Actions nightly (~02:00 IST) full build + test --force on main (existing 2-way matrix); failure opens/updates one GitHub issue + a Linear ticket                                                                   | D11 "A) Nightly full suite"                        |
| DX-MEASURE  | verify:push appends {ts, branch, mode, seconds, result, failed_task} to gitignored .claude/verify-log.jsonl; `yarn verify:stats` prints p50/p90 per mode, last 7 days                                                     | D12 "A) Gate timing log"                           |

Routine corrections (no decision): README test counts 271/11,501 → 1,485/37,901; README `DODO_API_KEY` → `DODO_PAYMENTS_API_KEY`; README must state main→QA, release→prod.

## DX outputs

**Magical moment:** "Claude finishes a ticket → verified and on QA in 5–10 min, unattended" via branch-aware verify:push (DX-GATE), backstopped by DX-NIGHTLY, measured by DX-MEASURE.
**Journey map**
| Stage | Developer does | Friction | Status |
|---|---|---|---|
| Find context | load CLAUDE.md + docs | 3,090-line root file, 6 homes | fixed (DX-CTX) |
| Local run | run against QA stack | shared QA by design | ok (DX-LOCAL, founder) |
| Verify | yarn verify:push | est. 25–35 min full gate | fixed (DX-GATE) |
| QA | push main → QA | cross-package breaks slip | fixed (DX-NIGHTLY) |
| Debug | read errors/logs | cause/stack dropped | fixed (DX-ERR) |
| Prod | release → prod, rollback | manual rollback | fixed (DX-ROLLBACK) |
| Session start | branch + ticket context | manual each run | deferred (DX-TICKET, TODOS) |
**Outside voice (DX):** Codex not installed; native fallback unavailable (no TaskOutput tool) — no completed outside review.
**NOT in scope:** external API/MCP partner DX and mobile-developer DX (persona D1 = founder + Claude Code; both surfaces post-5-Jan — evidence recorded: no API keys/OpenAPI/real quota; no SSE/devices/IAP; runtime Vercel vs Cloud Run unresolved); local sandbox DB (D7 keep).

## DX Implementation Tasks

**Priority (founder, 23-Sep, after the review): "CI is setup properly as solo - it make less difference, UX of the product improvement should be the focus".** All XT tasks are P3 and run only after DT1–DT10 (UX) and ET1–ET11 (loop fixes); none blocks weeks 1–2.

- [ ] **XT1 (P3, human: ~1d / CC: ~2h)** — tooling — branch-aware verify:push + marker mode + hook refuses fast marker for release | Files: .claude/hooks/run-verify.sh, .claude/hooks/pre-push-gate.sh, package.json | Verify: push to main runs affected only; push to release runs full; fast marker rejected for release
- [ ] **XT2 (P3, human: ~1d / CC: ~2h)** — docs — CLAUDE.md → ≤600-line index; env essays moved verbatim to docs/reference/<system>.md; size test | Files: CLAUDE.md, docs/reference/\*.md | Verify: size test passes; every moved section linked
- [ ] **XT3 (P3, human: ~1d / CC: ~1h)** — errors — Error cause convention + lint; broker adapters + apps/api | Files: packages/core/src/brokers/adapters/\*.ts, apps/api/src | Verify: lint fails on planted `${err.message}` throw
- [ ] **XT4 (P3, human: ~1d / CC: ~2h)** — ops — scripts/ops/rollback.sh + docs/reference/rollback.md | Verify: dry-run shows previous revision for workers-qa
- [ ] **XT5 (P3, human: ~2h / CC: ~30m)** — CI — nightly full suite on main + issue/ticket on failure | Files: .github/workflows/\*.yml | Verify: manual dispatch runs full suite
- [ ] **XT6 (P3, human: ~2h / CC: ~30m)** — tooling — verify-log.jsonl + yarn verify:stats | Verify: two runs produce p50/p90 output
- [ ] **XT7 (P3, human: ~30m / CC: ~5m)** — docs — README corrections (test counts, DODO_PAYMENTS_API_KEY, main→QA / release→prod) | Files: README.md

## DX Scorecard

```
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                             |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
|----------------------|--------|--------|--------|
| Getting Started      | 7/10   | 4/10   | +3 ↑   |
| API/CLI/SDK          | 6/10   | 6/10   | =      |
| Error Messages       | 8/10   | 5/10   | +3 ↑   |
| Documentation        | 7/10   | 3/10   | +4 ↑   |
| Upgrade Path         | 8/10   | 6/10   | +2 ↑   |
| Dev Environment      | 8/10   | 5/10   | +3 ↑   |
| Community            | 7/10   | 7/10   | =      |
| DX Measurement       | 7/10   | 2/10   | +5 ↑   |
+--------------------------------------------------------------------+
| Gate time (clock)    | 5–10 target | est. 25–35 | ↓ (unmeasured) |
| Competitive Rank     | Competitive (target, D3)                     |
| Magical Moment       | designed via branch-aware verify:push        |
| Product Type         | Platform/API + internal build loop           |
| Mode                 | EXPANSION                                    |
| Overall DX           | 6/10   | 2/10   | +4 ↑   |
+====================================================================+
| DX PRINCIPLE COVERAGE                                               |
| Zero Friction      | gap (ticket:start deferred)                    |
| Learn by Doing     | covered (skills + memory rules)                |
| Fight Uncertainty  | covered (DX-ERR, DX-MEASURE)                   |
| Opinionated + Escape Hatches | covered (fast gate; full gate on release) |
| Code in Context    | covered (docs/reference per system)            |
| Magical Moments    | covered (DX-GATE)                              |
+====================================================================+
```

Overall = lowest pass (API/CLI 6). No pass below 6.

## GSTACK REVIEW REPORT

| Review         | Trigger                                                                | Why                             | Runs | Status      | Findings                                                                        |
| -------------- | ---------------------------------------------------------------------- | ------------------------------- | ---- | ----------- | ------------------------------------------------------------------------------- |
| CEO Review     | `/plan-ceo-review`                                                     | Scope & strategy                | 1    | CLEAR       | 11 proposals, 11 accepted, 0 deferred                                           |
| Outside Review | codex via `/plan-ceo-review`, `/plan-eng-review`, `/plan-devex-review` | Independent 2nd opinion         | 3    | unavailable | Codex not installed; native fallback unavailable — no completed external review |
| Eng Review     | `/plan-eng-review`                                                     | Architecture & tests (required) | 1    | CLEAR       | 6 issues, 0 critical gaps                                                       |
| Design Review  | `/plan-design-review`                                                  | UI/UX gaps                      | 1    | CLEAR       | score: 2/10 → 8/10, 30 decisions                                                |
| DX Review      | `/plan-devex-review`                                                   | Developer experience gaps       | 1    | CLEAR       | score: 2/10 → 6/10, gate: est. 25–35 min → 5–10 min target                      |

- **OUTSIDE COVERAGE:** codex unavailable in all plan-review phases (CLI not installed). Design: native Claude subagent voice ran (in-host, not outside-model coverage), 12 findings all resolved (D20–D31).
- **VERDICT:** CEO + ENG + DESIGN + DX CLEARED — ready to implement weeks 1–2. Build order: UX (DT) + loop fixes (ET) first; DX (XT) is P3 per founder.

NO UNRESOLVED DECISIONS
