# UseMoney - Scaling Roadmap: 100 / 1,000 / 10,000 Concurrent Users

> Last Updated: 2026-03-21

---

## Current Baseline (as of today)

| Component                | Current Config                                  | Handles                   |
| ------------------------ | ----------------------------------------------- | ------------------------- |
| **Vercel (Web)**         | Hobby/Pro plan, serverless                      | ~50 concurrent requests   |
| **Cloud Run (Workers)**  | 2 CPU, 1Gi, max 20 instances, concurrency 10    | ~200 concurrent jobs      |
| **MongoDB Atlas**        | Pool size 10 per connection                     | ~50 concurrent DB ops     |
| **Redis (DigitalOcean)** | Single node, 3 retries, 10s connect timeout     | ~100 concurrent ops       |
| **Gemini API**           | ~60 RPM Pro, ~300 RPM Flash (default Vertex AI) | ~5 concurrent L3 analyses |
| **Pub/Sub**              | 16 topics, 600s ack, 7d retention               | Unlimited throughput      |

---

## Tier 1: 100 Concurrent Users

**Profile:** 100 users active simultaneously. ~20 chatting, ~5 running L2
research, ~2 running L3 comprehensive, ~30 browsing dashboard, ~43 on other
pages.

### What Breaks First

Nothing critical breaks at 100 users. Current infra handles this with headroom.

### Recommended Changes

| Component     | Change                                                 | Why                                                         |
| ------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| **Cloud Run** | Memory: 1Gi → **2Gi**                                  | L3 segments + research hold ~400MB JSON in memory           |
| **Cloud Run** | Concurrency: 10 → **5**                                | Prevent OOM when multiple heavy jobs land on same container |
| **MongoDB**   | Pool size: 10 → **25**                                 | More concurrent queries from serverless functions           |
| **Gemini**    | Request quota increase: **120 RPM Pro, 600 RPM Flash** | 2 concurrent L3s + 5 L2s + 20 Flash = ~90 RPM peak          |
| **Redis**     | No change                                              | Current config sufficient                                   |
| **Vercel**    | No change                                              | Serverless auto-scales                                      |

### Estimated Costs (Monthly)

| Service             | Current   | At 100 Users |
| ------------------- | --------- | ------------ |
| Cloud Run           | ~$30      | ~$50         |
| MongoDB Atlas (M10) | ~$60      | ~$60         |
| Redis (DO)          | ~$15      | ~$15         |
| Gemini API          | ~$20      | ~$80         |
| Vercel Pro          | ~$20      | ~$20         |
| **Total**           | **~$145** | **~$225**    |

---

## Tier 2: 1,000 Concurrent Users

**Profile:** 1,000 active users. ~200 chatting, ~50 L2 research, ~10-15 L3, ~300
dashboard, ~200 broker sync, ~235 browsing.

### What Breaks

| Component      | Failure Mode                      | Symptom                              |
| -------------- | --------------------------------- | ------------------------------------ |
| **Gemini API** | Rate limit (429)                  | L2/L3 analyses fail or queue         |
| **MongoDB**    | Connection pool exhaustion        | Timeout errors on dashboard/holdings |
| **Cloud Run**  | Max instances hit (20)            | Pub/Sub messages queue up, delays    |
| **Redis**      | Connection limit on DO basic plan | Cache misses, fallback to DB         |
| **Vercel**     | Function concurrency limits       | 504 timeouts on API routes           |

### Recommended Changes

| Component          | Change                                         | Config                           |
| ------------------ | ---------------------------------------------- | -------------------------------- |
| **Cloud Run**      | Max instances: 20 → **50**                     | `--max-instances=50`             |
| **Cloud Run**      | Memory: 1Gi → **2Gi**                          | `--memory=2Gi`                   |
| **Cloud Run**      | CPU: 2 → **4**                                 | `--cpu=4`                        |
| **Cloud Run**      | Concurrency: → **8**                           | `--concurrency=8`                |
| **MongoDB Atlas**  | Upgrade M10 → **M30**                          | 8GB RAM, dedicated cluster       |
| **MongoDB**        | Pool size: 10 → **50** (workers), **25** (web) | Connection string param          |
| **Redis**          | Upgrade to **4GB node** or Upstash serverless  | Higher connection limit          |
| **Gemini**         | **600 RPM Pro, 2000 RPM Flash**                | Vertex AI quota increase request |
| **Vercel**         | Upgrade to **Pro with increased concurrency**  | Or switch to Enterprise          |
| **Pub/Sub**        | No change                                      | Already unlimited throughput     |
| **L3 concurrency** | Per-user: 1, Global: **15 concurrent**         | Add global semaphore via Redis   |

### Architecture Changes Needed

1. **Gemini queue with backpressure:** When hitting rate limits, queue L2/L3
   requests in Redis with priority (L1 > L2 > L3) instead of failing
   immediately.

2. **MongoDB read replicas:** Route dashboard reads to secondary replica to
   reduce primary load.

3. **Redis connection pooling:** Switch from single ioredis connection to
   connection pool (ioredis `Cluster` or `maxPoolSize`).

4. **Vercel Edge caching:** Cache dashboard stats at the edge (5s TTL) to reduce
   serverless function invocations.

### Estimated Costs (Monthly)

| Service                         | At 1,000 Users |
| ------------------------------- | -------------- |
| Cloud Run (50 instances avg 10) | ~$300          |
| MongoDB Atlas M30               | ~$400          |
| Redis (4GB)                     | ~$60           |
| Gemini API                      | ~$500          |
| Vercel Pro                      | ~$40           |
| Pub/Sub                         | ~$10           |
| **Total**                       | **~$1,310**    |

---

## Tier 3: 10,000 Concurrent Users

**Profile:** 10,000 active. ~2,000 chatting, ~500 L2, ~50-100 L3, ~3,000
dashboard, ~1,000 broker sync, ~3,400 browsing.

### What Breaks

Everything from Tier 2, plus:

| Component             | Failure Mode                                            |
| --------------------- | ------------------------------------------------------- |
| **Gemini API**        | Even 600 RPM Pro is insufficient for 50+ concurrent L3s |
| **MongoDB**           | Write contention on Subscription model (credit updates) |
| **Cloud Run**         | 50 instances × 8 concurrency = 400 jobs - need more     |
| **Single Redis node** | Latency spikes, connection storms                       |
| **Vercel**            | Cold start storm on serverless                          |
| **Broker APIs**       | Rate limits on Zerodha/Upstox/Angel APIs                |

### Recommended Changes

| Component         | Change                                                          | Config                                  |
| ----------------- | --------------------------------------------------------------- | --------------------------------------- |
| **Cloud Run**     | Max instances: → **100**                                        | Regional + multi-region if needed       |
| **Cloud Run**     | Memory: → **4Gi**, CPU: → **4**                                 | For heavy L3 synthesis                  |
| **MongoDB Atlas** | Upgrade to **M50 or M60**                                       | 32-64GB RAM, SSD, auto-scaling          |
| **MongoDB**       | Enable **sharding** on `analysis_sessions`                      | Distribute L3 write load                |
| **MongoDB**       | Pool size: → **100** (workers), **50** (web)                    | Match instance count                    |
| **Redis**         | Switch to **Redis Cluster** (3 nodes) or **Upstash Enterprise** | Horizontal scaling                      |
| **Gemini**        | **2000 RPM Pro, 10000 RPM Flash**                               | Enterprise quota request                |
| **Gemini**        | Add **model fallback**: Pro → Flash on 429                      | Graceful degradation                    |
| **Vercel**        | **Enterprise plan** with guaranteed concurrency                 | Or self-host on Cloud Run               |
| **Pub/Sub**       | Add **flow control** on subscriptions                           | Prevent thundering herd                 |
| **L3**            | Global concurrency limit: **50** via Redis semaphore            | Prevent Gemini overload                 |
| **CDN**           | Add **Cloudflare** in front of Vercel                           | Edge caching for static + API responses |

### Architecture Changes Needed

1. **Multi-model strategy:**
   - L1 Flash: Gemini 2.5 Flash (cheap, fast, high quota)
   - L2 standard: Gemini 2.5 Flash with extended thinking
   - L2 advanced: Gemini 2.5 Pro
   - L3 segments: Gemini 2.5 Pro with Flash fallback on 429
   - Login briefing: Gemini 2.5 Flash only

2. **Rate limiter with token bucket:**

   ```
   Gemini Pro: 2000 tokens/min bucket, refill 33/sec
   Gemini Flash: 10000 tokens/min bucket, refill 167/sec
   Per-user: 10 RPM (Pro), 60 RPM (Flash)
   ```

3. **Database write optimization:**
   - Batch credit updates (aggregate in Redis, flush every 5s)
   - Use MongoDB `bulkWrite` for analysis session progress updates
   - Move hot counters (query usage) to Redis, sync to MongoDB every minute

4. **Worker specialization:**
   - Separate Cloud Run services for heavy (L3, roast) vs light (pairing, sync)
     jobs
   - Heavy service: 4Gi memory, 4 CPU, concurrency 3
   - Light service: 1Gi memory, 1 CPU, concurrency 20

5. **Broker sync optimization:**
   - Stagger 10,000 daily broker syncs across 6-hour window (not all at
     midnight)
   - Group by broker to maximize batch API calls
   - Cache broker responses in Redis (5min TTL) for users checking within
     minutes of each other

### Estimated Costs (Monthly)

| Service                               | At 10,000 Users   |
| ------------------------------------- | ----------------- |
| Cloud Run (100 instances, 2 services) | ~$2,000           |
| MongoDB Atlas M50                     | ~$1,500           |
| Redis Cluster (3 nodes)               | ~$300             |
| Gemini API                            | ~$3,000-5,000     |
| Vercel Enterprise                     | ~$500             |
| Pub/Sub                               | ~$50              |
| Cloudflare Pro                        | ~$25              |
| Datadog                               | ~$200             |
| **Total**                             | **~$7,575-9,575** |

---

## API Quota Requirements Summary

| API / Service                   | 100 Users  | 1,000 Users | 10,000 Users          |
| ------------------------------- | ---------- | ----------- | --------------------- |
| **Gemini 2.5 Pro RPM**          | 120        | 600         | 2,000                 |
| **Gemini 2.5 Flash RPM**        | 600        | 2,000       | 10,000                |
| **Gemini daily token budget**   | 10M tokens | 100M tokens | 1B tokens             |
| **MongoDB connections**         | 50         | 200         | 500                   |
| **MongoDB IOPS**                | 1,000      | 5,000       | 20,000                |
| **Redis connections**           | 50         | 200         | 1,000                 |
| **Redis ops/sec**               | 500        | 5,000       | 50,000                |
| **Pub/Sub messages/day**        | 5,000      | 50,000      | 500,000               |
| **Cloud Run instances**         | 20         | 50          | 100                   |
| **Vercel function concurrency** | 50         | 200         | 1,000                 |
| **Zerodha API RPM**             | 10         | 60          | 180 (need to stagger) |
| **Yahoo Finance RPM**           | 100        | 500         | 2,000                 |
| **Tickertape RPM** (cached)     | 20         | 50          | 100 (mostly cached)   |
| **Screener.in RPM** (cached)    | 5          | 10          | 20 (mostly cached)    |

---

## MongoDB Atlas Tier Mapping

| Users   | Atlas Tier | RAM  | Storage | vCPU   | Cost/mo |
| ------- | ---------- | ---- | ------- | ------ | ------- |
| Current | M10        | 2GB  | 10GB    | Shared | ~$60    |
| 100     | M10        | 2GB  | 20GB    | Shared | ~$60    |
| 1,000   | **M30**    | 8GB  | 50GB    | 2 vCPU | ~$400   |
| 10,000  | **M50**    | 32GB | 200GB   | 8 vCPU | ~$1,500 |

**Key settings to change:**

- `maxPoolSize` in connection string: `?maxPoolSize=25` (100 users) → `50` (1K)
  → `100` (10K)
- Enable **auto-scaling** on M30+ (scales storage automatically)
- Enable **read preference: secondaryPreferred** for dashboard reads at 1K+

---

## Redis Tier Mapping

| Users   | Provider                                | Plan      | RAM  | Connections | Cost/mo |
| ------- | --------------------------------------- | --------- | ---- | ----------- | ------- |
| Current | DigitalOcean                            | Basic     | 1GB  | 150         | ~$15    |
| 100     | DigitalOcean                            | Basic     | 1GB  | 150         | ~$15    |
| 1,000   | DO or **Upstash**                       | 4GB / Pro | 4GB  | 500         | ~$60    |
| 10,000  | **Upstash Enterprise** or Redis Cluster | 8GB+      | 8GB+ | 5,000+      | ~$300   |

---

## Vercel Config Mapping

| Users   | Plan                    | Functions/sec     | Edge Middleware | Bandwidth |
| ------- | ----------------------- | ----------------- | --------------- | --------- |
| Current | Pro                     | 50 concurrent     | Yes             | 1TB       |
| 100     | Pro                     | 50 concurrent     | Yes             | 1TB       |
| 1,000   | Pro + **Fluid Compute** | 200 concurrent    | Yes             | 5TB       |
| 10,000  | **Enterprise**          | 1,000+ concurrent | Yes             | Unlimited |

---

## Cost Projection Summary

| Scale        | Monthly Cost | Per User/mo | Revenue Needed        |
| ------------ | ------------ | ----------- | --------------------- |
| 100 users    | ~$225        | $2.25       | 15 PRO subs cover it  |
| 1,000 users  | ~$1,310      | $1.31       | 50 PRO subs cover it  |
| 10,000 users | ~$8,500      | $0.85       | 200 PRO subs cover it |

_Assumes PRO plan at ₹499/mo (~$6/mo), with 30% paying conversion._

---

_Last Updated: 2026-03-21_
