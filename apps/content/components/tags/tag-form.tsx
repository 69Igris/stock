"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@usemoney/ui/button";
import { Input } from "@usemoney/ui/input";
import { Label } from "@usemoney/ui/label";
import { Textarea } from "@usemoney/ui/textarea";
import { Loader2, RefreshCw, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface TagFormData {
  name: string;
  slug: string;
  description: string;
  color: string;
  imageUrl: string;
}

interface TagFormProps {
  initialData?: {
    id: string;
    name: string;
    slug: string;
    description?: string | null;
    color?: string | null;
    imageUrl?: string | null;
  };
  onSubmit: (
    data: TagFormData,
  ) => Promise<{ success: boolean; error?: string }>;
  submitLabel: string;
  isSubmitting?: boolean;
}

// Predefined color options
const colorOptions = [
  "#ef4444", // red
  "#f97316", // orange
  "#f59e0b", // amber
  "#eab308", // yellow
  "#84cc16", // lime
  "#22c55e", // green
  "#10b981", // emerald
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#0ea5e9", // sky
  "#3b82f6", // blue
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#a855f7", // purple
  "#d946ef", // fuchsia
  "#ec4899", // pink
  "#f43f5e", // rose
  "#64748b", // slate
];

export function TagForm({
  initialData,
  onSubmit,
  submitLabel,
  isSubmitting = false,
}: TagFormProps) {
  const router = useRouter();
  const [formData, setFormData] = useState<TagFormData>({
    name: initialData?.name || "",
    slug: initialData?.slug || "",
    description: initialData?.description || "",
    color: initialData?.color || "#3b82f6",
    imageUrl: initialData?.imageUrl || "",
  });
  const [error, setError] = useState<string | null>(null);
  const [isGeneratingSlug, setIsGeneratingSlug] = useState(false);

  // Auto-generate slug when name changes (only for new tags)
  useEffect(() => {
    if (!initialData && formData.name && !formData.slug) {
      generateSlug(formData.name);
    }
  }, [formData.name, initialData]);

  const generateSlug = (name: string) => {
    const slug = name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/[\s_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    setFormData((prev) => ({ ...prev, slug }));
  };

  const handleRegenerateSlug = () => {
    if (formData.name) {
      setIsGeneratingSlug(true);
      generateSlug(formData.name);
      setTimeout(() => setIsGeneratingSlug(false), 300);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validation
    if (!formData.name.trim()) {
      setError("Name is required");
      return;
    }

    if (!formData.slug.trim()) {
      setError("Slug is required");
      return;
    }

    // Validate slug format
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(formData.slug)) {
      setError(
        "Slug must be lowercase letters, numbers, and hyphens only (e.g., 'my-tag')",
      );
      return;
    }

    // Validate color format if provided
    if (formData.color && !/^#[0-9A-Fa-f]{6}$/.test(formData.color)) {
      setError("Color must be a valid hex color (e.g., #3b82f6)");
      return;
    }

    const result = await onSubmit(formData);

    if (!result.success) {
      setError(result.error || "Something went wrong");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Name */}
      <div className="space-y-2">
        <Label htmlFor="name" className="text-slate-200">
          Name <span className="text-red-400">*</span>
        </Label>
        <Input
          id="name"
          value={formData.name}
          onChange={(e) =>
            setFormData((prev) => ({ ...prev, name: e.target.value }))
          }
          placeholder="e.g., Stock Market Basics"
          className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 focus:border-blue-500"
        />
      </div>

      {/* Slug */}
      <div className="space-y-2">
        <Label htmlFor="slug" className="text-slate-200">
          Slug <span className="text-red-400">*</span>
        </Label>
        <div className="flex gap-2">
          <Input
            id="slug"
            value={formData.slug}
            onChange={(e) =>
              setFormData((prev) => ({
                ...prev,
                slug: e.target.value.toLowerCase(),
              }))
            }
            placeholder="e.g., stock-market-basics"
            className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 focus:border-blue-500"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={handleRegenerateSlug}
            disabled={!formData.name || isGeneratingSlug}
            className="border-slate-700 hover:bg-slate-800"
          >
            <RefreshCw
              className={cn("h-4 w-4", isGeneratingSlug && "animate-spin")}
            />
          </Button>
        </div>
        <p className="text-xs text-slate-500">
          URL-friendly version of the name. Will be used in URLs like /tags/
          {formData.slug || "your-tag"}
        </p>
      </div>

      {/* Description */}
      <div className="space-y-2">
        <Label htmlFor="description" className="text-slate-200">
          Description
        </Label>
        <Textarea
          id="description"
          value={formData.description}
          onChange={(e) =>
            setFormData((prev) => ({ ...prev, description: e.target.value }))
          }
          placeholder="A brief description of what this tag represents..."
          rows={3}
          className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 focus:border-blue-500 resize-none"
        />
      </div>

      {/* Color */}
      <div className="space-y-3">
        <Label htmlFor="color" className="text-slate-200">
          Color
        </Label>
        <div className="flex flex-wrap gap-2">
          {colorOptions.map((color) => (
            <button
              key={color}
              type="button"
              onClick={() => setFormData((prev) => ({ ...prev, color }))}
              className={cn(
                "w-8 h-8 rounded-lg transition-all duration-200 flex items-center justify-center",
                formData.color === color
                  ? "ring-2 ring-offset-2 ring-offset-slate-900 ring-white scale-110"
                  : "hover:scale-105",
              )}
              style={{ backgroundColor: color }}
            >
              {formData.color === color && (
                <Check className="h-4 w-4 text-white drop-shadow-lg" />
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 mt-3">
          <div className="flex items-center gap-2">
            <div
              className="w-10 h-10 rounded-lg border border-slate-700"
              style={{ backgroundColor: formData.color }}
            />
            <Input
              id="color"
              value={formData.color}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, color: e.target.value }))
              }
              placeholder="#3b82f6"
              className="w-32 bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 focus:border-blue-500 font-mono"
            />
          </div>
          <p className="text-xs text-slate-500">Or enter a custom hex color</p>
        </div>
      </div>

      {/* Image URL */}
      <div className="space-y-2">
        <Label htmlFor="imageUrl" className="text-slate-200">
          Image URL
        </Label>
        <Input
          id="imageUrl"
          value={formData.imageUrl}
          onChange={(e) =>
            setFormData((prev) => ({ ...prev, imageUrl: e.target.value }))
          }
          placeholder="https://example.com/tag-image.jpg"
          className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 focus:border-blue-500"
        />
        {formData.imageUrl && (
          <div className="mt-2 p-2 rounded-lg bg-slate-800 border border-slate-700">
            <img
              src={formData.imageUrl}
              alt="Tag preview"
              className="w-full h-32 object-cover rounded-md"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-4 border-t border-slate-800">
        <Button
          type="submit"
          disabled={isSubmitting}
          className="bg-blue-600 hover:bg-blue-700 text-white"
        >
          {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {submitLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => router.back()}
          className="border-slate-700 hover:bg-slate-800"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
