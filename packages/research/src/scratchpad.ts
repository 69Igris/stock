/**
 * StockSage Scratchpad - JSONL Reasoning Log
 *
 * Records every step of the research process for transparency
 * and debugging. Stored on the ResearchSession document.
 */

import type { ScratchpadEntry, ScratchpadEntryType } from "./types";

export class Scratchpad {
  private entries: ScratchpadEntry[] = [];
  private stepCounter = 0;

  log(
    type: ScratchpadEntryType,
    data: unknown,
    taskId?: string,
    tokenUsage?: { input: number; output: number },
  ): void {
    this.stepCounter++;
    this.entries.push({
      timestamp: new Date().toISOString(),
      stepNumber: this.stepCounter,
      type,
      taskId,
      data,
      tokenUsage,
    });
  }

  getEntries(): ScratchpadEntry[] {
    return [...this.entries];
  }

  getStepCount(): number {
    return this.stepCounter;
  }

  getTokenUsage(): { input: number; output: number } {
    let input = 0;
    let output = 0;
    for (const entry of this.entries) {
      if (entry.tokenUsage) {
        input += entry.tokenUsage.input;
        output += entry.tokenUsage.output;
      }
    }
    return { input, output };
  }

  toJSON(): ScratchpadEntry[] {
    return this.entries;
  }
}
