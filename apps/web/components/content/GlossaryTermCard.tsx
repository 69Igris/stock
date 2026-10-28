import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface GlossaryTermCardProps {
  title: string;
  excerpt: string | null;
  href: string;
}

export function GlossaryTermCard({
  title,
  excerpt,
  href,
}: GlossaryTermCardProps) {
  // Truncate excerpt to ~100 characters
  const truncatedExcerpt = excerpt
    ? excerpt.length > 100
      ? `${excerpt.substring(0, 100).trim()}...`
      : excerpt
    : null;

  return (
    <Link href={href} className="group block">
      <Card className="h-full bg-card/50 border-border hover:border-border hover:bg-muted/50 transition-all duration-200">
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <h3 className="font-medium text-foreground group-hover:text-cyan-400 transition-colors truncate">
                {title}
              </h3>
              {truncatedExcerpt && (
                <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                  {truncatedExcerpt}
                </p>
              )}
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-cyan-400 group-hover:translate-x-1 transition-all shrink-0 mt-1" />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
