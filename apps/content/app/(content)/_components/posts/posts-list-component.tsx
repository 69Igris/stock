"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  Loader2,
  Plus,
  FileText,
  Search,
  X,
  MoreHorizontal,
  Archive,
  Trash2,
} from "lucide-react";
import { format } from "date-fns";
import { Button } from "@usemoney/ui/button";
import { Input } from "@usemoney/ui/input";

import { Badge } from "@usemoney/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@usemoney/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@usemoney/ui/dropdown-menu";
import {
  fetchAllPosts,
  fetchAllPostsCount,
  listTags,
  listAuthors,
  archivePost,
  deletePost,
  type PostListType,
} from "@/lib/actions";
import { PaginationControls } from "@/components/pagination-controls";
import Link from "next/link";

const PAGE_SIZE = 25;

const statusColors: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
  PUBLISHED:
    "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  SCHEDULED: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  ARCHIVED: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300",
  DELETED: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
};

interface TagOption {
  slug: string;
  name: string;
}

interface AuthorOption {
  id: string;
  name: string;
}

interface PostsListComponentProps {
  defaultStatusFilter?: string;
  defaultContentTypeFilter?: string;
  pageTitle?: string;
}

export function PostsListComponent({
  defaultStatusFilter = "all",
  defaultContentTypeFilter = "all",
}: PostsListComponentProps): JSX.Element {
  const [posts, setPosts] = useState<PostListType[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalCount, setTotalCount] = useState(0);
  const [tags, setTags] = useState<TagOption[]>([]);
  const [authors, setAuthors] = useState<AuthorOption[]>([]);
  const [contentType, setContentType] = useState<string | null>(
    defaultContentTypeFilter === "all" ? null : defaultContentTypeFilter,
  );
  const [postStatus, setPostStatus] = useState<string | null>(
    defaultStatusFilter === "all" ? null : defaultStatusFilter,
  );
  const [authorId, setAuthorId] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [actingId, setActingId] = useState<string | null>(null);
  const searchTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Debounced search - triggers after 400ms of inactivity
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(value);
      setPage(0);
    }, 400);
  }, []);

  // Fetch tags + authors for filters
  useEffect(() => {
    const fetchFilters = async () => {
      try {
        const result = await listTags();
        if (result.success && result.data) {
          setTags(result.data.map((t) => ({ slug: t.slug, name: t.name })));
        }
      } catch {
        // Tags filter is optional
      }
      try {
        const a = await listAuthors();
        if (a.success && a.data) {
          setAuthors(
            a.data.map((au) => ({ id: au.id, name: au.name ?? "Unknown" })),
          );
        }
      } catch {
        // Authors filter is admin-only; gracefully hidden otherwise
      }
    };
    fetchFilters();
  }, []);

  const loadPosts = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const status = postStatus ?? undefined;
      const type = contentType ?? undefined;
      const search = debouncedSearch || undefined;
      const author = authorId ?? undefined;

      const [data, count] = await Promise.all([
        fetchAllPosts(page, type, status, PAGE_SIZE, search, author, sortOrder),
        fetchAllPostsCount(type, status, search, author),
      ]);
      setPosts(data);
      setTotalCount(count);
    } catch {
      setPosts([]);
      setTotalCount(0);
    } finally {
      setLoading(false);
    }
  }, [postStatus, contentType, page, debouncedSearch, authorId, sortOrder]);

  useEffect(() => {
    void loadPosts();
  }, [loadPosts]);

  const handleArchive = async (id: string, title: string): Promise<void> => {
    if (!window.confirm(`Archive "${title}"?`)) return;
    setActingId(id);
    try {
      const r = await archivePost(id);
      if (r.success) await loadPosts();
      else window.alert(r.error || "Failed to archive post");
    } finally {
      setActingId(null);
    }
  };

  const handleDelete = async (id: string, title: string): Promise<void> => {
    if (!window.confirm(`Delete "${title}"? This moves it to trash.`)) return;
    setActingId(id);
    try {
      const r = await deletePost(id);
      if (r.success) await loadPosts();
      else window.alert(r.error || "Failed to delete post");
    } finally {
      setActingId(null);
    }
  };

  // Shared toolbar controls (rendered in both mobile + desktop bars).
  const authorsFilter =
    authors.length > 0 ? (
      <Select
        value={authorId ?? "all"}
        onValueChange={(v) => {
          setAuthorId(v === "all" ? null : v);
          setPage(0);
        }}
      >
        <SelectTrigger className="w-auto border-none bg-transparent">
          <SelectValue placeholder="All authors" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All authors</SelectItem>
          {authors.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : (
      <span className="text-sm text-muted-foreground">All authors</span>
    );

  const sortToggle = (
    <button
      type="button"
      onClick={() => {
        setSortOrder((s) => (s === "desc" ? "asc" : "desc"));
        setPage(0);
      }}
      className="text-sm text-muted-foreground hover:text-foreground transition-colors"
    >
      {sortOrder === "desc" ? "Newest first" : "Oldest first"}
    </button>
  );

  const renderContent = (): JSX.Element => {
    if (loading) {
      return (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
        </div>
      );
    }

    if (posts.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center h-64 text-center">
          <FileText className="h-16 w-16 text-muted-foreground mb-4" />
          {debouncedSearch ? (
            <>
              <p className="text-xl text-muted-foreground mb-2">
                No results found
              </p>
              <p className="text-sm text-muted-foreground mb-4">
                Try a different search term or adjust your filters
              </p>
            </>
          ) : (
            <>
              <p className="text-xl text-muted-foreground mb-2">No posts yet</p>
              <p className="text-sm text-muted-foreground mb-4">
                Start creating content for your audience
              </p>
              <Link href="/new-post">
                <Button>
                  <Plus className="h-4 w-4 mr-2" />
                  Create your first post
                </Button>
              </Link>
            </>
          )}
        </div>
      );
    }

    const totalPages = Math.ceil(totalCount / PAGE_SIZE);

    return (
      <div>
        <div className="divide-y divide-border">
          {posts.map((post) => (
            <div
              key={post.id}
              className="flex items-center gap-4 px-4 py-4 hover:bg-accent transition-colors rounded-md"
            >
              <Link
                href={`/editor/${post.id}`}
                className="flex items-center gap-4 flex-1 min-w-0 cursor-pointer"
              >
                <Avatar className="h-10 w-10">
                  <AvatarImage src={post.author?.imageUrl || ""} />
                  <AvatarFallback>
                    {post.author?.name?.charAt(0) || "A"}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{post.title}</p>
                  <p className="text-sm text-muted-foreground">
                    {post.publishDate
                      ? format(new Date(post.publishDate), "MMM d, yyyy")
                      : format(new Date(post.createdAt), "MMM d, yyyy")}
                  </p>
                </div>
              </Link>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs">
                  {post.contentType}
                </Badge>
                <Badge className={statusColors[post.status]}>
                  {post.status}
                </Badge>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      disabled={actingId === post.id}
                      aria-label="Post actions"
                    >
                      {actingId === post.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <MoreHorizontal className="h-4 w-4" />
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => handleArchive(post.id, post.title)}
                    >
                      <Archive className="h-4 w-4 mr-2" /> Archive
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => handleDelete(post.id, post.title)}
                      className="text-red-600 focus:text-red-600"
                    >
                      <Trash2 className="h-4 w-4 mr-2" /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6">
          <PaginationControls
            currentPage={page}
            totalPages={totalPages}
            onPageChange={setPage}
            pageSize={PAGE_SIZE}
            totalItems={totalCount}
            label="posts"
          />
        </div>
      </div>
    );
  };

  return (
    <div className="p-8">
      {/* PostsNavbar - matching ratecreator layout */}
      {/* Mobile */}
      <div className="flex md:hidden flex-col gap-4">
        <div className="flex justify-end">
          <Link href="/new-post">
            <Button variant="outline">New post</Button>
          </Link>
        </div>
        <div className="flex flex-row gap-2 gap-x-4 justify-between items-center">
          {defaultContentTypeFilter === "all" && (
            <Select
              value={contentType?.toLowerCase() || "all"}
              onValueChange={(value) => {
                setContentType(value === "all" ? null : value.toUpperCase());
                setPage(0);
              }}
            >
              <SelectTrigger className="w-auto border-none bg-transparent">
                <SelectValue placeholder="All Posts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Posts</SelectItem>
                <SelectItem value="blog">Blog</SelectItem>
                <SelectItem value="glossary">Glossary</SelectItem>
                <SelectItem value="newsletter">Newsletter</SelectItem>
                <SelectItem value="docs">Docs</SelectItem>
                <SelectItem value="legal">Legal</SelectItem>
              </SelectContent>
            </Select>
          )}
          {defaultStatusFilter === "all" && (
            <Select
              value={postStatus?.toLowerCase() || "all"}
              onValueChange={(value) => {
                setPostStatus(value === "all" ? null : value.toUpperCase());
                setPage(0);
              }}
            >
              <SelectTrigger className="w-auto border-none bg-transparent">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="published">Published</SelectItem>
                <SelectItem value="scheduled">Scheduled</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          )}
          {authorsFilter}
          {tags.length > 0 && (
            <Select value="all" onValueChange={() => {}}>
              <SelectTrigger className="w-auto border-none bg-transparent">
                <SelectValue placeholder="All Tags" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Tags</SelectItem>
                {tags.map((tag) => (
                  <SelectItem key={tag.slug} value={tag.slug}>
                    {tag.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {sortToggle}
        </div>
      </div>

      {/* Desktop */}
      <div className="hidden md:flex flex-row gap-2 md:gap-8 items-center w-full justify-end">
        {defaultContentTypeFilter === "all" && (
          <Select
            value={contentType?.toLowerCase() || "all"}
            onValueChange={(value) => {
              setContentType(value === "all" ? null : value.toUpperCase());
              setPage(0);
            }}
          >
            <SelectTrigger className="w-auto border-none bg-transparent">
              <SelectValue placeholder="All Posts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Posts</SelectItem>
              <SelectItem value="blog">Blog</SelectItem>
              <SelectItem value="glossary">Glossary</SelectItem>
              <SelectItem value="newsletter">Newsletter</SelectItem>
              <SelectItem value="docs">Docs</SelectItem>
              <SelectItem value="legal">Legal</SelectItem>
            </SelectContent>
          </Select>
        )}
        {defaultStatusFilter === "all" && (
          <Select
            value={postStatus?.toLowerCase() || "all"}
            onValueChange={(value) => {
              setPostStatus(value === "all" ? null : value.toUpperCase());
              setPage(0);
            }}
          >
            <SelectTrigger className="w-auto border-none bg-transparent">
              <SelectValue placeholder="All Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="published">Published</SelectItem>
              <SelectItem value="scheduled">Scheduled</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        )}
        {authorsFilter}
        {tags.length > 0 && (
          <Select value="all" onValueChange={() => {}}>
            <SelectTrigger className="w-auto border-none bg-transparent">
              <SelectValue placeholder="All Tags" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Tags</SelectItem>
              {tags.map((tag) => (
                <SelectItem key={tag.slug} value={tag.slug}>
                  {tag.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {sortToggle}

        <Link href="/new-post">
          <Button variant="outline">New post</Button>
        </Link>
      </div>

      {/* Search bar */}
      <div className="relative mt-6 mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search posts by title or content..."
          className="pl-10 pr-10"
        />
        {searchQuery && (
          <button
            onClick={() => {
              setSearchQuery("");
              setDebouncedSearch("");
              setPage(0);
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <p className="text-sm text-muted-foreground mb-4">
        {totalCount} {totalCount === 1 ? "post" : "posts"} found
        {debouncedSearch && <span> for &ldquo;{debouncedSearch}&rdquo;</span>}
      </p>

      {renderContent()}
    </div>
  );
}
