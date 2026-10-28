import { z } from "zod";

// Enums
export const ContentTypeEnum = z.enum([
  "BLOG",
  "GLOSSARY",
  "NEWSLETTER",
  "LEGAL",
  "DOCS",
]);
export const PostStatusEnum = z.enum([
  "DRAFT",
  "PUBLISHED",
  "SCHEDULED",
  "ARCHIVED",
  "DELETED",
]);
export const ContentRoleEnum = z.enum(["ADMIN", "OWNER", "WRITER"]);
export const ContentPlatformEnum = z.enum(["STOCKBOOK"]);

// Post URL validation (slug format)
const postUrlSchema = z
  .string()
  .min(3, "URL must be at least 3 characters")
  .max(200, "URL must be at most 200 characters")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "URL must be lowercase with hyphens (e.g., 'my-blog-post')",
  );

// Create Post Schema
export const CreatePostSchema = z.object({
  contentType: ContentTypeEnum.default("BLOG"),
  title: z
    .string()
    .min(3, "Title must be at least 3 characters")
    .max(200, "Title must be at most 200 characters"),
  content: z.string().min(1, "Content is required"),
  featureImage: z.string().url("Feature image must be a valid URL").optional(),
  postUrl: postUrlSchema,
  excerpt: z
    .string()
    .max(500, "Excerpt must be at most 500 characters")
    .optional(),
  publishDate: z.coerce.date().optional(),
  status: PostStatusEnum.default("DRAFT"),
  isFeatured: z.boolean().default(false),
  isPremium: z.boolean().default(false),
  tagIds: z.array(z.string()).optional(),
  metadataTitle: z
    .string()
    .max(70, "Meta title should be at most 70 characters")
    .optional(),
  metadataDescription: z
    .string()
    .max(160, "Meta description should be at most 160 characters")
    .optional(),
  metadataImageUrl: z.string().url("Meta image must be a valid URL").optional(),
  metadataKeywords: z
    .string()
    .max(500, "Keywords should be at most 500 characters")
    .optional(),
  canonicalUrl: z.string().url("Canonical URL must be a valid URL").optional(),
});

export type CreatePostInput = z.input<typeof CreatePostSchema>;
export type CreatePostData = z.output<typeof CreatePostSchema>;

// Update Post Schema
export const UpdatePostSchema = z.object({
  title: z
    .string()
    .min(3, "Title must be at least 3 characters")
    .max(200, "Title must be at most 200 characters")
    .optional(),
  content: z.string().min(1, "Content is required").optional(),
  featureImage: z
    .string()
    .url("Feature image must be a valid URL")
    .nullable()
    .optional(),
  postUrl: postUrlSchema.optional(),
  excerpt: z
    .string()
    .max(500, "Excerpt must be at most 500 characters")
    .nullable()
    .optional(),
  publishDate: z.coerce.date().nullable().optional(),
  status: PostStatusEnum.optional(),
  // MONEY-864: allow converting a post's type on edit (e.g. BLOG → NEWSLETTER).
  // Without this, zod stripped the field so the change never persisted.
  contentType: ContentTypeEnum.optional(),
  isFeatured: z.boolean().optional(),
  isPremium: z.boolean().optional(),
  tagIds: z.array(z.string()).optional(),
  metadataTitle: z
    .string()
    .max(70, "Meta title should be at most 70 characters")
    .nullable()
    .optional(),
  metadataDescription: z
    .string()
    .max(160, "Meta description should be at most 160 characters")
    .nullable()
    .optional(),
  metadataImageUrl: z
    .string()
    .url("Meta image must be a valid URL")
    .nullable()
    .optional(),
  metadataKeywords: z
    .string()
    .max(500, "Keywords should be at most 500 characters")
    .nullable()
    .optional(),
  canonicalUrl: z
    .string()
    .url("Canonical URL must be a valid URL")
    .nullable()
    .optional(),
});

export type UpdatePostInput = z.input<typeof UpdatePostSchema>;
export type UpdatePostData = z.output<typeof UpdatePostSchema>;

// Tag slug validation
const tagSlugSchema = z
  .string()
  .min(2, "Slug must be at least 2 characters")
  .max(50, "Slug must be at most 50 characters")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Slug must be lowercase with hyphens (e.g., 'stock-market')",
  );

// Create Tag Schema
export const CreateTagSchema = z.object({
  slug: tagSlugSchema,
  name: z
    .string()
    .min(2, "Name must be at least 2 characters")
    .max(50, "Name must be at most 50 characters"),
  description: z
    .string()
    .max(200, "Description must be at most 200 characters")
    .optional(),
  color: z
    .string()
    .regex(
      /^#[0-9A-Fa-f]{6}$/,
      "Color must be a valid hex color (e.g., #FF5733)",
    )
    .optional(),
  imageUrl: z.string().url("Image URL must be a valid URL").optional(),
});

export type CreateTagInput = z.input<typeof CreateTagSchema>;
export type CreateTagData = z.output<typeof CreateTagSchema>;

// Update Tag Schema
export const UpdateTagSchema = z.object({
  slug: tagSlugSchema.optional(),
  name: z
    .string()
    .min(2, "Name must be at least 2 characters")
    .max(50, "Name must be at most 50 characters")
    .optional(),
  description: z
    .string()
    .max(200, "Description must be at most 200 characters")
    .nullable()
    .optional(),
  color: z
    .string()
    .regex(
      /^#[0-9A-Fa-f]{6}$/,
      "Color must be a valid hex color (e.g., #FF5733)",
    )
    .nullable()
    .optional(),
  imageUrl: z
    .string()
    .url("Image URL must be a valid URL")
    .nullable()
    .optional(),
});

export type UpdateTagInput = z.input<typeof UpdateTagSchema>;
export type UpdateTagData = z.output<typeof UpdateTagSchema>;

// Create Author Schema
export const CreateAuthorSchema = z.object({
  clerkId: z.string().min(1, "Clerk ID is required"),
  name: z.string().max(100, "Name must be at most 100 characters").optional(),
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be at most 30 characters")
    .regex(
      /^[a-z0-9_]+$/,
      "Username must be lowercase letters, numbers, and underscores only",
    ),
  email: z.string().email("Invalid email address"),
  imageUrl: z.string().url("Image URL must be a valid URL").optional(),
  role: ContentRoleEnum.default("WRITER"),
});

export type CreateAuthorInput = z.input<typeof CreateAuthorSchema>;
export type CreateAuthorData = z.output<typeof CreateAuthorSchema>;

// Post Filter Schema
export const PostFilterSchema = z.object({
  contentType: ContentTypeEnum.optional(),
  status: PostStatusEnum.optional(),
  authorId: z.string().optional(),
  tagSlug: z.string().optional(),
  isFeatured: z.boolean().optional(),
  isPremium: z.boolean().optional(),
  search: z.string().optional(),
});

export type PostFilterInput = z.input<typeof PostFilterSchema>;
export type PostFilterData = z.output<typeof PostFilterSchema>;

// Post Pagination Schema
export const PostPaginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  sortBy: z
    .enum(["publishDate", "createdAt", "viewCount", "title"])
    .default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type PostPaginationInput = z.input<typeof PostPaginationSchema>;
export type PostPaginationData = z.output<typeof PostPaginationSchema>;

// Publish Post Schema (for scheduling)
export const PublishPostSchema = z.object({
  postId: z.string().min(1, "Post ID is required"),
  publishDate: z.coerce.date().optional(), // If provided, schedule; otherwise publish immediately
});

export type PublishPostInput = z.input<typeof PublishPostSchema>;
export type PublishPostData = z.output<typeof PublishPostSchema>;

// Idea Enums
export const IdeaStatusEnum = z.enum([
  "NEW",
  "IN_PROGRESS",
  "DRAFT_CREATED",
  "ARCHIVED",
]);
export const IdeaStageEnum = z.enum([
  "ROUGH_IDEA",
  "OUTLINE",
  "SCRIPT",
  "READY",
]);

// Create Idea Schema
export const CreateIdeaSchema = z.object({
  title: z
    .string()
    .min(3, "Title must be at least 3 characters")
    .max(200, "Title must be at most 200 characters"),
  description: z
    .string()
    .max(1000, "Description must be at most 1000 characters")
    .optional(),
  topics: z
    .array(z.string().max(50, "Topic must be at most 50 characters"))
    .max(10, "Maximum 10 topics")
    .optional(),
  targetDate: z.coerce.date().nullable().optional(),
});

export type CreateIdeaInput = z.input<typeof CreateIdeaSchema>;
export type CreateIdeaData = z.output<typeof CreateIdeaSchema>;

// Update Idea Schema
export const UpdateIdeaSchema = z.object({
  title: z
    .string()
    .min(3, "Title must be at least 3 characters")
    .max(200, "Title must be at most 200 characters")
    .optional(),
  description: z
    .string()
    .max(1000, "Description must be at most 1000 characters")
    .nullable()
    .optional(),
  topics: z
    .array(z.string().max(50, "Topic must be at most 50 characters"))
    .max(10, "Maximum 10 topics")
    .optional(),
  status: IdeaStatusEnum.optional(),
  currentStage: IdeaStageEnum.optional(),
  generatedOutline: z.string().nullable().optional(),
  outlineContent: z.string().nullable().optional(),
  scriptContent: z.string().nullable().optional(),
  targetDate: z.coerce.date().nullable().optional(),
});

export type UpdateIdeaInput = z.input<typeof UpdateIdeaSchema>;
export type UpdateIdeaData = z.output<typeof UpdateIdeaSchema>;
