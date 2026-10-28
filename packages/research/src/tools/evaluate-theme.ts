/**
 * Evaluate Investment Theme Tool
 *
 * Looks up a curated investment theme by id or name and returns
 * its constituent stocks, thesis, catalysts, and risks with a
 * formatted summary for the AI agent.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import {
  getThemeById,
  searchThemes,
  getAllThemes,
  type InvestmentTheme,
} from "../strategies/investment-themes";

// ─── Helpers ────────────────────────────────────────────────

function formatThemeSummary(theme: InvestmentTheme): string {
  const lines: string[] = [];

  lines.push(`## ${theme.name}`);
  lines.push("");
  lines.push(
    `**Sector:** ${theme.sector} | **Timeframe:** ${theme.timeframe} | **Stocks:** ${theme.stocks.length}`,
  );
  lines.push("");
  lines.push(`### Thesis`);
  lines.push(theme.thesis);
  lines.push("");
  lines.push(`### Catalysts`);
  for (const c of theme.catalysts) {
    lines.push(`- ${c}`);
  }
  lines.push("");
  lines.push(`### Risks`);
  for (const r of theme.risks) {
    lines.push(`- ${r}`);
  }
  lines.push("");
  lines.push(`### Stocks`);
  lines.push("| Symbol | Name | Exchange | Rationale |");
  lines.push("|--------|------|----------|-----------|");
  for (const s of theme.stocks) {
    lines.push(`| ${s.symbol} | ${s.name} | ${s.exchange} | ${s.rationale} |`);
  }

  return lines.join("\n");
}

// ─── Tool Definition ────────────────────────────────────────

export const evaluateThemeTool: ResearchToolDef = {
  name: "evaluate_theme",
  description:
    "Look up a curated investment theme by id or name and return its stocks, thesis, catalysts, and risks. Use without parameters to list all available themes.",
  category: "computation",
  parameters: {
    theme_id: {
      type: "string",
      description:
        "Theme id (e.g., 'ev_battery', 'green_energy', 'defense_aerospace')",
    },
    theme_name: {
      type: "string",
      description:
        "Theme name or search query (e.g., 'EV', 'defense', 'digital payments')",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const themeId = params.theme_id as string | undefined;
    const themeName = params.theme_name as string | undefined;

    try {
      // No parameters - list all themes
      if (!themeId && !themeName) {
        const all = getAllThemes();
        const listing = all.map((t) => ({
          id: t.id,
          name: t.name,
          sector: t.sector,
          timeframe: t.timeframe,
          stockCount: t.stocks.length,
          description: t.description,
        }));

        return {
          success: true,
          data: {
            themes: listing,
            count: listing.length,
            summary: `${listing.length} investment themes available:\n${listing.map((t) => `- **${t.name}** (${t.id}) - ${t.sector}, ${t.timeframe}-term, ${t.stockCount} stocks`).join("\n")}`,
          },
          metadata: { action: "list_themes" },
        };
      }

      // Look up by id first
      if (themeId) {
        const theme = getThemeById(themeId);
        if (theme) {
          return {
            success: true,
            data: {
              theme,
              summary: formatThemeSummary(theme),
            },
            metadata: {
              themeId: theme.id,
              stockCount: theme.stocks.length,
              symbols: theme.stocks.map((s) => s.symbol),
            },
          };
        }
      }

      // Search by name
      const query = themeName || themeId || "";
      const matches = searchThemes(query);

      if (matches.length === 0) {
        // Provide available theme ids for the caller
        const available = getAllThemes().map((t) => `${t.id} (${t.name})`);
        return {
          success: false,
          error: `No theme found matching "${query}". Available themes: ${available.join(", ")}`,
        };
      }

      if (matches.length === 1) {
        const theme = matches[0]!;
        return {
          success: true,
          data: {
            theme,
            summary: formatThemeSummary(theme),
          },
          metadata: {
            themeId: theme.id,
            stockCount: theme.stocks.length,
            symbols: theme.stocks.map((s) => s.symbol),
          },
        };
      }

      // Multiple matches - return all with summaries
      return {
        success: true,
        data: {
          themes: matches,
          count: matches.length,
          summaries: matches.map((t) => formatThemeSummary(t)),
          summary: `Found ${matches.length} themes matching "${query}":\n${matches.map((t) => `- **${t.name}** (${t.id}) - ${t.sector}, ${t.timeframe}-term, ${t.stocks.length} stocks`).join("\n")}`,
        },
        metadata: {
          matchCount: matches.length,
          themeIds: matches.map((t) => t.id),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Theme evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
