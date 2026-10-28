/**
 * MONEY-620 — document server actions END-TO-END (real action handlers).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (shadow → de-shadow)
 * ───────────────────────────────────────────────────────────────────────────
 * The previous version was a textbook SHADOW. Under a "// Inline logic from
 * source" banner it re-declared `sanitizeFileName`, `generateDocPath`,
 * `validateMimeType`, `validateUploadMetadata`, `validateUrl`,
 * `VALID_CATEGORIES`, a `CATEGORY_MAP`, `validateFY`, a `MockDocumentDB`, and an
 * inline `demoDocuments` literal — then asserted the COPIES. It imported NOTHING
 * from `lib/actions/documents.ts`, so every gate that actually protects a user's
 * documents (the demo short-circuit, the auth gate, the IDOR userId-forwarding,
 * the "no signed URL for a doc you don't own", the "no download URL until READY",
 * and error sanitization) was completely unexercised. The copy could be green
 * while the real action handed a signed GCS URL to the wrong caller.
 *
 * This rewrite drives the REAL exported actions from `lib/actions/documents.ts`
 * through a `require.cache` seam (the established `*-action-e2e` pattern), and
 * asserts the action's OWN logic — NOT the service internals (those are
 * de-shadowed in the services package):
 *
 *   - uploadDocumentAction / importFromUrlAction / fetchNseDocumentAction /
 *     generateReportAction: demo gate → upsell (no GCS/DB/pubsub); unauth →
 *     "Not authenticated"; the userId written to prisma / forwarded to the
 *     service / put on the pubsub job is the CALLER's resolved userId (IDOR);
 *     the SSRF guard blocks a private-range URL before any DB write; a raw DB
 *     throw is sanitized (never leaked).
 *   - getDocumentAction: auth-gates; forwards the caller userId to the service
 *     (IDOR); mints a signed view URL ONLY when the service returns a doc the
 *     caller owns — a not-found / cross-user / errored lookup yields NO signed
 *     URL at all (the load-bearing security contract a service-only test can't
 *     see). No demo gate is fine here (read of own doc); but it must still 401.
 *   - getDownloadUrlAction: same auth + IDOR + signed-URL gating, PLUS the extra
 *     READY gate — a PENDING/PROCESSING document never yields a download URL.
 *   - deleteDocumentAction: demo gate; forwards the caller userId to BOTH the
 *     read and the soft-delete service calls (IDOR); embedding cleanup is scoped
 *     to the caller userId; a failed ownership check deletes NOTHING from GCS.
 *   - getDocumentsAction: demo path returns the static demo docs WITHOUT touching
 *     auth/DB; authed path forwards (userId, validatedFilters) to the service.
 *
 * `@usemoney/validation` and `@usemoney/utils/error-sanitization` are kept REAL so the
 * genuine Zod validation + sanitization run. The GCS / Pub/Sub / jobs / SSRF
 * boundaries are recorded stubs so we assert what the action HANDS them.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: apps/web/lib/actions/documents.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// ── recorders ───────────────────────────────────────────────────────────────

interface PrismaCall {
  model: string;
  method: string;
  args: unknown;
}
interface JobCall {
  args: unknown[];
}
interface PublishCall {
  args: unknown;
}
interface SignedUrlCall {
  path: string;
  opts: unknown;
}
interface ServiceCall {
  fn: string;
  args: unknown[];
}

interface Harness {
  authUser: { userId: string } | null;
  isDemo: boolean;
  // prisma
  prismaCalls: PrismaCall[];
  /** Per `model.method` queued return values (else sensible defaults). */
  prismaReturns: Record<string, unknown>;
  /** Per `model.method` forced rejection. */
  prismaFail: Record<string, Error>;
  // storage
  uploadCalls: Array<{ path: string; size: number; mime: string }>;
  deleteFileCalls: string[];
  signedUrlCalls: SignedUrlCall[];
  /** If set, generateSignedUrl rejects. */
  signedUrlThrows?: Error;
  // pubsub + jobs
  jobCalls: JobCall[];
  publishCalls: PublishCall[];
  /**
   * MONEY-1142 — the plan the tier gate sees. Defaults to an entitled plan
   * because this file's subject is upload / SSRF / validation, not
   * entitlement; the gate itself is covered by
   * `__tests__/subscription/premium-actions-gated.test.ts`. Set to "FREE" to
   * assert the gate actually bites (see the denial case below).
   */
  planId: string;
  /** When true, `getSubscription` returns {success:false} — the shape it
   *  actually returns on failure (it catches internally, never throws). */
  subscriptionFails?: boolean;
  // services
  serviceCalls: ServiceCall[];
  serviceReturns: Record<string, unknown>;
  // ssrf
  ssrfSafe: boolean;
  ssrfCalls: string[];
}

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

// Snapshot the cache entries we overwrite (captured ONCE, before our first stub)
// so the original modules are restored in `after()`. Without this, our stubs for
// `@usemoney/services` / `@usemoney/database` / `@/lib/*` would leak into sibling
// suites that load REAL versions later in the SAME `node --test __tests__/**`
// process (the contamination tax.test.ts guards against).
const priorCacheEntries = new Map<string, { exports: unknown } | undefined>();
function snapshotOnce(path: string): void {
  if (!priorCacheEntries.has(path)) {
    priorCacheEntries.set(path, moduleCache()[path]);
  }
}
function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  // Drop the action module so a later importer re-binds it to the REAL deps.
  delete cache[require.resolve(ACTION_REL)];
}

function freshHarness(): Harness {
  return {
    authUser: { userId: "internal-user-1" },
    isDemo: false,
    prismaCalls: [],
    prismaReturns: {},
    prismaFail: {},
    uploadCalls: [],
    deleteFileCalls: [],
    signedUrlCalls: [],
    jobCalls: [],
    publishCalls: [],
    planId: "PREMIUM",
    serviceCalls: [],
    serviceReturns: {},
    ssrfSafe: true,
    ssrfCalls: [],
  };
}

// A recording prisma double whose only used models are userDocument +
// documentEmbedding. create() returns a row with a generated id by default.
function makeRecordingPrisma(h: Harness): unknown {
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get(_t, method: string) {
          return (args?: unknown) => {
            h.prismaCalls.push({ model: name, method, args });
            const key = `${name}.${method}`;
            const err = h.prismaFail[key];
            if (err) return Promise.reject(err);
            if (key in h.prismaReturns) {
              return Promise.resolve(h.prismaReturns[key]);
            }
            if (method === "create") {
              return Promise.resolve({ id: `${name}-generated-id` });
            }
            if (method === "deleteMany" || method === "updateMany") {
              return Promise.resolve({ count: 1 });
            }
            return Promise.resolve(null);
          };
        },
      }
    );
  const cache: Record<string, unknown> = {};
  return new Proxy(
    {},
    {
      get(_t, name: string) {
        if (name === "then") return undefined;
        if (!(name in cache)) cache[name] = model(name);
        return cache[name];
      },
    }
  );
}

interface ActionResp<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

interface DocumentsActionModule {
  uploadDocumentAction: (
    formData: unknown
  ) => Promise<ActionResp<{ documentId: string }>>;
  importFromUrlAction: (
    url: string,
    category?: string
  ) => Promise<ActionResp<{ documentId: string }>>;
  fetchNseDocumentAction: (
    symbol: string,
    docType: string
  ) => Promise<ActionResp<{ documentId: string }>>;
  getDocumentsAction: (
    filters?: unknown
  ) => Promise<ActionResp<{ documents: unknown[]; total: number }>>;
  getDocumentAction: (
    id: string
  ) => Promise<ActionResp<{ viewUrl: string; storagePath: string }>>;
  getDownloadUrlAction: (
    id: string
  ) => Promise<ActionResp<{ downloadUrl: string; fileName: string }>>;
  deleteDocumentAction: (id: string) => Promise<ActionResp>;
  generateReportAction: (
    type: string,
    params?: { fy?: string }
  ) => Promise<ActionResp<{ documentId: string }>>;
}

const ACTION_REL = "../../lib/actions/documents";

// Static demo docs the action returns on the demo path (stubbed @/lib/demo/data).
const DEMO_DOCS = [
  { id: "doc-1", title: "Demo A" },
  { id: "doc-2", title: "Demo B" },
];

function loadAction(h: Harness): DocumentsActionModule {
  const cache = moduleCache();

  const authPath = require.resolve("../../lib/auth");
  const sessionPath = require.resolve("../../lib/demo/session");
  const dataPath = require.resolve("../../lib/demo/data");
  const storagePath = require.resolve("../../lib/storage");
  const pubsubPath = require.resolve("@usemoney/pubsub/publish");
  const jobsPath = require.resolve("../../lib/jobs/job-service");
  const dbPath = require.resolve("@usemoney/database");
  const servicesPath = require.resolve("@usemoney/services");
  const importPath = require.resolve("@usemoney/core/import");
  const loggerPath = require.resolve("@usemoney/logger");
  const actionPath = require.resolve(ACTION_REL);
  // MONEY-1142 — `premium-gate` imports `@usemoney/services` at module scope,
  // so it must be evicted alongside the action. Left cached, it keeps the
  // binding from whichever services module it FIRST saw, and the stub below is
  // silently ignored — the gate then reads a real (absent) subscription and
  // denies every case, or worse, allows one the test meant to deny.
  const gatePath = require.resolve("../../lib/actions/premium-gate");

  for (const p of [
    authPath,
    sessionPath,
    dataPath,
    storagePath,
    pubsubPath,
    jobsPath,
    dbPath,
    servicesPath,
    importPath,
    loggerPath,
  ]) {
    snapshotOnce(p);
  }

  cache[authPath] = {
    exports: {
      __esModule: true,
      getAuthenticatedUser: () => Promise.resolve(h.authUser),
    },
  };
  cache[sessionPath] = {
    exports: {
      __esModule: true,
      isDemoSession: () => Promise.resolve(h.isDemo),
    },
  };
  cache[dataPath] = {
    exports: { __esModule: true, demoDocuments: DEMO_DOCS },
  };
  cache[storagePath] = {
    exports: {
      __esModule: true,
      uploadFile: (path: string, buf: Buffer, mime: string) => {
        h.uploadCalls.push({ path, size: buf.length, mime });
        return Promise.resolve();
      },
      deleteFile: (path: string) => {
        h.deleteFileCalls.push(path);
        return Promise.resolve();
      },
      generateSignedUrl: (path: string, opts: unknown) => {
        h.signedUrlCalls.push({ path, opts });
        if (h.signedUrlThrows) return Promise.reject(h.signedUrlThrows);
        return Promise.resolve(`https://signed.example/${path}`);
      },
    },
  };
  cache[pubsubPath] = {
    exports: {
      __esModule: true,
      publishDocumentProcessJob: (args: unknown) => {
        h.publishCalls.push({ args });
        return Promise.resolve("pub-msg-id");
      },
    },
  };
  cache[jobsPath] = {
    exports: {
      __esModule: true,
      createJob: (...args: unknown[]) => {
        h.jobCalls.push({ args });
        return Promise.resolve("job-id-1");
      },
    },
  };
  cache[dbPath] = {
    exports: {
      __esModule: true,
      prisma: makeRecordingPrisma(h),
    },
  };
  cache[importPath] = {
    exports: {
      __esModule: true,
      isSafeFetchTarget: (url: string) => {
        h.ssrfCalls.push(url);
        return Promise.resolve(
          h.ssrfSafe ? { safe: true } : { safe: false, reason: "private-range" }
        );
      },
    },
  };
  const silentLogger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
    child() {
      return silentLogger;
    },
  };
  cache[loggerPath] = {
    exports: {
      __esModule: true,
      dbLogger: silentLogger,
      default: silentLogger,
    },
  };

  const svcFn =
    (name: string) =>
    (...args: unknown[]) => {
      h.serviceCalls.push({ fn: name, args });
      return Promise.resolve(
        h.serviceReturns[name] ?? { success: true, data: {} }
      );
    };
  cache[servicesPath] = {
    exports: {
      __esModule: true,
      // MONEY-1142 — `premium-gate` resolves the caller's plan through this.
      // Unmodelled, it is `undefined`, the gate throws, fails CLOSED and every
      // case in this file 403s — which is the gate working, not a test bug.
      getSubscription: (userId: string) =>
        Promise.resolve(
          h.subscriptionFails
            ? { success: false, error: "db unavailable" }
            : { success: true, data: { userId, planId: h.planId } }
        ),
      getDocuments: svcFn("getDocuments"),
      getDocument: svcFn("getDocument"),
      deleteDocument: svcFn("deleteDocument"),
      generateReport: svcFn("generateReport"),
    },
  };

  delete cache[actionPath];
  delete cache[gatePath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as DocumentsActionModule;
}

// A minimal FormData-like for the upload action (it calls .get(key)).
function makeForm(
  fields: Record<string, string>,
  file?: { name: string; type: string; size: number }
): unknown {
  const map = new Map<string, unknown>(Object.entries(fields));
  if (file) {
    map.set("file", {
      name: file.name,
      type: file.type,
      size: file.size,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(file.size)),
    });
  }
  return {
    get: (k: string) => (map.has(k) ? map.get(k) : null),
  };
}

// A DocumentDetail-ish service payload (only the fields the action reads).
function docDetail(
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "doc-xyz",
    title: "My Report",
    storagePath: "documents/internal-user-1/uploads/abc-file.pdf",
    fileName: "file.pdf",
    processingStatus: "READY",
    isEmbedded: false,
    ...over,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-620 — documents actions (real handlers, real Zod, mocked I/O)", () => {
  let h: Harness;
  beforeEach(() => {
    h = freshHarness();
  });
  // Restore the real module cache so our stubs never leak into a sibling suite
  // running later under the full `node --test __tests__/**` glob (single process).
  after(() => {
    restoreCache();
  });

  // ── uploadDocumentAction ────────────────────────────────────────────────
  describe("uploadDocumentAction", () => {
    const okFile = {
      name: "statement.pdf",
      type: "application/pdf",
      size: 1024,
    };

    it("uploads, creates the row + job + publishes — all under the CALLER userId (IDOR)", async () => {
      const action = loadAction(h);
      const res = await action.uploadDocumentAction(
        makeForm({ title: "Q3 Report", category: "TAX_REPORT" }, okFile)
      );
      assert.equal(res.success, true);
      assert.equal(res.data!.documentId, "userDocument-generated-id");

      // GCS path is namespaced to the caller's userId.
      assert.equal(h.uploadCalls.length, 1);
      assert.ok(
        h.uploadCalls[0]!.path.startsWith("documents/internal-user-1/uploads/"),
        h.uploadCalls[0]!.path
      );
      assert.equal(h.uploadCalls[0]!.mime, "application/pdf");

      // DB row carries the caller userId + validated metadata, never a client userId.
      const create = h.prismaCalls.find(
        (c) => c.model === "userDocument" && c.method === "create"
      );
      assert.ok(create);
      const data = (create!.args as { data: Record<string, unknown> }).data;
      assert.equal(data.userId, "internal-user-1");
      assert.equal(data.title, "Q3 Report");
      assert.equal(data.category, "TAX_REPORT");
      assert.equal(data.documentType, "PDF");
      assert.equal(data.sourceType, "UPLOAD");

      // The processing job + pubsub are scoped to the same caller userId.
      assert.equal(
        (h.jobCalls[0]!.args[0] as { userId: string }).userId,
        "internal-user-1"
      );
      const pub = h.publishCalls[0]!.args as {
        userId: string;
        documentId: string;
      };
      assert.equal(pub.userId, "internal-user-1");
      assert.equal(pub.documentId, "userDocument-generated-id");
    });

    it("demo session returns the upsell error — no GCS, no DB, no job", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.uploadDocumentAction(
        makeForm({ title: "X" }, okFile)
      );
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Demo mode/);
      assert.equal(h.uploadCalls.length, 0);
      assert.equal(h.prismaCalls.length, 0);
      assert.equal(h.jobCalls.length, 0);
      assert.equal(h.publishCalls.length, 0);
    });

    it("unauthenticated (non-demo) → Not authenticated, nothing written", async () => {
      h.authUser = null;
      const action = loadAction(h);
      const res = await action.uploadDocumentAction(
        makeForm({ title: "X" }, okFile)
      );
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Not authenticated/);
      assert.equal(h.uploadCalls.length, 0);
      assert.equal(h.prismaCalls.length, 0);
    });

    it("[MONEY-1142] a FREE plan is refused before any upload or write", async () => {
      // `/documents` requires `documentVault` (PREMIUM/ULTIMATE). Until
      // MONEY-1142 this action checked auth and nothing else, so the paywall
      // was the client PageGuard alone — bypassable, and bypassed.
      h.planId = "FREE";
      const action = loadAction(h);
      const res = await action.uploadDocumentAction(
        makeForm({ title: "X" }, okFile)
      );
      assert.equal(res.success, false);
      // The message is what a user READS, so assert it is prose rather than a
      // machine token — `app/risk/client.tsx` throws `new Error(result.error)`
      // straight into a toast, and "UPGRADE_REQUIRED" as a toast is a bug.
      assert.match(res.error ?? "", /paid plan|Upgrade/i);
      assert.doesNotMatch(
        res.error ?? "",
        /^UPGRADE_REQUIRED$/,
        "a raw token must not reach the user"
      );
      // The gate must precede the side effects, not just change the response.
      assert.equal(h.uploadCalls.length, 0, "no file may reach storage");
      assert.equal(h.prismaCalls.length, 0, "no row may be written");
      assert.equal(h.publishCalls.length, 0, "no job may be queued");
    });

    it("[MONEY-1142] a FAILED subscription lookup fails CLOSED", async () => {
      // The load-bearing line is `sub.success ? sub.data.planId : null` — NOT
      // the try/catch, because `getSubscription` catches internally and returns
      // `{success:false}` rather than throwing. A review mutated that ternary's
      // fallback to "PREMIUM" (paywall opens for everyone during any Mongo
      // blip) and 66 tests stayed green, because nothing modelled this shape.
      h.subscriptionFails = true;
      const action = loadAction(h);
      const res = await action.uploadDocumentAction(
        makeForm({ title: "X" }, okFile)
      );
      assert.equal(res.success, false);
      assert.equal(h.uploadCalls.length, 0, "no file may reach storage");
      assert.equal(h.prismaCalls.length, 0, "no row may be written");
    });

    it("[MONEY-1142] an unresolvable plan fails CLOSED", async () => {
      // Fail-open on an infra blip would hand the vault to whoever asks during
      // the blip — the exact failure the gate exists to prevent.
      h.planId = "";
      const action = loadAction(h);
      const res = await action.uploadDocumentAction(
        makeForm({ title: "X" }, okFile)
      );
      assert.equal(res.success, false);
      // The message is what a user READS, so assert it is prose rather than a
      // machine token — `app/risk/client.tsx` throws `new Error(result.error)`
      // straight into a toast, and "UPGRADE_REQUIRED" as a toast is a bug.
      assert.match(res.error ?? "", /paid plan|Upgrade/i);
      assert.doesNotMatch(
        res.error ?? "",
        /^UPGRADE_REQUIRED$/,
        "a raw token must not reach the user"
      );
      assert.equal(h.uploadCalls.length, 0);
    });

    it("rejects a missing file before any upload", async () => {
      const action = loadAction(h);
      const res = await action.uploadDocumentAction(makeForm({ title: "X" }));
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /No file/);
      assert.equal(h.uploadCalls.length, 0);
    });

    it("rejects an unsupported MIME type (real ALLOWED_MIME_TYPES gate)", async () => {
      const action = loadAction(h);
      const res = await action.uploadDocumentAction(
        makeForm(
          { title: "X" },
          { name: "a.zip", type: "application/zip", size: 10 }
        )
      );
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Unsupported file type/);
      assert.equal(h.uploadCalls.length, 0);
      assert.equal(h.prismaCalls.length, 0);
    });

    it("rejects a file over the per-type size limit (10MB image cap)", async () => {
      const action = loadAction(h);
      const res = await action.uploadDocumentAction(
        makeForm(
          { title: "X" },
          {
            name: "huge.png",
            type: "image/png",
            size: 15 * 1024 * 1024,
          }
        )
      );
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /too large/i);
      assert.equal(h.uploadCalls.length, 0);
    });

    it("rejects empty title via the REAL UploadDocumentSchema (no upload)", async () => {
      const action = loadAction(h);
      const res = await action.uploadDocumentAction(
        makeForm(
          { title: "" },
          { name: "x.pdf", type: "application/pdf", size: 5 }
        )
      );
      // title falls back to file.name only when "" is falsy → file.name "x.pdf"
      // is non-empty, so this actually succeeds. Assert the title used is the
      // filename, proving the fallback path runs through the real schema.
      assert.equal(res.success, true);
      const create = h.prismaCalls.find((c) => c.method === "create");
      assert.equal(
        (create!.args as { data: { title: string } }).data.title,
        "x.pdf"
      );
    });

    it("a raw GCS throw is sanitized (no internal leak)", async () => {
      const action = loadAction(h);
      // Force the upload boundary to throw an internal-looking error.
      h.uploadCalls = []; // reset
      const cache = moduleCache();
      const storagePath = require.resolve("../../lib/storage");
      (cache[storagePath]!.exports as { uploadFile: unknown }).uploadFile =
        () =>
          Promise.reject(new Error("ECONNREFUSED 10.0.0.5:443 internal-gcs"));
      const res = await action.uploadDocumentAction(
        makeForm({ title: "Q3" }, okFile)
      );
      assert.equal(res.success, false);
      // sanitized bucket for connection errors — not the raw internal message.
      assert.equal(res.error, "Connection error - please try again");
      assert.ok(!/10\.0\.0\.5/.test(res.error ?? ""));
    });
  });

  // ── importFromUrlAction ─────────────────────────────────────────────────
  describe("importFromUrlAction", () => {
    it("SSRF: a private-range URL is blocked BEFORE any DB write", async () => {
      h.ssrfSafe = false;
      const action = loadAction(h);
      const res = await action.importFromUrlAction(
        "http://169.254.169.254/latest"
      );
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /cannot be imported/);
      assert.equal(h.ssrfCalls.length, 1);
      assert.equal(h.prismaCalls.length, 0, "no row for a blocked SSRF target");
      assert.equal(h.jobCalls.length, 0);
    });

    it("safe URL: creates the row + job under the caller userId", async () => {
      const action = loadAction(h);
      const res = await action.importFromUrlAction(
        "https://nseindia.com/r.pdf"
      );
      assert.equal(res.success, true);
      const create = h.prismaCalls.find((c) => c.method === "create");
      const data = (create!.args as { data: Record<string, unknown> }).data;
      assert.equal(data.userId, "internal-user-1");
      assert.equal(data.sourceType, "URL");
      assert.equal(data.originalUrl, "https://nseindia.com/r.pdf");
      // pubsub job carries the same caller userId.
      assert.equal(
        (h.publishCalls[0]!.args as { userId: string }).userId,
        "internal-user-1"
      );
    });

    it("rejects a malformed URL via the REAL ImportUrlSchema (no SSRF, no DB)", async () => {
      const action = loadAction(h);
      const res = await action.importFromUrlAction("not-a-url");
      assert.equal(res.success, false);
      assert.equal(h.ssrfCalls.length, 0);
      assert.equal(h.prismaCalls.length, 0);
    });

    it("demo gate short-circuits before the SSRF check + DB", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.importFromUrlAction(
        "https://nseindia.com/r.pdf"
      );
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Demo mode/);
      assert.equal(h.ssrfCalls.length, 0);
      assert.equal(h.prismaCalls.length, 0);
    });
  });

  // ── fetchNseDocumentAction ──────────────────────────────────────────────
  describe("fetchNseDocumentAction", () => {
    it("creates an NSE row scoped to the caller userId + valid docType", async () => {
      const action = loadAction(h);
      const res = await action.fetchNseDocumentAction(
        "RELIANCE",
        "annual_report"
      );
      assert.equal(res.success, true);
      const create = h.prismaCalls.find((c) => c.method === "create");
      const data = (create!.args as { data: Record<string, unknown> }).data;
      assert.equal(data.userId, "internal-user-1");
      assert.equal(data.sourceType, "NSE_FETCH");
      assert.deepEqual(data.metadata, {
        symbol: "RELIANCE",
        docType: "annual_report",
      });
    });

    it("rejects an unknown docType via the REAL schema (no DB)", async () => {
      const action = loadAction(h);
      const res = await action.fetchNseDocumentAction(
        "RELIANCE",
        "made_up_type"
      );
      assert.equal(res.success, false);
      assert.equal(h.prismaCalls.length, 0);
    });

    it("demo gate short-circuits", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.fetchNseDocumentAction(
        "RELIANCE",
        "annual_report"
      );
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Demo mode/);
      assert.equal(h.prismaCalls.length, 0);
    });
  });

  // ── getDocumentsAction ──────────────────────────────────────────────────
  describe("getDocumentsAction", () => {
    it("demo path returns the static demo docs WITHOUT auth or the service", async () => {
      h.isDemo = true;
      h.authUser = null; // prove auth isn't even consulted on the demo path
      const action = loadAction(h);
      const res = await action.getDocumentsAction({ skip: 0, limit: 20 });
      assert.equal(res.success, true);
      assert.equal(res.data!.total, DEMO_DOCS.length);
      assert.equal(res.data!.documents.length, DEMO_DOCS.length);
      assert.equal(h.serviceCalls.length, 0);
      assert.equal(h.prismaCalls.length, 0);
    });

    it("authed path forwards (userId, validatedFilters) to the service", async () => {
      h.serviceReturns.getDocuments = {
        success: true,
        data: { documents: [{ id: "svc" }], total: 1 },
      };
      const action = loadAction(h);
      const res = await action.getDocumentsAction({
        skip: 5,
        limit: 10,
        category: "TAX_REPORT",
      });
      assert.equal(res.success, true);
      const call = h.serviceCalls.find((c) => c.fn === "getDocuments");
      assert.ok(call);
      assert.equal(call!.args[0], "internal-user-1");
      const filters = call!.args[1] as Record<string, unknown>;
      assert.equal(filters.skip, 5);
      assert.equal(filters.limit, 10);
      assert.equal(filters.category, "TAX_REPORT");
    });

    it("unauthenticated (non-demo) → Not authenticated, no service", async () => {
      h.authUser = null;
      const action = loadAction(h);
      const res = await action.getDocumentsAction({ skip: 0, limit: 20 });
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Not authenticated/);
      assert.equal(h.serviceCalls.length, 0);
    });
  });

  // ── getDocumentAction (signed-URL gating is the security crux) ───────────
  describe("getDocumentAction", () => {
    it("mints a signed view URL ONLY for a doc the caller owns (forwards userId)", async () => {
      h.serviceReturns.getDocument = { success: true, data: docDetail() };
      const action = loadAction(h);
      const res = await action.getDocumentAction("doc-xyz");
      assert.equal(res.success, true);
      // IDOR: the ownership lookup used the caller's resolved userId.
      const call = h.serviceCalls.find((c) => c.fn === "getDocument");
      assert.equal(call!.args[0], "internal-user-1");
      assert.equal(call!.args[1], "doc-xyz");
      // Signed URL minted from the OWNED doc's storagePath.
      assert.equal(h.signedUrlCalls.length, 1);
      assert.equal(
        h.signedUrlCalls[0]!.path,
        "documents/internal-user-1/uploads/abc-file.pdf"
      );
      assert.ok(res.data!.viewUrl.startsWith("https://signed.example/"));
    });

    it("a not-found / cross-user lookup yields NO signed URL (the IDOR wall)", async () => {
      // The service is IDOR-scoped: another user's id resolves to not-found.
      h.serviceReturns.getDocument = {
        success: false,
        error: "Document not found",
      };
      const action = loadAction(h);
      const res = await action.getDocumentAction("someone-elses-doc");
      assert.equal(res.success, false);
      assert.equal(
        h.signedUrlCalls.length,
        0,
        "must NOT sign a URL for a doc the caller does not own"
      );
    });

    it("a successful lookup with no data → not found, still NO signed URL", async () => {
      h.serviceReturns.getDocument = { success: true, data: null };
      const action = loadAction(h);
      const res = await action.getDocumentAction("doc-xyz");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /not found/i);
      assert.equal(h.signedUrlCalls.length, 0);
    });

    it("unauthenticated → Not authenticated, no service, no signed URL", async () => {
      h.authUser = null;
      const action = loadAction(h);
      const res = await action.getDocumentAction("doc-xyz");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Not authenticated/);
      assert.equal(h.serviceCalls.length, 0);
      assert.equal(h.signedUrlCalls.length, 0);
    });

    it("a signed-URL boundary throw is sanitized (no internal leak)", async () => {
      h.serviceReturns.getDocument = { success: true, data: docDetail() };
      h.signedUrlThrows = new Error("ETIMEDOUT signing key vault 10.1.2.3");
      const action = loadAction(h);
      const res = await action.getDocumentAction("doc-xyz");
      assert.equal(res.success, false);
      assert.equal(res.error, "Request timed out - please try again");
      assert.ok(!/10\.1\.2\.3/.test(res.error ?? ""));
    });
  });

  // ── getDownloadUrlAction (auth + IDOR + READY gate) ─────────────────────
  describe("getDownloadUrlAction", () => {
    it("mints an attachment download URL for an owned READY doc", async () => {
      h.serviceReturns.getDocument = {
        success: true,
        data: docDetail({ processingStatus: "READY", fileName: "report.pdf" }),
      };
      const action = loadAction(h);
      const res = await action.getDownloadUrlAction("doc-xyz");
      assert.equal(res.success, true);
      assert.equal(res.data!.fileName, "report.pdf");
      assert.equal(h.signedUrlCalls.length, 1);
      assert.equal(
        (h.signedUrlCalls[0]!.opts as { contentDisposition: string })
          .contentDisposition,
        "attachment"
      );
      // MONEY-1074: the download must be named after the human fileName, not the
      // storage-key leaf.
      assert.equal(
        (h.signedUrlCalls[0]!.opts as { downloadFilename?: string })
          .downloadFilename,
        "report.pdf"
      );
      // IDOR scoping.
      assert.equal(
        h.serviceCalls.find((c) => c.fn === "getDocument")!.args[0],
        "internal-user-1"
      );
    });

    it("a PENDING doc yields NO download URL (READY gate)", async () => {
      h.serviceReturns.getDocument = {
        success: true,
        data: docDetail({ processingStatus: "PENDING" }),
      };
      const action = loadAction(h);
      const res = await action.getDownloadUrlAction("doc-xyz");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /not ready/i);
      assert.equal(h.signedUrlCalls.length, 0, "no URL until READY");
    });

    it("a not-found lookup yields NO download URL", async () => {
      h.serviceReturns.getDocument = {
        success: false,
        error: "Document not found",
      };
      const action = loadAction(h);
      const res = await action.getDownloadUrlAction("nope");
      assert.equal(res.success, false);
      assert.equal(h.signedUrlCalls.length, 0);
    });

    it("unauthenticated → Not authenticated, no service, no URL", async () => {
      h.authUser = null;
      const action = loadAction(h);
      const res = await action.getDownloadUrlAction("doc-xyz");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Not authenticated/);
      assert.equal(h.signedUrlCalls.length, 0);
    });
  });

  // ── deleteDocumentAction (IDOR on read + soft-delete + embeddings) ───────
  describe("deleteDocumentAction", () => {
    it("forwards the caller userId to BOTH the read and delete service calls (IDOR)", async () => {
      h.serviceReturns.getDocument = {
        success: true,
        data: docDetail({ isEmbedded: false }),
      };
      h.serviceReturns.deleteDocument = { success: true, data: undefined };
      const action = loadAction(h);
      const res = await action.deleteDocumentAction("doc-xyz");
      assert.equal(res.success, true);
      const get = h.serviceCalls.find((c) => c.fn === "getDocument");
      const del = h.serviceCalls.find((c) => c.fn === "deleteDocument");
      assert.equal(get!.args[0], "internal-user-1");
      assert.equal(del!.args[0], "internal-user-1");
      assert.deepEqual(del!.args, ["internal-user-1", "doc-xyz"]);
      // GCS cleanup ran for the owned doc.
      assert.deepEqual(h.deleteFileCalls, [
        "documents/internal-user-1/uploads/abc-file.pdf",
      ]);
    });

    it("when ownership lookup fails, deletes NOTHING (no service delete, no GCS)", async () => {
      h.serviceReturns.getDocument = {
        success: false,
        error: "Document not found",
      };
      const action = loadAction(h);
      const res = await action.deleteDocumentAction("someone-elses-doc");
      assert.equal(res.success, false);
      assert.equal(
        h.serviceCalls.some((c) => c.fn === "deleteDocument"),
        false,
        "must not soft-delete a doc the caller does not own"
      );
      assert.equal(h.deleteFileCalls.length, 0);
    });

    it("embedding cleanup is scoped to the caller userId + this doc", async () => {
      h.serviceReturns.getDocument = {
        success: true,
        data: docDetail({ id: "doc-emb", isEmbedded: true }),
      };
      h.serviceReturns.deleteDocument = { success: true, data: undefined };
      const action = loadAction(h);
      const res = await action.deleteDocumentAction("doc-emb");
      assert.equal(res.success, true);
      const del = h.prismaCalls.find(
        (c) => c.model === "documentEmbedding" && c.method === "deleteMany"
      );
      assert.ok(del, "embeddings must be deleted when isEmbedded");
      const where = (del!.args as { where: Record<string, unknown> }).where;
      assert.equal(where.userId, "internal-user-1");
      assert.equal(where.docId, "doc-emb");
      assert.equal(where.docType, "document");
    });

    it("a GCS delete failure is swallowed — the delete still succeeds", async () => {
      h.serviceReturns.getDocument = {
        success: true,
        data: docDetail({ isEmbedded: false }),
      };
      h.serviceReturns.deleteDocument = { success: true, data: undefined };
      const action = loadAction(h);
      const cache = moduleCache();
      const storagePath = require.resolve("../../lib/storage");
      (cache[storagePath]!.exports as { deleteFile: unknown }).deleteFile =
        () => Promise.reject(new Error("gcs gone"));
      const res = await action.deleteDocumentAction("doc-xyz");
      assert.equal(res.success, true, "GCS cleanup is best-effort");
    });

    it("demo gate short-circuits before any service/GCS", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.deleteDocumentAction("doc-xyz");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Demo mode/);
      assert.equal(h.serviceCalls.length, 0);
      assert.equal(h.deleteFileCalls.length, 0);
    });

    it("unauthenticated → Not authenticated, nothing deleted", async () => {
      h.authUser = null;
      const action = loadAction(h);
      const res = await action.deleteDocumentAction("doc-xyz");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Not authenticated/);
      assert.equal(h.serviceCalls.length, 0);
    });
  });

  // ── generateReportAction ────────────────────────────────────────────────
  describe("generateReportAction", () => {
    it("forwards the caller userId to the service + publishes the job", async () => {
      h.serviceReturns.generateReport = {
        success: true,
        data: { documentId: "report-1" },
      };
      const action = loadAction(h);
      const res = await action.generateReportAction("tax", { fy: "2025-26" });
      assert.equal(res.success, true);
      assert.equal(res.data!.documentId, "report-1");
      const call = h.serviceCalls.find((c) => c.fn === "generateReport");
      assert.equal(call!.args[0], "internal-user-1");
      assert.equal(call!.args[1], "tax");
      // pubsub job carries the service-minted documentId + caller userId.
      const pub = h.publishCalls[0]!.args as {
        userId: string;
        documentId: string;
      };
      assert.equal(pub.userId, "internal-user-1");
      assert.equal(pub.documentId, "report-1");
    });

    it("rejects an unknown report type via the REAL schema (no service)", async () => {
      const action = loadAction(h);
      const res = await action.generateReportAction("made_up");
      assert.equal(res.success, false);
      assert.equal(h.serviceCalls.length, 0);
    });

    it("rejects a malformed FY via the REAL schema", async () => {
      const action = loadAction(h);
      const res = await action.generateReportAction("tax", { fy: "2025" });
      assert.equal(res.success, false);
      assert.equal(h.serviceCalls.length, 0);
    });

    it("a service failure does NOT publish a job", async () => {
      h.serviceReturns.generateReport = {
        success: false,
        error: "Failed to create report record",
      };
      const action = loadAction(h);
      const res = await action.generateReportAction("risk");
      assert.equal(res.success, false);
      assert.equal(
        h.publishCalls.length,
        0,
        "no job for a failed report record"
      );
    });

    it("demo gate short-circuits", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.generateReportAction("tax");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Demo mode/);
      assert.equal(h.serviceCalls.length, 0);
    });
  });
});
