// Key generation utilities
export {
  generateVersionHash,
  generateCacheKey,
  parseCacheKey,
  generateCachePattern,
  sanitizeUserId,
} from "./keys";

// Types
export type {
  CacheModule,
  CacheConfig,
  CacheEntry,
  CacheStats,
  CacheKey,
  CacheOperationResult,
} from "./types";

export { DEFAULT_TTL } from "./types";
