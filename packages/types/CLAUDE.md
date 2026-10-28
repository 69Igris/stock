# @usemoney/types - CLAUDE.md

## Overview

Shared TypeScript type definitions used across all UseMoney apps and packages.

**Package:** `@usemoney/types`

---

## Exports

```typescript
import { User, Trade, Holding, ... } from "@usemoney/types";
import { User } from "@usemoney/types/user";
import { Trade, TradeType } from "@usemoney/types/trade";
import { Holding } from "@usemoney/types/holding";
import { BrokerConfig, TradeData, HoldingData, MutualFundData } from "@usemoney/types/broker"; // broker owns the *Data DTOs
import { AnalysisResult } from "@usemoney/types/analysis";
import { PUBSUB_TOPICS, PubSubPushMessage, getTopicName, ... } from "@usemoney/types/pubsub";
import { DashboardStats, PortfolioStats, ... } from "@usemoney/types/dashboard";
// chat, gemini, research, roast, comparison, content, learning have NO subpath
// exports (see package.json "exports") — import them from the root barrel:
import { ResearchSessionSummary, StructuredRoastResult, ContentBlock, ChatContextMode, Course } from "@usemoney/types";
```

---

## Directory Structure

```
packages/types/src/
├── index.ts           # Main re-exports from all modules
├── analysis/          # Analysis report types
├── broker/            # Broker connection, config, normalized data types
├── chat.ts            # Chat dashboard content blocks & context types
├── common/            # ApiResponse, ActionResponse, PaginatedResponse
├── comparison.ts      # Fund comparison types (MF/ETF/INDEX)
├── content/           # Content platform types (blog, glossary, ideas)
├── dashboard/         # Dashboard stats, portfolio, trading, charts
├── fire/              # FIRE calculator scenario types
├── gemini.ts          # Gemini LLM integration types (query, actions, config)
├── holding/           # Holding types
├── learning/          # Course, chapter, lesson, quiz, enrollment types
├── mutual-fund/       # Mutual fund types
├── paper-trading/     # Paper trading position, order, portfolio types
├── pubsub.ts          # Pub/Sub topics, message types, helper functions
├── research.ts        # Research session and status types
├── roast.ts           # Portfolio roast structured result types
├── subscription/      # Subscription plan types
├── trade/             # Trade types (segment, type, status, etc.)
└── user/              # User types
```

---

## Key Types

### User Types

```typescript
interface UserProfile {
  id: string;
  clerkUserId: string;
  email: string;
  name?: string;
  subscriptionTier: SubscriptionTier;
}
```

### Trade Types

```typescript
interface TradeData {
  symbol: string;
  transactionType: "BUY" | "SELL";
  quantity: number;
  price: number;
  tradeTime: Date;
  exchange: string;
  segment: string;
  productType: string;
}
```

### Holding Types

```typescript
interface HoldingData {
  symbol: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercentage: number;
}
```

### Broker Types

```typescript
type BrokerType =
  | "ZERODHA"
  | "UPSTOX"
  | "DHAN"
  | "FYERS"
  | "ANGEL_ONE"
  | "GROWW";

interface BrokerConnection {
  brokerName: BrokerType;
  brokerId?: string;
  connected: boolean;
}
```

### Pub/Sub Types (`pubsub.ts`)

```typescript
// Const object with 40 topic base names — see src/pubsub.ts for the full list.
// Also exports MONEY-841 broker-sync shard helpers: DEFAULT_SYNC_BUCKET_COUNT,
// getSyncBucketCount, syncBucketFor (runtime code shared by web + workers).
const PUBSUB_TOPICS = {
  // (partial list)
  TRADE_PAIRING, CSV_IMPORT, BROKER_SYNC,
  INSTRUMENT_SYNC, PRICE_SYNC, SECTOR_ENRICHMENT,
  STOCK_RESEARCH, MF_SYNC, MF_METADATA_SYNC,
  DOCUMENT_PROCESS, PORTFOLIO_ROAST,
} as const;

// Helper functions (runtime code, not just types)
function getPubSubEnv(): "qa" | "prod";     // Returns env suffix from PUBSUB_ENV or NODE_ENV
function getTopicName(baseTopic: string): string; // Appends env suffix, e.g. "instrument-sync-qa"

// Job message interfaces (shared between web publisher and worker consumer)
interface PairingJobMessage { jobId, userId, batchId? }
interface ImportJobMessage { jobId, userId, content?, fileUrl?, brokerFormat, fileType, ... }
interface SyncJobMessage { jobId, userId, brokerConnectionId?, broker?, dataTypes?, isScheduled? }
interface InstrumentSyncMessage { exchanges?, forceFullSync? }
interface PriceSyncMessage { instrumentIds?, dateRange?, source? }
interface SectorEnrichmentMessage { batchSize?, exchanges?, forceReEnrich?, delayMs? }
interface MfSyncMessage { forceFullSync? }
interface MfMetadataSyncMessage { batchSize?, delayMs?, forceReEnrich? }
interface ResearchJobMessage { jobId, userId, sessionId, query, skill?, symbols?, mode? }
interface RoastJobMessage { jobId, userId, sessionId, mode, broker?, assetType }
interface DocumentProcessMessage { jobId, userId, documentId, action, url?, reportType?, reportParams? }

// Cloud Run push envelope
interface PubSubPushMessage { message: { data, messageId, publishTime }, subscription }
```

### Research Types (`research.ts`)

```typescript
type ResearchStatusType =
  | "PLANNING"
  | "RESEARCHING"
  | "ANALYZING"
  | "VALIDATING"
  | "REFINING"
  | "SYNTHESIZING"
  | "COMPLETED"
  | "FAILED";

interface ResearchSessionSummary {
  sessionId;
  query;
  status;
  progress;
  currentStep?;
  skill?;
  symbols;
  qualityScore?;
  startedAt;
  completedAt?;
}
```

### Roast Types (`roast.ts`)

```typescript
interface StructuredRoastResult {
  overallScore: number;
  scoreBreakdown: { diversification; riskManagement; stockPicking; timing };
  roastHighlights: RoastHighlight[];
  topPerformers: RoastPerformer[];
  worstPerformers: RoastPerformer[];
  sectorAnalysis: RoastSectorAnalysis[];
  constructiveAdvice: RoastAdvice[];
  roastNarrative: string;
  disclaimer: string;
}

interface RoastScoreBreakdown {
  score;
  comment;
}
interface RoastHighlight {
  type: "burn" | "praise";
  emoji;
  title;
  description;
}
interface RoastPerformer {
  symbol;
  pnlPercent;
  roast;
}
interface RoastSectorAnalysis {
  sector;
  percentage;
  verdict;
  comment;
}
interface RoastAdvice {
  title;
  description;
}
```

### Chat Types (`chat.ts`)

```typescript
// Content block discriminated union for rich message rendering — 26 variants
// (incl. StructuredReportBlock + the 12 MONEY-587 typed blocks: Portfolio,
// Holdings, TaxReport, Risk, MutualFund, Fire, Sector, Technical, News,
// Scorecard, Pnl, Dividend). Partial list:
type ContentBlock =
  | TextBlock
  | TableBlock
  | CardBlock
  | ChartBlock
  | ActionBlock
  | NavigationBlock
  | ComparisonBlock
  | StockListBlock
  | ErrorBlock
  | ResearchPromptBlock
  | ResearchStreamBlock
  | RoastSummaryBlock // compact in-chat Portfolio Roast card (MONEY-581)
  | RefusalBlock;

type ContentBlockType = ContentBlock["type"];

// Context modes for chat dashboard
type ChatContextMode =
  | "all"
  | { type: "broker"; brokerId; brokerName }
  | "stock_analysis"
  | "mf_analysis"
  | "retirement"
  | "paper_trading"
  | "research";

type ChatContextModeSerializable =
  | "all"
  | `broker:${string}:${string}`
  | "stock_analysis"
  | "mf_analysis"
  | "retirement"
  | "paper_trading"
  | "research";

// Request/response types
interface ChatDashboardRequest {
  message;
  queryType;
  pagePath;
  context?;
  toolExecution?;
  userContext?;
  chatId?;
  conversationHistory?;
}
interface ChatDashboardResponse {
  response;
  blocks?;
  action?;
  remaining?;
  queryType;
  blocked?;
  toolResults?;
}
interface ToolExecutionRequest {
  tool;
  params;
  actionId;
}
interface ToolResult {
  tool;
  success;
  data?;
  error?;
  renderType?;
}
interface ChatMessageWithBlocks {
  id;
  role;
  content;
  blocks?;
  timestamp;
}
```

### Gemini Types (`gemini.ts`)

```typescript
type QueryMode = "fast" | "advanced";
interface GenerationConfig {
  temperature;
  topP;
  topK;
  maxOutputTokens;
  thinkingConfig?;
}
interface ModelConfig {
  modelName;
  enableThinking;
  generationConfig;
}
interface ChatRequest {
  message;
  queryType;
  pagePath;
  userContext?;
  chatId?;
  conversationHistory?;
}
interface ChatResponse {
  response;
  action?;
  remaining?;
  queryType;
  blocked?;
  blocks?;
}
interface TokenUsageData {
  userId;
  queryType;
  inputTokens;
  outputTokens;
  duration;
  pagePath?;
}
// Action params: CreateScenarioParams, ModifyScenarioParams, AddStockParams, etc.
```

### Learning Types (`learning/`)

```typescript
interface Course { id, slug, title, description, level, duration, topics, published, chapters?, ... }
interface Chapter { id, courseId, title, order, lessons?, ... }
interface CourseLesson { id, chapterId, title, content, type, videoUrl?, duration?, quizzes?, ... }
interface Quiz { id, lessonId, question, options, correctAnswer, explanation?, ... }
interface Enrollment { id, userId, courseId, progress, completedAt?, lessonProgress?, ... }
interface GlossaryTerm { id, term, definition, category?, related, ... }
// Input types: CreateCourseInput, CreateChapterInput, CreateCourseLessonInput, etc.
// List types: CourseListItem, EnrollmentWithProgress
// Content engine: ContentVerificationResult, ContentCheck, QuizQuestion
```

### Content Types (`content/`)

```typescript
type ContentType = "BLOG" | "GLOSSARY" | "NEWSLETTER" | "LEGAL";
type PostStatus = "DRAFT" | "PUBLISHED" | "SCHEDULED" | "DELETED";
interface Post { id, contentPlatform, contentType, title, content, status, author, tags, ... }
interface ContentAuthor { id, clerkId, name?, username, email, role, ... }
interface Tag { id, slug, name, description?, color?, ... }
// Input types: CreatePostInput, UpdatePostInput, CreateTagInput, etc.
// Idea types: Idea, CreateIdeaInput, UpdateIdeaInput
// Stats: ContentStats
```

### Comparison Types (`comparison.ts`)

```typescript
interface ComparableFund { id, fundType: "MF"|"ETF"|"INDEX", name, issuer, category, nav, returns1Y/3Y/5Y, aum, expenseRatio, ... }
```

### Dashboard Types (`dashboard/`)

```typescript
interface DashboardStats { portfolio, trading, charts, recentTrades }
interface PortfolioStats { totalValue, totalPnL, holdingsValue, mfValue, ... }
interface TradingStats { totalRealizedPnL, totalTrades, winRate, bestTrade?, worstTrade?, ... }
```

---

## What's Been Completed

- [x] User types
- [x] Trade types
- [x] Holding types
- [x] Broker types
- [x] Mutual fund types
- [x] Analysis types
- [x] Subscription types
- [x] FIRE types
- [x] Paper trading types
- [x] Dashboard types
- [x] Learning types (courses, chapters, lessons, quizzes, enrollment)
- [x] Content types (blog, glossary, ideas, CMS)
- [x] Gemini/AI types (query modes, actions, guardrails, token usage)
- [x] Chat dashboard types (content blocks, context modes, request/response)
- [x] Pub/Sub topics and message types (40 topics, all job messages)
- [x] Research types (session summary, status)
- [x] Roast types (structured result, score breakdown, highlights)
- [x] Comparison types (fund comparison)
- [x] Common types (ApiResponse, ActionResponse, PaginatedResponse)

---

## Restrictions

- Types only, no runtime code - **exception:** `pubsub.ts` contains small helper
  functions (`getPubSubEnv`, `getTopicName`) and the MONEY-841 broker-sync shard
  helpers (`DEFAULT_SYNC_BUCKET_COUNT`, `getSyncBucketCount`, `syncBucketFor`)
  since they are needed by both publishers and consumers
- No external dependencies
- Re-export Prisma types where needed
- Keep types colocated by feature

---

_Last Updated: July 2026_
