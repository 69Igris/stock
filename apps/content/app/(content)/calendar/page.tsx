"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@usemoney/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@usemoney/ui/card";
import { Badge } from "@usemoney/ui/badge";
import { Skeleton } from "@usemoney/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  FileText,
  BookA,
  Mail,
  Scale,
} from "lucide-react";
import { fetchAllPosts, type PostListType } from "@/lib/actions";
import { cn } from "@/lib/utils";

type ContentType = "BLOG" | "GLOSSARY" | "NEWSLETTER" | "LEGAL";
type PostStatus = "DRAFT" | "PUBLISHED" | "SCHEDULED" | "DELETED";

const typeColors: Record<ContentType, string> = {
  BLOG: "bg-purple-500",
  GLOSSARY: "bg-cyan-500",
  NEWSLETTER: "bg-orange-500",
  LEGAL: "bg-slate-500",
};

const typeIcons: Record<ContentType, React.ReactNode> = {
  BLOG: <FileText className="h-3 w-3" />,
  GLOSSARY: <BookA className="h-3 w-3" />,
  NEWSLETTER: <Mail className="h-3 w-3" />,
  LEGAL: <Scale className="h-3 w-3" />,
};

const statusBadgeColors: Record<PostStatus, string> = {
  DRAFT: "bg-yellow-500/20 text-yellow-400",
  PUBLISHED: "bg-emerald-500/20 text-emerald-400",
  SCHEDULED: "bg-blue-500/20 text-blue-400",
  DELETED: "bg-red-500/20 text-red-400",
};

interface CalendarPost extends PostListType {
  displayDate: Date;
}

const DAYS_OF_WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

export default function ContentCalendarPage() {
  const router = useRouter();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [posts, setPosts] = useState<CalendarPost[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filterType, setFilterType] = useState<ContentType | "all">("all");

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const loadPosts = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchAllPosts(0, undefined, undefined);
      const calendarPosts: CalendarPost[] = data.map((post) => ({
        ...post,
        displayDate: post.publishDate
          ? new Date(post.publishDate)
          : new Date(post.createdAt),
      }));
      setPosts(calendarPosts);
    } catch {
      setPosts([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPosts();
  }, [loadPosts]);

  const goToPreviousMonth = () => {
    setCurrentDate(new Date(year, month - 1, 1));
  };

  const goToNextMonth = () => {
    setCurrentDate(new Date(year, month + 1, 1));
  };

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  const getPostsForDay = (day: number): CalendarPost[] => {
    return posts.filter((post) => {
      const postDate = post.displayDate;
      return (
        postDate.getDate() === day &&
        postDate.getMonth() === month &&
        postDate.getFullYear() === year &&
        (filterType === "all" || post.contentType === filterType)
      );
    });
  };

  const daysInMonth = getDaysInMonth(year, month);
  const firstDayOfMonth = getFirstDayOfMonth(year, month);
  const today = new Date();
  const isCurrentMonth =
    today.getMonth() === month && today.getFullYear() === year;

  const calendarDays: (number | null)[] = [];
  for (let i = 0; i < firstDayOfMonth; i++) {
    calendarDays.push(null);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    calendarDays.push(day);
  }

  return (
    <div className="p-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2">
            <CalendarDays className="h-8 w-8 text-primary" />
            Content Calendar
          </h1>
          <p className="text-muted-foreground text-sm sm:text-base">
            View and manage scheduled content
          </p>
        </div>

        <Select
          value={filterType}
          onValueChange={(v) => setFilterType(v as ContentType | "all")}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Filter by type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="BLOG">Blog</SelectItem>
            <SelectItem value="GLOSSARY">Glossary</SelectItem>
            <SelectItem value="NEWSLETTER">Newsletter</SelectItem>
            <SelectItem value="LEGAL">Legal</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Calendar */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button variant="outline" size="icon" onClick={goToPreviousMonth}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <CardTitle className="text-xl min-w-[200px] text-center">
                {MONTHS[month]} {year}
              </CardTitle>
              <Button variant="outline" size="icon" onClick={goToNextMonth}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <Button variant="outline" size="sm" onClick={goToToday}>
              Today
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="grid grid-cols-7 gap-1">
              {DAYS_OF_WEEK.map((day) => (
                <div
                  key={day}
                  className="h-10 flex items-center justify-center text-sm font-medium text-muted-foreground"
                >
                  {day}
                </div>
              ))}
              {Array.from({ length: 35 }).map((_, i) => (
                <Skeleton key={i} className="h-32" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-7 gap-1">
              {DAYS_OF_WEEK.map((day) => (
                <div
                  key={day}
                  className="h-10 flex items-center justify-center text-sm font-medium text-muted-foreground"
                >
                  {day}
                </div>
              ))}
              {calendarDays.map((day, index) => {
                if (day === null) {
                  return (
                    <div
                      key={`empty-${index}`}
                      className="min-h-[120px] bg-muted/20 rounded-lg"
                    />
                  );
                }

                const dayPosts = getPostsForDay(day);
                const isToday = isCurrentMonth && today.getDate() === day;

                return (
                  <div
                    key={day}
                    className={cn(
                      "min-h-[120px] p-2 rounded-lg transition-colors",
                      isToday
                        ? "bg-primary/10 border border-primary/50"
                        : "bg-muted/10 hover:bg-muted/20",
                    )}
                  >
                    <div
                      className={cn(
                        "text-sm font-medium mb-2",
                        isToday ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      {day}
                    </div>
                    <div className="space-y-1">
                      {dayPosts.slice(0, 3).map((post) => (
                        <button
                          key={post.id}
                          onClick={() => router.push(`/editor/${post.id}`)}
                          className={cn(
                            "w-full text-left px-2 py-1 rounded text-xs truncate flex items-center gap-1.5 hover:opacity-80 transition-opacity text-white",
                            typeColors[post.contentType as ContentType],
                          )}
                          title={post.title}
                        >
                          {typeIcons[post.contentType as ContentType]}
                          <span className="truncate">{post.title}</span>
                        </button>
                      ))}
                      {dayPosts.length > 3 && (
                        <div className="text-xs text-muted-foreground px-2">
                          +{dayPosts.length - 3} more
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Upcoming Scheduled Posts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Scheduled Posts This Month</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {posts
                .filter(
                  (p) =>
                    p.status === "SCHEDULED" &&
                    p.displayDate.getMonth() === month &&
                    p.displayDate.getFullYear() === year &&
                    (filterType === "all" || p.contentType === filterType),
                )
                .sort(
                  (a, b) => a.displayDate.getTime() - b.displayDate.getTime(),
                )
                .map((post) => (
                  <button
                    key={post.id}
                    onClick={() => router.push(`/editor/${post.id}`)}
                    className="w-full flex items-center justify-between p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors group"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={cn(
                          "h-8 w-8 rounded-lg flex items-center justify-center text-white",
                          typeColors[post.contentType as ContentType],
                        )}
                      >
                        {typeIcons[post.contentType as ContentType]}
                      </div>
                      <div className="min-w-0 text-left">
                        <p className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                          {post.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {post.displayDate.toLocaleDateString("en-IN", {
                            weekday: "short",
                            day: "2-digit",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-xs",
                        statusBadgeColors[post.status as PostStatus],
                      )}
                    >
                      Scheduled
                    </Badge>
                  </button>
                ))}

              {posts.filter(
                (p) =>
                  p.status === "SCHEDULED" &&
                  p.displayDate.getMonth() === month &&
                  p.displayDate.getFullYear() === year &&
                  (filterType === "all" || p.contentType === filterType),
              ).length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  <CalendarDays className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No scheduled posts this month</p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
