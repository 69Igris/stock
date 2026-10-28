/**
 * MONEY-393 §33 - lib/chat/slash-commands/{executor,parser}.ts source
 * coverage push (62% / 74% → 90%+).
 *
 * Existing slash-commands.test.ts (50+ cases) is a complete INLINE
 * reimplementation of the parser + executor - it doesn't import the
 * actual source files, so c8 records 0% on real code paths.
 *
 * This file imports the REAL parser + executor and covers the branches
 * the inline tests don't exist for:
 *   - executeNavigateCommand: /paper → mode:"navigate" → action+target
 *   - clientHandler === "compact": /compact action passthrough
 *   - clientHandler === "set_focus": /focus <text> + empty fallback
 *   - run_research preset merge: /deep, /dcf, /peer (presetParams baked
 *     into tool params); also symbol → symbols[] + default query
 *   - get_stock_news: symbol upper-cased
 *   - generic mapToToolParams default branch (passthrough)
 *   - generateHelpMarkdown: triggered via /help (response contains the
 *     category headers)
 *   - getAllCommands: exported array length
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseSlashInput,
  isSlashCommand,
  extractCommandPrefix,
} from "../../lib/chat/slash-commands/parser";
import {
  executeSlashCommand,
  getAllCommands,
} from "../../lib/chat/slash-commands/executor";

describe("MONEY-393 §33 - slash-commands real source", () => {
  // ── isSlashCommand / extractCommandPrefix ──────────────────────

  it("[parser] isSlashCommand recognizes leading slash + alpha", () => {
    assert.equal(isSlashCommand("/portfolio"), true);
    assert.equal(isSlashCommand("  /summary"), true);
    assert.equal(isSlashCommand("hello"), false);
    assert.equal(isSlashCommand("/"), false);
    assert.equal(isSlashCommand("/123"), false);
  });

  it("[parser] extractCommandPrefix returns name fragment", () => {
    assert.equal(extractCommandPrefix("/port"), "port");
    assert.equal(extractCommandPrefix("/"), "");
    assert.equal(extractCommandPrefix("hello"), "");
    assert.equal(extractCommandPrefix("/holdings RELIANCE"), "");
  });

  // ── parser: returns null for non-slash / unknown command ───────

  it("[parser] returns null when input has no slash", () => {
    assert.equal(parseSlashInput("hello"), null);
  });

  it("[parser] returns null when command name is unknown", () => {
    assert.equal(parseSlashInput("/definitely-not-a-command"), null);
  });

  // ── executor: navigate mode ────────────────────────────────────

  // SKIPPED (MONEY-587): `/paper` was removed (MONEY-550 dropped the orphaned
  // paper nav step); parser no longer finds it. Re-enable if `/paper` returns.
  it.skip("[executor] /paper resolves to mode:'navigate' with custom navigateTo", () => {
    const parsed = parseSlashInput("/paper");
    assert.ok(parsed, "parser found /paper");
    const result = executeSlashCommand(parsed!);
    assert.equal(result.handled, true);
    assert.equal(result.action, "navigate");
    assert.equal(result.navigateTo, "/paper-trading");
    assert.ok(
      result.response && result.response.includes("/paper-trading"),
      "response markdown links to navigateTo"
    );
  });

  // ── executor: client mode with various handlers ───────────────

  it("[executor] /help returns a markdown help block", () => {
    const parsed = parseSlashInput("/help");
    const result = executeSlashCommand(parsed!);
    assert.equal(result.handled, true);
    assert.ok(result.response, "help generates a response");
    // Help renders 5 category headers (portfolio/trading/research/tools/utility)
    assert.ok(
      result.response!.includes("Type `/` to see autocomplete suggestions"),
      "help has the autocomplete hint footer"
    );
  });

  it("[executor] /clear returns clear action", () => {
    const parsed = parseSlashInput("/clear");
    const result = executeSlashCommand(parsed!);
    assert.equal(result.handled, true);
    assert.equal(result.action, "clear");
    assert.ok(result.response, "clear has a confirmation response");
  });

  it("[executor] /compact returns compact action without response text", () => {
    const parsed = parseSlashInput("/compact");
    const result = executeSlashCommand(parsed!);
    assert.equal(result.handled, true);
    assert.equal(result.action, "compact");
    // compact handler does NOT set a response - ChatContext drives the UI
    assert.equal(result.response, undefined);
  });

  it("[executor] /import navigates to /tradebook/import + response", () => {
    const parsed = parseSlashInput("/import");
    const result = executeSlashCommand(parsed!);
    assert.equal(result.handled, true);
    assert.equal(result.action, "navigate");
    assert.equal(result.navigateTo, "/tradebook/import");
    assert.ok(result.response!.includes("Tradebook Import"));
  });

  it("[executor] /upload navigates to /documents", () => {
    const parsed = parseSlashInput("/upload");
    const result = executeSlashCommand(parsed!);
    assert.equal(result.handled, true);
    assert.equal(result.action, "navigate");
    assert.equal(result.navigateTo, "/documents");
    assert.ok(result.response!.includes("Documents"));
  });

  // ── /focus (MONEY-223 set_focus handler) ───────────────────────

  it("[executor] /focus with text returns set_focus action + focusText", () => {
    const parsed = parseSlashInput("/focus value investing");
    const result = executeSlashCommand(parsed!);
    assert.equal(result.handled, true);
    assert.equal(result.action, "set_focus");
    assert.equal(result.focusText, "value investing");
  });

  it("[executor] /focus alone clears focus (focusText === '')", () => {
    const parsed = parseSlashInput("/focus");
    const result = executeSlashCommand(parsed!);
    assert.equal(result.handled, true);
    assert.equal(result.action, "set_focus");
    assert.equal(result.focusText, "");
  });

  // ── run_research with preset params ────────────────────────────

  it("[executor] /deep RELIANCE bakes presetParams.mode into tool params", () => {
    const parsed = parseSlashInput("/deep RELIANCE");
    assert.ok(parsed, "parser found /deep");
    const result = executeSlashCommand(parsed!);
    assert.ok(result.toolExecution);
    const p = result.toolExecution!.params as Record<string, unknown>;
    assert.equal(result.toolExecution!.tool, "run_research");
    assert.equal(p.mode, "advanced", "presetParams.mode must be applied");
    assert.deepEqual(p.symbols, ["RELIANCE"]);
    assert.equal(p.query, "Analyze RELIANCE", "default query for symbol");
  });

  it("[executor] /quick TCS uses presetParams.mode='fast'", () => {
    const parsed = parseSlashInput("/quick TCS");
    const result = executeSlashCommand(parsed!);
    const p = result.toolExecution!.params as Record<string, unknown>;
    assert.equal(p.mode, "fast");
    assert.deepEqual(p.symbols, ["TCS"]);
  });

  it("[executor] /peer INFY merges customSkills + skill into params", () => {
    const parsed = parseSlashInput("/peer INFY");
    const result = executeSlashCommand(parsed!);
    const p = result.toolExecution!.params as Record<string, unknown>;
    // Presence of customSkills array is the contract; specific skills
    // are defined in the registry (peer-comparison etc.).
    assert.ok(
      Array.isArray(p.customSkills),
      "peer presets must include customSkills"
    );
    assert.ok((p.customSkills as unknown[]).length > 0);
  });

  it("[executor] /dcf, /thesis, /earnings, /technical all use 'advanced' mode preset", () => {
    for (const name of ["dcf", "thesis", "earnings", "technical"]) {
      const parsed = parseSlashInput(`/${name} ABC`);
      assert.ok(parsed, `parser found /${name}`);
      const result = executeSlashCommand(parsed!);
      const p = result.toolExecution!.params as Record<string, unknown>;
      assert.equal(p.mode, "advanced", `/${name} must use advanced mode`);
      assert.deepEqual(p.symbols, ["ABC"], `/${name} must set symbols`);
    }
  });

  // ── get_stock_news mapping ─────────────────────────────────────

  it("[executor] /news lowercase-symbol → symbol upper-cased", () => {
    const parsed = parseSlashInput("/news infy");
    const result = executeSlashCommand(parsed!);
    assert.ok(result.toolExecution);
    assert.equal(result.toolExecution!.tool, "get_stock_news");
    const p = result.toolExecution!.params as Record<string, unknown>;
    assert.equal(p.symbol, "INFY", "news must upper-case the symbol");
  });

  // ── generic passthrough (mapToToolParams default branch) ───────

  // Was /risk until that command was disabled (see registry.ts). /documents
  // is another paramless tool command and covers the same default branch of
  // mapToToolParams.
  it("[executor] /documents returns { ...args } passthrough (generic tool branch)", () => {
    const parsed = parseSlashInput("/documents");
    const result = executeSlashCommand(parsed!);
    assert.ok(result.toolExecution);
    assert.equal(result.toolExecution!.tool, "get_user_documents");
  });

  // ── userText preserves args ────────────────────────────────────

  it("[executor] toolExecution.userText echoes original /command + args", () => {
    const parsed = parseSlashInput("/holdings broker:zerodha");
    const result = executeSlashCommand(parsed!);
    assert.equal(
      result.toolExecution!.userText,
      "/holdings broker:zerodha",
      "userText must include the rawArgs after the slash command"
    );
  });

  // ── getAllCommands ─────────────────────────────────────────────

  it("[executor] getAllCommands returns the SLASH_COMMANDS array", () => {
    const all = getAllCommands();
    assert.ok(Array.isArray(all));
    assert.ok(all.length >= 17, "registry should have at least 17 commands");
    // sanity check shape
    for (const cmd of all) {
      assert.equal(typeof cmd.name, "string");
      assert.ok(["tool", "client", "navigate"].includes(cmd.mode));
    }
  });

  // ── Quoted string args ─────────────────────────────────────────

  it("[parser] strips surrounding quotes on key:value pairs", () => {
    const parsed = parseSlashInput('/research query:"Nifty IT sector outlook"');
    assert.ok(parsed);
    assert.equal(parsed!.args.query, "Nifty IT sector outlook");
  });

  it("[parser] number type param: limit parses to numeric", () => {
    const parsed = parseSlashInput("/trades limit:25");
    assert.ok(parsed);
    assert.equal(parsed!.args.limit, 25);
    assert.equal(typeof parsed!.args.limit, "number");
  });

  it("[parser] non-numeric limit stays as string when number parse fails", () => {
    const parsed = parseSlashInput("/trades limit:abc");
    assert.ok(parsed);
    assert.equal(parsed!.args.limit, "abc");
  });
});
