# Zerodha API Mocking

> 14 nodes

## Key Concepts

- **mock-agent.ts** (7 connections) — `__tests__/_contracts/mock-agent.ts`
- **zerodha-token-exchange-contract.test.ts** (6 connections) — `__tests__/brokers/zerodha-token-exchange-contract.test.ts`
- **installMockAgent()** (5 connections) — `__tests__/_contracts/mock-agent.ts`
- **normalizeHeaders()** (3 connections) — `__tests__/_contracts/mock-agent.ts`
- **interceptJson()** (2 connections) — `__tests__/_contracts/mock-agent.ts`
- **interceptText()** (2 connections) — `__tests__/_contracts/mock-agent.ts`
- **zerodha.ts** (2 connections) — `lib/brokers/clients/zerodha.ts`
- **CapturedRequest** (1 connections) — `__tests__/_contracts/mock-agent.ts`
- **InterceptJsonOptions** (1 connections) — `__tests__/_contracts/mock-agent.ts`
- **InterceptTextOptions** (1 connections) — `__tests__/_contracts/mock-agent.ts`
- **expectedChecksum()** (1 connections) — `__tests__/brokers/zerodha-token-exchange-contract.test.ts`
- **loadFixture()** (1 connections) — `__tests__/brokers/zerodha-token-exchange-contract.test.ts`
- **close()** (1 connections) — `__tests__/_contracts/mock-agent.ts`
- **FIXTURE_DIR** (1 connections) — `__tests__/brokers/zerodha-token-exchange-contract.test.ts`

## Relationships

- [Zerodha Web Client Tests](Zerodha_Web_Client_Tests.md) (1 shared connections)
- [Mock Agent Interceptors](Mock_Agent_Interceptors.md) (1 shared connections)

## Source Files

- `__tests__/_contracts/mock-agent.ts`
- `__tests__/brokers/zerodha-token-exchange-contract.test.ts`
- `lib/brokers/clients/zerodha.ts`

## Audit Trail

- EXTRACTED: 15 (83%)
- INFERRED: 3 (17%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*