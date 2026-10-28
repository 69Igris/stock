"use client";

import { useState, useEffect } from "react";
import { Input } from "@usemoney/ui/input";
import { Badge } from "@usemoney/ui/badge";
import { Card, CardContent } from "@usemoney/ui/card";
import { Search, BookA } from "lucide-react";
import { getGlossaryTermsAction } from "@/lib/actions/learning";

interface GlossaryTerm {
  id: string;
  term: string;
  definition: string;
  category: string | null;
  related: string[];
}

export function GlossaryList() {
  const [search, setSearch] = useState("");
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    const timeout = setTimeout(async () => {
      try {
        const result = await getGlossaryTermsAction(search || undefined);
        if (result?.success) {
          setTerms(result?.data as unknown as GlossaryTerm[]);
        }
      } catch {
        // handled
      } finally {
        setIsLoading(false);
      }
    }, 300);
    return () => clearTimeout(timeout);
  }, [search]);

  // Group terms by first letter
  const grouped = terms.reduce<Record<string, GlossaryTerm[]>>((acc, term) => {
    const letter = term.term[0]?.toUpperCase() || "#";
    if (!acc[letter]) acc[letter] = [];
    acc[letter].push(term);
    return acc;
  }, {});

  const sortedLetters = Object.keys(grouped).sort();

  return (
    <div className="space-y-6">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search financial terms..."
          className="pl-10"
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 bg-muted/50 rounded-lg animate-pulse"
            />
          ))}
        </div>
      ) : terms.length === 0 ? (
        <div className="text-center py-12">
          <BookA className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground">
            {search
              ? "No terms match your search"
              : "No glossary terms available yet"}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {sortedLetters.map((letter) => (
            <div key={letter}>
              <h3 className="text-lg font-bold text-blue-400 mb-3 border-b border-border pb-1">
                {letter}
              </h3>
              <div className="space-y-2">
                {grouped[letter].map((term) => (
                  <Card
                    key={term.id}
                    className="bg-card/30 border-border cursor-pointer hover:border-border transition-colors"
                    onClick={() =>
                      setExpandedId(expandedId === term.id ? null : term.id)
                    }
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div>
                          <h4 className="text-sm font-medium text-foreground">
                            {term.term}
                          </h4>
                          {term.category && (
                            <Badge
                              variant="outline"
                              className="text-xs text-muted-foreground border-border mt-1"
                            >
                              {term.category}
                            </Badge>
                          )}
                        </div>
                      </div>
                      {expandedId === term.id && (
                        <div className="mt-3 pt-3 border-t border-border">
                          <p className="text-sm text-muted-foreground">
                            {term.definition}
                          </p>
                          {term.related.length > 0 && (
                            <div className="flex gap-1 mt-2">
                              <span className="text-xs text-muted-foreground">
                                Related:
                              </span>
                              {term.related.map((r) => (
                                <Badge
                                  key={r}
                                  variant="outline"
                                  className="text-xs text-muted-foreground border-border"
                                >
                                  {r}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {expandedId !== term.id && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                          {term.definition}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
