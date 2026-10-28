/**
 * Slash Command Registry
 *
 * Defines all available slash commands with their metadata, parameter specs,
 * and routing mode (tool execution, client-handled, or navigation).
 */

export type SlashCommandCategory =
  | "portfolio"
  | "trading"
  | "research"
  | "tools"
  | "utility";

export interface SlashCommandParam {
  name: string;
  type: "string" | "number" | "enum";
  required: boolean;
  description: string;
  enumValues?: string[];
}

export interface SlashCommand {
  name: string;
  description: string;
  category: SlashCommandCategory;
  icon: string;
  params?: SlashCommandParam[];
  examples: string[];
  mode: "tool" | "client" | "navigate";
  toolName?: string;
  clientHandler?:
    | "help"
    | "clear"
    | "compact"
    | "import"
    | "upload"
    | "set_focus";
  /** For mode: "navigate" - destination path. Defaults to `/${name}` if absent. */
  navigateTo?: string;
  aliases?: string[];
  /**
   * MONEY-223 - research-shortcut commands stamp these onto the
   * run_research tool params so the agent kicks straight into the
   * right skill without the chip prompt or classifier guesswork.
   * `skill` matches the registered skill ID, `customSkills` drives
   * the planner trim from MONEY-222, `mode` overrides the default
   * fast/advanced.
   */
  presetParams?: {
    skill?: string;
    customSkills?: string[];
    mode?: "fast" | "advanced";
  };
}

// ============== Command Definitions ==============

export const SLASH_COMMANDS: SlashCommand[] = [
  // ── Portfolio ──
  {
    name: "portfolio",
    description: "View portfolio summary with total value and P&L",
    category: "portfolio",
    icon: "PieChart",
    examples: ["/portfolio"],
    mode: "tool",
    toolName: "get_portfolio_summary",
    aliases: ["summary", "dashboard"],
  },
  {
    name: "holdings",
    description: "List stock holdings with prices and P&L",
    category: "portfolio",
    icon: "Briefcase",
    params: [
      {
        name: "broker",
        type: "string",
        required: false,
        description: "Filter by broker name",
      },
      {
        name: "symbol",
        type: "string",
        required: false,
        description: "Filter by stock symbol",
      },
    ],
    examples: ["/holdings", "/holdings broker:zerodha", "/holdings RELIANCE"],
    mode: "tool",
    toolName: "get_holdings",
  },
  {
    name: "positions",
    description: "Show open and closed trading positions",
    category: "portfolio",
    icon: "TrendingUp",
    params: [
      {
        name: "status",
        type: "enum",
        required: false,
        description: "Filter by status",
        enumValues: ["OPEN", "CLOSED"],
      },
    ],
    examples: ["/positions", "/positions status:OPEN"],
    mode: "tool",
    toolName: "get_positions",
  },
  {
    name: "trades",
    description: "View trade history with buy/sell details",
    category: "portfolio",
    icon: "ArrowUpDown",
    params: [
      {
        name: "symbol",
        type: "string",
        required: false,
        description: "Filter by symbol",
      },
      {
        name: "type",
        type: "enum",
        required: false,
        description: "Filter by trade type",
        enumValues: ["BUY", "SELL"],
      },
      {
        name: "limit",
        type: "number",
        required: false,
        description: "Number of trades to show",
      },
    ],
    examples: ["/trades", "/trades RELIANCE", "/trades type:BUY limit:10"],
    mode: "tool",
    toolName: "get_trades",
  },
  {
    name: "mutualfunds",
    description: "List mutual fund investments with NAV and returns",
    category: "portfolio",
    icon: "Landmark",
    examples: ["/mutualfunds"],
    mode: "tool",
    toolName: "get_mutual_funds",
    aliases: ["mf", "funds"],
  },

  // ── Trading ──
  {
    name: "fire",
    description: "Show FIRE retirement planning scenarios",
    category: "trading",
    icon: "Flame",
    examples: ["/fire"],
    mode: "tool",
    toolName: "get_fire_scenarios",
    aliases: ["retire"],
  },

  // ── Research ──
  {
    name: "research",
    description: "Start a stock research analysis",
    category: "research",
    icon: "Search",
    params: [
      {
        name: "query",
        type: "string",
        required: true,
        description: "Stock or topic to research",
      },
      {
        name: "mode",
        type: "enum",
        required: false,
        description: "Research depth",
        enumValues: ["fast", "advanced"],
      },
    ],
    examples: [
      "/research RELIANCE",
      "/research TCS mode:advanced",
      "/research Nifty IT sector outlook",
    ],
    mode: "tool",
    toolName: "run_research",
  },

  // ── Research shortcuts (MONEY-223) ──
  // Each shortcut is a thin wrapper over run_research that pre-fills the
  // `skill` + `customSkills` + `mode` params so the planner picks the
  // right skill plan and trims to that skill's compute tools (MONEY-222
  // trimming). Power users keep these in muscle memory; the
  // bare-stock-options chip prompt is skipped because mode is set.
  {
    name: "deep",
    description: "Full multi-skill comprehensive research (5 credits)",
    category: "research",
    icon: "Microscope",
    params: [
      {
        name: "symbol",
        type: "string",
        required: true,
        description: "Stock symbol",
      },
    ],
    examples: ["/deep RELIANCE", "/deep TCS"],
    mode: "tool",
    toolName: "run_research",
    presetParams: { mode: "advanced" },
  },
  {
    name: "quick",
    description: "Single-skill quick scorecard (1 credit, ~30s)",
    category: "research",
    icon: "Zap",
    params: [
      {
        name: "symbol",
        type: "string",
        required: true,
        description: "Stock symbol",
      },
    ],
    examples: ["/quick RELIANCE", "/quick INFY"],
    mode: "tool",
    toolName: "run_research",
    presetParams: { mode: "fast" },
  },
  {
    name: "peer",
    description: "Side-by-side peer comparison vs sector",
    category: "research",
    icon: "Users",
    params: [
      {
        name: "symbol",
        type: "string",
        required: true,
        description: "Stock symbol",
      },
    ],
    examples: ["/peer HDFCBANK", "/peer ICICIBANK"],
    mode: "tool",
    toolName: "run_research",
    presetParams: {
      skill: "peer-comparison",
      customSkills: ["peer-comparison"],
      mode: "advanced",
    },
  },
  {
    name: "dcf",
    description: "DCF intrinsic-value model with WACC + scenarios",
    category: "research",
    icon: "Calculator",
    params: [
      {
        name: "symbol",
        type: "string",
        required: true,
        description: "Stock symbol",
      },
    ],
    examples: ["/dcf RELIANCE", "/dcf TCS"],
    mode: "tool",
    toolName: "run_research",
    presetParams: {
      skill: "dcf-valuation",
      customSkills: ["dcf-valuation"],
      mode: "advanced",
    },
    aliases: ["valuation"],
  },
  {
    name: "thesis",
    description: "Bull case + bear case + conviction call",
    category: "research",
    icon: "ScrollText",
    params: [
      {
        name: "symbol",
        type: "string",
        required: true,
        description: "Stock symbol",
      },
    ],
    examples: ["/thesis BAJFINANCE", "/thesis ZOMATO"],
    mode: "tool",
    toolName: "run_research",
    presetParams: {
      skill: "investment-thesis",
      customSkills: ["investment-thesis"],
      mode: "advanced",
    },
  },
  {
    name: "earnings",
    description: "Quarterly results + guidance trend + earnings quality",
    category: "research",
    icon: "Receipt",
    params: [
      {
        name: "symbol",
        type: "string",
        required: true,
        description: "Stock symbol",
      },
    ],
    examples: ["/earnings INFY", "/earnings TATAMOTORS"],
    mode: "tool",
    toolName: "run_research",
    presetParams: {
      skill: "earnings-analysis",
      customSkills: ["earnings-analysis"],
      mode: "advanced",
    },
  },
  {
    name: "technical",
    description: "RSI, MACD, ADX, Stochastic, Bollinger, candlestick patterns",
    category: "research",
    icon: "Activity",
    params: [
      {
        name: "symbol",
        type: "string",
        required: true,
        description: "Stock symbol",
      },
    ],
    examples: ["/technical RELIANCE", "/technical NIFTY"],
    mode: "tool",
    toolName: "run_research",
    presetParams: {
      skill: "stock-analysis",
      customSkills: ["stock-analysis"],
      mode: "advanced",
    },
    aliases: ["chart", "ta"],
  },
  {
    name: "news",
    description: "Recent stock-specific news + sentiment",
    category: "research",
    icon: "Newspaper",
    params: [
      {
        name: "symbol",
        type: "string",
        required: true,
        description: "Stock symbol",
      },
    ],
    examples: ["/news RELIANCE", "/news ADANIENT"],
    mode: "tool",
    toolName: "get_stock_news",
  },
  {
    name: "focus",
    description:
      "Set a recurring research focus the agent applies to every report",
    category: "research",
    icon: "Target",
    params: [
      {
        // NOT required: bare `/focus` is a real, documented action — it CLEARS
        // the saved focus (see the third example below, and the hint
        // ChatPromptArea shows after a successful save). This was declared
        // `required: true` until MONEY-1119, which was harmless only because
        // nothing enforced `required` — the moment the missing-argument gate
        // landed, that lie would have broken clearing.
        name: "text",
        type: "string",
        required: false,
        description:
          "Free-text directive (e.g. 'margin expansion, India-listed names only'). Omit to clear.",
      },
    ],
    examples: [
      "/focus margin expansion + AI exposure",
      "/focus Indian large-caps only",
      "/focus", // empty clears
    ],
    mode: "client",
    clientHandler: "set_focus",
  },
  {
    name: "quote",
    description: "Get quick financial data for a stock",
    category: "research",
    icon: "BarChart3",
    params: [
      {
        name: "symbol",
        type: "string",
        required: true,
        description: "Stock symbol (e.g. RELIANCE.NS)",
      },
    ],
    examples: ["/quote RELIANCE.NS", "/quote TCS.NS"],
    mode: "tool",
    toolName: "get_financial_data",
    aliases: ["price", "stock"],
  },

  // ── Tools ──
  // DISABLED - `/risk` and `/tax` are commented out below. Unregistering them
  // here is the whole switch: this array is the single source for the `/`
  // autocomplete, the `/help` markdown (generateHelpMarkdown reads
  // getCommandsByCategory), and the Help Center Commands tab
  // (components/help/SlashCommandsTab.tsx, whose category counts are derived
  // with .filter().length and so re-count themselves).
  //
  // Typing `/tax` now falls through gracefully rather than erroring:
  // findCommand returns undefined -> parseSlashInput returns null -> the text
  // is treated as an ordinary chat message.
  //
  // The underlying tools stay registered and live. `portfolio_risk_analysis`
  // and `tax_report` remain in lib/chat-tools/registry.ts, so the model can
  // still reach them from natural language, and the /risk and /tax PAGES are
  // untouched. Re-enable by uncommenting these two entries and restoring the
  // matching test expectations (see __tests__/chat/slash-commands.test.ts
  // EXPECTED_COMMAND_NAMES + EXPECTED_CATEGORY_COUNTS).
  // {
  //   name: "risk",
  //   description: "Analyze portfolio risk, concentration, and VaR",
  //   category: "tools",
  //   icon: "Shield",
  //   examples: ["/risk"],
  //   mode: "tool",
  //   toolName: "portfolio_risk_analysis",
  // },
  // {
  //   name: "tax",
  //   description: "Generate capital gains tax report",
  //   category: "tools",
  //   icon: "Receipt",
  //   params: [
  //     {
  //       name: "fy",
  //       type: "string",
  //       required: false,
  //       description: "Financial year (e.g. 2025-26)",
  //     },
  //   ],
  //   examples: ["/tax", "/tax fy:2025-26"],
  //   mode: "tool",
  //   toolName: "tax_report",
  // },
  {
    name: "documents",
    description: "List uploaded documents and reports",
    category: "tools",
    icon: "FolderOpen",
    examples: ["/documents"],
    mode: "tool",
    toolName: "get_user_documents",
    aliases: ["docs"],
  },
  {
    name: "report",
    description: "Generate a downloadable PDF report",
    category: "tools",
    icon: "FileSpreadsheet",
    params: [
      {
        name: "type",
        type: "enum",
        required: true,
        description: "Report type",
        enumValues: ["tax", "risk", "portfolio_statement"],
      },
    ],
    examples: ["/report tax", "/report risk", "/report portfolio_statement"],
    mode: "tool",
    toolName: "generate_report",
  },

  // ── Utility ──
  {
    name: "import",
    description: "Navigate to tradebook import page",
    category: "utility",
    icon: "Upload",
    examples: ["/import"],
    mode: "client",
    clientHandler: "import",
  },
  {
    name: "upload",
    description: "Navigate to documents page to upload files",
    category: "utility",
    icon: "CloudUpload",
    examples: ["/upload"],
    mode: "client",
    clientHandler: "upload",
  },
  {
    name: "help",
    description: "Show all available slash commands",
    category: "utility",
    icon: "HelpCircle",
    examples: ["/help"],
    mode: "client",
    clientHandler: "help",
  },
  {
    name: "clear",
    description: "Clear the current conversation and start fresh",
    category: "utility",
    icon: "Trash2",
    examples: ["/clear"],
    mode: "client",
    clientHandler: "clear",
  },
  {
    name: "compact",
    description: "Summarize conversation to save context space and continue",
    category: "utility",
    icon: "Minimize2",
    examples: ["/compact"],
    mode: "client",
    clientHandler: "compact",
  },
];

// ============== Lookup Utilities ==============

const commandMap = new Map<string, SlashCommand>();
const aliasMap = new Map<string, SlashCommand>();

for (const cmd of SLASH_COMMANDS) {
  commandMap.set(cmd.name, cmd);
  if (cmd.aliases) {
    for (const alias of cmd.aliases) {
      aliasMap.set(alias, cmd);
    }
  }
}

/** Find a command by exact name or alias */
export function findCommand(name: string): SlashCommand | undefined {
  const lower = name.toLowerCase();
  return commandMap.get(lower) ?? aliasMap.get(lower);
}

/** Search commands by partial name/description match */
export function searchCommands(query: string): SlashCommand[] {
  const lower = query.toLowerCase();
  if (!lower) return SLASH_COMMANDS;

  return SLASH_COMMANDS.filter(
    (cmd) =>
      cmd.name.includes(lower) ||
      cmd.description.toLowerCase().includes(lower) ||
      cmd.aliases?.some((a) => a.includes(lower))
  );
}

/**
 * Render one param as its usage token: `<required>` / `[optional]`.
 *
 * Single source for the convention. It previously existed as three
 * hand-rolled copies (`/help` markdown, the Help Center tab, and nothing at
 * all on the error path) — which is how the `<>`/`[]` meaning drifts out of
 * sync with what the executor actually enforces.
 */
export function formatParamToken(param: SlashCommandParam): string {
  return param.required ? `<${param.name}>` : `[${param.name}]`;
}

/** Canonical usage line for a command, e.g. `/research <query> [mode]`. */
export function formatUsage(command: SlashCommand): string {
  const tokens = command.params?.map(formatParamToken).join(" ");
  return tokens ? `/${command.name} ${tokens}` : `/${command.name}`;
}

/** Get commands grouped by category */
export function getCommandsByCategory(): Record<
  SlashCommandCategory,
  SlashCommand[]
> {
  const grouped: Record<SlashCommandCategory, SlashCommand[]> = {
    portfolio: [],
    trading: [],
    research: [],
    tools: [],
    utility: [],
  };

  for (const cmd of SLASH_COMMANDS) {
    grouped[cmd.category].push(cmd);
  }

  return grouped;
}

/** Category display metadata */
export const CATEGORY_META: Record<
  SlashCommandCategory,
  { label: string; color: string }
> = {
  portfolio: {
    label: "Portfolio",
    color: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  },
  trading: {
    label: "Trading",
    color: "bg-green-500/20 text-green-400 border-green-500/30",
  },
  research: {
    label: "Research List",
    color: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  },
  tools: {
    label: "Tools",
    color: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  },
  utility: {
    label: "Utility",
    color: "bg-slate-500/20 text-slate-400 border-slate-500/30",
  },
};
