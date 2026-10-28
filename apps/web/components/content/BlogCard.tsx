import Image from "next/image";
import Link from "next/link";
import { Calendar } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AuthorAvatar } from "@/components/content/AuthorAvatar";
import type { PostListItem } from "@usemoney/types";

const CONTENT_TYPE_PATHS: Record<string, string> = {
  BLOG: "/blog",
  NEWSLETTER: "/newsletter",
  GLOSSARY: "/glossary",
  DOCS: "/docs",
  LEGAL: "/legal",
};

interface BlogCardProps {
  post: PostListItem;
  variant?: "default" | "featured";
  basePath?: string;
}

function formatDate(date: Date | null | undefined): string {
  if (!date) return "";
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function BlogCard({
  post,
  variant = "default",
  basePath,
}: BlogCardProps) {
  const isFeatured = variant === "featured";
  const path = basePath || CONTENT_TYPE_PATHS[post.contentType] || "/blog";

  return (
    <Link href={`${path}/${post.postUrl}`} className="group block h-full">
      <Card
        className={`h-full overflow-hidden bg-card/50 border-border hover:border-border transition-all duration-300 hover:shadow-lg hover:shadow-blue-500/5 ${
          isFeatured ? "md:flex md:flex-row" : ""
        }`}
      >
        {/* Feature Image */}
        <div
          className={`relative overflow-hidden ${
            isFeatured ? "h-48 md:h-auto md:w-2/5 md:min-h-[250px]" : "h-48"
          }`}
        >
          {post.featureImage ? (
            <Image
              src={post.featureImage}
              alt={post.title}
              fill
              className="object-cover transition-transform duration-300 group-hover:scale-105"
              sizes={
                isFeatured
                  ? "(max-width: 768px) 100vw, 40vw"
                  : "(max-width: 768px) 100vw, 33vw"
              }
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-slate-800 to-slate-900 flex items-center justify-center">
              <span className="text-4xl text-muted-foreground/50">
                {post.title.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          {/* Premium badge */}
          {post.isPremium && (
            <div className="absolute top-3 right-3">
              <Badge className="bg-amber-500/90 hover:bg-amber-500 text-black font-semibold">
                Premium
              </Badge>
            </div>
          )}
        </div>

        {/* Content */}
        <CardContent
          className={`p-5 flex flex-col ${isFeatured ? "md:w-3/5 md:p-6" : ""}`}
        >
          {/* Tags */}
          {post.tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {post.tags.slice(0, 3).map((tag) => (
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
          <h3
            className={`font-semibold text-foreground group-hover:text-blue-400 transition-colors line-clamp-2 mb-2 ${
              isFeatured ? "text-xl md:text-2xl" : "text-lg"
            }`}
          >
            {post.title}
          </h3>

          {/* Excerpt */}
          {post.excerpt && (
            <p
              className={`text-muted-foreground line-clamp-2 mb-4 ${
                isFeatured ? "text-base" : "text-sm"
              }`}
            >
              {post.excerpt}
            </p>
          )}

          {/* Meta info - pushed to bottom */}
          <div className="mt-auto flex items-center gap-4 text-sm text-muted-foreground">
            {/* Author */}
            <div className="flex items-center gap-2">
              <AuthorAvatar
                src={post.author.imageUrl}
                name={post.author.name || post.author.username}
                size={20}
              />
              <span className="truncate max-w-[120px]">
                {post.author.name || post.author.username}
              </span>
            </div>

            {/* Date */}
            <div className="flex items-center gap-1">
              <Calendar className="h-4 w-4" />
              <span>{formatDate(post.publishDate)}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
