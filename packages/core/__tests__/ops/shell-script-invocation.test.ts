/**
 * A script's INTERPRETER must match what the script actually uses.
 *
 * `package.json` invoked `sh scripts/run-python-tests.sh`, and an explicit
 * interpreter OVERRIDES the shebang — so the file's own `#!/usr/bin/env bash`
 * was ignored. On macOS `/bin/sh` is bash in POSIX mode and `set -o pipefail`
 * works, so it passed locally and in the local verify gate. On CI `/bin/sh` is
 * dash:
 *
 *     scripts/run-python-tests.sh: 14: set: Illegal option -o pipefail
 *     Error: Process completed with exit code 2.
 *
 * The whole Python suite — 1,414 cases — never ran, and the failure was in the
 * SHELL, so nothing about the tests themselves looked wrong.
 *
 * This class is structurally invisible to the local gate: the developer machine
 * cannot reproduce it without explicitly calling dash. So it gets a test rather
 * than vigilance.
 *
 * Two rules, in both directions:
 *   - a bash-shebang script must not be invoked with `sh`
 *   - a script invoked with `sh` must contain no bashisms, even if its shebang
 *     says sh today (that is the drift that creates the next instance)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/** `{ interpreter, path }` for every package.json script that runs a .sh file. */
function shellInvocations(): {
  script: string;
  interpreter: string;
  path: string;
}[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const out: { script: string; interpreter: string; path: string }[] = [];
  for (const [script, cmd] of Object.entries(pkg.scripts ?? {})) {
    const m = /(^|&&\s*)(sh|bash)\s+(\S+\.sh)/.exec(cmd);
    if (m) out.push({ script, interpreter: m[2]!, path: m[3]! });
  }
  return out;
}

function shebangOf(rel: string): string {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return "";
  return readFileSync(abs, "utf8").split("\n", 1)[0] ?? "";
}

/** Constructs dash rejects. `set -o pipefail` is the one that bit us. */
const BASHISMS: [RegExp, string][] = [
  [/^\s*set\s+-[a-z]*o\s+pipefail/m, "set -o pipefail"],
  [/\[\[/, "[[ ]] test"],
  [/<<</, "here-string <<<"],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*\[[@*]\]\}/, "array expansion"],
  [/\bBASH_[A-Z]+/, "BASH_* variable"],
];

describe("shell scripts are run by an interpreter that understands them", () => {
  const invocations = shellInvocations();

  it("PREMISE: package.json actually invokes shell scripts this way", () => {
    // Without this, every assertion below passes over an empty list — the
    // vacuous-guard shape this repo has shipped more than once.
    assert.ok(
      invocations.length >= 2,
      `found ${invocations.length} shell invocations in package.json; the parser ` +
        "is probably not matching the command shape any more",
    );
    for (const inv of invocations) {
      assert.ok(existsSync(join(ROOT, inv.path)), `${inv.path} does not exist`);
    }
  });

  it("a bash-shebang script is never invoked with `sh`", () => {
    for (const inv of invocations) {
      const shebang = shebangOf(inv.path);
      if (!/bash/.test(shebang)) continue;
      assert.equal(
        inv.interpreter,
        "bash",
        `package.json "${inv.script}" runs ${inv.path} with \`sh\`, but the file ` +
          `declares ${shebang.trim()}. An explicit interpreter OVERRIDES the ` +
          "shebang, and CI's /bin/sh is dash while macOS's is bash — so this " +
          "passes locally and fails only in CI.",
      );
    }
  });

  it("a script invoked with `sh` contains no bashisms", () => {
    for (const inv of invocations) {
      if (inv.interpreter !== "sh") continue;
      const src = readFileSync(join(ROOT, inv.path), "utf8");
      for (const [re, name] of BASHISMS) {
        assert.ok(
          !re.test(src),
          `${inv.path} is invoked with \`sh\` but uses ${name}. Either switch ` +
            `package.json "${inv.script}" to \`bash\`, or rewrite it POSIX-clean.`,
        );
      }
    }
  });

  it("REGRESSION: test:python runs under bash, and its script needs it", () => {
    // Named because this is the instance that cost a red CI run, and because a
    // generic loop can pass by simply not finding the entry any more.
    const inv = invocations.find((i) => i.script === "test:python");
    assert.ok(inv, 'no "test:python" shell invocation found in package.json');
    assert.equal(inv!.interpreter, "bash");
    assert.match(
      readFileSync(join(ROOT, inv!.path), "utf8"),
      /set\s+-[a-z]*o\s+pipefail/,
      "the script no longer needs bash; if that is deliberate, this case can go",
    );
  });
});
