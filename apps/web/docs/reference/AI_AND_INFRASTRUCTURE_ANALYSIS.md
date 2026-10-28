# UseMoney AI & Infrastructure Analysis

> **Last Updated:** January 2026
> **Purpose:** Comprehensive reference for AI, monitoring, and infrastructure decisions

---

## Table of Contents

- [Executive Summary](#executive-summary)
- [Monitoring Tools: Sentry vs Datadog](#monitoring-tools-sentry-vs-datadog)
- [AI Infrastructure: Gemini vs io.net](#ai-infrastructure-gemini-vs-ionet)
- [Current AI Implementation](#current-ai-implementation)
- [Claudefiles Roadmap Analysis](#claudefiles-roadmap-analysis)
- [Implementation Recommendations](#implementation-recommendations)
- [Cost Analysis](#cost-analysis)

---

## Executive Summary

| Decision               | Recommendation                | Reason                                                      |
| ---------------------- | ----------------------------- | ----------------------------------------------------------- |
| **Monitoring Tool**    | **Datadog**                   | Credits available, full-stack observability, LLM monitoring |
| **AI Provider**        | **Google Gemini (Vertex AI)** | Sufficient for all current features                         |
| **io.net GPU Compute** | **Deferred**                  | Optional for future backtesting/ML                          |
| **Additional LLMs**    | **Not needed now**            | Gemini covers all use cases                                 |

---

## Monitoring Tools: Sentry vs Datadog

### Comparison Matrix

| Feature                       | Sentry         | Datadog                 | Winner  |
| ----------------------------- | -------------- | ----------------------- | ------- |
| **Primary Focus**             | Error tracking | Full observability      | Depends |
| **APM (Performance)**         | Basic          | Advanced                | Datadog |
| **Infrastructure Monitoring** | No             | Yes                     | Datadog |
| **Log Management**            | No             | Yes                     | Datadog |
| **Real-time Metrics**         | Limited        | Comprehensive           | Datadog |
| **Distributed Tracing**       | Basic          | Advanced                | Datadog |
| **Database Monitoring**       | No             | Yes (MongoDB)           | Datadog |
| **AI/LLM Monitoring**         | No             | Yes (LLM Observability) | Datadog |
| **NextJS Integration**        | Good           | Excellent               | Datadog |
| **Cost**                      | ~$26/member/mo | ~$15/host/mo            | Similar |
| **Setup Complexity**          | Easy           | Medium                  | Sentry  |
| **Free Tier**                 | Generous       | Limited                 | Sentry  |

### Recommendation: **DATADOG**

Since you have Datadog credits, it's the clear winner for UseMoney:

#### Why Datadog for UseMoney:

1. **Full Stack Visibility**
   - Monitor Vercel deployments
   - Track MongoDB Atlas queries
   - Monitor Redis cache performance
   - Observe Vertex AI/Gemini API calls

2. **LLM Observability (Crucial for AI-heavy app)**
   - Track Gemini API calls, latency, errors
   - Monitor token usage per user/feature
   - Cost tracking per LLM request
   - Response quality monitoring

3. **Real User Monitoring (RUM)**
   - Frontend performance metrics
   - Core Web Vitals
   - User session replay
   - Error tracking with source maps

4. **Alerting & Dashboards**
   - Error rate spikes
   - API latency thresholds
   - Cost budget alerts
   - Custom metrics (queries/user, etc.)

### Datadog Setup Plan for UseMoney

```bash
# 1. Install Datadog packages
pnpm add dd-trace @datadog/browser-rum @datadog/browser-logs

# 2. Environment variables needed
DD_API_KEY=<your-api-key>
DD_SITE=us5.datadoghq.com
DD_ENV=production
DD_SERVICE=stockbook-web
DD_VERSION=<package-version>
```

**Integration Points:**

- APM: Wrap Next.js API routes
- Logs: Replace Pino → Datadog transport
- RUM: Add to `_app.tsx` or `layout.tsx`
- LLM: Instrument Gemini client calls
- Synthetics: Uptime checks for usemoney.ai

---

## AI Infrastructure: Gemini vs io.net

### What They Do (Different Purposes!)

| Service           | Type                    | Purpose                         | When to Use                       |
| ----------------- | ----------------------- | ------------------------------- | --------------------------------- |
| **Google Gemini** | LLM API                 | Text generation, analysis, chat | Always - core AI features         |
| **io.net**        | GPU Compute Marketplace | Heavy compute, ML training      | Optional - backtesting, custom ML |

**Key Insight:** They're **complementary**, not competing technologies.

### Current State

- **AI Provider**: Google Gemini via Vertex AI
- **Models Used**:
  - `gemini-2.5-flash` (fast queries)
  - `gemini-2.5-pro` (advanced queries with thinking mode)
- **io.net**: NOT implemented (only in design docs)

### Is Gemini Enough?

**YES - Gemini is sufficient for all current and planned features.**

### What Gemini Currently Handles

| Feature              | Model     | Thinking Mode     | Status    |
| -------------------- | --------- | ----------------- | --------- |
| AI Chat (all pages)  | Flash/Pro | Optional          | ✅ Active |
| Stock Analysis       | Pro       | Yes (4096 tokens) | ✅ Active |
| Holdings Insights    | Flash     | No                | ✅ Active |
| FIRE Calculator Chat | Flash     | No                | ✅ Active |
| Trading Strategies   | Pro       | Yes               | ✅ Active |
| Learning Modules     | Flash/Pro | Optional          | ✅ Active |
| Content Guardrails   | Flash     | No                | ✅ Active |

### What io.net Would Add (Future - OPTIONAL)

| Feature                   | Why io.net Needed                   | Priority | Effort    |
| ------------------------- | ----------------------------------- | -------- | --------- |
| Strategy Backtesting      | Process 10+ years historical data   | Medium   | High      |
| Custom ML Models          | Train on user trading patterns      | Low      | Very High |
| Batch Signal Generation   | Analyze 5000 stocks at once         | Low      | Medium    |
| Monte Carlo Simulations   | Run 10,000+ scenarios               | Low      | Medium    |
| Real-time Market Scanning | GPU-accelerated pattern recognition | Low      | High      |

### Recommendation

**Phase 1 (Now):** Gemini is more than sufficient for:

- All chat/analysis features
- Stock recommendations
- FIRE planning
- Learning modules
- Trading strategies

**Phase 2 (Future):** Consider io.net only if:

- You need backtesting on 10+ years of data
- You want custom ML models on user data
- You need real-time analysis of entire NSE/BSE universe
- User demand for GPU-accelerated features

---

## Current AI Implementation

### Architecture Overview

```
User Request
    │
    ▼
┌─────────────────────────────────────┐
│  Guardrails (lib/gemini/guardrails) │
│  - Finance keyword validation       │
│  - Prompt injection detection       │
│  - Input sanitization (5000 chars)  │
└─────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────┐
│  Query Consumption (subscription)   │
│  - Check quota (fast/advanced)      │
│  - Deduct from user allocation      │
└─────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────┐
│  Gemini Generation (Vertex AI)      │
│  - Flash: 0.7 temp, 2048 max tokens │
│  - Pro: 0.9 temp, 8192 max, thinking│
│  - Retry with exponential backoff   │
└─────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────┐
│  Post-Processing                    │
│  - Action detection (ACTION markers)│
│  - Response cleaning                │
│  - Token usage tracking             │
│  - Cost calculation (USD & INR)     │
└─────────────────────────────────────┘
    │
    ▼
  Response to User
```

### Key Files

| File                                     | Purpose                                |
| ---------------------------------------- | -------------------------------------- |
| `packages/core/src/gemini/client.ts`     | Vertex AI client initialization        |
| `packages/core/src/gemini/models.ts`     | Model configs, retry logic             |
| `packages/core/src/gemini/guardrails.ts` | Content filtering, injection detection |
| `packages/core/src/gemini/pricing.ts`    | Token cost calculation                 |
| `packages/core/src/gemini/prompts.ts`    | Page-specific system prompts           |
| `apps/web/lib/gemini/cost-tracker.ts`    | Usage tracking to database             |
| `apps/web/app/api/chat/route.ts`         | Main chat API endpoint                 |

### Model Configuration

**Fast Mode (gemini-2.5-flash):**

```typescript
{
  model: "gemini-2.5-flash",
  temperature: 0.7,
  maxOutputTokens: 2048,
  thinkingMode: false,
  costPerMInput: 0.075, // USD per 1M tokens
  costPerMOutput: 0.30
}
```

**Advanced Mode (gemini-2.5-pro):**

```typescript
{
  model: "gemini-2.5-pro",
  temperature: 0.9,
  maxOutputTokens: 8192,
  thinkingMode: true,
  thinkingBudget: 4096, // Extra tokens for reasoning
  costPerMInput: 1.25, // USD per 1M tokens
  costPerMOutput: 5.00
}
```

---

## Claudefiles Roadmap Analysis

### Files Analyzed

| File                       | Purpose              | Key Insights                      |
| -------------------------- | -------------------- | --------------------------------- |
| `GEMINI_DESIGN_PROMPT.md`  | UI design prompts    | io.net aesthetic inspiration      |
| `Claude Code Prompt.md`    | Implementation guide | Full tech stack, components       |
| `Design System.md`         | UI specifications    | Dark mode, animations, components |
| `README from Claude AI.md` | Quick start guide    | Project structure, checklist      |

### io.net in Design Docs

The design docs reference io.net for:

1. **Aesthetic Inspiration** - Dark mode, GPU cluster UI style
2. **GPU Compute Status Panel** - UI component showing compute credits
3. **Backtest Workers** - GPU-accelerated strategy testing
4. **AI Signal Generation** - GPU-powered batch analysis

**Current Reality:** io.net integration was planned but NOT implemented. The GPU Compute UI exists but is cosmetic (mock data).

### Tech Stack from Claudefiles (vs Actual)

| Planned                      | Actual                       | Notes                         |
| ---------------------------- | ---------------------------- | ----------------------------- |
| PostgreSQL (Supabase)        | MongoDB Atlas                | Changed to MongoDB            |
| Better Auth                  | Clerk                        | Changed to Clerk              |
| Zustand + TanStack Query     | React hooks + server actions | Simplified                    |
| io.net SDK                   | Not implemented              | GPU compute deferred          |
| OpenAI + Gemini + Perplexity | Gemini only                  | Simplified to single provider |

---

## Implementation Recommendations

### Immediate (High Priority)

1. **Datadog Integration**
   - Setup APM for API routes
   - Add RUM for frontend
   - Configure LLM observability for Gemini
   - Set up alerts for errors and costs

2. **AI Improvements**
   - Implement Redis caching for common queries
   - Add response streaming for better UX
   - Improve guardrails with more finance keywords

### Short-term (Medium Priority)

3. **Monitoring Dashboard**
   - Create custom Datadog dashboard for UseMoney
   - Track: API latency, error rates, token usage, costs

4. **Cost Optimization**
   - Cache frequent Gemini responses
   - Implement query deduplication
   - Add cost alerts per user

### Future (Low Priority - As Needed)

5. **io.net Integration** (if backtesting demand grows)
   - Research io.net SDK
   - Implement backtesting engine
   - Add GPU compute status (real, not mock)

6. **Multi-LLM Fallback**
   - Add OpenAI as Gemini backup
   - Implement automatic failover

---

## Cost Analysis

### Current Costs (Gemini Only)

| Component    | Monthly Estimate | Notes              |
| ------------ | ---------------- | ------------------ |
| Gemini Flash | ₹1,000-2,000     | Fast queries       |
| Gemini Pro   | ₹2,000-4,000     | Advanced queries   |
| Vertex AI    | Included         | No separate charge |
| **Total AI** | **₹3,000-6,000** | Per month          |

### If Adding io.net (Future)

| Component             | Monthly Estimate  | Notes                |
| --------------------- | ----------------- | -------------------- |
| Gemini (current)      | ₹3,000-6,000      | Same as above        |
| io.net GPU Hours      | ₹5,000-15,000     | 50-100 GPU hours     |
| **Total with io.net** | **₹8,000-21,000** | Significant increase |

### Monitoring Costs

| Tool                 | Monthly Cost | Notes                |
| -------------------- | ------------ | -------------------- |
| Datadog              | ₹0           | You have credits     |
| Sentry (alternative) | ~₹2,000      | If credits run out   |
| PostHog (current)    | ₹0           | Free tier sufficient |

---

## Related Documentation

- [Broker Integration Guide](./BROKER_INTEGRATION.md)
- [Dodo Payments Setup](./DODO_PAYMENTS_SETUP.md)
- [MongoDB Encryption Setup](./MONGODB_ENCRYPTION_SETUP.md)
- [Redis/Memorystore Setup](./MEMORYSTORE_REDIS_SETUP.md)
- [Feature Flag Caching](./FEATURE_FLAG_CACHING.md)

---

## Appendix: Environment Variables for AI/Monitoring

```bash
# Google Cloud / Gemini
GCP_PROJECT_ID=<project-id>
GCP_LOCATION=us-central1
GCP_SERVICE_ACCOUNT_KEY_BASE64=<base64-encoded-key>

# Gemini Configuration
USE_GEMINI=true
GEMINI_MAX_RETRIES=3
GEMINI_TIMEOUT_MS=30000

# Datadog (when integrated)
DD_API_KEY=<your-api-key>
DD_SITE=us5.datadoghq.com
DD_ENV=production
DD_SERVICE=stockbook-web

# PostHog (current analytics)
NEXT_PUBLIC_POSTHOG_KEY=<your-key>
NEXT_PUBLIC_POSTHOG_HOST=https://app.posthog.com
```
