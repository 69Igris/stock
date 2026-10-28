# Email Preferences and Unsubscribe

> 16 nodes

## Key Concepts

- **preferences.ts** (13 connections) — `packages/email/src/preferences.ts`
- **generateUnsubscribeToken()** (7 connections) — `packages/email/src/tokens.ts`
- **sendHistoricalEmail()** (7 connections) — `workers/src/processors/sync.ts`
- **sendSyncCompleteEmail()** (7 connections) — `workers/src/processors/sync.ts`
- **tokens.ts** (7 connections) — `packages/email/src/tokens.ts`
- **buildUnsubscribeUrl()** (6 connections) — `packages/email/src/preferences.ts`
- **getEffectivePreferences()** (5 connections) — `packages/email/src/preferences.ts`
- **shouldSendEmail()** (5 connections) — `packages/email/src/preferences.ts`
- **APP_URL** (4 connections) — `packages/email/src/constants.ts`
- **verifyUnsubscribeToken()** (3 connections) — `packages/email/src/tokens.ts`
- **EmailPreferences** (2 connections) — `packages/email/src/preferences.ts`
- **UNSUBSCRIBE_SECRET** (2 connections) — `packages/email/src/constants.ts`
- **DEFAULT_EMAIL_PREFERENCES** (2 connections) — `packages/email/src/preferences.ts`
- **EMAIL_CATEGORY_MAP** (2 connections) — `packages/email/src/preferences.ts`
- **EMAIL_PREFERENCE_LABELS** (2 connections) — `packages/email/src/preferences.ts`
- **ALWAYS_SEND** (1 connections) — `packages/email/src/preferences.ts`

## Relationships

- [Email Broadcast Analytics](Email_Broadcast_Analytics.md) (22 shared connections)
- [Broker Tradebook Synchronization](Broker_Tradebook_Synchronization.md) (7 shared connections)
- [Transactional Email Templates](Transactional_Email_Templates.md) (2 shared connections)

## Source Files

- `packages/email/src/constants.ts`
- `packages/email/src/preferences.ts`
- `packages/email/src/tokens.ts`
- `workers/src/processors/sync.ts`

## Audit Trail

- EXTRACTED: 51 (96%)
- INFERRED: 2 (4%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*