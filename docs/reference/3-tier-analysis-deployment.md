# 3-Tier AI Analysis Engine - QA/Prod Deployment Guide

> **Feature branch:** `feat/analysis-agent` **Date:** 2026-03-21 **Commit:**
> `c58a911` (ai financial analysis engine)

---

## What Changed

- **L1 Flash:** Instant (<5s) chat answers, free for all users, BIHSPONG
  metadata fix
- **L2 Deep Dive:** 3 new research skills (earnings, financial-deep-dive,
  investment-thesis) + 2 new tools
- **L3 Comprehensive:** Multi-segment autonomous analysis with credit
  reservation, Pub/Sub chaining, progress tracking
- **Login Briefing:** Clerk `session.created` → proactive portfolio briefing for
  Premium users
- **Data Sources:** Tickertape.in + Screener.in clients with Redis caching (1yr
  TTL)
- **New DB Models:** `AnalysisSession`, `CreditReservation`, `LoginBriefing`
- **New Pub/Sub Topics:** `l3-analysis`, `login-briefing`
  (`proactive-analysis` was declared but never given a publisher, route or
  processor; removed in MONEY-1205)
- **New Notification Types:** `ANALYSIS_COMPLETE`, `ANALYSIS_FAILED`,
  `LOGIN_BRIEFING`
- **New Worker Routes:** `/jobs/l3-analysis`, `/jobs/login-briefing`
- **125 new test cases** across 10 test files

---

## 1. Database Schema Migration (BOTH envs)

```bash
# Get DATABASE_URL from GCP Secret Manager
# QA:
gcloud secrets versions access latest --secret="DATABASE_URL_QA" --project="stock-book-483718"
# Prod:
gcloud secrets versions access latest --secret="DATABASE_URL_PROD" --project="stock-book-483718"

# Push schema changes (adds 3 new models + 3 enums + 2 fields on Subscription)
DATABASE_URL="<url>" npx prisma db push --schema=packages/database/prisma/schema.prisma
```

**What gets created:**

| Collection            | Model             | Purpose                                    |
| --------------------- | ----------------- | ------------------------------------------ |
| `analysis_sessions`   | AnalysisSession   | L3 segment tracking, results, credits      |
| `credit_reservations` | CreditReservation | Reserve/commit/refund credit lifecycle     |
| `login_briefings`     | LoginBriefing     | Daily portfolio briefing for Premium users |

**New enums:** `AnalysisStatus`, `ReservationStatus`, `BriefingStatus` **New
notification types:** `ANALYSIS_COMPLETE`, `ANALYSIS_FAILED`, `LOGIN_BRIEFING`
**New fields on Subscription:** `comprehensiveCreditsUsed` (Int, default 0),
`comprehensiveCreditsLimit` (Int, default 0)

**Order:** Run on QA first, verify, then Prod.

---

## 2. Pub/Sub Topics (BOTH envs)

```bash
# Creates 3 new topics + push subscriptions pointing to Cloud Run worker
./workers/scripts/setup-pubsub.sh qa
./workers/scripts/setup-pubsub.sh prod
```

**New topics:**

| Topic                  | Push Endpoint          | Purpose                          |
| ---------------------- | ---------------------- | -------------------------------- |
| `l3-analysis-{env}`    | `/jobs/l3-analysis`    | L3 segment processing + chaining |
| `login-briefing-{env}` | `/jobs/login-briefing` | Login briefing generation        |

---

## 3. Cloud Scheduler (BOTH envs)

```bash
./scripts/ops/setup-scheduler.sh qa
./scripts/ops/setup-scheduler.sh prod
```

**New job:**

| Job                                | Schedule     | Topic         | Purpose                                            |
| ---------------------------------- | ------------ | ------------- | -------------------------------------------------- |
| `credit-reservation-cleanup-{env}` | Every 15 min | `l3-analysis` | Expires stale credit reservations, refunds credits |

---

## 4. Deploy Workers to Cloud Run (BOTH envs)

Workers have 2 new routes that need to be deployed:

```bash
# QA
gcloud builds submit --config=workers/cloudbuild.yaml

# Prod
gcloud builds submit --config=workers/cloudbuild.prod.yaml
```

**After deploy, re-run Pub/Sub setup** to update push endpoints if the Cloud Run
URL changed:

```bash
./workers/scripts/setup-pubsub.sh qa
./workers/scripts/setup-pubsub.sh prod
```

---

## 5. Deploy Web App (Vercel)

Auto-deploys on merge to `main`. No new env vars required.

**Changes deployed:**

- Tier classifier (L1/L2/L3 routing in `/api/chat`)
- L1 Flash responses (no credits consumed)
- BIHSPONG metadata fix (both card builders in route.ts)
- 3 new L3 chat tools (`run_comprehensive_analysis`, `get_analysis_status`,
  `get_analysis_result`)
- Login briefing dashboard card component
- Clerk `session.created` webhook handler
- New intent patterns for L2 skills + L3 comprehensive

---

## 6. Clerk Webhook Configuration

**REQUIRED:** Add `session.created` event to the existing Clerk webhook:

1. Go to **Clerk Dashboard → Webhooks**
2. Edit the existing endpoint (`/api/webhooks/clerk`)
3. **Add event:** `session.created`
4. Save

> Without this, login briefings will NOT trigger.

---

## 7. Set Comprehensive Credits on Subscription Plans

The `comprehensiveCreditsLimit` field defaults to 0. Update existing
subscriptions:

```javascript
// MongoDB shell (run for each environment):

// FREE users: 0 comprehensive credits (L3 not available)
// Already 0 by default - no action needed

// PRO users: 2 comprehensive analyses/month
db.subscriptions.updateMany(
  { planId: "PRO" },
  { $set: { comprehensiveCreditsLimit: 2 } },
);

// PREMIUM users: 10 comprehensive analyses/month
db.subscriptions.updateMany(
  { planId: "PREMIUM" },
  { $set: { comprehensiveCreditsLimit: 10 } },
);

// ULTIMATE users: 20 comprehensive analyses/month
db.subscriptions.updateMany(
  { planId: "ULTIMATE" },
  { $set: { comprehensiveCreditsLimit: 20 } },
);
```

**Also update** `packages/services/src/subscription.service.ts` PLANS constant
so new subscriptions get the right limits automatically.

---

## 8. Verification Checklist

### QA (run ALL before touching prod)

| #   | Test            | How to Verify                                           | Expected                                        |
| --- | --------------- | ------------------------------------------------------- | ----------------------------------------------- |
| 1   | Schema pushed   | `prisma studio` or MongoDB Compass                      | 3 new collections visible                       |
| 2   | Pub/Sub topics  | `gcloud pubsub topics list --project=stock-book-483718` | 3 new topics with `-qa` suffix                  |
| 3   | Workers healthy | `curl https://stockbook-workers-qa-xxx.run.app/health`  | 200 OK                                          |
| 4   | L1 Flash        | Send "What is RELIANCE PE?" in chat                     | Instant response (<5s), 0 credits consumed      |
| 5   | BIHSPONG fix    | Send "BIHSPONG financials"                              | "Limited data" message, NOT metadata fields     |
| 6   | L2 new skills   | Send "earnings analysis TCS"                            | Triggers earnings-analysis skill                |
| 7   | L2 financial    | Send "balance sheet analysis HDFC"                      | Triggers financial-deep-dive skill              |
| 8   | L2 thesis       | Send "bull case for INFY"                               | Triggers investment-thesis skill                |
| 9   | L3 starts       | Send "full analysis of RELIANCE"                        | Cost approval dialog shows 5 credits            |
| 10  | L3 progress     | Approve analysis                                        | Progress: 0/6 → 1/6 → ... → 6/6                 |
| 11  | L3 completion   | Wait for completion                                     | Notification: "Comprehensive Analysis Complete" |
| 12  | L3 cancel       | Start new L3, cancel mid-analysis                       | Credits refunded proportionally                 |
| 13  | L3 concurrency  | Start L3 while another is running                       | "Already in progress" error                     |
| 14  | Login briefing  | Login as PREMIUM user with holdings                     | Briefing notification within 30s                |
| 15  | Briefing dedup  | Login again within 24h                                  | No new briefing created                         |
| 16  | Briefing card   | Check dashboard                                         | Morning Briefing card visible, dismissable      |
| 17  | Credit cleanup  | Wait 15 min or check scheduler logs                     | Expired reservations cleaned up                 |
| 18  | Build passes    | `yarn build`                                            | No errors                                       |

### Prod

Repeat all 18 tests after deploying to production.

---

## 9. Rollback Plan

| Component         | Rollback Method                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------- |
| **Web app**       | Vercel Dashboard → Deployments → Promote previous deployment                                  |
| **Workers**       | `gcloud run services update-traffic stockbook-workers-{env} --to-revisions=PREVIOUS`          |
| **Schema**        | No rollback needed - all changes are additive (new collections/fields, old code ignores them) |
| **Pub/Sub**       | New topics are harmless if workers aren't processing them                                     |
| **Clerk webhook** | Remove `session.created` from webhook events if briefing is causing issues                    |

---

## 10. Execution Order

```
┌─── QA ──────────────────────────────────────────┐
│ 1. prisma db push (QA DATABASE_URL)              │
│ 2. ./workers/scripts/setup-pubsub.sh qa          │
│ 3. ./scripts/ops/setup-scheduler.sh qa               │
│ 4. Deploy workers: gcloud builds submit (QA)     │
│ 5. Re-run setup-pubsub.sh qa (update endpoints)  │
│ 6. Deploy web (merge to QA / Vercel preview)     │
│ 7. Clerk webhook: add session.created            │
│ 8. Set comprehensiveCreditsLimit on QA subs      │
│ 9. Run verification checklist (18 tests)         │
│ 10. ✅ QA GREEN LIGHT                            │
└──────────────────────────────────────────────────┘
                    │
                    ▼
┌─── PROD ─────────────────────────────────────────┐
│ 11. prisma db push (PROD DATABASE_URL)            │
│ 12. ./workers/scripts/setup-pubsub.sh prod        │
│ 13. ./scripts/ops/setup-scheduler.sh prod             │
│ 14. Deploy workers: gcloud builds submit (PROD)   │
│ 15. Re-run setup-pubsub.sh prod                   │
│ 16. Deploy web (merge to main)                    │
│ 17. Clerk webhook: verify session.created exists  │
│ 18. Set comprehensiveCreditsLimit on PROD subs    │
│ 19. Run verification checklist (18 tests)         │
│ 20. ✅ PROD GREEN LIGHT                           │
└──────────────────────────────────────────────────┘
```

---

## Appendix: New Files Summary

**30 new files, 19 modified files, 125 new test cases**

<details>
<summary>Click to expand full file list</summary>

### New Files

| File                                                         | Purpose                               |
| ------------------------------------------------------------ | ------------------------------------- |
| `apps/web/lib/chat-tools/tier-classifier.ts`                 | L1/L2/L3 query classification         |
| `apps/web/lib/chat-tools/flash-responder.ts`                 | L1 Flash instant responses            |
| `apps/web/lib/chat-tools/metadata-fields.ts`                 | Yahoo metadata filter (BIHSPONG fix)  |
| `apps/web/lib/gemini/flash-prompt.ts`                        | L1 Flash system prompt                |
| `apps/web/lib/actions/analysis.ts`                           | L3 server actions                     |
| `apps/web/lib/actions/briefing.ts`                           | Login briefing server actions         |
| `apps/web/components/dashboard/LoginBriefingCard.tsx`        | Briefing UI component                 |
| `packages/research/src/skills/earnings-analysis.ts`          | Quarterly results skill               |
| `packages/research/src/skills/financial-deep-dive.ts`        | Balance sheet quality skill           |
| `packages/research/src/skills/investment-thesis.ts`          | Bull/bear case skill                  |
| `packages/research/src/skills/multi-comparison.ts`           | 3+ stock deep compare                 |
| `packages/research/src/skills/portfolio-optimization.ts`     | Portfolio rebalancing                 |
| `packages/research/src/tools/compute-accounting-quality.ts`  | Beneish M-Score + Altman Z-Score      |
| `packages/research/src/tools/compute-earnings-surprise.ts`   | Beat/miss patterns                    |
| `packages/research/src/tools/compute-investment-score.ts`    | Weighted multi-dimensional score      |
| `packages/research/src/tools/compute-portfolio-delta.ts`     | Portfolio change detection            |
| `packages/research/src/tools/fetch-earnings-calendar.ts`     | Upcoming earnings dates               |
| `packages/research/src/tools/fetch-bulk-block-deals.ts`      | NSE trade info                        |
| `packages/research/src/tools/fetch-promoter-pledging.ts`     | Promoter pledging risk flags          |
| `packages/research/src/tools/fetch-tickertape-financials.ts` | Tickertape financial data             |
| `packages/research/src/tools/screen-stocks-advanced.ts`      | 150+ filter screener                  |
| `packages/research/src/data-sources/tickertape-client.ts`    | Tickertape API + Redis cache          |
| `packages/research/src/data-sources/screener-client.ts`      | Screener.in HTML parser + Redis cache |
| `packages/research/src/data-sources/data-source-chain.ts`    | Priority-based fallback chain         |
| `packages/research/src/data-sources/cache.ts`                | Redis + memory cache wrapper          |
| `packages/services/src/credit-reservation.service.ts`        | Credit lifecycle management           |
| `workers/src/routes/l3-analysis.ts`                          | L3 segment Pub/Sub handler            |
| `workers/src/processors/l3-analysis.ts`                      | L3 segment processing + chaining      |
| `workers/src/routes/login-briefing.ts`                       | Login briefing Pub/Sub handler        |
| `workers/src/processors/login-briefing.ts`                   | Portfolio briefing generator          |

### Test Files (10 new, 125 test cases)

| File                                                    | Cases |
| ------------------------------------------------------- | ----- |
| `__tests__/chat-tools/tier-classifier.test.ts`          | 21    |
| `__tests__/chat-tools/flash-responder.test.ts`          | 14    |
| `__tests__/chat-tools/metadata-fields.test.ts`          | 8     |
| `__tests__/research/compute-accounting-quality.test.ts` | 7     |
| `__tests__/research/compute-earnings-surprise.test.ts`  | 12    |
| `__tests__/research/compute-investment-score.test.ts`   | 15    |
| `__tests__/research/skills-new.test.ts`                 | 12    |
| `__tests__/services/credit-reservation.test.ts`         | 14    |
| `__tests__/workers/l3-analysis.test.ts`                 | 14    |
| `__tests__/workers/login-briefing.test.ts`              | 8     |

</details>

---

_Last Updated: 2026-03-21_
