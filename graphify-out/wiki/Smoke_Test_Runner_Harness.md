# Smoke Test Runner Harness

> 16 nodes

## Key Concepts

- **run-smoke.ts** (12 connections) — `scripts/run-smoke.ts`
- **test-timeout.ts** (6 connections) — `scripts/test-timeout.ts`
- **main()** (4 connections) — `scripts/run-smoke.ts`
- **collectByWorkspace()** (3 connections) — `scripts/run-smoke.ts`
- **parseManifest()** (2 connections) — `scripts/run-smoke.ts`
- **runWorkspace()** (2 connections) — `scripts/run-smoke.ts`
- **workspaceOf()** (2 connections) — `scripts/run-smoke.ts`
- **killGroup()** (2 connections) — `scripts/test-timeout.ts`
- **watchdog** (2 connections) — `scripts/test-timeout.ts`
- **NODE_TEST_FLAGS** (1 connections) — `scripts/run-smoke.ts`
- **REPO_ROOT** (1 connections) — `scripts/run-smoke.ts`
- **SCRIPT_DIR** (1 connections) — `scripts/run-smoke.ts`
- **TIMEOUT_GUARD** (1 connections) — `scripts/run-smoke.ts`
- **child** (1 connections) — `scripts/test-timeout.ts`
- **forwarded** (1 connections) — `scripts/test-timeout.ts`
- **smoke-list.txt** (1 connections) — `scripts/README.md`

## Relationships

- [Database Migration Scripts](Database_Migration_Scripts.md) (2 shared connections)

## Source Files

- `scripts/README.md`
- `scripts/run-smoke.ts`
- `scripts/test-timeout.ts`

## Audit Trail

- EXTRACTED: 22 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*