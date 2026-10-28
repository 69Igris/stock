// Content Platform Types

export type ContentPlatform = "STOCKBOOK";
export type ContentType = "BLOG" | "GLOSSARY" | "NEWSLETTER" | "LEGAL" | "DOCS";
export type PostStatus = "DRAFT" | "PUBLISHED" | "SCHEDULED" | "DELETED";
export type ContentRole = "ADMIN" | "OWNER" | "WRITER";
export type IdeaStatus = "NEW" | "IN_PROGRESS" | "DRAFT_CREATED" | "ARCHIVED";
export type IdeaStage = "ROUGH_IDEA" | "OUTLINE" | "SCRIPT" | "READY";

export interface ContentAuthor {
  id: string;
  clerkId: string;
  name?: string | null;
  username: string;
  email: string;
  imageUrl?: string | null;
  role: ContentRole;
  createdAt: Date;
  updatedAt: Date;
}

export interface Tag {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  color?: string | null;
  imageUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TagOnPost {
  id: string;
  postId: string;
  tagId: string;
  tag: Tag;
  createdAt: Date;
}

export interface PostMetadata {
  title?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  keywords?: string | null;
  canonicalUrl?: string | null;
}

export interface Post {
  id: string;
  contentPlatform: ContentPlatform;
  contentType: ContentType;
  title: string;
  content: string; // BlockNote JSON
  featureImage?: string | null;
  postUrl: string;
  excerpt?: string | null;
  publishDate?: Date | null;
  status: PostStatus;
  isFeatured: boolean;
  isPremium: boolean;
  authorId: string;
  author: ContentAuthor;
  tags: TagOnPost[];
  metadataTitle?: string | null;
  metadataDescription?: string | null;
  metadataImageUrl?: string | null;
  metadataKeywords?: string | null;
  canonicalUrl?: string | null;
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// Simplified post for list views
export interface PostListItem {
  id: string;
  postUrl: string;
  contentType: ContentType;
  title: string;
  excerpt?: string | null;
  featureImage?: string | null;
  publishDate?: Date | null;
  status: PostStatus;
  isFeatured: boolean;
  isPremium: boolean;
  viewCount: number;
  author: {
    id: string;
    name?: string | null;
    username: string;
    imageUrl?: string | null;
  };
  tags: {
    id: string;
    name: string;
    slug: string;
    color?: string | null;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

// For creating/updating posts
export interface CreatePostInput {
  contentType: ContentType;
  title: string;
  content: string;
  featureImage?: string;
  postUrl: string;
  excerpt?: string;
  publishDate?: Date;
  status?: PostStatus;
  isFeatured?: boolean;
  isPremium?: boolean;
  tagIds?: string[];
  metadataTitle?: string;
  metadataDescription?: string;
  metadataImageUrl?: string;
  metadataKeywords?: string;
  canonicalUrl?: string;
}

export interface UpdatePostInput {
  title?: string;
  content?: string;
  featureImage?: string | null;
  postUrl?: string;
  excerpt?: string | null;
  publishDate?: Date | null;
  status?: PostStatus;
  isFeatured?: boolean;
  isPremium?: boolean;
  tagIds?: string[];
  metadataTitle?: string | null;
  metadataDescription?: string | null;
  metadataImageUrl?: string | null;
  metadataKeywords?: string | null;
  canonicalUrl?: string | null;
}

// For creating/updating tags
export interface CreateTagInput {
  slug: string;
  name: string;
  description?: string;
  color?: string;
  imageUrl?: string;
}

export interface UpdateTagInput {
  slug?: string;
  name?: string;
  description?: string | null;
  color?: string | null;
  imageUrl?: string | null;
}

// For creating authors
export interface CreateAuthorInput {
  clerkId: string;
  name?: string;
  username: string;
  email: string;
  imageUrl?: string;
  role?: ContentRole;
}

// Filter and pagination
export interface PostFilter {
  contentType?: ContentType;
  status?: PostStatus;
  authorId?: string;
  tagSlug?: string;
  isFeatured?: boolean;
  isPremium?: boolean;
  search?: string;
}

export interface PostPagination {
  page: number;
  limit: number;
  sortBy?: "publishDate" | "createdAt" | "viewCount" | "title";
  sortOrder?: "asc" | "desc";
}

// Idea types
export interface Idea {
  id: string;
  title: string;
  description?: string | null;
  topics: string[];
  status: IdeaStatus;
  currentStage: IdeaStage;
  generatedOutline?: string | null;
  outlineContent?: string | null;
  scriptContent?: string | null;
  targetDate?: Date | null;
  createdPostId?: string | null;
  authorId: string;
  author?: ContentAuthor;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateIdeaInput {
  title: string;
  description?: string;
  topics?: string[];
  targetDate?: Date | null;
}

export interface UpdateIdeaInput {
  title?: string;
  description?: string | null;
  topics?: string[];
  status?: IdeaStatus;
  currentStage?: IdeaStage;
  generatedOutline?: string | null;
  outlineContent?: string | null;
  scriptContent?: string | null;
  targetDate?: Date | null;
}

// Dashboard stats
export interface ContentStats {
  totalPosts: number;
  publishedPosts: number;
  draftPosts: number;
  scheduledPosts: number;
  totalViews: number;
  postsByType: {
    contentType: ContentType;
    count: number;
  }[];
}
