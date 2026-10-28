"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Trash2, AlertTriangle, Loader2 } from "lucide-react";
import { TagForm } from "@/components/tags";
import { getTagBySlug, updateTag, deleteTag } from "@/lib/actions/tags";
import { Button } from "@usemoney/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@usemoney/ui/alert-dialog";

interface TagData {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  color: string | null;
  imageUrl: string | null;
  _count: {
    posts: number;
  };
}

export default function EditTagPage() {
  const router = useRouter();
  const params = useParams();
  const slug = params.slug as string;

  const [tag, setTag] = useState<TagData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTag() {
      setIsLoading(true);
      const result = await getTagBySlug(slug);

      if (result.success && result.data) {
        setTag(result.data);
      } else {
        setError(result.error || "Tag not found");
      }

      setIsLoading(false);
    }

    fetchTag();
  }, [slug]);

  const handleSubmit = async (data: {
    name: string;
    slug: string;
    description: string;
    color: string;
    imageUrl: string;
  }) => {
    if (!tag) return { success: false, error: "Tag not found" };

    setIsSubmitting(true);

    try {
      const result = await updateTag(tag.id, {
        name: data.name,
        slug: data.slug,
        description: data.description || null,
        color: data.color || null,
        imageUrl: data.imageUrl || null,
      });

      if (result.success) {
        // If slug changed, redirect to new slug
        if (data.slug !== slug) {
          router.push(`/tags/${data.slug}`);
        } else {
          router.push("/tags");
        }
        return { success: true };
      }

      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: "An unexpected error occurred" };
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!tag) return;

    setIsDeleting(true);

    try {
      const result = await deleteTag(tag.id);

      if (result.success) {
        router.push("/tags");
      } else {
        setError(result.error || "Failed to delete tag");
      }
    } catch (error) {
      setError("An unexpected error occurred");
    } finally {
      setIsDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-center p-12">
          <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        </div>
      </div>
    );
  }

  if (error && !tag) {
    return (
      <div className="max-w-2xl mx-auto">
        <Link
          href="/tags"
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors mb-6"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Tags
        </Link>

        <div className="p-8 rounded-xl bg-red-500/10 border border-red-500/20 text-center">
          <p className="text-red-400">{error}</p>
        </div>
      </div>
    );
  }

  if (!tag) return null;

  const hasPostsWarning = tag._count.posts > 0;

  return (
    <div className="max-w-2xl mx-auto">
      {/* Back link */}
      <Link
        href="/tags"
        className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors mb-6"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Tags
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Edit Tag</h1>
          <p className="text-slate-400 mt-1">
            Update the tag details or delete it.
          </p>
        </div>

        {/* Delete button */}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              className="border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-400"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="bg-slate-900 border-slate-800">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-white">
                Delete Tag
              </AlertDialogTitle>
              <AlertDialogDescription className="text-slate-400">
                {hasPostsWarning ? (
                  <div className="space-y-3">
                    <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
                      <div className="text-amber-400 text-sm">
                        <p className="font-medium">Warning: Tag is in use</p>
                        <p className="mt-1">
                          This tag is currently used by{" "}
                          <strong>{tag._count.posts}</strong>{" "}
                          {tag._count.posts === 1 ? "post" : "posts"}. You must
                          remove the tag from all posts before deleting it.
                        </p>
                      </div>
                    </div>
                    <p>
                      Are you sure you want to delete the tag &quot;
                      <strong>{tag.name}</strong>&quot;?
                    </p>
                  </div>
                ) : (
                  <p>
                    Are you sure you want to delete the tag &quot;
                    <strong>{tag.name}</strong>&quot;? This action cannot be
                    undone.
                  </p>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="border-slate-700 hover:bg-slate-800">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                disabled={isDeleting}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  "Delete Tag"
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* Error message */}
      {error && (
        <div className="mb-6 p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Post count info */}
      <div className="mb-6 p-4 rounded-xl border border-slate-800 bg-slate-900/30">
        <div className="flex items-center gap-3">
          <div
            className="h-10 w-10 rounded-lg"
            style={{ backgroundColor: tag.color || "#3b82f6" }}
          />
          <div>
            <p className="text-sm text-slate-400">
              This tag is used in{" "}
              <span className="text-white font-medium">{tag._count.posts}</span>{" "}
              {tag._count.posts === 1 ? "post" : "posts"}
            </p>
          </div>
        </div>
      </div>

      {/* Form Card */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-6">
        <TagForm
          initialData={{
            id: tag.id,
            name: tag.name,
            slug: tag.slug,
            description: tag.description,
            color: tag.color,
            imageUrl: tag.imageUrl,
          }}
          onSubmit={handleSubmit}
          submitLabel="Update Tag"
          isSubmitting={isSubmitting}
        />
      </div>
    </div>
  );
}
