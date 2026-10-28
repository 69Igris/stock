# Database Script Safety Tests

> 33 nodes

## Key Concepts

- **@usemoney/database** (23 connections) — `@usemoney/database`
- **backfill-corp-action-isins.ts** (22 connections) — `scripts/data/backfill-corp-action-isins.ts`
- **main()** (10 connections) — `scripts/data/backfill-corp-action-isins.ts`
- **ops-script-db-target.test.ts** (8 connections) — `packages/core/__tests__/market-data/ops-script-db-target.test.ts`
- **classify-corporate-actions.ts** (8 connections) — `scripts/data/classify-corporate-actions.ts`
- **findDbReachers()** (3 connections) — `packages/core/__tests__/market-data/ops-script-db-target.test.ts`
- **staticImports()** (3 connections) — `packages/core/__tests__/market-data/ops-script-db-target.test.ts`
- **confirmWrite()** (3 connections) — `scripts/data/backfill-corp-action-isins.ts`
- **maskedHost()** (3 connections) — `scripts/data/backfill-corp-action-isins.ts`
- **main()** (3 connections) — `scripts/data/classify-corporate-actions.ts`
- **backfill-financials-flag-safety.test.ts** (3 connections) — `packages/core/__tests__/market-data/backfill-financials-flag-safety.test.ts`
- **resolveSpecifier()** (2 connections) — `packages/core/__tests__/market-data/ops-script-db-target.test.ts`
- **staticImportSpecifiers()** (2 connections) — `packages/core/__tests__/market-data/ops-script-db-target.test.ts`
- **bump()** (2 connections) — `scripts/data/backfill-corp-action-isins.ts`
- **databaseUrlForEnv()** (2 connections) — `scripts/data/backfill-corp-action-isins.ts`
- **parseArgs()** (2 connections) — `scripts/data/backfill-corp-action-isins.ts`
- **topN()** (2 connections) — `scripts/data/backfill-corp-action-isins.ts`
- **classify()** (2 connections) — `scripts/data/classify-corporate-actions.ts`
- **log()** (2 connections) — `scripts/data/classify-corporate-actions.ts`
- **Run** (1 connections) — `packages/core/__tests__/market-data/backfill-financials-flag-safety.test.ts`
- **Bucket** (1 connections) — `scripts/data/backfill-corp-action-isins.ts`
- **Opts** (1 connections) — `scripts/data/backfill-corp-action-isins.ts`
- **PrismaLike** (1 connections) — `scripts/data/backfill-corp-action-isins.ts`
- **read()** (1 connections) — `packages/core/__tests__/market-data/ops-script-db-target.test.ts`
- **REPO_ROOT** (1 connections) — `packages/core/__tests__/market-data/backfill-financials-flag-safety.test.ts`
- *... and 8 more nodes in this community*

## Relationships

- [Corporate Actions Windows](Corporate_Actions_Windows.md) (7 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (2 shared connections)
- [Document Container Management](Document_Container_Management.md) (2 shared connections)
- [Research Agent Planning](Research_Agent_Planning.md) (1 shared connections)
- [RAG Document Context Retrieval](RAG_Document_Context_Retrieval.md) (1 shared connections)
- [Stock Price Fetching Tools](Stock_Price_Fetching_Tools.md) (1 shared connections)
- [NSE Research Tools](NSE_Research_Tools.md) (1 shared connections)
- [BSE Announcements Backfill](BSE_Announcements_Backfill.md) (1 shared connections)
- [XBRL Financial Basis Backfill](XBRL_Financial_Basis_Backfill.md) (1 shared connections)
- [Stock Financials Normalization](Stock_Financials_Normalization.md) (1 shared connections)
- [EDGAR US Filings Acceptance](EDGAR_US_Filings_Acceptance.md) (1 shared connections)
- [EDGAR Filing Coverage Reports](EDGAR_Filing_Coverage_Reports.md) (1 shared connections)

## Source Files

- `@usemoney/database`
- `packages/core/__tests__/market-data/backfill-financials-flag-safety.test.ts`
- `packages/core/__tests__/market-data/ops-script-db-target.test.ts`
- `scripts/data/backfill-corp-action-isins.ts`
- `scripts/data/classify-corporate-actions.ts`

## Audit Trail

- EXTRACTED: 75 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*