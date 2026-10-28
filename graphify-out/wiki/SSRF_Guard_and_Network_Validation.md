# SSRF Guard and Network Validation

> 18 nodes

## Key Concepts

- **ssrf-guard.ts** (18 connections) — `packages/core/src/import/ssrf-guard.ts`
- **safeFetch()** (14 connections) — `packages/core/src/import/ssrf-guard.ts`
- **isBlockedIpv6()** (6 connections) — `packages/core/src/import/ssrf-guard.ts`
- **SsrfBlockedError** (5 connections) — `packages/core/src/import/ssrf-guard.ts`
- **isBlockedIp()** (5 connections) — `packages/core/src/import/ssrf-guard.ts`
- **isSafeFetchTarget()** (5 connections) — `packages/core/src/import/ssrf-guard.ts`
- **isBlockedIpv4()** (4 connections) — `packages/core/src/import/ssrf-guard.ts`
- **bufferResponse()** (3 connections) — `packages/core/src/import/ssrf-guard.ts`
- **expandIpv6()** (3 connections) — `packages/core/src/import/ssrf-guard.ts`
- **groupsToIpv4()** (3 connections) — `packages/core/src/import/ssrf-guard.ts`
- **SafeFetchOptions** (2 connections) — `packages/core/src/import/ssrf-guard.ts`
- **SafeFetchTargetResult** (2 connections) — `packages/core/src/import/ssrf-guard.ts`
- **buildPinnedAgent()** (2 connections) — `packages/core/src/import/ssrf-guard.ts`
- **hostMatchesAllowlist()** (2 connections) — `packages/core/src/import/ssrf-guard.ts`
- **HostnameResolver** (1 connections) — `packages/core/src/import/ssrf-guard.ts`
- **defaultResolver()** (1 connections) — `packages/core/src/import/ssrf-guard.ts`
- **.constructor()** (1 connections) — `packages/core/src/import/ssrf-guard.ts`
- **BLOCKED_HOSTNAMES** (1 connections) — `packages/core/src/import/ssrf-guard.ts`

## Relationships

- [Data Import Normalizers and Parsers](Data_Import_Normalizers_and_Parsers.md) (11 shared connections)
- [Document Recovery Pipeline](Document_Recovery_Pipeline.md) (2 shared connections)
- [Vector Embeddings Service](Vector_Embeddings_Service.md) (2 shared connections)
- [Broker Trade Import Processing](Broker_Trade_Import_Processing.md) (2 shared connections)
- [Stock Document Text Extraction](Stock_Document_Text_Extraction.md) (2 shared connections)
- [Network Mock Agent Utilities](Network_Mock_Agent_Utilities.md) (1 shared connections)

## Source Files

- `packages/core/src/import/ssrf-guard.ts`

## Audit Trail

- EXTRACTED: 49 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*