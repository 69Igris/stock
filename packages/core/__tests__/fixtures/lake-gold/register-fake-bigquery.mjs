// `node --import tsx --import <this>` resolves `@google-cloud/bigquery` to
// fake-bigquery.cjs for the whole process, so the real job entry runs with no
// network and no credentials. BOTH module systems: tsx runs scripts/ as CJS
// (the root package.json declares no "type"), where only a `require` resolver
// sees the import; the ESM hook covers the same import if it is ever ESM.
// Must be imported AFTER tsx, so this resolver wraps tsx's and runs first.
import Module, { register } from "node:module";
import { fileURLToPath } from "node:url";

const fake = new URL("./fake-bigquery.cjs", import.meta.url);
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === "@google-cloud/bigquery"
    ? fileURLToPath(fake)
    : resolveFilename.call(this, request, ...rest);
};
const hooks =
  "export async function resolve(s, c, next) {" +
  ` return s === "@google-cloud/bigquery" ? { url: ${JSON.stringify(fake.href)}, shortCircuit: true } : next(s, c); }`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
