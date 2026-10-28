# User Feedback Quota Logic

> 36 nodes

## Key Concepts

- **feedback.service.ts** (33 connections) — `packages/services/src/feedback.service.ts`
- **feedback-logic.ts** (17 connections) — `packages/services/src/feedback-logic.ts`
- **feedback-service.test.ts** (14 connections) — `packages/services/__tests__/feedback-service.test.ts`
- **submitFeedback()** (7 connections) — `packages/services/src/feedback.service.ts`
- **checkFeedbackQuota()** (5 connections) — `packages/services/src/feedback-logic.ts`
- **filterOwnedImagePaths()** (5 connections) — `packages/services/src/feedback-logic.ts`
- **isValidFeedbackType()** (5 connections) — `packages/services/src/feedback-logic.ts`
- **getUserFeedback()** (5 connections) — `packages/services/src/feedback.service.ts`
- **FeedbackServiceDeps** (4 connections) — `packages/services/src/feedback.service.ts`
- **isValidFeedbackStatus()** (4 connections) — `packages/services/src/feedback-logic.ts`
- **monthStartUtc()** (4 connections) — `packages/services/src/feedback-logic.ts`
- **addFeedbackReply()** (4 connections) — `packages/services/src/feedback.service.ts`
- **getFeedbackThread()** (4 connections) — `packages/services/src/feedback.service.ts`
- **toFeedbackItem()** (4 connections) — `packages/services/src/feedback.service.ts`
- **getSignedUrl()** (4 connections) — `packages/storage/src/index.ts`
- **resolveFeedbackLimit()** (3 connections) — `packages/services/src/feedback-logic.ts`
- **resolveImageUrls()** (3 connections) — `packages/services/src/feedback.service.ts`
- **FeedbackThreadDeps** (2 connections) — `packages/services/src/feedback.service.ts`
- **defaultSignImageUrl()** (2 connections) — `packages/services/src/feedback.service.ts`
- **FeedbackQuotaResult** (1 connections) — `packages/services/src/feedback-logic.ts`
- **FeedbackStatus** (1 connections) — `packages/services/src/feedback-logic.ts`
- **FeedbackType** (1 connections) — `packages/services/src/feedback-logic.ts`
- **AddFeedbackReplyInput** (1 connections) — `packages/services/src/feedback.service.ts`
- **FeedbackItem** (1 connections) — `packages/services/src/feedback.service.ts`
- **FeedbackListInput** (1 connections) — `packages/services/src/feedback.service.ts`
- *... and 11 more nodes in this community*

## Relationships

- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (5 shared connections)
- [User Onboarding and Preferences](User_Onboarding_and_Preferences.md) (4 shared connections)
- [Storage Download Budget Manager](Storage_Download_Budget_Manager.md) (3 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (2 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (1 shared connections)

## Source Files

- `packages/services/__tests__/feedback-service.test.ts`
- `packages/services/src/feedback-logic.ts`
- `packages/services/src/feedback.service.ts`
- `packages/storage/src/index.ts`

## Audit Trail

- EXTRACTED: 81 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*