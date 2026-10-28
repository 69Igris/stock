# Financial Ratio Extraction

> 86 nodes

## Key Concepts

- **processors/xbrl-ratios.ts** (65 connections) — `workers/src/processors/xbrl-ratios.ts`
- **xbrl-ratios-producer.test.ts** (25 connections) — `packages/core/__tests__/market-data/xbrl-ratios-producer.test.ts`
- **deriveOne()** (20 connections) — `workers/src/processors/xbrl-ratios.ts`
- **xbrl-ratios-logic.ts** (18 connections) — `workers/src/processors/xbrl-ratios-logic.ts`
- **xbrl-ratios-producer.ts** (17 connections) — `packages/core/src/market-data/xbrl-ratios-producer.ts`
- **xbrl-valuation.ts** (17 connections) — `packages/core/src/market-data/xbrl-valuation.ts`
- **xbrl-ratios-logic.test.ts** (17 connections) — `workers/__tests__/processors/xbrl-ratios-logic.test.ts`
- **deriveFromExtracts()** (16 connections) — `workers/src/processors/xbrl-ratios.ts`
- **mayOverwriteFinancials()** (15 connections) — `packages/core/src/market-data/xbrl-projection.ts`
- **selectFilingForPeriod()** (13 connections) — `packages/core/src/market-data/xbrl-projection.ts`
- **document-ratio-inputs.ts** (13 connections) — `packages/core/src/market-data/document-ratio-inputs.ts`
- **document-ratio-inputs.test.ts** (11 connections) — `packages/core/__tests__/market-data/document-ratio-inputs.test.ts`
- **deriveShareCount()** (10 connections) — `packages/core/src/market-data/xbrl-valuation.ts`
- **extractToRatioInputs()** (9 connections) — `packages/core/src/market-data/document-ratio-inputs.ts`
- **deriveValuation()** (9 connections) — `packages/core/src/market-data/xbrl-valuation.ts`
- **xbrl-valuation.test.ts** (7 connections) — `packages/core/__tests__/market-data/xbrl-valuation.test.ts`
- **ClosePoint** (6 connections) — `packages/core/src/market-data/ratio-derivations.ts`
- **selectAnnualExtractsByPeriod()** (6 connections) — `packages/core/src/market-data/document-ratio-inputs.ts`
- **isPlanWorthWriting()** (6 connections) — `packages/core/src/market-data/xbrl-ratios-producer.ts`
- **planRatiosWrite()** (6 connections) — `packages/core/src/market-data/xbrl-ratios-producer.ts`
- **ttmDividendPerShare()** (6 connections) — `packages/core/src/market-data/xbrl-valuation.ts`
- **RUPEES_PER_CRORE** (6 connections) — `packages/core/src/market-data/xbrl-financials-logic.ts`
- **RatioInputs** (5 connections) — `packages/core/src/market-data/xbrl-financials-logic.ts`
- **betaExcludeDatesFrom()** (5 connections) — `workers/src/processors/xbrl-ratios-logic.ts`
- **rankRatiosTargets()** (5 connections) — `workers/src/processors/xbrl-ratios-logic.ts`
- *... and 61 more nodes in this community*

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (30 shared connections)
- [XBRL Financial Projections](XBRL_Financial_Projections.md) (27 shared connections)
- [XBRL Financial Ratio Arming](XBRL_Financial_Ratio_Arming.md) (13 shared connections)
- [Financial Ratio Derivations](Financial_Ratio_Derivations.md) (12 shared connections)
- [XBRL Concept Parsing](XBRL_Concept_Parsing.md) (7 shared connections)
- [XBRL Projection Pipeline](XBRL_Projection_Pipeline.md) (6 shared connections)
- [Stock Financials Normalization](Stock_Financials_Normalization.md) (5 shared connections)
- [XBRL Ratios Fallback Tests](XBRL_Ratios_Fallback_Tests.md) (3 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (2 shared connections)
- [XBRL Ratio Quality Gates](XBRL_Ratio_Quality_Gates.md) (2 shared connections)
- [XBRL Financials Parser](XBRL_Financials_Parser.md) (2 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (2 shared connections)

## Source Files

- `packages/core/__tests__/market-data/document-ratio-inputs.test.ts`
- `packages/core/__tests__/market-data/xbrl-ratios-producer.test.ts`
- `packages/core/__tests__/market-data/xbrl-valuation.test.ts`
- `packages/core/src/market-data/document-ratio-inputs.ts`
- `packages/core/src/market-data/ratio-derivations.ts`
- `packages/core/src/market-data/xbrl-financials-logic.ts`
- `packages/core/src/market-data/xbrl-projection.ts`
- `packages/core/src/market-data/xbrl-ratios-producer.ts`
- `packages/core/src/market-data/xbrl-valuation.ts`
- `workers/__tests__/processors/xbrl-ratios-logic.test.ts`
- `workers/src/processors/xbrl-ratios-logic.ts`
- `workers/src/processors/xbrl-ratios.ts`

## Audit Trail

- EXTRACTED: 293 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*