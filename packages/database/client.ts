// Prisma's generated client is CommonJS. Two consumer runtimes need this to
// work without code changes:
//   1. Next.js (webpack bundles for the server). Webpack's interop wraps
//      `import pkg from "@prisma/client"` into a `.default` access. The CJS
//      module exports a NAMESPACE (no `.default` property), so the
//      destructure `const { PrismaClient } = pkg` blows up at runtime with
//      "Cannot destructure property 'PrismaClient' of '...default(...)' as
//      it is undefined" - exactly the dev-server error the user hit.
//   2. Workers (raw Node ESM via tsx). With TS `esModuleInterop: true`,
//      named imports from CJS are rewritten into the same require + .default
//      shape, but `tsx` and modern Node both resolve the named binding via
//      the package's `exports` field correctly.
//
// Named imports work in BOTH runtimes; default-then-destructure only works
// in raw Node ESM, not under webpack. So we use named imports.
import { PrismaClient } from "@prisma/client";
import type { PrismaClient as PrismaClientType } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClientType | undefined;
};

/**
 * Build the datasource URL with connection pool parameters if not already set.
 * MongoDB connection pooling is configured via the connection string, not the
 * PrismaClient constructor. Defaults: maxPoolSize=100 (too high for serverless).
 */
function getDatasourceUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;

  // Only add pool params if not already present in the URL
  if (url.includes("maxPoolSize")) return url;

  const separator = url.includes("?") ? "&" : "?";
  // Keep pool small for serverless (Vercel): each function instance gets its own pool
  return `${url}${separator}maxPoolSize=10&minPoolSize=1`;
}

const datasourceUrl = getDatasourceUrl();

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    ...(datasourceUrl ? { datasourceUrl } : {}),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;
