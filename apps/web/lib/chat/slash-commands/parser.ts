/**
 * Slash Command Parser
 *
 * Parses user input like `/holdings broker:zerodha` into structured
 * command + args objects. Supports key:value pairs and positional args.
 */

import { findCommand, type SlashCommand } from "./registry";

export interface ParsedSlashCommand {
  command: SlashCommand;
  args: Record<string, unknown>;
  rawArgs: string;
}

/** Check if text starts with a slash command pattern */
export function isSlashCommand(text: string): boolean {
  return /^\/[a-zA-Z]/.test(text.trim());
}

/** Extract the command name prefix from partial input (for autocomplete filtering) */
export function extractCommandPrefix(text: string): string {
  const match = text.trim().match(/^\/([a-zA-Z]*)$/);
  return match ? match[1] : "";
}

/**
 * Parse a slash command input string into a structured object.
 *
 * Parsing rules:
 * - `/command` → command with no args
 * - `/command key:value key2:value2` → named args
 * - `/command RELIANCE` → first required param gets the positional value
 * - `/command RELIANCE mode:advanced` → mix of positional + named
 * - Values with spaces can be quoted: `query:"Nifty IT sector"`
 */
export function parseSlashInput(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  if (!isSlashCommand(trimmed)) return null;

  // Split on first space to get command name vs rest
  const spaceIdx = trimmed.indexOf(" ");
  const commandName =
    spaceIdx === -1
      ? trimmed.slice(1).toLowerCase()
      : trimmed.slice(1, spaceIdx).toLowerCase();
  const rawArgs = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  const command = findCommand(commandName);
  if (!command) return null;

  const args = parseArgs(rawArgs, command);

  return { command, args, rawArgs };
}

/**
 * Parse argument string into key-value pairs.
 * Supports: `key:value`, `key:"quoted value"`, and positional args.
 */
function parseArgs(
  rawArgs: string,
  command: SlashCommand
): Record<string, unknown> {
  if (!rawArgs) return {};

  const args: Record<string, unknown> = {};
  const positionalParts: string[] = [];

  // Tokenize: split on spaces but respect quotes
  const tokens = tokenize(rawArgs);

  for (const token of tokens) {
    const colonIdx = token.indexOf(":");
    if (colonIdx > 0 && colonIdx < token.length - 1) {
      // Named arg: key:value
      const key = token.slice(0, colonIdx).toLowerCase();
      let value: string | number = token.slice(colonIdx + 1);
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // Check if param expects a number
      const paramDef = command.params?.find(
        (p) => p.name.toLowerCase() === key
      );
      if (paramDef?.type === "number") {
        const num = Number(value);
        if (!isNaN(num)) {
          args[key] = num;
          continue;
        }
      }
      args[key] = value;
    } else {
      positionalParts.push(token);
    }
  }

  // Assign positional args to the first required param (if any)
  if (positionalParts.length > 0 && command.params) {
    const firstRequired = command.params.find((p) => p.required);
    if (firstRequired && !(firstRequired.name in args)) {
      args[firstRequired.name] = positionalParts.join(" ");
    } else {
      // If no required param, try first optional string param
      const firstOptionalString = command.params.find(
        (p) => !p.required && p.type === "string" && !(p.name in args)
      );
      if (firstOptionalString) {
        args[firstOptionalString.name] = positionalParts.join(" ");
      }
    }
  }

  return args;
}

/** Split input on whitespace but keep quoted strings together */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (const char of input) {
    if (inQuote) {
      current += char;
      if (char === inQuote) {
        inQuote = null;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
      current += char;
    } else if (char === " ") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) tokens.push(current);
  return tokens;
}
