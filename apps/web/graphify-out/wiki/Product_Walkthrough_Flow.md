# Product Walkthrough Flow

> 31 nodes

## Key Concepts

- **WalkthroughProvider.tsx** (45 connections) — `components/walkthrough/WalkthroughProvider.tsx`
- **WalkthroughProvider()** (25 connections) — `components/walkthrough/WalkthroughProvider.tsx`
- **walkthrough.ts** (16 connections) — `lib/actions/walkthrough.ts`
- **resetWalkthroughAction()** (9 connections) — `lib/actions/walkthrough.ts`
- **snoozeWalkthroughAction()** (7 connections) — `lib/actions/walkthrough.ts`
- **isKnownWalkthroughVersion()** (6 connections) — `lib/walkthrough/tours/index.ts`
- **terms-signal.ts** (6 connections) — `lib/walkthrough/terms-signal.ts`
- **getWalkthroughStateAction()** (5 connections) — `lib/actions/walkthrough.ts`
- **markWalkthroughSeenAction()** (5 connections) — `lib/actions/walkthrough.ts`
- **getTourByVersion()** (5 connections) — `lib/walkthrough/tours/index.ts`
- **CURRENT_WALKTHROUGH_VERSION** (5 connections) — `lib/walkthrough/tours/index.ts`
- **terms-signal.test.ts** (5 connections) — `__tests__/walkthrough/terms-signal.test.ts`
- **selectDurationMs()** (4 connections) — `components/walkthrough/state-machine.ts`
- **selectIsOnLastStep()** (4 connections) — `components/walkthrough/state-machine.ts`
- **walkthroughReducer()** (4 connections) — `components/walkthrough/state-machine.ts`
- **readSnoozedUntil()** (4 connections) — `lib/actions/walkthrough.ts`
- **isTermsBlocking()** (4 connections) — `lib/walkthrough/terms-signal.ts`
- **onTermsBlockingChange()** (4 connections) — `lib/walkthrough/terms-signal.ts`
- **setTermsBlocking()** (4 connections) — `lib/walkthrough/terms-signal.ts`
- **getActionEventNames()** (4 connections) — `lib/walkthrough/tours/index.ts`
- **mergePreferencesWithSnooze()** (3 connections) — `lib/actions/walkthrough.ts`
- **isMobileViewport()** (2 connections) — `components/walkthrough/WalkthroughProvider.tsx`
- **normalizeLocation()** (2 connections) — `components/walkthrough/WalkthroughProvider.tsx`
- **setMobileNav()** (2 connections) — `components/walkthrough/WalkthroughProvider.tsx`
- **targetExists()** (2 connections) — `components/walkthrough/WalkthroughProvider.tsx`
- *... and 6 more nodes in this community*

## Relationships

- [Tour State Machine](Tour_State_Machine.md) (15 shared connections)
- [App Walkthrough Tours](App_Walkthrough_Tours.md) (8 shared connections)
- [App Layout & Shell](App_Layout_&_Shell.md) (7 shared connections)
- [App Walkthrough Tour](App_Walkthrough_Tour.md) (7 shared connections)
- [Holdings & Analysis Actions](Holdings_&_Analysis_Actions.md) (6 shared connections)
- [Interactive Walkthrough Tour](Interactive_Walkthrough_Tour.md) (6 shared connections)
- [Dashboard UI & Navigation](Dashboard_UI_&_Navigation.md) (4 shared connections)
- [Terms Acceptance Gate](Terms_Acceptance_Gate.md) (3 shared connections)
- [Account & Billing Views](Account_&_Billing_Views.md) (2 shared connections)
- [Walkthrough Spotlight Component](Walkthrough_Spotlight_Component.md) (2 shared connections)
- [Debug & UI Components](Debug_&_UI_Components.md) (1 shared connections)
- [Auth & Integration Routes](Auth_&_Integration_Routes.md) (1 shared connections)

## Source Files

- `__tests__/walkthrough/terms-signal.test.ts`
- `components/walkthrough/WalkthroughProvider.tsx`
- `components/walkthrough/state-machine.ts`
- `lib/actions/walkthrough.ts`
- `lib/walkthrough/terms-signal.ts`
- `lib/walkthrough/tours/index.ts`

## Audit Trail

- EXTRACTED: 120 (95%)
- INFERRED: 6 (5%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*