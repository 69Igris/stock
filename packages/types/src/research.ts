/**
 * Research Agent Types - shared between web app, workers, and research package
 */

export interface ResearchJobMessage {
  jobId: string;
  userId: string;
  sessionId: string;
  query: string;
  skill?: string;
  symbols?: string[];
  mode?: "fast" | "advanced";
  /** v2 (MONEY-219) - extras for the planner + worker. */
  customSkills?: string[];
  researchFocus?: string;
  /** Preset id (`quick-pulse` | `investment-thesis` | …). */
  preset?: string;
  /** Model override; planner/worker default to RESEARCH_DEFAULT_MODEL when omitted. */
  model?: string;
}

export type ResearchStatusType =
  | "PLANNING"
  | "RESEARCHING"
  | "ANALYZING"
  | "VALIDATING"
  | "REFINING"
  | "SYNTHESIZING"
  | "COMPLETED"
  | "FAILED";

export interface ResearchSessionSummary {
  sessionId: string;
  query: string;
  status: ResearchStatusType;
  progress: number;
  currentStep?: string;
  skill?: string;
  symbols: string[];
  qualityScore?: number;
  startedAt: string;
  completedAt?: string;
}
