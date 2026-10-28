/**
 * Slash Command Executor
 *
 * Routes parsed commands to either:
 * - Tool pipeline (mode="tool") → returns tool execution info for ChatContext
 * - Client handlers (mode="client") → returns response/action for local handling
 */

import {
  SLASH_COMMANDS,
  getCommandsByCategory,
  formatUsage,
  CATEGORY_META,
  type SlashCommand,
  type SlashCommandParam,
} from "./registry";
import type { ParsedSlashCommand } from "./parser";

export interface SlashExecutionResult {
  handled: boolean;
  /** For tool commands - pass to ChatContext for execution */
  toolExecution?: {
    tool: string;
    params: Record<string, unknown>;
    userText: string;
  };
  /** For client commands - display as assistant message */
  response?: string;
  /** Special action to perform */
  action?: "clear" | "compact" | "navigate" | "set_focus";
  /** Navigation target */
  navigateTo?: string;
  /**
   * MONEY-223 - `/focus <text>` payload. Empty string clears the saved
   * focus. ChatPromptArea consumes this and calls
   * setMyResearchPreferencesAction.
   */
  focusText?: string;
}

/**
 * True when `value` was actually supplied. `0` and `false` count as supplied;
 * a whitespace-only string does not (`/research "   "` is not a query).
 */
function isSupplied(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

/** Required params the user did not supply, in declaration order. */
function findMissingRequiredParams(
  command: SlashCommand,
  args: Record<string, unknown>
): SlashCommandParam[] {
  if (!command.params) return [];
  return command.params.filter((p) => p.required && !isSupplied(args[p.name]));
}

/**
 * MONEY-1119 - the reply shown INSTEAD of dispatching an under-specified
 * command. Rendered locally by ChatPromptArea via `handled + response`, so it
 * costs no round-trip and no credits.
 */
function missingParamsResponse(
  command: SlashCommand,
  missing: SlashCommandParam[]
): SlashExecutionResult {
  const names = missing.map((p) => `\`${p.name}\``).join(" and ");
  const subject = missing.length === 1 ? `a ${names} value` : `${names} values`;
  const lines = [
    `\`/${command.name}\` needs ${subject} to run.`,
    "",
    `**Usage:** \`${formatUsage(command)}\``,
  ];

  for (const param of missing) {
    if (param.type === "enum" && param.enumValues?.length) {
      const values = param.enumValues.map((v) => `\`${v}\``).join(" · ");
      lines.push(`**${param.name}:** ${values}`);
    }
  }

  // Skip a bare `/cmd` example — it demonstrates exactly the thing we just
  // rejected.
  const example = command.examples.find(
    (ex) => ex.trim() !== `/${command.name}`
  );
  if (example) {
    lines.push(`**Example:** \`${example}\``);
  }

  return { handled: true, response: lines.join("\n") };
}

/** Execute a parsed slash command */
export function executeSlashCommand(
  parsed: ParsedSlashCommand
): SlashExecutionResult {
  const { command, args, rawArgs } = parsed;

  // MONEY-1119 - refuse to dispatch before the command has what it needs.
  // Previously the parser recorded `required` but nothing enforced it, so a
  // bare `/research` reached run_research with no query, burned credits and
  // came back "Research failed". Enforced here rather than per-mode so a new
  // command cannot opt out of it by accident.
  const missing = findMissingRequiredParams(command, args);
  if (missing.length > 0) {
    return missingParamsResponse(command, missing);
  }

  switch (command.mode) {
    case "tool":
      return executeToolCommand(command, args, rawArgs);
    case "client":
      return executeClientCommand(command, rawArgs);
    case "navigate":
      return executeNavigateCommand(command);
    default:
      return { handled: false };
  }
}

function executeNavigateCommand(command: SlashCommand): SlashExecutionResult {
  const target = command.navigateTo ?? `/${command.name}`;
  return {
    handled: true,
    action: "navigate",
    navigateTo: target,
    response: `Opening **${command.description.replace(/\.$/, "")}** - [Go to ${target} →](${target})`,
  };
}

function executeToolCommand(
  command: SlashCommand,
  args: Record<string, unknown>,
  rawArgs: string
): SlashExecutionResult {
  if (!command.toolName) {
    return { handled: false };
  }

  // Map slash command params to tool params
  const toolParams = mapToToolParams(command, args);

  return {
    handled: false, // Not fully handled - needs ChatContext to execute the tool
    toolExecution: {
      tool: command.toolName,
      params: toolParams,
      userText: `/${command.name}${rawArgs ? " " + rawArgs : ""}`,
    },
  };
}

function executeClientCommand(
  command: SlashCommand,
  rawArgs?: string
): SlashExecutionResult {
  switch (command.clientHandler) {
    case "help":
      return {
        handled: true,
        response: generateHelpMarkdown(),
      };
    case "clear":
      return {
        handled: true,
        action: "clear",
        response:
          "Conversation cleared. Starting fresh - all previous context has been removed. Feel free to start a new query!",
      };
    case "compact":
      return {
        handled: true,
        action: "compact",
      };
    case "import":
      return {
        handled: true,
        response: generateImportMessage(),
        action: "navigate",
        navigateTo: "/tradebook/import",
      };
    case "upload":
      return {
        handled: true,
        response: generateUploadMessage(),
        action: "navigate",
        navigateTo: "/documents",
      };
    case "set_focus":
      return {
        handled: true,
        action: "set_focus",
        focusText: rawArgs?.trim() ?? "",
      };
    default:
      return { handled: false };
  }
}

/** Map slash command args to tool parameter names */
function mapToToolParams(
  command: SlashCommand,
  args: Record<string, unknown>
): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  // Special mappings for certain tools
  switch (command.toolName) {
    case "get_trades":
      if (args.type) params.tradeType = args.type;
      if (args.symbol) params.symbol = args.symbol;
      if (args.limit) params.limit = args.limit;
      params.skip = 0;
      return params;

    case "get_financial_data":
      if (args.symbol) params.symbol = args.symbol;
      return params;

    case "run_research": {
      // MONEY-223 - research-shortcut commands like /deep / /dcf / /peer
      // pass a `symbol` arg + bake their `presetParams` (skill + mode +
      // customSkills) into the request. The base /research command
      // continues to take a free-text query.
      if (args.query) params.query = args.query;
      if (args.symbol) {
        const symbol = String(args.symbol).toUpperCase();
        params.symbols = [symbol];
        params.query = (params.query as string) || `Analyze ${symbol}`;
      }
      if (args.mode) params.mode = args.mode;
      if (command.presetParams) {
        if (command.presetParams.skill && !params.skill) {
          params.skill = command.presetParams.skill;
        }
        if (command.presetParams.customSkills && !params.customSkills) {
          params.customSkills = [...command.presetParams.customSkills];
        }
        if (command.presetParams.mode && !params.mode) {
          params.mode = command.presetParams.mode;
        }
      }
      return params;
    }

    case "get_stock_news":
      if (args.symbol) {
        params.symbol = String(args.symbol).toUpperCase();
      }
      return params;

    case "generate_report":
      if (args.type) params.type = args.type;
      if (args.fy) params.fy = args.fy;
      return params;

    // DISABLED alongside the `/tax` registry entry. mapToToolParams switches
    // on command.toolName, and no registered command carries "tax_report"
    // any more, so this branch is unreachable. Restore it together with the
    // `/tax` command or its `fy:` argument silently stops mapping.
    // NOTE: `/report tax` is a DIFFERENT command (toolName "generate_report",
    // handled above) and still passes `fy` through — it is unaffected.
    // case "tax_report":
    //   if (args.fy) params.fy = args.fy;
    //   return params;

    default:
      // Pass args through directly for simple tools
      return { ...args };
  }
}

function generateHelpMarkdown(): string {
  const grouped = getCommandsByCategory();
  const lines: string[] = ["Here are all available slash commands:\n"];

  const categoryOrder: Array<keyof typeof grouped> = [
    "portfolio",
    "trading",
    "research",
    "tools",
    "utility",
  ];

  for (const cat of categoryOrder) {
    const commands = grouped[cat];
    if (commands.length === 0) continue;

    const meta = CATEGORY_META[cat];
    lines.push(`**${meta.label}**`);

    for (const cmd of commands) {
      lines.push(`- \`${formatUsage(cmd)}\` - ${cmd.description}`);
    }

    lines.push("");
  }

  lines.push(
    "*Type `/` to see autocomplete suggestions. Use `key:value` for named parameters.*"
  );

  return lines.join("\n");
}

function generateImportMessage(): string {
  return (
    "Opening the **Tradebook Import** page where you can:\n" +
    "- Upload CSV files from your broker\n" +
    "- Auto-detect broker format\n" +
    "- Review and confirm trades before importing\n\n" +
    "[Go to Import →](/tradebook/import)"
  );
}

function generateUploadMessage(): string {
  return (
    "Opening the **Documents** page where you can:\n" +
    "- Upload broker statements, contract notes, and reports\n" +
    "- Generate tax and risk reports\n" +
    "- View and manage all your documents\n\n" +
    "[Go to Documents →](/documents)"
  );
}

/** Get the list of all commands for external consumers (Help Center, etc.) */
export function getAllCommands(): typeof SLASH_COMMANDS {
  return SLASH_COMMANDS;
}
