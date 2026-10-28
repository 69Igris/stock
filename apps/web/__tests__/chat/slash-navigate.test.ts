/**
 * Slash command - navigate mode (MONEY-200 follow-up).
 *
 * Verifies the `mode: "navigate"` branch added to the executor when
 * /paper-trading shifted from a tool dispatch to a route navigation.
 *
 * Imports the real registry + parser + executor (pure TS, no Next runtime).
 *
 * Backfilled in Wave 0.5 of the MONEY-196 bundle.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SLASH_COMMANDS,
  findCommand,
} from "@/lib/chat/slash-commands/registry";
import { parseSlashInput } from "@/lib/chat/slash-commands/parser";
import { executeSlashCommand } from "@/lib/chat/slash-commands/executor";

describe("Slash navigate mode", () => {
  // SKIPPED (MONEY-587): the `/paper` slash command + its paper-trading nav
  // step were removed (MONEY-550 dropped the orphaned paper nav). These assert
  // `/paper` is still registered, which no longer holds. Re-enable if `/paper`
  // is re-added; otherwise delete this block with the command.
  describe.skip("/paper navigation", () => {
    it("/paper resolves to mode=navigate with /paper-trading target", () => {
      const cmd = findCommand("paper");
      assert.ok(cmd, "/paper should be registered");
      assert.strictEqual(cmd!.mode, "navigate");
      assert.strictEqual(cmd!.navigateTo, "/paper-trading");
    });

    it("/paper-trading alias resolves to the same command", () => {
      const cmd = findCommand("paper-trading");
      assert.ok(cmd, "/paper-trading alias should resolve");
      assert.strictEqual(cmd!.name, "paper");
      assert.strictEqual(cmd!.mode, "navigate");
    });

    it("/papertrade alias resolves to the same command", () => {
      const cmd = findCommand("papertrade");
      assert.ok(cmd, "/papertrade alias should resolve");
      assert.strictEqual(cmd!.name, "paper");
    });

    it("/papertrading alias resolves to the same command", () => {
      const cmd = findCommand("papertrading");
      assert.ok(cmd, "/papertrading alias should resolve");
      assert.strictEqual(cmd!.name, "paper");
    });

    it("executor returns handled+action=navigate+navigateTo for /paper", () => {
      const parsed = parseSlashInput("/paper");
      assert.ok(parsed, "parser should accept /paper");
      const result = executeSlashCommand(parsed!);
      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.action, "navigate");
      assert.strictEqual(result.navigateTo, "/paper-trading");
      assert.ok(
        typeof result.response === "string" && result.response.length > 0,
        "navigate response message should be present so chat shows context"
      );
    });

    it("executor accepts the alias and still maps to /paper-trading", () => {
      const parsed = parseSlashInput("/paper-trading");
      assert.ok(parsed, "parser should accept /paper-trading alias");
      const result = executeSlashCommand(parsed!);
      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.action, "navigate");
      assert.strictEqual(result.navigateTo, "/paper-trading");
    });
  });

  describe("Navigate-mode invariants across registry", () => {
    // SKIPPED (MONEY-587): asserts ≥1 navigate-mode command exists, but the
    // only one (`/paper`) was removed (MONEY-550). Re-enable when a navigate
    // command is re-added.
    it.skip("every navigate-mode command has a navigateTo OR a sensible default", () => {
      const navCommands = SLASH_COMMANDS.filter((c) => c.mode === "navigate");
      assert.ok(
        navCommands.length > 0,
        "registry should contain at least one navigate command"
      );
      for (const c of navCommands) {
        // navigateTo is optional; the executor falls back to `/${name}`
        // when absent. Confirm both forms are well-formed paths.
        const target = c.navigateTo ?? `/${c.name}`;
        assert.ok(target.startsWith("/"), `${c.name}: target must be absolute`);
        assert.ok(target.length > 1, `${c.name}: target must be non-empty`);
      }
    });

    it("navigate commands do NOT carry toolName (mode-mutual-exclusion)", () => {
      const navCommands = SLASH_COMMANDS.filter((c) => c.mode === "navigate");
      for (const c of navCommands) {
        assert.strictEqual(
          c.toolName,
          undefined,
          `${c.name}: navigate-mode command should not declare a toolName`
        );
      }
    });

    it("navigate commands do NOT carry clientHandler", () => {
      const navCommands = SLASH_COMMANDS.filter((c) => c.mode === "navigate");
      for (const c of navCommands) {
        assert.strictEqual(
          c.clientHandler,
          undefined,
          `${c.name}: navigate-mode command should not declare a clientHandler`
        );
      }
    });
  });

  describe("Executor branch isolation", () => {
    it("tool-mode command does NOT return action=navigate", () => {
      // /portfolio is mode:"tool" - must not accidentally trip the
      // navigate branch.
      const parsed = parseSlashInput("/portfolio");
      assert.ok(parsed);
      const result = executeSlashCommand(parsed!);
      assert.notStrictEqual(result.action, "navigate");
      assert.ok(
        result.toolExecution,
        "tool-mode command should populate toolExecution"
      );
    });

    it("client-mode /clear command returns action=clear (not navigate)", () => {
      const parsed = parseSlashInput("/clear");
      assert.ok(parsed);
      const result = executeSlashCommand(parsed!);
      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.action, "clear");
    });
  });
});
