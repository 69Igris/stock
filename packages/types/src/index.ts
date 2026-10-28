// User types
export type { User } from "./user";

// Trade types
export type {
  Trade,
  TradeSegment,
  TradeType,
  PositionType,
  OrderType,
  ProductType,
  TradeStatus,
  AIInsight,
  TradeComment,
} from "./trade";

// Holding types
export type { Holding } from "./holding";

// Broker types
export type {
  BrokerType,
  RefreshStrategy,
  ConnectionStatus,
  BrokerConnection,
  BrokerAccountInfo,
  BrokerCredentials,
  AuthResult,
  BrokerInfo,
  BrokerConfig,
  HoldingData,
  PositionData,
  OrderData,
  TradeData,
  MutualFundData,
  NormalizedHolding,
  NormalizedPosition,
  NormalizedTrade,
  NormalizedOrder,
  NormalizedMutualFund,
  NormalizedMargins,
  BrokerProfile,
} from "./broker";

// Mutual Fund types
export type { MutualFund } from "./mutual-fund";

// Analysis types
export type { AnalysisReport, ChatMessage } from "./analysis";

// FIRE types
export type {
  FireScenario,
  AssetClass,
  FireExpense,
  OneTimeExpense,
} from "./fire";

// Dashboard types
export type {
  DashboardStats,
  PortfolioStats,
  TradingStats,
  ChartData,
  DailyPnL,
  RecentTrade,
  PortfolioReturns,
} from "./dashboard";

// Paper Trading types
export type {
  PaperPosition,
  PaperPortfolio,
  PaperOrder,
  PlaceOrderInput,
  PaperDashboardStats,
} from "./paper-trading";

// Learning types
export type {
  Course,
  Chapter,
  CourseLesson,
  Quiz,
  Enrollment,
  CourseLessonProgress,
  GlossaryTerm,
  CreateCourseInput,
  CreateChapterInput,
  CreateCourseLessonInput,
  CreateQuizInput,
  CreateGlossaryTermInput,
  CourseListItem,
  EnrollmentWithProgress,
  ContentVerificationResult,
  ContentCheck,
  QuizQuestion,
} from "./learning";

// Subscription types
export type { PlanType, SubscriptionAccess } from "./subscription";

// Common types
export type { ApiResponse, ActionResponse, PaginatedResponse } from "./common";

// Gemini types
export type {
  QueryMode,
  GenerationConfig,
  ModelConfig,
  TopicValidationResult,
  PageContext,
  ActionType,
  DetectedAction,
  ActionValidationResult,
  ChatRequest,
  ChatResponse,
  TokenUsageData,
  ModelPricing,
  GeminiResult,
  CreateScenarioParams,
  ModifyScenarioParams,
  AddStockParams,
  AddMutualFundParams,
  RemoveHoldingParams,
  SaveAnalysisParams,
} from "./gemini";

// Pub/Sub types
export {
  PUBSUB_TOPICS,
  getPubSubEnv,
  getTopicName,
  // MONEY-841 broker-sync shard config (shared by web + worker)
  DEFAULT_SYNC_BUCKET_COUNT,
  getSyncBucketCount,
  syncBucketFor,
  type PairingJobMessage,
  type ImportJobMessage,
  type SyncJobMessage,
  type InstrumentSyncMessage,
  type PublicPriceSource,
  type PriceSyncMessage,
  type IntradaySyncMessage,
  type SectorEnrichmentMessage,
  type MfSyncMessage,
  type MfMetadataSyncMessage,
  type MfNavPropagateMessage,
  type MfNavBackfillMessage,
  type PeersSyncMessage,
  type PubSubPushMessage,
  type DocumentProcessMessage,
  type RoastJobMessage,
  type ComparisonJobMessage,
  type L3AnalysisMessage,
  type LoginBriefingMessage,
  type NewsletterPublishMessage,
  type IndexConstituentSyncMessage,
  type StrategyScanMessage,
  type SparklineSyncMessage,
  type ResearchPreviewPlanJobMessage,
  type NewsRssSyncMessage,
  type AlertEvaluatorMessage,
  type StrategyStatsSyncMessage,
  type AccountDeletionMessage,
  type ClerkDeleteSweepMessage,
} from "./pubsub";

// US transaction-cost model — MONEY-1373. The field names ARE the Mongo field
// names, because the quant engine is Python and reads the collections directly.
export type {
  LiquidityTier,
  TodBucket,
  UsCostModelVersionRead,
  UsCostModelRowRead,
  UsCostModelQuery,
} from "./us-cost-model";
export { US_COST_MODEL_COLLECTIONS } from "./us-cost-model";

// Research types
export type {
  ResearchJobMessage,
  ResearchStatusType,
  ResearchSessionSummary,
} from "./research";

// Content types
export type {
  ContentPlatform,
  ContentType,
  PostStatus,
  ContentRole,
  ContentAuthor,
  Tag,
  TagOnPost,
  PostMetadata,
  Post,
  PostListItem,
  CreatePostInput,
  UpdatePostInput,
  CreateTagInput,
  UpdateTagInput,
  CreateAuthorInput,
  PostFilter,
  PostPagination,
  ContentStats,
  IdeaStatus,
  IdeaStage,
  Idea,
  CreateIdeaInput,
  UpdateIdeaInput,
} from "./content";

// Comparison types
export type { ComparableFund } from "./comparison";

// Chat dashboard types
export type {
  TextBlock,
  TableBlock,
  TableColumn,
  CardBlock,
  CardItem,
  ChartBlock,
  ChartYKey,
  ActionBlock,
  TaskProgressItem,
  ResearchPromptBlock,
  ResearchStreamBlock,
  NavigationBlock,
  NavigationLink,
  ComparisonBlock,
  ComparisonItem,
  ComparisonMetric,
  StockListBlock,
  ErrorBlock,
  RefusalBlock,
  RoastSummaryBlock,
  RoastSummaryHighlight,
  PortfolioBlock,
  HoldingsBlock,
  TaxReportBlock,
  RiskBlock,
  MutualFundBlock,
  FireBlock,
  SectorBlock,
  TechnicalBlock,
  NewsBlock,
  ScorecardBlock,
  PnlBlock,
  DividendBlock,
  StructuredReportBlock,
  ContentBlock,
  ContentBlockType,
  ChatContextMode,
  ChatContextModeSerializable,
  ToolExecutionRequest,
  ChatDashboardRequest,
  ChatDashboardResponse,
  ToolResult,
  ChatMessageWithBlocks,
  TurnMeta,
} from "./chat";

// Roast types
export type {
  StructuredRoastResult,
  RoastScoreBreakdown,
  RoastHighlight,
  RoastPerformer,
  RoastSectorAnalysis,
  RoastAdvice,
} from "./roast";
