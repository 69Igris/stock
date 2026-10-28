/**
 * Module-resolution hooks that make `import "./foo.css"` a no-op under
 * `node --test` (MONEY-1192).
 *
 * ## Why
 *
 * The web suite runs on plain `node --import tsx --test`. Node has no idea what
 * CSS is, so any module in a test's import graph that imports a stylesheet dies
 * with a syntax error pointing at the CSS, not at the import:
 *
 *   apps/web/app/chat-blocks.css:14
 *   SyntaxError: Unexpected token ':'
 *
 * That made the standard Next pattern — a stylesheet imported by a client
 * component, bundled into that component's chunk so it loads only where the
 * component renders — unusable for any component a test touches. It is why
 * 117KB of CSS still ships from the root layout to every marketing page
 * (MONEY-1140).
 *
 * Thirteen renderers in components/chat/blocks/ already import CSS and pass,
 * purely because no test imports them. That is an accident holding up a real
 * constraint, and it turns into a baffling failure the first time someone
 * tests a block renderer.
 *
 * ## What this does NOT do
 *
 * It does not parse, validate or apply CSS. A test can never assert anything
 * about styling through this hook, and it should not try — CSS correctness is
 * a build/visual concern. The hook exists so that importing a stylesheet is
 * INERT in a test process, nothing more.
 *
 * ## Chaining
 *
 * `nextResolve` is called for everything else, so tsx's hooks (TypeScript,
 * path aliases) still run. Registering this must not change how any non-CSS
 * specifier resolves.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const STUB_URL = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "css-stub-empty.mjs"),
).href;

/** Any specifier ending in a stylesheet extension, query strings included. */
const STYLESHEET = /\.(css|scss|sass|less)(\?.*)?$/;

export async function resolve(specifier, context, nextResolve) {
  if (STYLESHEET.test(specifier)) {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
