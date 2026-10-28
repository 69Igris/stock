import Link from "next/link";
import Image from "next/image";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface NewsletterCardProps {
  title: string;
  slug: string;
  excerpt: string | null | undefined;
  publishDate: Date | null | undefined;
  featureImage?: string | null | undefined;
  authorName?: string;
  authorImage?: string | null;
  tags?: { id: string; name: string; slug: string; color?: string | null }[];
}

function formatDate(date: Date | null | undefined): string {
  if (!date) return "";
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function NewsletterCard({
  title,
  slug,
  excerpt,
  publishDate,
  featureImage,
  authorName,
  authorImage,
  tags,
}: NewsletterCardProps) {
  return (
    <Link href={`/newsletter/${slug}`} className="group block h-full">
      <Card className="h-full overflow-hidden bg-card/50 border-border hover:border-border transition-all duration-300 hover:shadow-lg hover:shadow-blue-500/5">
        {/* Feature Image */}
        <div className="relative overflow-hidden h-48">
          {featureImage ? (
            <Image
              src={featureImage}
              alt={title}
              fill
              className="object-cover transition-transform duration-300 group-hover:scale-105"
              sizes="(max-width: 768px) 100vw, 33vw"
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-slate-800 to-slate-900 flex items-center justify-center">
              <span className="text-4xl text-muted-foreground/50">
                {title.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
        </div>

        {/* Content */}
        <CardContent className="p-5 flex flex-col">
          {/* Tags */}
          {tags && tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {tags.slice(0, 3).map((tag) => (
                <Badge
                  key={tag.id}
                  variant="outline"
                  className="text-xs border-border text-muted-foreground hover:border-border"
                  style={
                    tag.color
                      ? {
                          borderColor: `${tag.color}40`,
                          color: tag.color,
                        }
                      : undefined
                  }
                >
                  {tag.name}
                </Badge>
              ))}
            </div>
          )}

          {/* Title */}
          <h3 className="text-lg font-semibold text-foreground group-hover:text-blue-400 transition-colors line-clamp-2 mb-2">
            {title}
          </h3>

          {/* Excerpt */}
          {excerpt && (
            <p className="text-muted-foreground text-sm line-clamp-2 mb-4">
              {excerpt}
            </p>
          )}

          {/* Meta info */}
          <div className="mt-auto flex items-center gap-3 text-xs text-muted-foreground">
            {authorName && <span>{authorName}</span>}
            {authorName && publishDate && (
              <span className="text-muted-foreground/50">&middot;</span>
            )}
            {publishDate && <span>{formatDate(publishDate)}</span>}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
