/**
 * StockSage Loop Controller
 *
 * Controls the iterative refinement loop:
 * Plan -> Execute -> Synthesize -> Validate -> (Refine if needed) -> Done
 */

import type { ResearchAgentConfig, ValidationResult } from "./types";

export class LoopController {
  private config: ResearchAgentConfig;
  private iteration = 0;
  private totalSteps = 0;

  constructor(config: ResearchAgentConfig) {
    this.config = config;
  }

  /**
   * Check if we should refine based on validation results.
   */
  shouldRefine(validation: ValidationResult): boolean {
    // Don't refine if we've hit the max iterations
    if (this.iteration >= this.config.maxIterations) {
      return false;
    }

    // Don't refine if we've hit the step limit
    if (this.totalSteps >= this.config.maxSteps) {
      return false;
    }

    // Refine if quality is below threshold
    return (
      !validation.passed && validation.score < this.config.qualityThreshold
    );
  }

  /**
   * Record that a refinement iteration is starting.
   */
  startIteration(): number {
    this.iteration++;
    return this.iteration;
  }

  /**
   * Record steps executed.
   */
  addSteps(count: number): void {
    this.totalSteps += count;
  }

  /**
   * Check if we've exceeded safety limits.
   */
  isAtLimit(): boolean {
    return (
      this.iteration >= this.config.maxIterations ||
      this.totalSteps >= this.config.maxSteps
    );
  }

  getIteration(): number {
    return this.iteration;
  }

  getTotalSteps(): number {
    return this.totalSteps;
  }
}
