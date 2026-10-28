/**
 * MONEY-837: the rich broker client layer was relocated to @usemoney/core so
 * the production worker, the web server action, and apps/api all share ONE
 * canonical fetch implementation (no more lean-vs-rich drift). This file is a
 * thin re-export shim — every `@/lib/brokers/base-client` import keeps working.
 */
export * from "@usemoney/core/brokers/clients/base-client";
