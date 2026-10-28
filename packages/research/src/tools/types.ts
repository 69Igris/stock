/**
 * Research Tool Interface
 */

export interface ToolOutput {
  success: boolean;
  data?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ResearchToolDef {
  name: string;
  description: string;
  category: "data" | "computation" | "synthesis";
  parameters: Record<
    string,
    {
      type: string;
      description: string;
      required?: boolean;
      default?: unknown;
    }
  >;
  execute: (params: Record<string, unknown>) => Promise<ToolOutput>;
  cacheTTL?: number; // seconds
}
