"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { EditorErrorBoundary } from "@/components/editor/editor-error-boundary";
import { getPostById } from "@/lib/actions";

const BlockNoteRenderDynamic = dynamic(
  () =>
    import("@/components/editor/blocknote-render").then(
      (mod) => mod.BlockNoteRender,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    ),
  },
);

interface PostData {
  title: string;
  content: string;
  contentType: string;
  featureImage: string | null;
  excerpt: string | null;
}

export default function PreviewPage() {
  const params = useParams();
  const postId = params.id as string;

  const [post, setPost] = useState<PostData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchPost = async () => {
      try {
        const result = await getPostById(postId);
        if (result.success && result.data) {
          setPost(result.data as unknown as PostData);
        } else {
          setError(result.error || "Post not found");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load post");
      } finally {
        setIsLoading(false);
      }
    };
    fetchPost();
  }, [postId]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !post) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold">Failed to load preview</h1>
          <p className="text-muted-foreground">{error || "Post not found"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-6 py-12">
        {/* Content type badge */}
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {post.contentType} Preview
        </span>

        {/* Feature image */}
        {post.featureImage && (
          <img
            src={post.featureImage}
            alt={post.title}
            className="w-full max-h-80 object-cover rounded-lg mt-4"
          />
        )}

        {/* Title */}
        <h1 className="text-4xl font-bold mt-6 mb-2">{post.title}</h1>

        {/* Excerpt */}
        {post.excerpt && (
          <p className="text-lg text-muted-foreground mb-8">{post.excerpt}</p>
        )}

        {/* Content */}
        <div className="mt-8">
          {post.content ? (
            <EditorErrorBoundary fallbackContent={post.content}>
              <BlockNoteRenderDynamic content={post.content} />
            </EditorErrorBoundary>
          ) : (
            <p className="text-muted-foreground text-center py-8">
              No content to preview
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
