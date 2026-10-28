"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  Loader2,
  Mail,
  MailX,
  MailCheck,
  Download,
  Users,
  UserCheck,
  Clock,
  UserMinus,
  RefreshCw,
  CloudDownload,
  Tag,
  ChevronDown,
  Search,
  X,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@usemoney/ui/button";
import { Card, CardContent } from "@usemoney/ui/card";
import { Badge } from "@usemoney/ui/badge";
import { Input } from "@usemoney/ui/input";
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
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@usemoney/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@usemoney/ui/popover";
import { Label } from "@usemoney/ui/label";
import {
  getSubscriberStats,
  listSubscribers,
  exportSubscribersCSV,
  syncSubscribersFromResend,
  toggleSubscription,
  updateSubscriberSegments,
  type SubscriberFilter,
} from "@/lib/actions";
import { toast } from "sonner";

type Subscriber = {
  id: string;
  email: string;
  name: string | null;
  status: string;
  source: string | null;
  segments: string[];
  subscribedAt: Date | null;
  unsubscribedAt: Date | null;
  createdAt: Date;
};

type Stats = {
  total: number;
  active: number;
  pending: number;
  unsubscribed: number;
  bySegment: {
    free: number;
    paid: number;
    security: number;
  };
};

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

const ALL_SEGMENTS = ["free", "paid", "security"];

const emptyFilter: SubscriberFilter = {};

export default function SubscribersPage() {
  const router = useRouter();
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [savingSegmentsId, setSavingSegmentsId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Filter popover state
  const [filters, setFilters] = useState<SubscriberFilter>(emptyFilter);
  const [tempFilters, setTempFilters] = useState<SubscriberFilter>(emptyFilter);
  const [filterOpen, setFilterOpen] = useState(false);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.status) count++;
    if (filters.segment) count++;
    if (filters.name) count++;
    if (filters.email) count++;
    if (filters.source) count++;
    if (filters.createdAfter) count++;
    if (filters.createdBefore) count++;
    return count;
  }, [filters]);

  const fetchData = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const serverFilter: SubscriberFilter = {};
        if (filters.status) serverFilter.status = filters.status;
        if (filters.segment) serverFilter.segment = filters.segment;
        if (filters.name) serverFilter.name = filters.name;
        if (filters.email) serverFilter.email = filters.email;
        if (filters.source) serverFilter.source = filters.source;
        if (filters.createdAfter)
          serverFilter.createdAfter = filters.createdAfter;
        if (filters.createdBefore)
          serverFilter.createdBefore = filters.createdBefore;

        const hasFilter = Object.keys(serverFilter).length > 0;

        const [statsResult, subscribersResult] = await Promise.all([
          getSubscriberStats(),
          listSubscribers(hasFilter ? serverFilter : undefined),
        ]);

        if (statsResult.success && statsResult.data) {
          setStats(statsResult.data as unknown as Stats);
        }

        if (subscribersResult.success && subscribersResult.data) {
          setSubscribers(subscribersResult.data as unknown as Subscriber[]);
        } else {
          setError(subscribersResult.error || "Failed to load subscribers");
        }
      } catch {
        setError("Failed to load subscribers");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [filters],
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const handleFocus = () => fetchData(true);
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [fetchData]);

  // Client-side search filter on top of server-side filters
  const filteredSubscribers = useMemo(() => {
    if (!searchQuery.trim()) return subscribers;
    const q = searchQuery.toLowerCase();
    return subscribers.filter(
      (sub) =>
        sub.email.toLowerCase().includes(q) ||
        (sub.name && sub.name.toLowerCase().includes(q)),
    );
  }, [subscribers, searchQuery]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await syncSubscribersFromResend();
      if (result.success) {
        toast.success(result.message || "Synced from Resend");
        fetchData(true);
      } else {
        toast.error(result.error || "Failed to sync");
      }
    } catch {
      toast.error("Failed to sync from Resend");
    } finally {
      setSyncing(false);
    }
  };

  const handleToggle = async (id: string) => {
    setTogglingId(id);
    try {
      const result = await toggleSubscription(id);
      if (result.success) {
        toast.success(result.message || "Subscription updated");
        fetchData(true);
      } else {
        toast.error(result.error || "Failed to toggle");
      }
    } catch {
      toast.error("Failed to toggle subscription");
    } finally {
      setTogglingId(null);
    }
  };

  const handleSegmentToggle = async (
    sub: Subscriber,
    segment: string,
    checked: boolean,
  ) => {
    const newSegments = checked
      ? [...(sub.segments || []), segment]
      : (sub.segments || []).filter((s) => s !== segment);

    setSavingSegmentsId(sub.id);
    try {
      const result = await updateSubscriberSegments(sub.id, newSegments);
      if (result.success) {
        toast.success("Segments updated");
        fetchData(true);
      } else {
        toast.error(result.error || "Failed to update segments");
      }
    } catch {
      toast.error("Failed to update segments");
    } finally {
      setSavingSegmentsId(null);
    }
  };

  const handleSubscribeAll = async (sub: Subscriber) => {
    setSavingSegmentsId(sub.id);
    try {
      const result = await updateSubscriberSegments(sub.id, [...ALL_SEGMENTS]);
      if (result.success) {
        toast.success("Subscribed to all segments");
        fetchData(true);
      } else {
        toast.error(result.error || "Failed to update segments");
      }
    } catch {
      toast.error("Failed to update segments");
    } finally {
      setSavingSegmentsId(null);
    }
  };

  const handleUnsubscribeAll = async (sub: Subscriber) => {
    setSavingSegmentsId(sub.id);
    try {
      const result = await updateSubscriberSegments(sub.id, []);
      if (result.success) {
        toast.success("Unsubscribed from all segments");
        fetchData(true);
      } else {
        toast.error(result.error || "Failed to update segments");
      }
    } catch {
      toast.error("Failed to update segments");
    } finally {
      setSavingSegmentsId(null);
    }
  };

  const handleExport = async () => {
    try {
      const result = await exportSubscribersCSV();
      if (result.success && result.data) {
        const blob = new Blob([result.data], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `subscribers-${format(new Date(), "yyyy-MM-dd")}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch {
      toast.error("Failed to export subscribers");
    }
  };

  const handleApplyFilters = () => {
    setFilters({ ...tempFilters });
    setFilterOpen(false);
  };

  const handleResetFilters = () => {
    setTempFilters(emptyFilter);
    setFilters(emptyFilter);
    setFilterOpen(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && subscribers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <Mail className="h-16 w-16 text-muted-foreground mb-4" />
        <p className="text-xl text-muted-foreground mb-2">{error}</p>
        <Button variant="outline" size="sm" onClick={() => fetchData()}>
          <RefreshCw className="size-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Newsletter Subscribers</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your newsletter subscriber list
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSync}
            disabled={syncing}
          >
            {syncing ? (
              <Loader2 className="size-4 animate-spin mr-2" />
            ) : (
              <CloudDownload className="size-4 mr-2" />
            )}
            Sync from Resend
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fetchData(true)}
            disabled={refreshing}
          >
            <RefreshCw
              className={`size-4 ${refreshing ? "animate-spin" : ""}`}
            />
          </Button>
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="size-4 mr-2" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4 mb-6">
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <Users className="size-5 text-muted-foreground" />
              <div>
                <p className="text-2xl font-bold">{stats.total}</p>
                <p className="text-xs text-muted-foreground">Total</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <UserCheck className="size-5 text-green-600" />
              <div>
                <p className="text-2xl font-bold">{stats.active}</p>
                <p className="text-xs text-muted-foreground">Active</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <Clock className="size-5 text-yellow-600" />
              <div>
                <p className="text-2xl font-bold">{stats.pending}</p>
                <p className="text-xs text-muted-foreground">Pending</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <UserMinus className="size-5 text-red-600" />
              <div>
                <p className="text-2xl font-bold">{stats.unsubscribed}</p>
                <p className="text-xs text-muted-foreground">Unsubscribed</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <Tag className="size-5 text-blue-600" />
              <div>
                <p className="text-2xl font-bold">{stats.bySegment.free}</p>
                <p className="text-xs text-muted-foreground">Free</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <Tag className="size-5 text-emerald-600" />
              <div>
                <p className="text-2xl font-bold">{stats.bySegment.paid}</p>
                <p className="text-xs text-muted-foreground">Paid</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <Tag className="size-5 text-orange-600" />
              <div>
                <p className="text-2xl font-bold">{stats.bySegment.security}</p>
                <p className="text-xs text-muted-foreground">Security</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Search + Filter Button */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or email..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-8 text-sm"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <Popover
          open={filterOpen}
          onOpenChange={(open) => {
            setFilterOpen(open);
            if (open) setTempFilters({ ...filters });
          }}
        >
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5">
              <SlidersHorizontal className="size-4" />
              Filter
              {activeFilterCount > 0 && (
                <Badge className="ml-1 h-5 w-5 rounded-full p-0 flex items-center justify-center text-[10px]">
                  {activeFilterCount}
                </Badge>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80" align="start">
            <div className="space-y-3">
              <p className="text-sm font-medium">Filter subscribers</p>

              <div className="space-y-1.5">
                <Label className="text-xs">Name contains</Label>
                <Input
                  placeholder="e.g. John"
                  value={tempFilters.name || ""}
                  onChange={(e) =>
                    setTempFilters({
                      ...tempFilters,
                      name: e.target.value || undefined,
                    })
                  }
                  className="h-8 text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Email contains</Label>
                <Input
                  placeholder="e.g. gmail.com"
                  value={tempFilters.email || ""}
                  onChange={(e) =>
                    setTempFilters({
                      ...tempFilters,
                      email: e.target.value || undefined,
                    })
                  }
                  className="h-8 text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Status</Label>
                <Select
                  value={tempFilters.status || "all"}
                  onValueChange={(v) =>
                    setTempFilters({
                      ...tempFilters,
                      status: v === "all" ? undefined : v,
                    })
                  }
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="ACTIVE">Active</SelectItem>
                    <SelectItem value="PENDING">Pending</SelectItem>
                    <SelectItem value="UNSUBSCRIBED">Unsubscribed</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Segment</Label>
                <Select
                  value={tempFilters.segment || "all"}
                  onValueChange={(v) =>
                    setTempFilters({
                      ...tempFilters,
                      segment: v === "all" ? undefined : v,
                    })
                  }
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Segments</SelectItem>
                    <SelectItem value="free">Free</SelectItem>
                    <SelectItem value="paid">Paid</SelectItem>
                    <SelectItem value="security">Security</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Source</Label>
                <Select
                  value={tempFilters.source || "all"}
                  onValueChange={(v) =>
                    setTempFilters({
                      ...tempFilters,
                      source: v === "all" ? undefined : v,
                    })
                  }
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Sources</SelectItem>
                    <SelectItem value="website">Website</SelectItem>
                    <SelectItem value="resend-sync">Resend Sync</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Created after</Label>
                  <Input
                    type="date"
                    value={tempFilters.createdAfter || ""}
                    onChange={(e) =>
                      setTempFilters({
                        ...tempFilters,
                        createdAfter: e.target.value || undefined,
                      })
                    }
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Created before</Label>
                  <Input
                    type="date"
                    value={tempFilters.createdBefore || ""}
                    onChange={(e) =>
                      setTempFilters({
                        ...tempFilters,
                        createdBefore: e.target.value || undefined,
                      })
                    }
                    className="h-8 text-sm"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-2 border-t">
                <button
                  onClick={handleResetFilters}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Reset all
                </button>
                <Button size="sm" className="h-7" onClick={handleApplyFilters}>
                  Apply filters
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {/* Subscriber List */}
      {filteredSubscribers.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-32 text-center">
          <Mail className="h-10 w-10 text-muted-foreground mb-2" />
          <p className="text-muted-foreground">
            {searchQuery || activeFilterCount > 0
              ? "No subscribers match your filters"
              : "No subscribers yet"}
          </p>
          {!searchQuery && activeFilterCount === 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              Click &quot;Sync from Resend&quot; to import subscribers from your
              Resend audiences
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filteredSubscribers.map((sub) => {
            const segments = sub.segments || [];
            const isSaving = savingSegmentsId === sub.id;

            return (
              <Card
                key={sub.id}
                className="hover:bg-accent/50 transition-colors cursor-pointer"
                onClick={() => router.push(`/subscribers/${sub.id}`)}
              >
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{sub.email}</p>
                      {sub.name && (
                        <p className="text-sm text-muted-foreground truncate">
                          {sub.name}
                        </p>
                      )}
                    </div>

                    {/* Segment dropdown */}
                    <div
                      className="hidden md:block"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 gap-1"
                            disabled={isSaving}
                          >
                            {isSaving ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : segments.length > 0 ? (
                              <div className="flex items-center gap-1">
                                {segments.map((seg) => (
                                  <Badge
                                    key={seg}
                                    className={`text-[10px] px-1.5 py-0 ${segmentColors[seg] || ""}`}
                                  >
                                    {seg}
                                  </Badge>
                                ))}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                No segments
                              </span>
                            )}
                            <ChevronDown className="size-3 text-muted-foreground" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuLabel className="text-xs">
                            Segments
                          </DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          {ALL_SEGMENTS.map((seg) => (
                            <DropdownMenuCheckboxItem
                              key={seg}
                              checked={segments.includes(seg)}
                              onCheckedChange={(checked) =>
                                handleSegmentToggle(sub, seg, !!checked)
                              }
                              onSelect={(e) => e.preventDefault()}
                            >
                              <span className="capitalize">{seg}</span>
                            </DropdownMenuCheckboxItem>
                          ))}
                          <DropdownMenuSeparator />
                          <DropdownMenuCheckboxItem
                            checked={segments.length === ALL_SEGMENTS.length}
                            onCheckedChange={(checked) =>
                              checked
                                ? handleSubscribeAll(sub)
                                : handleUnsubscribeAll(sub)
                            }
                            onSelect={(e) => e.preventDefault()}
                          >
                            <span className="font-medium">All segments</span>
                          </DropdownMenuCheckboxItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    <div className="hidden lg:flex items-center gap-6 text-sm text-muted-foreground">
                      {sub.source && (
                        <span className="text-xs">{sub.source}</span>
                      )}
                      <span className="text-xs">
                        {sub.subscribedAt
                          ? format(new Date(sub.subscribedAt), "MMM d, yyyy")
                          : format(new Date(sub.createdAt), "MMM d, yyyy")}
                      </span>
                    </div>

                    <Badge className={statusColors[sub.status] || ""}>
                      {sub.status.charAt(0) + sub.status.slice(1).toLowerCase()}
                    </Badge>

                    <div onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleToggle(sub.id)}
                        disabled={togglingId === sub.id}
                        title={
                          sub.status === "UNSUBSCRIBED"
                            ? "Re-activate subscriber"
                            : "Unsubscribe"
                        }
                      >
                        {togglingId === sub.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : sub.status === "UNSUBSCRIBED" ? (
                          <MailCheck className="size-4 text-green-600" />
                        ) : (
                          <MailX className="size-4 text-red-500" />
                        )}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
