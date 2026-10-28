"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface GlossarySearchProps {
  resultCount: number;
  initialQuery?: string;
}

export function GlossarySearch({
  resultCount,
  initialQuery = "",
}: GlossarySearchProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);

  // Debounce the search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  // Update URL when debounced query changes
  useEffect(() => {
    const currentQuery = searchParams.get("q") || "";

    if (debouncedQuery !== currentQuery) {
      const params = new URLSearchParams(searchParams.toString());

      if (debouncedQuery) {
        params.set("q", debouncedQuery);
      } else {
        params.delete("q");
      }

      const newUrl = params.toString() ? `?${params.toString()}` : "/glossary";
      router.push(newUrl, { scroll: false });
    }
  }, [debouncedQuery, router, searchParams]);

  const handleClear = useCallback(() => {
    setQuery("");
    setDebouncedQuery("");
    router.push("/glossary", { scroll: false });
  }, [router]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Search terms..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-10 pr-10 h-12 bg-card/50 border-border text-foreground placeholder:text-muted-foreground focus:border-cyan-500/50 focus:ring-cyan-500/20"
        />
        {query && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClear}
            className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 p-0 text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Clear search</span>
          </Button>
        )}
      </div>
      <p className="text-center text-sm text-muted-foreground">
        {resultCount} term{resultCount !== 1 ? "s" : ""} found
        {query && ` for "${query}"`}
      </p>
    </div>
  );
}
