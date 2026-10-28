export interface AnalysisReport {
  id: string;
  userId: string;
  symbol: string;
  name?: string | null;
  type: "stock" | "mf";
  model: string;
  recommendation: "BUY" | "SELL" | "HOLD";
  confidence: number;
  currentPrice?: number | null;
  targetPrice?: number | null;
  stopLoss?: number | null;
  riskReward?: string | null;
  strengths: string[];
  weaknesses: string[];
  commentary?: string | null;
  chatHistory: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: Date;
  /** Optional rich content blocks persisted for chat reload */
  blocks?: unknown[];
  /** Per-turn structured metadata (schemaless for Json[] persistence) */
  turnMeta?: unknown;
}
