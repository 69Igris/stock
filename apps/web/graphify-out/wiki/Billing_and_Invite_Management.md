# Billing and Invite Management

> 27 nodes

## Key Concepts

- **subscription.ts** (50 connections) — `lib/actions/subscription.ts`
- **[token]/client.tsx** (7 connections) — `app/invite/[token]/client.tsx`
- **billing-flags.ts** (7 connections) — `lib/actions/billing-flags.ts`
- **[token]/page.tsx** (6 connections) — `app/invite/[token]/page.tsx`
- **getBillingFlagsAction()** (4 connections) — `lib/actions/billing-flags.ts`
- **InviteClient()** (3 connections) — `app/invite/[token]/client.tsx`
- **applyDiscountedUpgrade()** (3 connections) — `lib/actions/subscription.ts`
- **applyDodoUpgradeInPlace()** (3 connections) — `lib/actions/subscription.ts`
- **downgradeWithGracePeriodAction()** (3 connections) — `lib/actions/subscription.ts`
- **sendUpgradeConfirmationEmail()** (3 connections) — `lib/actions/subscription.ts`
- **fetchBillingFlagsFromPostHog()** (2 connections) — `lib/actions/billing-flags.ts`
- **cancelSubscriptionAction()** (2 connections) — `lib/actions/subscription.ts`
- **downgradeToFreeAction()** (2 connections) — `lib/actions/subscription.ts`
- **Props** (1 connections) — `app/invite/[token]/client.tsx`
- **Props** (1 connections) — `app/invite/[token]/page.tsx`
- **BillingFlags** (1 connections) — `lib/actions/billing-flags.ts`
- **PlanChangePreview** (1 connections) — `lib/actions/subscription.ts`
- **ScheduleActionResult** (1 connections) — `lib/actions/subscription.ts`
- **InvitePage()** (1 connections) — `app/invite/[token]/page.tsx`
- **@usemoney/core/subscription/plans** (1 connections) — `@usemoney/core/subscription/plans`
- **@usemoney/core/subscription/proration** (1 connections) — `@usemoney/core/subscription/proration`
- **dynamic** (1 connections) — `app/invite/[token]/page.tsx`
- **BILLING_FLAG_KEYS** (1 connections) — `lib/actions/billing-flags.ts`
- **billingFlagsCache** (1 connections) — `lib/actions/billing-flags.ts`
- **DEFAULT_BILLING_FLAGS** (1 connections) — `lib/actions/billing-flags.ts`
- *... and 2 more nodes in this community*

## Relationships

- [Billing & Plans UI](Billing_&_Plans_UI.md) (12 shared connections)
- [Dashboard UI & Navigation](Dashboard_UI_&_Navigation.md) (7 shared connections)
- [Holdings & Analysis Actions](Holdings_&_Analysis_Actions.md) (6 shared connections)
- [Auth & Integration Routes](Auth_&_Integration_Routes.md) (4 shared connections)
- [App Layout & Shell](App_Layout_&_Shell.md) (4 shared connections)
- [Debug & UI Components](Debug_&_UI_Components.md) (3 shared connections)
- [Chat Narrative Routing](Chat_Narrative_Routing.md) (2 shared connections)
- [Portfolio Roast Views](Portfolio_Roast_Views.md) (2 shared connections)
- [Research Modal Configuration](Research_Modal_Configuration.md) (2 shared connections)
- [Account & Billing Views](Account_&_Billing_Views.md) (1 shared connections)
- [Usage and Feature Flags](Usage_and_Feature_Flags.md) (1 shared connections)
- [Market Discovery Views](Market_Discovery_Views.md) (1 shared connections)

## Source Files

- `@usemoney/core/subscription/plans`
- `@usemoney/core/subscription/proration`
- `app/invite/[token]/client.tsx`
- `app/invite/[token]/page.tsx`
- `lib/actions/billing-flags.ts`
- `lib/actions/subscription.ts`

## Audit Trail

- EXTRACTED: 77 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*