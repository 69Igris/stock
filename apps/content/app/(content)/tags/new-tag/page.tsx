"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { TagForm } from "@/components/tags";
import { createTag } from "@/lib/actions/tags";

export default function NewTagPage() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (data: {
    name: string;
    slug: string;
    description: string;
    color: string;
    imageUrl: string;
  }) => {
    setIsSubmitting(true);

    try {
      const result = await createTag({
        name: data.name,
        slug: data.slug,
        description: data.description || undefined,
        color: data.color || undefined,
        imageUrl: data.imageUrl || undefined,
      });

      if (result.success) {
        router.push("/tags");
        return { success: true };
      }

      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: "An unexpected error occurred" };
    } finally {
      setIsSubmitting(false);
    }
  };

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
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Create New Tag</h1>
        <p className="text-slate-400 mt-1">
          Add a new tag to organize your content.
        </p>
      </div>

      {/* Form Card */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-6">
        <TagForm
          onSubmit={handleSubmit}
          submitLabel="Create Tag"
          isSubmitting={isSubmitting}
        />
      </div>
    </div>
  );
}
