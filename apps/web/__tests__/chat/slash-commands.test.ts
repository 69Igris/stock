/**
 * Slash Commands Tests (de-shadowed — MONEY-620)
 *
 * Asserts the REAL exported symbols from the slash-command source modules.
 * Covers:
 * - Registry: SLASH_COMMANDS table, findCommand, searchCommands,
 *   getCommandsByCategory, CATEGORY_META
 * - Parser: isSlashCommand, extractCommandPrefix, parseSlashInput (+ tokenizer
 *   and arg-parsing behaviour exercised through parseSlashInput)
 * - Executor: executeSlashCommand routing (tool / client / navigate),
 *   getAllCommands
 * - Negative / edge / prototype-pollution / deterministic-dispatch regressions
 *
 * HISTORY: this file used to be a full SHADOW — it re-declared the entire
 * registry + parser + executor inline (a stale copy: 17 commands incl. a
 * `/paper` that no longer exists) and asserted the copy, so c8 recorded 0% on
 * the real code paths. The source modules are pure & import-safe (no Prisma /
 * next/headers / GCS at module load), so we assert the real exports directly —
 * no `*-logic.ts` extraction needed. See `.claude/skills/writing-tests`.
 *
 * Source: apps/web/lib/chat/slash-commands/registry.ts
 *         apps/web/lib/chat/slash-commands/parser.ts
 *         apps/web/lib/chat/slash-commands/executor.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SLASH_COMMANDS,
  findCommand,
  searchCommands,
  getCommandsByCategory,
  formatParamToken,
  formatUsage,
  CATEGORY_META,
  type SlashCommand,
  type SlashCommandCategory,
} from "@/lib/chat/slash-commands/registry";
import {
  parseSlashInput,
  isSlashCommand,
  extractCommandPrefix,
} from "@/lib/chat/slash-commands/parser";
import {
  executeSlashCommand,
  getAllCommands,
} from "@/lib/chat/slash-commands/executor";

// ── Ground-truth snapshot of the REAL registry (pinned 2026-06-05) ──
// If the registry changes, these MUST be updated deliberately — that is the
// point: registry drift is caught here instead of silently shipping.
const EXPECTED_COMMAND_NAMES = [
  "portfolio",
  "holdings",
  "positions",
  "trades",
  "mutualfunds",
  "fire",
  "research",
  "deep",
  "quick",
  "peer",
  "dcf",
  "thesis",
  "earnings",
  "technical",
  "news",
  "focus",
  "quote",
  // "risk" + "tax" DISABLED — commented out in the registry. Their absence is
  // asserted explicitly below so re-enabling one is a deliberate act, not an
  // accident.
  "documents",
  "report",
  "import",
  "upload",
  "help",
  "clear",
  "compact",
];

/** Commands deliberately commented out of the registry. */
const DISABLED_COMMAND_NAMES = ["risk", "tax"];

const EXPECTED_CATEGORY_COUNTS: Record<SlashCommandCategory, number> = {
  portfolio: 5,
  trading: 1,
  research: 11,
  // 4 → 2: /risk and /tax were the other two "tools" entries.
  tools: 2,
  utility: 5,
};

const EXPECTED_ALIASES: Record<string, string> = {
  summary: "portfolio",
  dashboard: "portfolio",
  mf: "mutualfunds",
  funds: "mutualfunds",
  retire: "fire",
  valuation: "dcf",
  chart: "technical",
  ta: "technical",
  price: "quote",
  stock: "quote",
  docs: "documents",
};

describe("Slash Commands (real source)", () => {
  // ═══════════════════ Registry Tests ═══════════════════

  describe("Registry — command table", () => {
    it("pins the EXACT registered command set (count + names + order)", () => {
      assert.deepStrictEqual(
        SLASH_COMMANDS.map((c) => c.name),
        EXPECTED_COMMAND_NAMES,
        "registered slash-command set drifted from the pinned snapshot"
      );
      assert.strictEqual(SLASH_COMMANDS.length, EXPECTED_COMMAND_NAMES.length);
    });

    it("keeps the disabled commands unregistered and unreachable", () => {
      for (const name of DISABLED_COMMAND_NAMES) {
        assert.ok(
          !SLASH_COMMANDS.some((c) => c.name === name),
          `/${name} is disabled and must not be registered`
        );
        assert.strictEqual(
          findCommand(name),
          undefined,
          `findCommand('${name}') must miss so parseSlashInput returns null`
        );
        assert.strictEqual(
          parseSlashInput(`/${name}`),
          null,
          `/${name} must fall through to normal chat, not dispatch a tool`
        );
      }
    });

    it("matches the exact per-category counts", () => {
      const counts: Record<string, number> = {};
      for (const c of SLASH_COMMANDS) {
        counts[c.category] = (counts[c.category] ?? 0) + 1;
      }
      assert.deepStrictEqual(counts, EXPECTED_CATEGORY_COUNTS);
    });

    it("has unique command names (no collisions)", () => {
      const names = SLASH_COMMANDS.map((c) => c.name);
      assert.strictEqual(new Set(names).size, names.length);
    });

    it("every command has at least one example", () => {
      for (const cmd of SLASH_COMMANDS) {
        assert.ok(cmd.examples.length > 0, `${cmd.name} should have examples`);
      }
    });

    it("every tool-mode command declares a toolName", () => {
      for (const cmd of SLASH_COMMANDS.filter((c) => c.mode === "tool")) {
        assert.ok(cmd.toolName, `${cmd.name} (tool) must have toolName`);
      }
    });

    it("every client-mode command declares a clientHandler", () => {
      for (const cmd of SLASH_COMMANDS.filter((c) => c.mode === "client")) {
        assert.ok(
          cmd.clientHandler,
          `${cmd.name} (client) must have clientHandler`
        );
      }
    });

    it("mode is always one of tool | client | navigate", () => {
      for (const cmd of SLASH_COMMANDS) {
        assert.ok(
          ["tool", "client", "navigate"].includes(cmd.mode),
          `${cmd.name} has invalid mode ${cmd.mode}`
        );
      }
    });

    it("no alias collides with a primary command name", () => {
      const names = new Set(SLASH_COMMANDS.map((c) => c.name));
      for (const cmd of SLASH_COMMANDS) {
        for (const alias of cmd.aliases ?? []) {
          assert.ok(
            !names.has(alias),
            `alias '${alias}' on /${cmd.name} collides with a command name`
          );
        }
      }
    });

    it("no alias is registered twice across commands", () => {
      const seen = new Set<string>();
      for (const cmd of SLASH_COMMANDS) {
        for (const alias of cmd.aliases ?? []) {
          assert.ok(!seen.has(alias), `alias '${alias}' is registered twice`);
          seen.add(alias);
        }
      }
    });
  });

  describe("Registry — findCommand", () => {
    it("finds a command by exact name", () => {
      assert.strictEqual(findCommand("portfolio")?.name, "portfolio");
    });

    it("finds every registered command by its own name", () => {
      for (const cmd of SLASH_COMMANDS) {
        assert.strictEqual(
          findCommand(cmd.name)?.name,
          cmd.name,
          `findCommand('${cmd.name}') must resolve to itself`
        );
      }
    });

    it("resolves every registered alias to its owning command", () => {
      for (const [alias, owner] of Object.entries(EXPECTED_ALIASES)) {
        assert.strictEqual(
          findCommand(alias)?.name,
          owner,
          `alias '${alias}' must resolve to /${owner}`
        );
      }
    });

    it("is case-insensitive for names and aliases", () => {
      assert.strictEqual(findCommand("PORTFOLIO")?.name, "portfolio");
      assert.strictEqual(findCommand("MuTuAlFuNdS")?.name, "mutualfunds");
      assert.strictEqual(findCommand("MF")?.name, "mutualfunds");
      assert.strictEqual(findCommand("Price")?.name, "quote");
    });

    it("returns undefined for an unknown command", () => {
      assert.strictEqual(findCommand("nonexistent"), undefined);
    });

    it("returns undefined for a misspelled command", () => {
      assert.strictEqual(findCommand("portfollio"), undefined);
      assert.strictEqual(findCommand("holdngs"), undefined);
    });

    it("returns undefined for empty / whitespace name", () => {
      assert.strictEqual(findCommand(""), undefined);
      assert.strictEqual(findCommand("   "), undefined);
    });

    // ── Prototype-pollution-style lookup regression ──
    // findCommand MUST do an own-property (Map) lookup, never `obj[name]`
    // against a plain object — otherwise `/toString`, `/constructor`, etc.
    // would resolve to an inherited Function and break dispatch. This exact
    // class of bug existed historically in getTool().
    it("does NOT resolve Object.prototype keys to inherited methods", () => {
      for (const key of [
        "toString",
        "constructor",
        "hasOwnProperty",
        "valueOf",
        "__proto__",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "toLocaleString",
        "prototype",
      ]) {
        const result = findCommand(key);
        assert.strictEqual(
          result,
          undefined,
          `findCommand('${key}') must be undefined, got ${typeof result}`
        );
      }
    });
  });

  describe("Registry — searchCommands", () => {
    it("returns the full set for an empty query", () => {
      assert.strictEqual(searchCommands("").length, SLASH_COMMANDS.length);
    });

    it("matches by partial name", () => {
      assert.ok(searchCommands("hold").some((c) => c.name === "holdings"));
    });

    it("matches by description keyword (case-insensitive)", () => {
      assert.ok(searchCommands("STOCK").some((c) => c.name === "holdings"));
    });

    it("matches by alias", () => {
      assert.ok(searchCommands("mf").some((c) => c.name === "mutualfunds"));
    });

    // Was "capital gains" → /tax until that command was disabled. Still a
    // MULTI-WORD phrase that appears only in a description, never in a
    // command name or alias — that is the branch under test.
    it("matches 'downloadable pdf' inside the report description", () => {
      assert.ok(
        searchCommands("downloadable pdf").some((c) => c.name === "report")
      );
    });

    it("returns empty for a no-match query", () => {
      assert.strictEqual(searchCommands("zzzzzzzzz").length, 0);
    });
  });

  describe("Registry — getCommandsByCategory & CATEGORY_META", () => {
    it("returns exactly the five known categories", () => {
      const grouped = getCommandsByCategory();
      assert.deepStrictEqual(Object.keys(grouped).sort(), [
        "portfolio",
        "research",
        "tools",
        "trading",
        "utility",
      ]);
    });

    it("groups counts that match the pinned per-category snapshot", () => {
      const grouped = getCommandsByCategory();
      for (const [cat, count] of Object.entries(EXPECTED_CATEGORY_COUNTS)) {
        assert.strictEqual(
          grouped[cat as SlashCommandCategory].length,
          count,
          `category ${cat} count mismatch`
        );
      }
    });

    it("total grouped commands equals SLASH_COMMANDS length", () => {
      const grouped = getCommandsByCategory();
      const total = Object.values(grouped).reduce((s, c) => s + c.length, 0);
      assert.strictEqual(total, SLASH_COMMANDS.length);
    });

    it("CATEGORY_META has a label + color for every category", () => {
      for (const cat of Object.keys(
        getCommandsByCategory()
      ) as SlashCommandCategory[]) {
        assert.ok(CATEGORY_META[cat].label, `${cat} needs a label`);
        assert.ok(CATEGORY_META[cat].color, `${cat} needs a color`);
      }
    });
  });

  // ═══════════════════ Parser Tests ═══════════════════

  describe("Parser — isSlashCommand", () => {
    it("accepts /command and /c", () => {
      assert.strictEqual(isSlashCommand("/portfolio"), true);
      assert.strictEqual(isSlashCommand("/h"), true);
    });

    it("accepts leading/trailing whitespace around a command", () => {
      assert.strictEqual(isSlashCommand("  /portfolio  "), true);
    });

    it("rejects plain text", () => {
      assert.strictEqual(isSlashCommand("hello"), false);
    });

    it("rejects empty string", () => {
      assert.strictEqual(isSlashCommand(""), false);
    });

    it("rejects '/' alone", () => {
      assert.strictEqual(isSlashCommand("/"), false);
    });

    it("rejects '/' followed by a digit", () => {
      assert.strictEqual(isSlashCommand("/123"), false);
    });

    it("rejects '/' followed by a space", () => {
      assert.strictEqual(isSlashCommand("/ hello"), false);
    });

    it("rejects '/' followed by a non-alpha symbol", () => {
      assert.strictEqual(isSlashCommand("/_x"), false);
      assert.strictEqual(isSlashCommand("/-x"), false);
    });
  });

  describe("Parser — extractCommandPrefix", () => {
    it("extracts the name fragment from a partial input", () => {
      assert.strictEqual(extractCommandPrefix("/port"), "port");
      assert.strictEqual(extractCommandPrefix("/holdings"), "holdings");
    });

    it("returns '' for '/'", () => {
      assert.strictEqual(extractCommandPrefix("/"), "");
    });

    it("returns '' for non-slash input", () => {
      assert.strictEqual(extractCommandPrefix("hello"), "");
    });

    it("returns '' once args are present (no longer a bare prefix)", () => {
      assert.strictEqual(extractCommandPrefix("/holdings RELIANCE"), "");
      assert.strictEqual(extractCommandPrefix("/holdings x"), "");
    });

    it("trims surrounding whitespace before matching", () => {
      assert.strictEqual(extractCommandPrefix("  /tax  "), "tax");
    });
  });

  describe("Parser — parseSlashInput", () => {
    it("parses a bare command into {} args", () => {
      const r = parseSlashInput("/portfolio");
      assert.ok(r);
      assert.strictEqual(r.command.name, "portfolio");
      assert.deepStrictEqual(r.args, {});
      assert.strictEqual(r.rawArgs, "");
    });

    it("parses a named arg key:value", () => {
      const r = parseSlashInput("/holdings broker:zerodha");
      assert.strictEqual(r?.args.broker, "zerodha");
    });

    it("assigns a positional value to the first REQUIRED param", () => {
      const r = parseSlashInput("/research RELIANCE");
      assert.strictEqual(r?.args.query, "RELIANCE");
    });

    it("assigns a positional value to the first optional string param when no required", () => {
      const r = parseSlashInput("/holdings RELIANCE");
      assert.strictEqual(r?.args.broker, "RELIANCE");
    });

    it("mixes positional + named args", () => {
      const r = parseSlashInput("/research RELIANCE mode:advanced");
      assert.strictEqual(r?.args.query, "RELIANCE");
      assert.strictEqual(r?.args.mode, "advanced");
    });

    it("coerces a number-typed param", () => {
      const r = parseSlashInput("/trades limit:10");
      assert.strictEqual(r?.args.limit, 10);
      assert.strictEqual(typeof r?.args.limit, "number");
    });

    it("leaves a non-numeric value as a string when number parse fails", () => {
      const r = parseSlashInput("/trades limit:abc");
      assert.strictEqual(r?.args.limit, "abc");
    });

    it("strips surrounding double quotes from a value", () => {
      const r = parseSlashInput('/research query:"Nifty IT sector outlook"');
      assert.strictEqual(r?.args.query, "Nifty IT sector outlook");
    });

    it("strips surrounding single quotes from a value", () => {
      const r = parseSlashInput("/research query:'Bank Nifty view'");
      assert.strictEqual(r?.args.query, "Bank Nifty view");
    });

    it("joins multi-word positional args into the required param", () => {
      const r = parseSlashInput("/research Nifty IT sector outlook");
      assert.strictEqual(r?.args.query, "Nifty IT sector outlook");
    });

    it("resolves aliases through the parser", () => {
      assert.strictEqual(
        parseSlashInput("/summary")?.command.name,
        "portfolio"
      );
      assert.strictEqual(parseSlashInput("/mf")?.command.name, "mutualfunds");
      const price = parseSlashInput("/price RELIANCE.NS");
      assert.strictEqual(price?.command.name, "quote");
      assert.strictEqual(price?.args.symbol, "RELIANCE.NS");
    });

    it("is case-insensitive for the command name", () => {
      assert.strictEqual(
        parseSlashInput("/PORTFOLIO")?.command.name,
        "portfolio"
      );
    });

    it("trims surrounding whitespace on the whole input", () => {
      assert.strictEqual(
        parseSlashInput("  /portfolio  ")?.command.name,
        "portfolio"
      );
    });

    // ── Negative / malformed input — must return null, never throw ──
    it("returns null for an unknown command", () => {
      assert.strictEqual(parseSlashInput("/nonexistent"), null);
    });

    it("returns null for a misspelled command", () => {
      assert.strictEqual(parseSlashInput("/portfollio"), null);
    });

    it("returns null for non-slash input", () => {
      assert.strictEqual(parseSlashInput("hello world"), null);
    });

    it("returns null for empty / whitespace-only / '/' inputs", () => {
      assert.strictEqual(parseSlashInput(""), null);
      assert.strictEqual(parseSlashInput("   "), null);
      assert.strictEqual(parseSlashInput("/"), null);
      assert.strictEqual(parseSlashInput("/ "), null);
      assert.strictEqual(parseSlashInput("/ hello"), null);
      assert.strictEqual(parseSlashInput("/123"), null);
    });

    // ── Prototype-pollution-style command names must be "unknown" ──
    it("returns null for Object.prototype-key command names", () => {
      for (const key of [
        "/toString",
        "/constructor",
        "/hasOwnProperty",
        "/valueOf",
        "/__proto__",
        "/isPrototypeOf",
      ]) {
        assert.strictEqual(
          parseSlashInput(key),
          null,
          `${key} must parse to null (unknown), not a prototype method`
        );
      }
    });

    // ── Adversarial args must not crash the parser ──
    it("does not crash on a very long positional arg", () => {
      const long = "X".repeat(10_000);
      const r = parseSlashInput(`/research ${long}`);
      assert.strictEqual((r?.args.query as string).length, 10_000);
    });

    it("preserves unicode in args", () => {
      const r = parseSlashInput("/research 日本語 テスト");
      assert.strictEqual(r?.args.query, "日本語 テスト");
    });

    it("keeps colons inside a quoted value intact", () => {
      const r = parseSlashInput('/research query:"a:b c:d"');
      assert.strictEqual(r?.args.query, "a:b c:d");
    });

    it("treats a trailing-colon token as positional (known edge)", () => {
      // `broker:` has the colon at the END, so it is NOT a key:value pair;
      // it falls through to the first optional string param verbatim.
      const r = parseSlashInput("/holdings broker:");
      assert.deepStrictEqual(r?.args, { broker: "broker:" });
    });

    it("ignores extra/unexpected positional args on a no-param command", () => {
      const r = parseSlashInput("/portfolio extra unexpected stuff");
      assert.ok(r);
      assert.deepStrictEqual(r.args, {});
      assert.strictEqual(r.rawArgs, "extra unexpected stuff");
    });

    // ── Determinism: same input → same command, every time ──
    it("is deterministic — identical input yields the identical command", () => {
      const inputs = ["/portfolio", "/holdings broker:zerodha", "/deep TCS"];
      for (const input of inputs) {
        const a = parseSlashInput(input);
        const b = parseSlashInput(input);
        assert.strictEqual(a?.command.name, b?.command.name);
        assert.deepStrictEqual(a?.args, b?.args);
      }
    });
  });

  // ═══════════════════ Executor Tests ═══════════════════

  describe("Executor — tool commands", () => {
    function exec(input: string) {
      const parsed = parseSlashInput(input);
      assert.ok(parsed, `parser should accept ${input}`);
      return executeSlashCommand(parsed);
    }

    it("routes /portfolio to get_portfolio_summary (needs ChatContext → handled:false)", () => {
      const r = exec("/portfolio");
      assert.strictEqual(r.handled, false);
      assert.strictEqual(r.toolExecution?.tool, "get_portfolio_summary");
      assert.strictEqual(r.toolExecution?.userText, "/portfolio");
    });

    it("passes /holdings named args through", () => {
      const r = exec("/holdings broker:zerodha");
      assert.strictEqual(r.toolExecution?.tool, "get_holdings");
      assert.strictEqual(r.toolExecution?.params.broker, "zerodha");
    });

    it("maps /trades type → tradeType and injects skip:0", () => {
      const r = exec("/trades type:BUY limit:10");
      const p = r.toolExecution!.params;
      assert.strictEqual(r.toolExecution?.tool, "get_trades");
      assert.strictEqual(p.tradeType, "BUY");
      assert.strictEqual(p.limit, 10);
      assert.strictEqual(p.skip, 0);
      assert.strictEqual(p.type, undefined, "original 'type' must not leak");
    });

    it("routes /quote with an upper-case-preserved symbol", () => {
      const r = exec("/quote RELIANCE.NS");
      assert.strictEqual(r.toolExecution?.tool, "get_financial_data");
      assert.strictEqual(r.toolExecution?.params.symbol, "RELIANCE.NS");
    });

    it("routes /research with query + mode", () => {
      const r = exec("/research TCS mode:advanced");
      assert.strictEqual(r.toolExecution?.tool, "run_research");
      assert.strictEqual(r.toolExecution?.params.query, "TCS");
      assert.strictEqual(r.toolExecution?.params.mode, "advanced");
    });

    // DISABLED with the `/tax` command — the tax_report branch of
    // mapToToolParams is commented out too. Restore both together.
    // it("routes /tax fy through", () => {
    //   const r = exec("/tax fy:2025-26");
    //   assert.strictEqual(r.toolExecution?.tool, "tax_report");
    //   assert.strictEqual(r.toolExecution?.params.fy, "2025-26");
    // });

    // `/report tax` is a separate, still-live command and keeps its own
    // fy passthrough — proof the disable did not over-reach.
    it("routes /report type through", () => {
      const r = exec("/report tax");
      assert.strictEqual(r.toolExecution?.tool, "generate_report");
      assert.strictEqual(r.toolExecution?.params.type, "tax");
    });

    it("echoes the original command + args in userText", () => {
      const r = exec("/trades type:BUY");
      assert.strictEqual(r.toolExecution?.userText, "/trades type:BUY");
    });

    it("refuses to dispatch a tool command missing its required arg", () => {
      // CONTRACT CHANGE (MONEY-1119). This case previously asserted the
      // opposite — that /report emitted generate_report with empty params and
      // let "downstream validation" handle it. No such validation existed, so
      // under-specified commands ran, failed, and burned credits (reported in
      // the MONEY-1095 bug doc as "Should not have run"). The executor now
      // answers locally instead of dispatching; it still must not throw.
      const r = exec("/report");
      assert.strictEqual(r.toolExecution, undefined);
      assert.strictEqual(r.handled, true);
      assert.ok(r.response?.includes("**Usage:**"));
    });

    it("dispatch is deterministic for a registered tool command", () => {
      const a = exec("/holdings broker:zerodha");
      const b = exec("/holdings broker:zerodha");
      assert.strictEqual(a.toolExecution?.tool, b.toolExecution?.tool);
      assert.deepStrictEqual(a.toolExecution?.params, b.toolExecution?.params);
    });
  });

  describe("Executor — research-shortcut preset merge", () => {
    function exec(input: string) {
      return executeSlashCommand(parseSlashInput(input)!);
    }

    it("/deep bakes presetParams.mode='advanced' + default query + symbols[]", () => {
      const p = exec("/deep RELIANCE").toolExecution!.params;
      assert.strictEqual(p.mode, "advanced");
      assert.deepStrictEqual(p.symbols, ["RELIANCE"]);
      assert.strictEqual(p.query, "Analyze RELIANCE");
    });

    it("/quick uses presetParams.mode='fast'", () => {
      assert.strictEqual(exec("/quick TCS").toolExecution!.params.mode, "fast");
    });

    it("/peer merges skill + customSkills + advanced", () => {
      const p = exec("/peer HDFCBANK").toolExecution!.params;
      assert.strictEqual(p.skill, "peer-comparison");
      assert.deepStrictEqual(p.customSkills, ["peer-comparison"]);
      assert.strictEqual(p.mode, "advanced");
    });

    it("upper-cases the symbol regardless of input casing", () => {
      const p = exec("/dcf reliance").toolExecution!.params;
      assert.deepStrictEqual(p.symbols, ["RELIANCE"]);
    });

    it("/news upper-cases the symbol and routes to get_stock_news", () => {
      const r = exec("/news infy");
      assert.strictEqual(r.toolExecution?.tool, "get_stock_news");
      assert.strictEqual(r.toolExecution?.params.symbol, "INFY");
    });
  });

  describe("Executor — client commands", () => {
    function exec(input: string) {
      return executeSlashCommand(parseSlashInput(input)!);
    }

    it("/help is fully handled and lists every category header + footer", () => {
      const r = exec("/help");
      assert.strictEqual(r.handled, true);
      assert.ok(r.response);
      for (const cat of Object.keys(
        getCommandsByCategory()
      ) as SlashCommandCategory[]) {
        const label = CATEGORY_META[cat].label;
        assert.ok(
          r.response!.includes(`**${label}**`),
          `help must include the '${label}' header`
        );
      }
      assert.ok(
        r.response!.includes("Type `/` to see autocomplete suggestions")
      );
    });

    it("/help output is deterministic", () => {
      assert.strictEqual(exec("/help").response, exec("/help").response);
    });

    it("/clear returns action:clear + a confirmation response", () => {
      const r = exec("/clear");
      assert.strictEqual(r.handled, true);
      assert.strictEqual(r.action, "clear");
      assert.ok(r.response);
    });

    it("/compact returns action:compact with NO response text", () => {
      const r = exec("/compact");
      assert.strictEqual(r.handled, true);
      assert.strictEqual(r.action, "compact");
      assert.strictEqual(r.response, undefined);
    });

    it("/import navigates to /tradebook/import", () => {
      const r = exec("/import");
      assert.strictEqual(r.handled, true);
      assert.strictEqual(r.action, "navigate");
      assert.strictEqual(r.navigateTo, "/tradebook/import");
      assert.ok(r.response!.includes("Tradebook Import"));
    });

    it("/upload navigates to /documents", () => {
      const r = exec("/upload");
      assert.strictEqual(r.handled, true);
      assert.strictEqual(r.action, "navigate");
      assert.strictEqual(r.navigateTo, "/documents");
      assert.ok(r.response!.includes("Documents"));
    });

    it("/focus <text> returns set_focus with trimmed focusText", () => {
      const r = exec("/focus    margin expansion   ");
      assert.strictEqual(r.handled, true);
      assert.strictEqual(r.action, "set_focus");
      assert.strictEqual(r.focusText, "margin expansion");
    });

    it("/focus alone clears focus (focusText === '')", () => {
      const r = exec("/focus");
      assert.strictEqual(r.action, "set_focus");
      assert.strictEqual(r.focusText, "");
    });
  });

  describe("Executor — alias routing", () => {
    function exec(input: string) {
      return executeSlashCommand(parseSlashInput(input)!);
    }

    it("/summary → get_portfolio_summary", () => {
      assert.strictEqual(
        exec("/summary").toolExecution?.tool,
        "get_portfolio_summary"
      );
    });

    it("/mf → get_mutual_funds", () => {
      assert.strictEqual(exec("/mf").toolExecution?.tool, "get_mutual_funds");
    });

    it("/price → get_financial_data with symbol", () => {
      const r = exec("/price TCS.NS");
      assert.strictEqual(r.toolExecution?.tool, "get_financial_data");
      assert.strictEqual(r.toolExecution?.params.symbol, "TCS.NS");
    });

    it("/retire → get_fire_scenarios", () => {
      assert.strictEqual(
        exec("/retire").toolExecution?.tool,
        "get_fire_scenarios"
      );
    });

    it("/valuation aliases to /dcf and keeps the dcf preset", () => {
      const r = exec("/valuation RELIANCE");
      assert.strictEqual(r.toolExecution?.tool, "run_research");
      assert.strictEqual(r.toolExecution?.params.skill, "dcf-valuation");
    });
  });

  describe("Executor — branch isolation", () => {
    function exec(input: string) {
      return executeSlashCommand(parseSlashInput(input)!);
    }

    it("a tool-mode command never trips the navigate branch", () => {
      const r = exec("/portfolio");
      assert.notStrictEqual(r.action, "navigate");
      assert.ok(r.toolExecution);
    });

    it("a client-mode command never returns a toolExecution", () => {
      const r = exec("/clear");
      assert.strictEqual(r.toolExecution, undefined);
      assert.strictEqual(r.action, "clear");
    });
  });

  // ═══════════ MONEY-1119 — required-argument gate ═══════════
  //
  // Reported in the MONEY-1095 bug doc as "Should not have run": a bare
  // `/research` reached run_research with no query, burned a credit and came
  // back "Research failed". The registry always declared `required: true`;
  // nothing enforced it.

  describe("Registry — formatUsage / formatParamToken", () => {
    it("wraps required params in <> and optional in []", () => {
      assert.strictEqual(
        formatParamToken({
          name: "query",
          type: "string",
          required: true,
          description: "",
        }),
        "<query>"
      );
      assert.strictEqual(
        formatParamToken({
          name: "mode",
          type: "string",
          required: false,
          description: "",
        }),
        "[mode]"
      );
    });

    it("builds the canonical usage line for a command with params", () => {
      assert.strictEqual(
        formatUsage(findCommand("research")!),
        "/research <query> [mode]"
      );
    });

    it("omits the param section for a command that takes none", () => {
      // Was /risk until that command was disabled; /documents is the
      // remaining paramless "tools" command and exercises the same branch.
      assert.strictEqual(formatUsage(findCommand("documents")!), "/documents");
    });
  });

  describe("Executor — required-argument gate (MONEY-1119)", () => {
    function exec(input: string) {
      const parsed = parseSlashInput(input);
      assert.ok(parsed, `parser should accept ${input}`);
      return executeSlashCommand(parsed);
    }

    const GATED = SLASH_COMMANDS.filter((c) =>
      c.params?.some((p) => p.required)
    );

    it("pins exactly which commands declare a required param", () => {
      assert.deepStrictEqual(
        GATED.map((c) => c.name),
        [
          "research",
          "deep",
          "quick",
          "peer",
          "dcf",
          "thesis",
          "earnings",
          "technical",
          "news",
          "quote",
          "report",
        ],
        "a command gained or lost a required param — confirm the gate suits it"
      );
    });

    it("/focus is NOT gated — bare /focus clears the saved focus", () => {
      assert.ok(
        !GATED.some((c) => c.name === "focus"),
        "/focus must stay ungated: bare /focus is how users clear their focus"
      );
    });

    // Generated from the registry, so a command added later is covered without
    // anyone remembering to add a case here.
    for (const cmd of GATED) {
      it(`/${cmd.name} with no args is answered locally, never dispatched`, () => {
        const r = exec(`/${cmd.name}`);
        assert.strictEqual(
          r.toolExecution,
          undefined,
          `/${cmd.name} must not reach the tool pipeline without its required args`
        );
        assert.strictEqual(
          r.handled,
          true,
          "must be handled locally so it costs no round-trip and no credits"
        );
        assert.ok(r.response?.includes(`/${cmd.name}`));
        assert.ok(r.response?.includes("**Usage:**"));
      });
    }

    it("reproduces the reported bug: bare /research no longer runs", () => {
      const r = exec("/research");
      assert.strictEqual(r.toolExecution, undefined);
      assert.match(r.response ?? "", /needs a `query` value to run/);
      assert.match(r.response ?? "", /\/research <query> \[mode\]/);
      assert.match(r.response ?? "", /\*\*Example:\*\*/);
    });

    it("still dispatches once the required arg is supplied", () => {
      const r = exec("/research RELIANCE");
      assert.strictEqual(r.handled, false);
      assert.strictEqual(r.toolExecution?.tool, "run_research");
      assert.strictEqual(r.toolExecution?.params.query, "RELIANCE");
    });

    it("treats a whitespace-only named arg as missing", () => {
      const r = exec('/research query:"   "');
      assert.strictEqual(r.toolExecution, undefined);
      assert.strictEqual(r.handled, true);
    });

    it("lists the valid values when the missing param is an enum", () => {
      const r = exec("/report");
      assert.strictEqual(r.toolExecution, undefined);
      assert.match(r.response ?? "", /`tax`/);
      assert.match(r.response ?? "", /`risk`/);
      assert.match(r.response ?? "", /`portfolio_statement`/);
    });

    it("dispatches /report once the enum value is given", () => {
      const r = exec("/report tax");
      assert.strictEqual(r.toolExecution?.tool, "generate_report");
      assert.strictEqual(r.toolExecution?.params.type, "tax");
    });

    it("leaves commands with no required params alone", () => {
      // "risk" + "tax" dropped from this list when they were disabled;
      // "documents" and "mutualfunds" keep the paramless coverage.
      for (const name of [
        "portfolio",
        "documents",
        "mutualfunds",
        "holdings",
      ]) {
        const r = exec(`/${name}`);
        assert.ok(
          r.toolExecution,
          `/${name} has no required params and must still dispatch`
        );
      }
    });

    it("bare /focus still returns the clear action, not a usage hint", () => {
      const r = exec("/focus");
      assert.strictEqual(r.action, "set_focus");
      assert.strictEqual(r.focusText, "");
      assert.strictEqual(r.toolExecution, undefined);
    });

    // ── Branches no registered command currently exercises ──

    /** Minimal real SlashCommand, built per-test to hit a specific branch. */
    function syntheticCommand(params: SlashCommand["params"]): SlashCommand {
      return {
        name: "synthetic",
        description: "test-only command",
        category: "tools",
        icon: "Bug",
        params,
        examples: ["/synthetic alpha beta"],
        mode: "tool",
        toolName: "noop_tool",
      };
    }

    it("names every missing param when more than one is absent", () => {
      const r = executeSlashCommand({
        command: syntheticCommand([
          { name: "alpha", type: "string", required: true, description: "" },
          { name: "beta", type: "string", required: true, description: "" },
        ]),
        args: {},
        rawArgs: "",
      });
      assert.strictEqual(r.toolExecution, undefined);
      assert.match(r.response ?? "", /`alpha` and `beta` values to run/);
    });

    it("counts 0 as a supplied value (not missing)", () => {
      const r = executeSlashCommand({
        command: syntheticCommand([
          { name: "count", type: "number", required: true, description: "" },
        ]),
        args: { count: 0 },
        rawArgs: "0",
      });
      assert.ok(
        r.toolExecution,
        "0 is a real value — the gate must not treat it as absent"
      );
    });
  });

  // ═══════════════════ getAllCommands ═══════════════════

  describe("getAllCommands", () => {
    it("returns the live SLASH_COMMANDS array (same reference + length)", () => {
      const all = getAllCommands();
      assert.strictEqual(all, SLASH_COMMANDS);
      assert.strictEqual(all.length, EXPECTED_COMMAND_NAMES.length);
    });

    it("every returned command has a string name and a valid mode", () => {
      for (const cmd of getAllCommands() as SlashCommand[]) {
        assert.strictEqual(typeof cmd.name, "string");
        assert.ok(["tool", "client", "navigate"].includes(cmd.mode));
      }
    });
  });
});
