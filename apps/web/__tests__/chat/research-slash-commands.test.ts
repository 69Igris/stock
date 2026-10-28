/**
 * MONEY-223 - Research-shortcut slash commands.
 *
 * Each shortcut (/deep, /quick, /peer, /dcf, /thesis, /earnings, /technical,
 * /news, /focus) bakes a specific skill + customSkills + mode into the
 * run_research tool params so the user skips the chip prompt and the
 * planner trims to the right tool set (MONEY-222). These tests pin the
 * mapping so a future refactor can't silently downgrade /dcf to fast mode
 * or drop the customSkills allow-list.
 *
 * Imports the real registry + parser + executor (no Next runtime deps in
 * those modules) so production code is exercised, not a reimplementation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findCommand } from "@/lib/chat/slash-commands/registry";
import { parseSlashInput } from "@/lib/chat/slash-commands/parser";
import { executeSlashCommand } from "@/lib/chat/slash-commands/executor";

function execShortcut(input: string) {
  const parsed = parseSlashInput(input);
  if (!parsed) throw new Error(`failed to parse: ${input}`);
  return executeSlashCommand(parsed);
}

describe("MONEY-223 - research shortcut commands exist + route to run_research", () => {
  const SHORTCUTS = [
    "deep",
    "quick",
    "peer",
    "dcf",
    "thesis",
    "earnings",
    "technical",
    "news",
    "focus",
  ];

  it("registers all 9 shortcut commands", () => {
    for (const name of SHORTCUTS) {
      assert.ok(findCommand(name), `missing slash command: /${name}`);
    }
  });

  it("/deep RELIANCE → run_research mode=advanced symbol=RELIANCE", () => {
    const result = execShortcut("/deep RELIANCE");
    assert.equal(result.toolExecution?.tool, "run_research");
    assert.deepEqual(result.toolExecution?.params.symbols, ["RELIANCE"]);
    assert.equal(result.toolExecution?.params.mode, "advanced");
  });

  it("/quick INFY → run_research mode=fast", () => {
    const result = execShortcut("/quick INFY");
    assert.equal(result.toolExecution?.tool, "run_research");
    assert.equal(result.toolExecution?.params.mode, "fast");
    assert.deepEqual(result.toolExecution?.params.symbols, ["INFY"]);
  });

  it("/peer HDFCBANK → skill=peer-comparison + customSkills=[peer-comparison] + advanced", () => {
    const result = execShortcut("/peer HDFCBANK");
    const params = result.toolExecution!.params;
    assert.equal(params.skill, "peer-comparison");
    assert.deepEqual(params.customSkills, ["peer-comparison"]);
    assert.equal(params.mode, "advanced");
  });

  it("/dcf RELIANCE → skill=dcf-valuation + customSkills=[dcf-valuation] + advanced", () => {
    const result = execShortcut("/dcf RELIANCE");
    const params = result.toolExecution!.params;
    assert.equal(params.skill, "dcf-valuation");
    assert.deepEqual(params.customSkills, ["dcf-valuation"]);
    assert.equal(params.mode, "advanced");
  });

  it("/thesis BAJFINANCE → skill=investment-thesis + customSkills + advanced", () => {
    const result = execShortcut("/thesis BAJFINANCE");
    const params = result.toolExecution!.params;
    assert.equal(params.skill, "investment-thesis");
    assert.deepEqual(params.customSkills, ["investment-thesis"]);
    assert.equal(params.mode, "advanced");
  });

  it("/earnings TCS → skill=earnings-analysis + customSkills + advanced", () => {
    const result = execShortcut("/earnings TCS");
    const params = result.toolExecution!.params;
    assert.equal(params.skill, "earnings-analysis");
    assert.deepEqual(params.customSkills, ["earnings-analysis"]);
    assert.equal(params.mode, "advanced");
  });

  it("/technical NIFTY → skill=stock-analysis + customSkills + advanced", () => {
    const result = execShortcut("/technical NIFTY");
    const params = result.toolExecution!.params;
    assert.equal(params.skill, "stock-analysis");
    assert.deepEqual(params.customSkills, ["stock-analysis"]);
    assert.equal(params.mode, "advanced");
  });

  it("/news RELIANCE → get_stock_news with symbol", () => {
    const result = execShortcut("/news RELIANCE");
    assert.equal(result.toolExecution?.tool, "get_stock_news");
    assert.equal(result.toolExecution?.params.symbol, "RELIANCE");
  });

  it("uppercases the symbol regardless of input casing", () => {
    const result = execShortcut("/dcf reliance");
    assert.deepEqual(result.toolExecution?.params.symbols, ["RELIANCE"]);
  });

  it("auto-fills query as 'Analyze SYMBOL' when only symbol is given", () => {
    const result = execShortcut("/deep TCS");
    assert.equal(result.toolExecution?.params.query, "Analyze TCS");
  });
});

describe("MONEY-223 - /focus command (client-side preference write)", () => {
  it("returns set_focus action with the trimmed text payload", () => {
    const result = execShortcut("/focus margin expansion + AI exposure");
    assert.equal(result.action, "set_focus");
    assert.equal(result.handled, true);
    assert.equal(result.focusText, "margin expansion + AI exposure");
  });

  it("returns empty focusText when /focus has no args (clear)", () => {
    const result = execShortcut("/focus");
    assert.equal(result.action, "set_focus");
    assert.equal(result.focusText, "");
  });

  it("trims whitespace around the focus text", () => {
    const result = execShortcut("/focus    margin expansion   ");
    assert.equal(result.focusText, "margin expansion");
  });
});

describe("MONEY-223 - alias coverage", () => {
  it("/valuation aliases to /dcf", () => {
    assert.equal(findCommand("valuation")?.name, "dcf");
  });

  it("/chart and /ta alias to /technical", () => {
    assert.equal(findCommand("chart")?.name, "technical");
    assert.equal(findCommand("ta")?.name, "technical");
  });
});
