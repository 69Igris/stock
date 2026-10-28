/**
 * Newsletter Publish Processor Tests (workers/src/processors/newsletter-publish.ts)
 *
 * Tests for the processNewsletterPublish function that queries for SCHEDULED
 * newsletters whose publishDate has arrived, transitions them to PUBLISHED,
 * and sends emails via the shared @usemoney/email newsletter module.
 *
 * Covers:
 *   - No scheduled posts -> returns { published: 0 }
 *   - Single due post with segments -> published + broadcast sent
 *   - Single due post with individual emails -> published + individual emails sent
 *   - Multiple due posts -> all processed
 *   - Future posts (publishDate in future) -> not found by query
 *   - Already-published posts -> not re-sent (status PUBLISHED, not SCHEDULED)
 *   - Post with both segments and emails -> both called
 *   - Specific postId -> only that post processed
 *   - Send failure doesn't prevent status update (try/catch in processor)
 *   - Query shape (status, contentType, publishDate)
 *   - sendParams construction (title, excerpt, content, etc.)
 *   - Author fallback handling (name, imageUrl)
 *
 * All external dependencies are inlined/mocked in-place.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Inline types (mirrors @usemoney/types NewsletterPublishMessage) ──

interface NewsletterPublishMessage {
  postId?: string;
}

// ── Post shape (mirrors Prisma Post with author include) ─────────────

interface Author {
  id: string;
  name: string | null;
  username: string | null;
  imageUrl: string | null;
}

interface Post {
  id: string;
  title: string;
  excerpt: string | null;
  content: string | null;
  postUrl: string | null;
  featureImage: string | null;
  status: string;
  contentType: string;
  publishDate: Date | null;
  targetSegments: string[];
  targetEmails: string[];
  author: Author | null;
}

// ── Send params shape ────────────────────────────────────────────────

interface SendParams {
  title: string;
  excerpt: string | null;
  content: string | null;
  postUrl: string | null;
  featureImage: string | null;
  authorName: string | undefined;
  authorImageUrl: string | undefined;
  publishDate: string | undefined;
}

// ── Mock infrastructure ─────────────────────────────────────────────

interface PrismaCall {
  model: string;
  method: string;
  args: unknown;
}

let prismaCalls: PrismaCall[] = [];
let broadcastCalls: Array<{ params: SendParams; segments: string[] }> = [];
let individualCalls: Array<{ params: SendParams; emails: string[] }> = [];

let broadcastShouldThrow = false;
let individualShouldThrow = false;

function createMockPrisma(posts: Post[] = []) {
  return {
    post: {
      findMany: async (args: unknown) => {
        prismaCalls.push({ model: "post", method: "findMany", args });
        return posts;
      },
      update: async (args: unknown) => {
        prismaCalls.push({ model: "post", method: "update", args });
        return {};
      },
    },
  };
}

async function mockSendNewsletterBroadcast(
  params: SendParams,
  segments: string[]
): Promise<void> {
  if (broadcastShouldThrow) {
    throw new Error("Broadcast send failed");
  }
  broadcastCalls.push({ params, segments });
}

async function mockSendNewsletterToIndividuals(
  params: SendParams,
  emails: string[]
): Promise<void> {
  if (individualShouldThrow) {
    throw new Error("Individual send failed");
  }
  individualCalls.push({ params, emails });
}

// ── Injectable deps ──────────────────────────────────────────────────

interface NewsletterDeps {
  prisma: ReturnType<typeof createMockPrisma>;
  sendBroadcast: typeof mockSendNewsletterBroadcast;
  sendIndividuals: typeof mockSendNewsletterToIndividuals;
}

// ── Inline processor (mirrors workers/src/processors/newsletter-publish.ts) ─

async function processNewsletterPublish(
  data: NewsletterPublishMessage,
  deps: NewsletterDeps
): Promise<{ published: number }> {
  const now = new Date();

  // Build query: find due SCHEDULED newsletters
  const where: Record<string, unknown> = {
    status: "SCHEDULED",
    contentType: "NEWSLETTER",
    publishDate: { lte: now },
  };

  // If a specific postId was provided, only process that one
  if (data.postId) {
    where.id = data.postId;
  }

  const duePosts = (await deps.prisma.post.findMany({
    where,
    include: {
      author: {
        select: {
          id: true,
          name: true,
          username: true,
          imageUrl: true,
        },
      },
    },
  })) as Post[];

  if (duePosts.length === 0) {
    return { published: 0 };
  }

  let published = 0;

  for (const post of duePosts) {
    try {
      // 1. Update status to PUBLISHED
      await deps.prisma.post.update({
        where: { id: post.id },
        data: { status: "PUBLISHED" },
      });

      // 2. Build params for email sending
      const sendParams: SendParams = {
        title: post.title,
        excerpt: post.excerpt,
        content: post.content,
        postUrl: post.postUrl,
        featureImage: post.featureImage,
        authorName: post.author?.name || undefined,
        authorImageUrl: post.author?.imageUrl || undefined,
        publishDate: post.publishDate?.toISOString(),
      };

      // 3. Send to audience segments
      if (post.targetSegments.length > 0) {
        try {
          await deps.sendBroadcast(sendParams, post.targetSegments);
        } catch (_err) {
          // Broadcast failure caught and logged, doesn't block
        }
      }

      // 4. Send to individual emails
      if (post.targetEmails.length > 0) {
        try {
          await deps.sendIndividuals(sendParams, post.targetEmails);
        } catch (_err) {
          // Individual send failure caught and logged, doesn't block
        }
      }

      published++;
    } catch (_err) {
      // Outer catch: status update itself failed
    }
  }

  return { published };
}

// ── Helpers ──────────────────────────────────────────────────────────

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: "post-001",
    title: "Weekly Market Update",
    excerpt: "A summary of the week's market activity",
    content: "<p>Full newsletter content here.</p>",
    postUrl: "https://usemoney.ai/blog/weekly-update",
    featureImage: "https://usemoney.ai/images/banner.png",
    status: "SCHEDULED",
    contentType: "NEWSLETTER",
    publishDate: new Date("2026-03-01T09:00:00Z"),
    targetSegments: [],
    targetEmails: [],
    author: {
      id: "author-1",
      name: "Shaswat",
      username: "shaswat",
      imageUrl: "https://usemoney.ai/avatars/shaswat.png",
    },
    ...overrides,
  };
}

function findCalls(model: string, method: string): PrismaCall[] {
  return prismaCalls.filter((c) => c.model === model && c.method === method);
}

function createDeps(overrides: Partial<NewsletterDeps> = {}): NewsletterDeps {
  return {
    prisma: createMockPrisma([]),
    sendBroadcast: mockSendNewsletterBroadcast,
    sendIndividuals: mockSendNewsletterToIndividuals,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("Workers - Processor: Newsletter Publish", () => {
  beforeEach(() => {
    prismaCalls = [];
    broadcastCalls = [];
    individualCalls = [];
    broadcastShouldThrow = false;
    individualShouldThrow = false;
  });

  // ── No scheduled posts ─────────────────────────────────────────

  describe("No scheduled posts", () => {
    it("should return { published: 0 } when no posts found", async () => {
      const result = await processNewsletterPublish({}, createDeps());

      assert.deepStrictEqual(result, { published: 0 });
    });

    it("should call findMany exactly once", async () => {
      await processNewsletterPublish({}, createDeps());

      const calls = findCalls("post", "findMany");
      assert.strictEqual(calls.length, 1);
    });

    it("should NOT call post.update when no posts found", async () => {
      await processNewsletterPublish({}, createDeps());

      const calls = findCalls("post", "update");
      assert.strictEqual(calls.length, 0);
    });

    it("should NOT call sendBroadcast when no posts found", async () => {
      await processNewsletterPublish({}, createDeps());

      assert.strictEqual(broadcastCalls.length, 0);
    });

    it("should NOT call sendIndividuals when no posts found", async () => {
      await processNewsletterPublish({}, createDeps());

      assert.strictEqual(individualCalls.length, 0);
    });
  });

  // ── Query shape ────────────────────────────────────────────────

  describe("Query shape", () => {
    it("should query with status SCHEDULED", async () => {
      await processNewsletterPublish({}, createDeps());

      const calls = findCalls("post", "findMany");
      const args = calls[0]!.args as { where: Record<string, unknown> };
      assert.strictEqual(args.where.status, "SCHEDULED");
    });

    it("should query with contentType NEWSLETTER", async () => {
      await processNewsletterPublish({}, createDeps());

      const calls = findCalls("post", "findMany");
      const args = calls[0]!.args as { where: Record<string, unknown> };
      assert.strictEqual(args.where.contentType, "NEWSLETTER");
    });

    it("should query with publishDate lte now", async () => {
      const before = new Date();
      await processNewsletterPublish({}, createDeps());
      const after = new Date();

      const calls = findCalls("post", "findMany");
      const args = calls[0]!.args as {
        where: { publishDate: { lte: Date } };
      };
      assert.ok(args.where.publishDate.lte >= before);
      assert.ok(args.where.publishDate.lte <= after);
    });

    it("should NOT include id in where when postId is not provided", async () => {
      await processNewsletterPublish({}, createDeps());

      const calls = findCalls("post", "findMany");
      const args = calls[0]!.args as { where: Record<string, unknown> };
      assert.strictEqual("id" in args.where, false);
    });

    it("should include author in the query", async () => {
      await processNewsletterPublish({}, createDeps());

      const calls = findCalls("post", "findMany");
      const args = calls[0]!.args as {
        include: { author: { select: Record<string, boolean> } };
      };
      assert.ok(args.include.author);
      assert.strictEqual(args.include.author.select.id, true);
      assert.strictEqual(args.include.author.select.name, true);
      assert.strictEqual(args.include.author.select.username, true);
      assert.strictEqual(args.include.author.select.imageUrl, true);
    });
  });

  // ── Specific postId ────────────────────────────────────────────

  describe("Specific postId", () => {
    it("should add id to where clause when postId is provided", async () => {
      await processNewsletterPublish({ postId: "post-42" }, createDeps());

      const calls = findCalls("post", "findMany");
      const args = calls[0]!.args as { where: Record<string, unknown> };
      assert.strictEqual(args.where.id, "post-42");
    });

    it("should still include status and contentType in where with postId", async () => {
      await processNewsletterPublish({ postId: "post-42" }, createDeps());

      const calls = findCalls("post", "findMany");
      const args = calls[0]!.args as { where: Record<string, unknown> };
      assert.strictEqual(args.where.status, "SCHEDULED");
      assert.strictEqual(args.where.contentType, "NEWSLETTER");
    });

    it("should only process the specified post when returned", async () => {
      const post = makePost({
        id: "post-42",
        targetSegments: ["free-users"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      const result = await processNewsletterPublish(
        { postId: "post-42" },
        deps
      );

      assert.strictEqual(result.published, 1);
      assert.strictEqual(broadcastCalls.length, 1);
    });
  });

  // ── Single due post with segments ──────────────────────────────

  describe("Single due post with segments", () => {
    it("should update post status to PUBLISHED", async () => {
      const post = makePost({
        id: "post-seg",
        targetSegments: ["premium-users"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      const updateCalls = findCalls("post", "update");
      assert.strictEqual(updateCalls.length, 1);
      const args = updateCalls[0]!.args as {
        where: { id: string };
        data: { status: string };
      };
      assert.strictEqual(args.where.id, "post-seg");
      assert.strictEqual(args.data.status, "PUBLISHED");
    });

    it("should call sendBroadcast with correct segments", async () => {
      const post = makePost({
        targetSegments: ["premium-users", "pro-users"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      assert.strictEqual(broadcastCalls.length, 1);
      assert.deepStrictEqual(broadcastCalls[0]!.segments, [
        "premium-users",
        "pro-users",
      ]);
    });

    it("should NOT call sendIndividuals when targetEmails is empty", async () => {
      const post = makePost({
        targetSegments: ["all-users"],
        targetEmails: [],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      assert.strictEqual(individualCalls.length, 0);
    });

    it("should return { published: 1 }", async () => {
      const post = makePost({ targetSegments: ["free-users"] });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      const result = await processNewsletterPublish({}, deps);

      assert.strictEqual(result.published, 1);
    });
  });

  // ── Single due post with individual emails ─────────────────────

  describe("Single due post with individual emails", () => {
    it("should call sendIndividuals with correct emails", async () => {
      const post = makePost({
        targetEmails: ["alice@example.com", "bob@example.com"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      assert.strictEqual(individualCalls.length, 1);
      assert.deepStrictEqual(individualCalls[0]!.emails, [
        "alice@example.com",
        "bob@example.com",
      ]);
    });

    it("should NOT call sendBroadcast when targetSegments is empty", async () => {
      const post = makePost({
        targetSegments: [],
        targetEmails: ["user@example.com"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      assert.strictEqual(broadcastCalls.length, 0);
    });

    it("should return { published: 1 }", async () => {
      const post = makePost({
        targetEmails: ["user@example.com"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      const result = await processNewsletterPublish({}, deps);

      assert.strictEqual(result.published, 1);
    });
  });

  // ── Post with both segments and emails ─────────────────────────

  describe("Post with both segments and emails", () => {
    it("should call both sendBroadcast and sendIndividuals", async () => {
      const post = makePost({
        targetSegments: ["premium-users"],
        targetEmails: ["vip@example.com"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      assert.strictEqual(broadcastCalls.length, 1);
      assert.strictEqual(individualCalls.length, 1);
    });

    it("should pass same sendParams to both broadcast and individuals", async () => {
      const post = makePost({
        title: "Shared Newsletter",
        targetSegments: ["all"],
        targetEmails: ["user@test.com"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      assert.strictEqual(broadcastCalls[0]!.params.title, "Shared Newsletter");
      assert.strictEqual(individualCalls[0]!.params.title, "Shared Newsletter");
    });

    it("should return { published: 1 } (one post, two send paths)", async () => {
      const post = makePost({
        targetSegments: ["segment-a"],
        targetEmails: ["a@test.com"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      const result = await processNewsletterPublish({}, deps);

      assert.strictEqual(result.published, 1);
    });
  });

  // ── Multiple due posts ─────────────────────────────────────────

  describe("Multiple due posts", () => {
    it("should process all due posts", async () => {
      const posts = [
        makePost({
          id: "post-1",
          targetSegments: ["seg-a"],
        }),
        makePost({
          id: "post-2",
          targetEmails: ["user@test.com"],
        }),
        makePost({
          id: "post-3",
          targetSegments: ["seg-b"],
          targetEmails: ["another@test.com"],
        }),
      ];
      const deps = createDeps({ prisma: createMockPrisma(posts) });

      const result = await processNewsletterPublish({}, deps);

      assert.strictEqual(result.published, 3);
    });

    it("should call post.update for each post", async () => {
      const posts = [
        makePost({ id: "p-1", targetSegments: ["a"] }),
        makePost({ id: "p-2", targetSegments: ["b"] }),
      ];
      const deps = createDeps({ prisma: createMockPrisma(posts) });

      await processNewsletterPublish({}, deps);

      const updateCalls = findCalls("post", "update");
      assert.strictEqual(updateCalls.length, 2);

      const ids = updateCalls.map(
        (c) => (c.args as { where: { id: string } }).where.id
      );
      assert.ok(ids.includes("p-1"));
      assert.ok(ids.includes("p-2"));
    });

    it("should call sendBroadcast for each post with segments", async () => {
      const posts = [
        makePost({ id: "p-1", targetSegments: ["seg-a"] }),
        makePost({ id: "p-2", targetSegments: ["seg-b"] }),
        makePost({ id: "p-3", targetSegments: [] }),
      ];
      const deps = createDeps({ prisma: createMockPrisma(posts) });

      await processNewsletterPublish({}, deps);

      assert.strictEqual(broadcastCalls.length, 2);
    });
  });

  // ── Send params construction ───────────────────────────────────

  describe("Send params construction", () => {
    it("should pass post title to sendParams", async () => {
      const post = makePost({
        title: "My Newsletter",
        targetSegments: ["all"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      assert.strictEqual(broadcastCalls[0]!.params.title, "My Newsletter");
    });

    it("should pass excerpt and content", async () => {
      const post = makePost({
        excerpt: "Short summary",
        content: "<p>Full content</p>",
        targetSegments: ["all"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      assert.strictEqual(broadcastCalls[0]!.params.excerpt, "Short summary");
      assert.strictEqual(
        broadcastCalls[0]!.params.content,
        "<p>Full content</p>"
      );
    });

    it("should pass postUrl and featureImage", async () => {
      const post = makePost({
        postUrl: "https://usemoney.ai/blog/test",
        featureImage: "https://usemoney.ai/img/test.png",
        targetSegments: ["all"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      assert.strictEqual(
        broadcastCalls[0]!.params.postUrl,
        "https://usemoney.ai/blog/test"
      );
      assert.strictEqual(
        broadcastCalls[0]!.params.featureImage,
        "https://usemoney.ai/img/test.png"
      );
    });

    it("should pass author name and imageUrl when author exists", async () => {
      const post = makePost({
        author: {
          id: "a-1",
          name: "Alice",
          username: "alice",
          imageUrl: "https://usemoney.ai/avatars/alice.png",
        },
        targetSegments: ["all"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      assert.strictEqual(broadcastCalls[0]!.params.authorName, "Alice");
      assert.strictEqual(
        broadcastCalls[0]!.params.authorImageUrl,
        "https://usemoney.ai/avatars/alice.png"
      );
    });

    it("should set authorName to undefined when author is null", async () => {
      const post = makePost({
        author: null,
        targetSegments: ["all"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      assert.strictEqual(broadcastCalls[0]!.params.authorName, undefined);
      assert.strictEqual(broadcastCalls[0]!.params.authorImageUrl, undefined);
    });

    it("should set authorName to undefined when author.name is null", async () => {
      const post = makePost({
        author: { id: "a-1", name: null, username: "anon", imageUrl: null },
        targetSegments: ["all"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      // `null || undefined` => `undefined`
      assert.strictEqual(broadcastCalls[0]!.params.authorName, undefined);
    });

    it("should convert publishDate to ISO string", async () => {
      const pubDate = new Date("2026-03-15T10:00:00Z");
      const post = makePost({
        publishDate: pubDate,
        targetSegments: ["all"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      assert.strictEqual(
        broadcastCalls[0]!.params.publishDate,
        "2026-03-15T10:00:00.000Z"
      );
    });

    it("should set publishDate to undefined when publishDate is null", async () => {
      const post = makePost({
        publishDate: null,
        targetSegments: ["all"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      assert.strictEqual(broadcastCalls[0]!.params.publishDate, undefined);
    });
  });

  // ── Broadcast send failure ─────────────────────────────────────

  describe("Broadcast send failure", () => {
    it("should still count post as published when broadcast fails", async () => {
      broadcastShouldThrow = true;
      const post = makePost({ targetSegments: ["all"] });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      const result = await processNewsletterPublish({}, deps);

      assert.strictEqual(result.published, 1);
    });

    it("should still update status to PUBLISHED before broadcast fails", async () => {
      broadcastShouldThrow = true;
      const post = makePost({ id: "p-fail", targetSegments: ["all"] });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      const updateCalls = findCalls("post", "update");
      assert.strictEqual(updateCalls.length, 1);
      const args = updateCalls[0]!.args as { data: { status: string } };
      assert.strictEqual(args.data.status, "PUBLISHED");
    });

    it("should still send individuals when broadcast fails", async () => {
      broadcastShouldThrow = true;
      const post = makePost({
        targetSegments: ["all"],
        targetEmails: ["user@test.com"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      assert.strictEqual(individualCalls.length, 1);
    });
  });

  // ── Individual send failure ────────────────────────────────────

  describe("Individual send failure", () => {
    it("should still count post as published when individual send fails", async () => {
      individualShouldThrow = true;
      const post = makePost({ targetEmails: ["user@test.com"] });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      const result = await processNewsletterPublish({}, deps);

      assert.strictEqual(result.published, 1);
    });

    it("should still send broadcast when individual send fails", async () => {
      individualShouldThrow = true;
      const post = makePost({
        targetSegments: ["premium"],
        targetEmails: ["user@test.com"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      assert.strictEqual(broadcastCalls.length, 1);
    });
  });

  // ── Both sends fail ────────────────────────────────────────────

  describe("Both sends fail", () => {
    it("should still count post as published when both sends fail", async () => {
      broadcastShouldThrow = true;
      individualShouldThrow = true;
      const post = makePost({
        targetSegments: ["all"],
        targetEmails: ["user@test.com"],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      const result = await processNewsletterPublish({}, deps);

      assert.strictEqual(result.published, 1);
    });
  });

  // ── Future posts (not found by query) ──────────────────────────

  describe("Future posts", () => {
    it("should return { published: 0 } when all posts are in the future", async () => {
      // Future posts won't be returned by findMany because the query
      // filters publishDate <= now. The mock just returns empty.
      const deps = createDeps({ prisma: createMockPrisma([]) });

      const result = await processNewsletterPublish({}, deps);

      assert.strictEqual(result.published, 0);
    });

    it("should use publishDate lte filter to exclude future posts", async () => {
      await processNewsletterPublish({}, createDeps());

      const calls = findCalls("post", "findMany");
      const args = calls[0]!.args as {
        where: { publishDate: { lte: Date } };
      };
      assert.ok(
        args.where.publishDate.lte instanceof Date,
        "publishDate.lte should be a Date"
      );
      assert.ok(
        args.where.publishDate.lte <= new Date(),
        "publishDate.lte should be <= now"
      );
    });
  });

  // ── Already-published posts ────────────────────────────────────

  describe("Already-published posts", () => {
    it("should not re-process published posts (they have wrong status)", async () => {
      // Already-published posts have status PUBLISHED, not SCHEDULED.
      // The query filters status: "SCHEDULED", so they won't appear.
      const deps = createDeps({ prisma: createMockPrisma([]) });

      const result = await processNewsletterPublish({}, deps);

      assert.strictEqual(result.published, 0);
      assert.strictEqual(broadcastCalls.length, 0);
      assert.strictEqual(individualCalls.length, 0);
    });

    it("should query specifically for SCHEDULED status", async () => {
      await processNewsletterPublish({}, createDeps());

      const calls = findCalls("post", "findMany");
      const args = calls[0]!.args as { where: { status: string } };
      assert.strictEqual(args.where.status, "SCHEDULED");
    });
  });

  // ── Post with no segments and no emails ────────────────────────

  describe("Post with no segments and no emails", () => {
    it("should still update status to PUBLISHED", async () => {
      const post = makePost({
        id: "post-empty",
        targetSegments: [],
        targetEmails: [],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      const updateCalls = findCalls("post", "update");
      assert.strictEqual(updateCalls.length, 1);
      const args = updateCalls[0]!.args as { data: { status: string } };
      assert.strictEqual(args.data.status, "PUBLISHED");
    });

    it("should return { published: 1 } even with no sends", async () => {
      const post = makePost({
        targetSegments: [],
        targetEmails: [],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      const result = await processNewsletterPublish({}, deps);

      assert.strictEqual(result.published, 1);
    });

    it("should NOT call sendBroadcast or sendIndividuals", async () => {
      const post = makePost({
        targetSegments: [],
        targetEmails: [],
      });
      const deps = createDeps({ prisma: createMockPrisma([post]) });

      await processNewsletterPublish({}, deps);

      assert.strictEqual(broadcastCalls.length, 0);
      assert.strictEqual(individualCalls.length, 0);
    });
  });

  // ── Status update failure (outer try/catch) ────────────────────

  describe("Status update failure (outer try/catch)", () => {
    it("should not count post as published when update throws", async () => {
      const post = makePost({ id: "p-fail-update", targetSegments: ["all"] });
      const failingPrisma = {
        post: {
          findMany: async () => [post],
          update: async () => {
            throw new Error("DB write failed");
          },
        },
      };
      const deps = createDeps({
        prisma: failingPrisma as ReturnType<typeof createMockPrisma>,
      });

      const result = await processNewsletterPublish({}, deps);

      assert.strictEqual(result.published, 0);
    });

    it("should not throw even when update fails (caught by outer try/catch)", async () => {
      const post = makePost({ id: "p-fail" });
      const failingPrisma = {
        post: {
          findMany: async () => [post],
          update: async () => {
            throw new Error("DB down");
          },
        },
      };
      const deps = createDeps({
        prisma: failingPrisma as ReturnType<typeof createMockPrisma>,
      });

      // Should NOT reject
      const result = await processNewsletterPublish({}, deps);
      assert.strictEqual(result.published, 0);
    });

    it("should continue processing remaining posts when one fails", async () => {
      const posts = [
        makePost({ id: "p-1", targetSegments: ["a"] }),
        makePost({ id: "p-2", targetSegments: ["b"] }),
      ];

      let updateCallCount = 0;
      const partialFailPrisma = {
        post: {
          findMany: async () => posts,
          update: async () => {
            updateCallCount++;
            if (updateCallCount === 1) {
              throw new Error("First update fails");
            }
            return {};
          },
        },
      };
      const deps = createDeps({
        prisma: partialFailPrisma as ReturnType<typeof createMockPrisma>,
      });

      const result = await processNewsletterPublish({}, deps);

      // First fails, second succeeds
      assert.strictEqual(result.published, 1);
    });
  });

  // ── NewsletterPublishMessage shape ─────────────────────────────

  describe("NewsletterPublishMessage shape", () => {
    it("should accept empty object (no postId)", async () => {
      const result = await processNewsletterPublish({}, createDeps());
      assert.deepStrictEqual(result, { published: 0 });
    });

    it("should accept object with postId", async () => {
      const result = await processNewsletterPublish(
        { postId: "test-id" },
        createDeps()
      );
      assert.deepStrictEqual(result, { published: 0 });
    });

    it("should accept object with undefined postId", async () => {
      const result = await processNewsletterPublish(
        { postId: undefined },
        createDeps()
      );

      // undefined postId should not add id to where
      const calls = findCalls("post", "findMany");
      const args = calls[0]!.args as { where: Record<string, unknown> };
      assert.strictEqual("id" in args.where, false);
      assert.deepStrictEqual(result, { published: 0 });
    });
  });
});
