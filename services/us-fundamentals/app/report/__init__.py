"""Reporting arithmetic for the EDGAR engine — MONEY-979 T12.

Nothing in this package performs I/O. The QA gates and the ops scripts read
rows themselves and hand them here, so the same arithmetic can be driven by a
test with plain dicts, by the Python service, and — through the mirrored
TypeScript in ``packages/core/src/us-fundamentals/repository-logic.ts`` — by
``scripts/data/edgar-coverage-report.ts``.
"""
