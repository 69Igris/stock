# XBRL Instrument Symbol Resolution

> 38 nodes

## Key Concepts

- **xbrl-sync-bse-exchange.test.ts** (18 connections) — `workers/__tests__/processors/xbrl-sync-bse-exchange.test.ts`
- **xbrl-sync-instrument-rung.test.ts** (17 connections) — `workers/__tests__/processors/xbrl-sync-instrument-rung.test.ts`
- **reresolve-xbrl-instruments.ts** (15 connections) — `scripts/data/reresolve-xbrl-instruments.ts`
- **main()** (7 connections) — `scripts/data/reresolve-xbrl-instruments.ts`
- **rankIsinCandidates()** (7 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **XbrlStoreDeps** (6 connections) — `workers/src/processors/xbrl-sync.ts`
- **InstrumentCandidate** (5 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **resolveWritableSymbol()** (5 connections) — `workers/src/processors/xbrl-sync.ts`
- **isUsableSymbol()** (4 connections) — `workers/src/processors/xbrl-sync.ts`
- **pickWritableSymbol()** (4 connections) — `workers/src/processors/xbrl-sync.ts`
- **InstrumentResolutionTally** (3 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **InstrumentRung** (3 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **confirmWrite()** (3 connections) — `scripts/data/reresolve-xbrl-instruments.ts`
- **maskedHost()** (3 connections) — `scripts/data/reresolve-xbrl-instruments.ts`
- **buildInstanceFetchPlan()** (3 connections) — `workers/src/processors/xbrl-sync.ts`
- **databaseUrlForEnv()** (2 connections) — `scripts/data/reresolve-xbrl-instruments.ts`
- **parseArgs()** (2 connections) — `scripts/data/reresolve-xbrl-instruments.ts`
- **financialsOf()** (2 connections) — `workers/__tests__/processors/xbrl-sync-bse-exchange.test.ts`
- **relianceFinancials()** (2 connections) — `workers/__tests__/processors/xbrl-sync-instrument-rung.test.ts`
- **Opts** (1 connections) — `scripts/data/reresolve-xbrl-instruments.ts`
- **PrismaLike** (1 connections) — `scripts/data/reresolve-xbrl-instruments.ts`
- **Verdict** (1 connections) — `scripts/data/reresolve-xbrl-instruments.ts`
- **Lookup** (1 connections) — `workers/__tests__/processors/xbrl-sync-bse-exchange.test.ts`
- **Upsert** (1 connections) — `workers/__tests__/processors/xbrl-sync-bse-exchange.test.ts`
- **Upsert** (1 connections) — `workers/__tests__/processors/xbrl-sync-instrument-rung.test.ts`
- *... and 13 more nodes in this community*

## Relationships

- [XBRL Filings Index Sync](XBRL_Filings_Index_Sync.md) (15 shared connections)
- [XBRL Filing Era Sync](XBRL_Filing_Era_Sync.md) (7 shared connections)
- [XBRL Concept Parsing](XBRL_Concept_Parsing.md) (4 shared connections)
- [XBRL Feed Archive Backfill](XBRL_Feed_Archive_Backfill.md) (2 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (2 shared connections)
- [XBRL Fact Store Sync Tests](XBRL_Fact_Store_Sync_Tests.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Vertex AI RAG Retrieval](Vertex_AI_RAG_Retrieval.md) (1 shared connections)
- [Database Script Safety Tests](Database_Script_Safety_Tests.md) (1 shared connections)

## Source Files

- `scripts/data/reresolve-xbrl-instruments.ts`
- `workers/__tests__/processors/xbrl-sync-bse-exchange.test.ts`
- `workers/__tests__/processors/xbrl-sync-instrument-rung.test.ts`
- `workers/src/processors/xbrl-sync-logic.ts`
- `workers/src/processors/xbrl-sync.ts`

## Audit Trail

- EXTRACTED: 82 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*