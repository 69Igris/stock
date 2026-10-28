# Redis Caching & Pino Logging - Operational Runbook

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Environment Variables](#environment-variables)
4. [Deployment Guide](#deployment-guide)
5. [Cache Operations](#cache-operations)
6. [Monitoring](#monitoring)
7. [Troubleshooting](#troubleshooting)
8. [Rollback Procedures](#rollback-procedures)

---

## Overview

This runbook covers the operation, monitoring, and troubleshooting of the dual-layer caching system (in-memory LRU + Redis) and structured Pino logging implemented in TradeBook.

### What's Included

- **Dual-layer caching**: In-memory (Layer 1) → Redis (Layer 2)
- **Cached modules**: Dashboard, Positions, Holdings, Trades, FIRE, User, Brokers, Mutual Funds
- **Structured logging**: Pino with module-specific child loggers
- **Cache monitoring**: API endpoint for real-time stats

### Key Benefits

- 10-50x performance improvement on cache hits
- Reduced database load
- Better observability with structured logs
- Graceful degradation when Redis unavailable

---

## Architecture

### Dual-Layer Cache Strategy

```
Request → Memory Cache (Layer 1: ~1-5ms)
              ↓ miss
          Redis Cache (Layer 2: ~10-20ms)
              ↓ miss
          Database Query (~50-300ms)
              ↓
          Cache in both layers
```

### Cache Configuration

- **Memory**: LRU cache, 1000 entry limit, 5-minute default TTL
- **Redis**: DigitalOcean managed Redis, TLS connection
- **TTL Strategy**:
  - Positions: 1-2 minutes (volatile)
  - Dashboard/Holdings/Trades: 2-5 minutes
  - FIRE scenarios: 1-2 minutes (user-edited)
  - Broker info: 1 hour (static)
  - User trial: 5 minutes

### Cache Invalidation Triggers

| Event                      | Invalidates                                          |
| -------------------------- | ---------------------------------------------------- |
| Broker sync                | Dashboard, Positions, Holdings, Trades, Mutual Funds |
| Trade create/update/delete | Dashboard, Trades                                    |
| Position close             | Dashboard, Positions, Holdings, Trades               |
| FIRE scenario save/delete  | FIRE cache                                           |
| Broker connect/disconnect  | Broker connections                                   |

---

## Environment Variables

### Required Variables

```bash
# Redis Connection (already configured)
REDIS_URL=rediss://default:<REDIS_PASSWORD>@<REDIS_HOST>:25061

# Cache Control
CACHE_ENABLED=true                    # Global cache toggle (default: true)

# Logging Configuration
LOG_LEVEL=info                        # trace|debug|info|warn|error|fatal (default: info)
NODE_ENV=production                   # development|production
```

### Optional Override Variables

```bash
CACHE_ENABLE_MEMORY=true              # Enable/disable memory cache layer
CACHE_ENABLE_REDIS=true               # Enable/disable Redis cache layer
CACHE_DEFAULT_TTL=300                 # Default TTL in seconds (5 minutes)
```

### Variable Hierarchy

1. If `CACHE_ENABLED=false`, no caching occurs (both layers disabled)
2. If `CACHE_ENABLE_REDIS=false`, only memory cache works
3. If `CACHE_ENABLE_MEMORY=false`, only Redis cache works

---

## Deployment Guide

### Pre-Deployment Checklist

- [ ] Redis connection URL is correct and accessible
- [ ] Environment variables are set
- [ ] Build passes: `yarn build`
- [ ] Unit tests pass: `yarn test:cache`
- [ ] Verify cache is disabled in .env.local (for safe deployment): `CACHE_ENABLED=false`

### Deployment Steps

#### Option 1: Rolling Deployment (Recommended)

```bash
# 1. Deploy with cache DISABLED
git pull origin main
CACHE_ENABLED=false yarn build
# Deploy to production

# 2. Monitor application health for 10 minutes
# Check logs, API responses, error rates

# 3. Enable cache via environment variable
# Update deployment config: CACHE_ENABLED=true
# Restart application

# 4. Monitor cache stats
curl https://your-domain.com/api/cache/stats \
  -H "Authorization: Bearer YOUR_TOKEN"

# 5. Verify cache hit rates increase over time
```

#### Option 2: Direct Deployment (Faster, Higher Risk)

```bash
# Deploy with cache ENABLED from start
git pull origin main
CACHE_ENABLED=true yarn build
# Deploy to production

# Monitor closely for first 30 minutes
```

### Post-Deployment Verification

```bash
# 1. Check Redis connection
curl https://your-domain.com/api/cache/stats | jq '.data.redis.connected'
# Expected: true

# 2. Check cache hit rates after 5 minutes
curl https://your-domain.com/api/cache/stats | jq '.data.cache.overall.hitRate'
# Expected: >60% after warmup

# 3. Check application logs
# Look for: "Cache statistics" messages every 100 operations
```

---

## Cache Operations

### Checking Cache Status

```bash
# Get comprehensive cache statistics
curl https://your-domain.com/api/cache/stats \
  -H "Authorization: Bearer YOUR_TOKEN" | jq

# Expected response:
{
  "success": true,
  "data": {
    "cache": {
      "memory": {
        "hits": 850,
        "misses": 150,
        "sets": 200,
        "deletes": 10,
        "errors": 0,
        "hitRate": "85.00%"
      },
      "redis": {
        "hits": 100,
        "misses": 50,
        "sets": 50,
        "deletes": 5,
        "errors": 0,
        "hitRate": "66.67%"
      },
      "overall": {
        "hits": 950,
        "misses": 200,
        "hitRate": "82.61%"
      }
    },
    "redis": {
      "connected": true,
      "keyCount": 145
    },
    "timestamp": "2026-01-09T17:00:00.000Z"
  }
}
```

### Resetting Cache Statistics

```bash
# Reset statistics counters (doesn't clear cache, only stats)
curl -X DELETE https://your-domain.com/api/cache/stats \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Manual Cache Clearing

Cache automatically invalidates on data mutations, but you can force clear if needed:

**Option 1: Restart Application**

- Clears in-memory cache completely
- Redis cache persists (will repopulate memory)

**Option 2: Disable and Re-enable Caching**

```bash
# Set CACHE_ENABLED=false, restart, wait 1 minute, set true, restart
```

**Option 3: Flush Redis (NUCLEAR OPTION - USE SPARINGLY)**

```bash
# Connect to Redis
redis-cli -h <REDIS_HOST> \
  -p 25061 \
  --tls \
  -a '<REDIS_PASSWORD>'

# List all keys
KEYS *

# Delete specific pattern
DEL dashboard:user123:*

# Flush ALL cache (WARNING: Also clears feature flags!)
# DO NOT USE unless absolutely necessary
# FLUSHDB
```

### Disabling Caching

**Temporary (Testing)**

```bash
# In your deployment config or .env
CACHE_ENABLED=false

# Restart application
```

**Per-Layer Disable**

```bash
# Disable Redis only (memory cache still works)
CACHE_ENABLE_REDIS=false

# Disable memory only (Redis cache still works)
CACHE_ENABLE_MEMORY=false
```

---

## Monitoring

### Key Metrics to Watch

#### Cache Performance

- **Overall hit rate**: Target >70% after warmup (5-10 minutes)
- **Memory hit rate**: Target >80% (fastest layer)
- **Redis hit rate**: Target >60%
- **Error count**: Should be 0 or very low

#### Redis Health

- **Connection status**: Must be `true`
- **Key count**: Should be 50-200 depending on active users
- **Response time**: Monitor in application logs

#### Application Performance

- **Response times**: Should decrease 10-50x for cached requests
- **Database load**: Should decrease proportionally to hit rate

### Cache Hit Rate Targets by Module

| Module      | Expected Hit Rate | Notes                |
| ----------- | ----------------- | -------------------- |
| Dashboard   | 80-90%            | Frequently accessed  |
| Positions   | 70-80%            | Updated on sync      |
| Holdings    | 70-80%            | Updated on sync      |
| Trades      | 60-70%            | Varies by pagination |
| FIRE        | 90%+              | Rarely changes       |
| Broker Info | 95%+              | Static data          |

### Log Monitoring

**Structured Log Format**

```json
{
  "level": "info",
  "time": "2026-01-09T17:00:00.000Z",
  "module": "cache",
  "key": "dashboard:user123:stats:default",
  "age": 120,
  "layer": "memory",
  "msg": "Cache hit"
}
```

**Important Log Patterns**

```bash
# Cache statistics (every 100 operations)
grep "Cache statistics" application.log

# Cache errors
grep '"level":"error"' application.log | grep '"module":"cache"'

# Redis connection issues
grep "Redis" application.log | grep "error\|close\|reconnecting"

# Cache invalidation events
grep "Clearing.*cache" application.log
```

---

## Troubleshooting

### High Cache Miss Rate (<50%)

**Symptoms**: Low hit rates, slow API responses

**Possible Causes**:

1. Cache not warmed up yet (wait 5-10 minutes)
2. High user turnover (users with different IDs)
3. Frequent data mutations triggering invalidation
4. TTL too low

**Actions**:

```bash
# 1. Check cache stats
curl /api/cache/stats | jq '.data.cache.overall'

# 2. Check if Redis is connected
curl /api/cache/stats | jq '.data.redis.connected'

# 3. Review invalidation frequency
grep "Clearing.*cache" application.log | tail -20

# 4. Consider increasing TTL if appropriate
# In code: change TTL in cache config (requires deployment)
```

### Redis Connection Issues

**Symptoms**: `"connected": false`, Redis errors in logs

**Possible Causes**:

1. Network connectivity issues
2. Redis service down
3. TLS certificate issues
4. Connection pool exhausted

**Actions**:

```bash
# 1. Test Redis connectivity
redis-cli -h <REDIS_HOST> \
  -p 25061 --tls -a '<REDIS_PASSWORD>' PING
# Expected: PONG

# 2. Check Redis service status (DigitalOcean console)

# 3. Verify REDIS_URL environment variable

# 4. Check application logs for connection errors
grep "Redis" application.log | grep "error"

# 5. Application will auto-fallback to memory-only cache
# No action needed if memory cache is sufficient
```

### Memory Usage Too High

**Symptoms**: Application memory >500MB, OOM errors

**Possible Causes**:

1. LRU cache limit too high (default: 1000 entries)
2. Large cached objects
3. Memory leak elsewhere

**Actions**:

```bash
# 1. Check current memory usage
node -e "console.log(process.memoryUsage())"

# 2. Reduce LRU cache size (requires code change)
# In lib/cache/client.ts: Change max: 1000 to max: 500

# 3. Clear memory cache (restart application)

# 4. Monitor memory over time
# Set up memory usage alerts
```

### Stale Data Displayed

**Symptoms**: Users see outdated information

**Possible Causes**:

1. Cache invalidation not triggered
2. TTL too long
3. Bug in invalidation logic

**Actions**:

```bash
# 1. Identify affected module
# Check when data was last updated vs last cache refresh

# 2. Force cache clear for affected user
# Restart application or use Redis DEL command

# 3. Check invalidation triggers
grep "Clearing.*cache" application.log

# 4. Reduce TTL if needed (requires code change + deployment)

# 5. Verify fix in staging first
```

### Cache Errors Increasing

**Symptoms**: `errors > 0` in cache stats, error logs

**Possible Causes**:

1. Redis intermittent failures
2. Serialization errors (circular references, BigInt, etc.)
3. Network timeouts

**Actions**:

```bash
# 1. Check error details in logs
grep '"module":"cache"' application.log | grep '"level":"error"'

# 2. Identify error patterns
# - Redis connection errors: Transient, auto-recovers
# - Serialization errors: Code fix needed
# - Timeout errors: Check network/Redis performance

# 3. If Redis errors, check:
curl /api/cache/stats | jq '.data.redis'

# 4. If serialization errors, identify problematic data
# May need to exclude certain data from caching
```

---

## Rollback Procedures

### Emergency Rollback (Disable Caching)

**When to use**: Critical issues, stale data, memory leaks

```bash
# 1. Disable cache immediately (no deployment needed)
# Set environment variable: CACHE_ENABLED=false
# Restart application

# 2. Verify cache is disabled
curl /api/cache/stats
# Should return error or show 0 hits/sets

# 3. Monitor application health
# Response times will be slower but correct

# 4. Investigate root cause
```

### Partial Rollback (Disable Redis Only)

**When to use**: Redis issues, but memory cache works fine

```bash
# 1. Disable Redis cache layer
CACHE_ENABLE_REDIS=false

# 2. Restart application

# 3. Verify memory cache still works
curl /api/cache/stats | jq '.data.cache.memory'

# 4. Fix Redis issues
```

### Full Rollback (Revert Code)

**When to use**: Bugs in caching logic, major issues

```bash
# 1. Disable cache first (see above)

# 2. Revert to previous deployment
git checkout <previous-tag>
yarn build
# Deploy

# 3. Verify application health

# 4. Fix issues in separate branch
# Test thoroughly before re-deploying
```

---

## Performance Baselines

### Expected Response Times

| Endpoint  | Without Cache | With Cache (Memory) | With Cache (Redis) |
| --------- | ------------- | ------------------- | ------------------ |
| Dashboard | 200-400ms     | 5-15ms              | 15-30ms            |
| Positions | 80-200ms      | 2-10ms              | 10-20ms            |
| Holdings  | 80-200ms      | 2-10ms              | 10-20ms            |
| Trades    | 300-600ms     | 10-20ms             | 20-40ms            |

### Memory Usage

| Component       | Expected Memory         |
| --------------- | ----------------------- |
| In-memory cache | 50-150MB (1000 entries) |
| Redis client    | 10-30MB                 |
| Total overhead  | 60-180MB                |

---

## Support Contacts

- **Redis Service**: DigitalOcean Support
- **Application Issues**: Development team
- **Emergency Hotline**: [Add contact info]

---

## Changelog

| Date       | Change                   | Author |
| ---------- | ------------------------ | ------ |
| 2026-01-09 | Initial runbook creation | Claude |

---

## Quick Reference

```bash
# Check cache status
curl /api/cache/stats | jq

# Disable cache
CACHE_ENABLED=false

# Check Redis connection
redis-cli -h <redis-host> --tls PING

# View cache logs
grep "Cache" application.log | tail -50

# Reset cache stats
curl -X DELETE /api/cache/stats
```
