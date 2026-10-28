# Mutual Fund NAV Processing

> 54 nodes

## Key Concepts

- **mutualfunds-logic.ts** (37 connections) — `packages/services/src/mutualfunds-logic.ts`
- **mutualfunds.service.ts** (30 connections) — `packages/services/src/mutualfunds.service.ts`
- **mf-nav-propagation.service.ts** (12 connections) — `packages/services/src/mf-nav-propagation.service.ts`
- **finite()** (9 connections) — `packages/services/src/mutualfunds-logic.ts`
- **mf-nav-derivatives.test.ts** (9 connections) — `packages/services/__tests__/mf-nav-derivatives.test.ts`
- **computeNavDerivatives()** (8 connections) — `packages/services/src/mutualfunds-logic.ts`
- **buildMfNavPatch()** (7 connections) — `packages/services/src/mutualfunds-logic.ts`
- **deriveMutualFundCreateFields()** (7 connections) — `packages/services/src/mutualfunds-logic.ts`
- **getMutualFunds()** (7 connections) — `packages/services/src/mutualfunds.service.ts`
- **calculateMfSummary()** (5 connections) — `packages/services/src/mutualfunds-logic.ts`
- **mutualfunds-category-join.test.ts** (5 connections) — `packages/services/__tests__/mutualfunds-category-join.test.ts`
- **ListPageParams** (4 connections) — `packages/services/src/trades-logic.ts`
- **MutualFundFormInput** (4 connections) — `packages/validation/src/mutual-fund/index.ts`
- **computeMfCurrentValue()** (4 connections) — `packages/services/src/mutualfunds-logic.ts`
- **computeMfUnrealizedGain()** (4 connections) — `packages/services/src/mutualfunds-logic.ts`
- **sanitizeMutualFundNumerics()** (4 connections) — `packages/services/src/mutualfunds-logic.ts`
- **validation/src/mutual-fund/index.ts** (4 connections) — `packages/validation/src/mutual-fund/index.ts`
- **MutualFundSummary** (3 connections) — `packages/services/src/mutualfunds-logic.ts`
- **buildMutualFundWhere()** (3 connections) — `packages/services/src/mutualfunds-logic.ts`
- **computeMfInvested()** (3 connections) — `packages/services/src/mutualfunds-logic.ts`
- **collectMfMasterLookupKeys()** (3 connections) — `packages/services/src/mutualfunds.service.ts`
- **patchMfCategoriesFromMasters()** (3 connections) — `packages/services/src/mutualfunds.service.ts`
- **MutualFundFormSchema** (3 connections) — `packages/validation/src/mutual-fund/index.ts`
- **MfNavPatch** (2 connections) — `packages/services/src/mutualfunds-logic.ts`
- **MutualFundFilters** (2 connections) — `packages/services/src/mutualfunds-logic.ts`
- *... and 29 more nodes in this community*

## Relationships

- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (8 shared connections)
- [Content and Author Validation](Content_and_Author_Validation.md) (5 shared connections)
- [Market Sector Performance Aggregation](Market_Sector_Performance_Aggregation.md) (4 shared connections)
- [Portfolio Holdings Grouping Logic](Portfolio_Holdings_Grouping_Logic.md) (3 shared connections)
- [Trade History Analytics](Trade_History_Analytics.md) (2 shared connections)
- [Mutual Fund NAV Propagation](Mutual_Fund_NAV_Propagation.md) (2 shared connections)
- [Portfolio Performance and PnL Aggregation](Portfolio_Performance_and_PnL_Aggregation.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (2 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (2 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (2 shared connections)
- [Trading Position Calculations](Trading_Position_Calculations.md) (1 shared connections)

## Source Files

- `packages/services/__tests__/mf-nav-derivatives.test.ts`
- `packages/services/__tests__/mutualfunds-category-join.test.ts`
- `packages/services/src/mf-nav-propagation.service.ts`
- `packages/services/src/mutualfunds-logic.ts`
- `packages/services/src/mutualfunds.service.ts`
- `packages/services/src/trades-logic.ts`
- `packages/validation/__tests__/mutual-fund.test.ts`
- `packages/validation/src/mutual-fund/index.ts`

## Audit Trail

- EXTRACTED: 129 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*