/**
 * What each `deploy_job` call in a provisioner EFFECTIVELY deploys — MONEY-1609.
 *
 * `job-metrics-path.test.ts` reads a provisioner's `--set-secrets` / `--set-env-vars`
 * as TEXT, which is right for a script that deploys one job and blind for a
 * helper that deploys seven: `setup-lake-jobs.sh`'s helper builds both strings
 * from per-call positional arguments, so the helper's text can carry
 * `DD_API_KEY` while one call site's value displaces or corrupts it. This
 * substitutes each call site's arguments into the helper's template, so a guard
 * can ask about the job rather than about the helper.
 *
 * Narrow on purpose: it models the one helper shape it is used on — a
 * `deploy_job() {` whose first statement is `local a=$1 b=$2 …` — and returns
 * NOTHING for any other file, so a caller must assert it resolved something.
 */

/** Drop whole-line shell comments, keeping everything else byte-identical. */
export const shellCode = (src: string): string =>
  src
    .split("\n")
    .map((l) => (/^\s*#/.test(l) ? "" : l))
    .join("\n");

export interface DeployCall {
  /** The call's quoted arguments, in order, `${…}` left unexpanded. */
  args: string[];
  /** `dist/<entry>.js` → `<entry>`, or null when arg 2 is not one. */
  entry: string | null;
  /** The helper's `--set-secrets` value with this call's arguments substituted. */
  secrets: string;
  /** The helper's `--set-env-vars` value, likewise. */
  envVars: string;
}

export function deployJobCalls(src: string): DeployCall[] {
  const code = shellCode(src);
  const helper = /deploy_job\(\)\s*\{\s*\n\s*local ([^\n]+)/.exec(code);
  if (!helper) return [];
  const params = new Map<string, number>();
  for (const m of helper[1]!.matchAll(/(\w+)=\$(\d)/g)) {
    params.set(m[1]!, Number(m[2]));
  }
  // The helper's own locals, one hop — `local env_vars="${env_extra}DD_ENV=…"`.
  const locals = new Map<string, string>();
  for (const m of code.matchAll(/local (\w+)="([^"]*)"/g)) {
    locals.set(m[1]!, m[2]!);
  }
  const flag = (name: string): string | null => {
    const m = new RegExp(`${name}="([^"]+)"`).exec(code);
    if (!m) return null;
    const ref = /^\$\{?(\w+)\}?$/.exec(m[1]!);
    return ref ? (locals.get(ref[1]!) ?? null) : m[1]!;
  };
  const secretsTpl = flag("--set-secrets");
  const envTpl = flag("--set-env-vars");
  if (secretsTpl === null || envTpl === null) return [];

  const lines = code.split("\n");
  const calls: DeployCall[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*deploy_job\s+"/.test(lines[i]!)) continue;
    let text = lines[i]!;
    while (/\\\s*$/.test(lines[i]!) && i + 1 < lines.length) {
      text += "\n" + lines[++i]!;
    }
    const args = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
    const fill = (tpl: string) =>
      tpl.replace(/\$\{(\w+)\}|\$(\w+)/g, (whole, a?: string, b?: string) => {
        const pos = params.get((a ?? b)!);
        return pos === undefined ? whole : (args[pos - 1] ?? "");
      });
    calls.push({
      args,
      entry: /^dist\/([\w-]+)\.js$/.exec(args[1] ?? "")?.[1] ?? null,
      secrets: fill(secretsTpl),
      envVars: fill(envTpl),
    });
  }
  return calls;
}
