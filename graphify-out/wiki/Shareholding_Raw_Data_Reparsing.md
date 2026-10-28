# Shareholding Raw Data Reparsing

> 17 nodes

## Key Concepts

- **reparse-shareholding-raw.ts** (20 connections) — `scripts/data/reparse-shareholding-raw.ts`
- **main()** (10 connections) — `scripts/data/reparse-shareholding-raw.ts`
- **ShareholdingRow** (3 connections) — `packages/research/src/data-sources/ownership-logic.ts`
- **confirmWrite()** (3 connections) — `scripts/data/reparse-shareholding-raw.ts`
- **maskedHost()** (3 connections) — `scripts/data/reparse-shareholding-raw.ts`
- **parseArgs()** (3 connections) — `scripts/data/reparse-shareholding-raw.ts`
- **assertKnownFlags()** (2 connections) — `scripts/data/reparse-shareholding-raw.ts`
- **bump()** (2 connections) — `scripts/data/reparse-shareholding-raw.ts`
- **databaseUrlForEnv()** (2 connections) — `scripts/data/reparse-shareholding-raw.ts`
- **pad()** (2 connections) — `scripts/data/reparse-shareholding-raw.ts`
- **pctsOf()** (2 connections) — `scripts/data/reparse-shareholding-raw.ts`
- **Column** (1 connections) — `scripts/data/reparse-shareholding-raw.ts`
- **Options** (1 connections) — `scripts/data/reparse-shareholding-raw.ts`
- **Planned** (1 connections) — `scripts/data/reparse-shareholding-raw.ts`
- **StoredRow** (1 connections) — `scripts/data/reparse-shareholding-raw.ts`
- **COLUMNS** (1 connections) — `scripts/data/reparse-shareholding-raw.ts`
- **KNOWN_FLAGS** (1 connections) — `scripts/data/reparse-shareholding-raw.ts`

## Relationships

- [BSE Shareholding Logic](BSE_Shareholding_Logic.md) (4 shared connections)
- [NSE Shareholding Ownership Sync](NSE_Shareholding_Ownership_Sync.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Vertex AI RAG Retrieval](Vertex_AI_RAG_Retrieval.md) (1 shared connections)
- [Database Script Safety Tests](Database_Script_Safety_Tests.md) (1 shared connections)

## Source Files

- `packages/research/src/data-sources/ownership-logic.ts`
- `scripts/data/reparse-shareholding-raw.ts`

## Audit Trail

- EXTRACTED: 33 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*