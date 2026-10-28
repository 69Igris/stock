/**
 * Re-export shim (MONEY-1079). The FIRE projection math moved to the shared
 * `@usemoney/fire` package so apps/api (mobile) can reuse the chat engine. This
 * path is kept as a thin re-export so the /fire page's existing imports keep
 * working; new code should import from `@usemoney/fire/calculations` directly.
 */
export * from "@usemoney/fire/calculations";
