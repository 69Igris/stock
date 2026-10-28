"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@usemoney/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@usemoney/ui/tabs";
import { Badge } from "@usemoney/ui/badge";
import { Input } from "@usemoney/ui/input";
import {
  Loader2,
  BarChart3,
  Eye,
  FileText,
  Users,
  Mail,
  Search,
  X,
  ArrowUpDown,
} from "lucide-react";
import { Button } from "@usemoney/ui/button";
import { PaginationControls } from "@/components/pagination-controls";
import {
  getAnalyticsOverview,
  getTopPostsByViews,
  fetchAllPosts,
  fetchAllPostsCount,
  type AnalyticsOverview,
  type PostAnalytics,
  type PostListType,
  listSubscribers,
} from "@/lib/actions";

const statusColors: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  PENDING:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300",
  UNSUBSCRIBED: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
};

const segmentColors: Record<string, string> = {
  free: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  paid: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300",
  security:
    "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300",
};

type Subscriber = {
  id: string;
  email: string;
  name: string | null;
  status: string;
  segments: string[];
  subscribedAt: Date | null;
  createdAt: Date;
};

const POSTS_PAGE_SIZE = 20;
const SUBSCRIBERS_PAGE_SIZE = 25;

export default function AnalyticsPage() {
  const router = useRouter();
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [topPosts, setTopPosts] = useState<PostAnalytics[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");

  // Posts tab state
  const [allPosts, setAllPosts] = useState<PostListType[]>([]);
  const [postSortBy, setPostSortBy] = useState<"views" | "date">("views");
  const [postsLoading, setPostsLoading] = useState(false);
  const [postSearch, setPostSearch] = useState("");
  const [postSearchDebounced, setPostSearchDebounced] = useState("");
  const [postsPage, setPostsPage] = useState(0);
  const [postsTotal, setPostsTotal] = useState(0);

  // Subscribers tab state
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [subscribersLoading, setSubscribersLoading] = useState(false);
  const [subscriberSearch, setSubscriberSearch] = useState("");
  const [subscribersPage, setSubscribersPage] = useState(0);

  // Load overview data
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [overviewResult, topPostsResult] = await Promise.all([
          getAnalyticsOverview(),
          getTopPostsByViews(10),
        ]);

        if (overviewResult.success && overviewResult.data) {
          setOverview(overviewResult.data);
        }
        if (topPostsResult.success && topPostsResult.data) {
          setTopPosts(topPostsResult.data);
        }
      } catch {
        // Failed to load
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  // Debounce post search
  useEffect(() => {
    const timer = setTimeout(() => {
      setPostSearchDebounced(postSearch);
      setPostsPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [postSearch]);

  // Load posts tab data
  const loadPosts = useCallback(async () => {
    setPostsLoading(true);
    try {
      const search = postSearchDebounced.trim() || undefined;
      const [posts, count] = await Promise.all([
        fetchAllPosts(
          postsPage,
          undefined,
          "PUBLISHED",
          POSTS_PAGE_SIZE,
          search,
        ),
        fetchAllPostsCount(undefined, "PUBLISHED", search),
      ]);
      setAllPosts(posts);
      setPostsTotal(count);
    } catch {
      // Failed
    } finally {
      setPostsLoading(false);
    }
  }, [postsPage, postSearchDebounced]);

  useEffect(() => {
    if (activeTab === "posts") {
      void loadPosts();
    }
  }, [activeTab, loadPosts]);

  // Load subscribers tab data
  const loadSubscribers = useCallback(async () => {
    setSubscribersLoading(true);
    try {
      const result = await listSubscribers();
      if (result.success && result.data) {
        setSubscribers(result.data as unknown as Subscriber[]);
      }
    } catch {
      // Failed
    } finally {
      setSubscribersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "subscribers" && subscribers.length === 0) {
      void loadSubscribers();
    }
  }, [activeTab, subscribers.length, loadSubscribers]);

  const sortedPosts = useMemo(() => {
    const posts = [...allPosts];
    if (postSortBy === "views") {
      posts.sort((a, b) => b.viewCount - a.viewCount);
    } else {
      posts.sort(
        (a, b) =>
          new Date(b.publishDate || b.createdAt).getTime() -
          new Date(a.publishDate || a.createdAt).getTime(),
      );
    }
    return posts;
  }, [allPosts, postSortBy]);

  // Client-side filter + paginate subscribers
  const filteredSubscribers = useMemo(() => {
    if (!subscriberSearch.trim()) return subscribers;
    const q = subscriberSearch.toLowerCase();
    return subscribers.filter(
      (sub) =>
        sub.email.toLowerCase().includes(q) ||
        (sub.name && sub.name.toLowerCase().includes(q)),
    );
  }, [subscribers, subscriberSearch]);

  const subscribersTotalFiltered = filteredSubscribers.length;
  const subscribersPageCount = Math.ceil(
    subscribersTotalFiltered / SUBSCRIBERS_PAGE_SIZE,
  );
  const paginatedSubscribers = useMemo(() => {
    const start = subscribersPage * SUBSCRIBERS_PAGE_SIZE;
    return filteredSubscribers.slice(start, start + SUBSCRIBERS_PAGE_SIZE);
  }, [filteredSubscribers, subscribersPage]);

  // Reset subscriber page on search change
  useEffect(() => {
    setSubscribersPage(0);
  }, [subscriberSearch]);

  const postsPageCount = Math.ceil(postsTotal / POSTS_PAGE_SIZE);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="flex items-center justify-center h-96">
        <p className="text-muted-foreground">Failed to load analytics</p>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <BarChart3 className="h-8 w-8 text-primary" />
          Analytics
        </h1>
        <p className="text-muted-foreground mt-1">
          Content performance and subscriber insights
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="posts">Posts</TabsTrigger>
          <TabsTrigger value="subscribers">Subscribers</TabsTrigger>
        </TabsList>

        {/* OVERVIEW TAB */}
        <TabsContent value="overview" className="space-y-6 mt-6">
          {/* Stat Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Total Subscribers
                </CardTitle>
                <Users className="h-4 w-4 text-blue-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {overview.subscribers.total}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {overview.subscribers.active} active /{" "}
                  {overview.subscribers.pending} pending /{" "}
                  {overview.subscribers.unsubscribed} unsubscribed
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Published Posts
                </CardTitle>
                <FileText className="h-4 w-4 text-green-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {overview.posts.published}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {overview.posts.total} total posts
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Total Views
                </CardTitle>
                <Eye className="h-4 w-4 text-purple-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {overview.posts.totalViews.toLocaleString()}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Broadcasts Sent
                </CardTitle>
                <Mail className="h-4 w-4 text-amber-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {overview.broadcasts.length}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Subscriber Growth */}
          {overview.subscriberGrowth.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Subscriber Growth</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-48 flex items-end gap-1">
                  {(() => {
                    const data = overview.subscriberGrowth;
                    const recent = data.slice(-30);
                    const max = Math.max(...recent.map((d) => d.count), 1);
                    return recent.map((point) => (
                      <div
                        key={point.date}
                        className="flex-1 bg-primary/80 rounded-t hover:bg-primary transition-colors"
                        style={{
                          height: `${(point.count / max) * 100}%`,
                          minHeight: "2px",
                        }}
                        title={`${point.date}: ${point.count} subscribers`}
                      />
                    ));
                  })()}
                </div>
                <div className="flex justify-between mt-2 text-xs text-muted-foreground">
                  <span>
                    {overview.subscriberGrowth.length > 30
                      ? overview.subscriberGrowth[
                          overview.subscriberGrowth.length - 30
                        ]?.date
                      : overview.subscriberGrowth[0]?.date}
                  </span>
                  <span>
                    {
                      overview.subscriberGrowth[
                        overview.subscriberGrowth.length - 1
                      ]?.date
                    }
                  </span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Two columns: Recent Broadcasts + Top Posts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Recent Broadcasts</CardTitle>
              </CardHeader>
              <CardContent>
                {overview.broadcasts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No broadcasts sent yet
                  </p>
                ) : (
                  <div className="space-y-3">
                    {overview.broadcasts.slice(0, 10).map((bc) => (
                      <div
                        key={bc.id}
                        className="flex items-center justify-between text-sm"
                      >
                        <div className="truncate flex-1 mr-4">
                          <p className="font-medium truncate">
                            {bc.name || "Unnamed broadcast"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {format(new Date(bc.created_at), "MMM d, yyyy")}
                          </p>
                        </div>
                        <Badge
                          variant={
                            bc.status === "sent" ? "default" : "secondary"
                          }
                        >
                          {bc.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Top Posts by Views</CardTitle>
              </CardHeader>
              <CardContent>
                {topPosts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No published posts yet
                  </p>
                ) : (
                  <div className="space-y-3">
                    {topPosts.slice(0, 10).map((post, i) => (
                      <div
                        key={post.id}
                        className="flex items-center justify-between text-sm"
                      >
                        <div className="truncate flex-1 mr-4">
                          <p className="font-medium truncate">
                            {i + 1}. {post.title}
                          </p>
                          <p className="text-xs text-muted-foreground capitalize">
                            {post.contentType.toLowerCase()}
                          </p>
                        </div>
                        <span className="text-muted-foreground flex items-center gap-1 shrink-0">
                          <Eye className="size-3" />
                          {post.viewCount}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* POSTS TAB */}
        <TabsContent value="posts" className="mt-6 space-y-4">
          {/* Search + Sort */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                placeholder="Search posts..."
                value={postSearch}
                onChange={(e) => setPostSearch(e.target.value)}
                className="pl-9 h-9"
              />
              {postSearch && (
                <button
                  onClick={() => setPostSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setPostSortBy((s) => (s === "views" ? "date" : "views"))
              }
              className="gap-1.5"
            >
              <ArrowUpDown className="size-3.5" />
              Sort by {postSortBy === "views" ? "date" : "views"}
            </Button>
          </div>

          {postsLoading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">
                  Published Posts
                  <span className="text-sm font-normal text-muted-foreground ml-2">
                    ({postsTotal})
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {sortedPosts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {postSearchDebounced
                      ? "No posts match your search"
                      : "No published posts yet"}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {sortedPosts.map((post) => (
                      <div
                        key={post.id}
                        className="flex items-center justify-between py-2 border-b border-border last:border-0"
                      >
                        <div className="flex-1 min-w-0 mr-4">
                          <p className="font-medium truncate">{post.title}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <Badge variant="outline" className="text-[10px]">
                              {post.contentType}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {post.publishDate
                                ? format(
                                    new Date(post.publishDate),
                                    "MMM d, yyyy",
                                  )
                                : format(
                                    new Date(post.createdAt),
                                    "MMM d, yyyy",
                                  )}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 text-sm text-muted-foreground shrink-0">
                          <Eye className="size-3.5" />
                          {post.viewCount}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <PaginationControls
                  currentPage={postsPage}
                  totalPages={postsPageCount}
                  onPageChange={setPostsPage}
                  pageSize={POSTS_PAGE_SIZE}
                  totalItems={postsTotal}
                  label="posts"
                />
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* SUBSCRIBERS TAB */}
        <TabsContent value="subscribers" className="mt-6 space-y-4">
          <div className="relative max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder="Search by name or email..."
              value={subscriberSearch}
              onChange={(e) => setSubscriberSearch(e.target.value)}
              className="pl-9 h-9"
            />
            {subscriberSearch && (
              <button
                onClick={() => setSubscriberSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          {subscribersLoading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : paginatedSubscribers.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-center">
              <Users className="h-10 w-10 text-muted-foreground mb-2" />
              <p className="text-muted-foreground">
                {subscriberSearch
                  ? "No subscribers match your search"
                  : "No subscribers yet"}
              </p>
            </div>
          ) : (
            <Card>
              <CardContent className="p-0">
                <div className="divide-y divide-border">
                  {paginatedSubscribers.map((sub) => (
                    <div
                      key={sub.id}
                      className="flex items-center justify-between px-4 py-3 hover:bg-accent/50 transition-colors cursor-pointer"
                      onClick={() => router.push(`/subscribers/${sub.id}`)}
                    >
                      <div className="flex-1 min-w-0 mr-4">
                        <p className="font-medium truncate">{sub.email}</p>
                        {sub.name && (
                          <p className="text-sm text-muted-foreground truncate">
                            {sub.name}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {sub.segments.map((seg) => (
                          <Badge
                            key={seg}
                            className={`text-[10px] px-1.5 py-0 ${segmentColors[seg] || ""}`}
                          >
                            {seg}
                          </Badge>
                        ))}
                        <Badge className={statusColors[sub.status] || ""}>
                          {sub.status.charAt(0) +
                            sub.status.slice(1).toLowerCase()}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>

                <PaginationControls
                  currentPage={subscribersPage}
                  totalPages={subscribersPageCount}
                  onPageChange={setSubscribersPage}
                  pageSize={SUBSCRIBERS_PAGE_SIZE}
                  totalItems={subscribersTotalFiltered}
                  label="subscribers"
                />
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
