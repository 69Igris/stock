"use client";

import { useState } from "react";
import { Link as LinkIcon, Star, X, Search } from "lucide-react";
import { Label } from "@usemoney/ui/label";
import { Textarea } from "@usemoney/ui/textarea";
import { Switch } from "@usemoney/ui/switch";
import { Separator } from "@usemoney/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import { Input } from "@usemoney/ui/input";
import type { Tag } from "@usemoney/types";

const CONTENT_TYPE_PREFIXES: Record<string, string> = {
  BLOG: "blog",
  GLOSSARY: "glossary",
  NEWSLETTER: "newsletter",
  DOCS: "docs",
  LEGAL: "legal",
};

interface MetadataSidebarProps {
  postUrl?: string;
  contentType?: string;
  featureImage: string | null;
  excerpt: string | null;
  isFeatured: boolean;
  isPremium: boolean;
  metadataTitle: string | null;
  metadataDescription: string | null;
  metadataKeywords: string | null;
  selectedTagIds: string[];
  availableTags: Tag[];
  onChange: (updates: {
    postUrl?: string;
    featureImage?: string | null;
    excerpt?: string | null;
    isFeatured?: boolean;
    isPremium?: boolean;
    metadataTitle?: string | null;
    metadataDescription?: string | null;
    metadataKeywords?: string | null;
    selectedTagIds?: string[];
  }) => void;
  isVisible?: boolean;
}

export function MetadataSidebar({
  postUrl,
  contentType = "BLOG",
  featureImage,
  excerpt,
  isFeatured,
  metadataTitle,
  metadataDescription,
  metadataKeywords,
  selectedTagIds,
  availableTags,
  onChange,
  isVisible = true,
}: MetadataSidebarProps) {
  const [tagSearch, setTagSearch] = useState("");

  if (!isVisible) return null;

  const filteredTags = availableTags.filter(
    (tag) =>
      tag.name.toLowerCase().includes(tagSearch.toLowerCase()) ||
      tag.slug.toLowerCase().includes(tagSearch.toLowerCase()),
  );

  const selectedTags = availableTags.filter((tag) =>
    selectedTagIds.includes(tag.id),
  );

  const handleTagToggle = (tagId: string) => {
    const newSelectedIds = selectedTagIds.includes(tagId)
      ? selectedTagIds.filter((id) => id !== tagId)
      : [...selectedTagIds, tagId];
    onChange({ selectedTagIds: newSelectedIds });
  };

  const keywordCount = metadataKeywords
    ? metadataKeywords
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0).length
    : 0;

  return (
    <div className="w-[400px] fixed right-0 top-[57px] bottom-0 z-40 shadow-lg p-6 overflow-y-auto bg-background border-l border-border">
      <h2 className="text-2xl font-semibold mb-4">Post settings</h2>

      <div className="space-y-4 mt-8">
        {/* Post URL */}
        {postUrl !== undefined && (
          <div className="space-y-2">
            <Label htmlFor="postUrl" className="text-[13px]">
              Post URL
            </Label>
            <div className="flex items-center bg-muted border-2 border-transparent focus-within:border-green-500 rounded-md">
              <LinkIcon className="text-muted-foreground ml-2 size-4" />
              <input
                id="postUrl"
                type="text"
                placeholder="Post URL"
                value={postUrl}
                onChange={(e) => {
                  const url = e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, "-")
                    .replace(/-+/g, "-")
                    .replace(/(^-|-$)/g, "");
                  onChange({ postUrl: url });
                }}
                className="flex h-8 w-full rounded-md bg-muted text-foreground ring-0 focus:ring-0 focus:outline-none px-3 py-2 text-sm placeholder:text-muted-foreground"
              />
            </div>
            {postUrl && (
              <span className="text-[12px] text-muted-foreground">
                usemoney.ai/{CONTENT_TYPE_PREFIXES[contentType] || "blog"}/
                {postUrl}/
              </span>
            )}
          </div>
        )}

        {/* Publish Date */}
        <div className="flex flex-col gap-2 mb-4">
          <Label htmlFor="PublishDate" className="text-[13px]">
            Publish Date
          </Label>
          <div className="flex flex-row items-center gap-2">
            <input
              type="date"
              defaultValue={new Date().toISOString().split("T")[0]}
              className="flex h-10 rounded-md bg-muted text-foreground ring-0 focus:ring-0 focus:outline-none px-3 py-2 text-sm"
            />
            <div className="flex items-center bg-muted rounded-md">
              <input
                type="time"
                defaultValue="23:59"
                className="flex h-10 rounded-md bg-muted text-foreground ring-0 focus:ring-0 focus:outline-none px-3 py-2 text-sm"
              />
              <span className="text-muted-foreground items-center mr-4 text-[10px]">
                IST
              </span>
            </div>
          </div>
        </div>

        {/* Excerpt */}
        <div>
          <Label htmlFor="Excerpt" className="text-[13px]">
            Excerpt
          </Label>
          <Textarea
            id="Excerpt"
            placeholder="Write a short description of your post"
            value={excerpt || ""}
            onChange={(e) => onChange({ excerpt: e.target.value || null })}
            className="mt-2 bg-muted border-2 border-transparent focus-within:border-green-500 text-sm"
          />
          <div className="text-muted-foreground text-[12px]">
            Recommended: 150 characters. You&apos;ve used{" "}
            <span
              className={
                (excerpt?.length || 0) === 0
                  ? ""
                  : (excerpt?.length || 0) <= 250
                    ? "text-green-500"
                    : "text-red-500"
              }
            >
              {excerpt?.length || 0}
            </span>
            .
          </div>
        </div>

        {/* Tags */}
        <div className="space-y-2">
          <Label className="text-[13px]">Tags</Label>

          {/* Selected Tags */}
          {selectedTags.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {selectedTags.map((tag) => (
                <span
                  key={tag.id}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full bg-primary/20 text-primary border border-primary/30"
                >
                  {tag.color && (
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                  )}
                  {tag.name}
                  <button
                    type="button"
                    onClick={() => handleTagToggle(tag.id)}
                    className="ml-1 hover:opacity-70"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <Select
            value=""
            onValueChange={(tagId) => {
              if (tagId && !selectedTagIds.includes(tagId)) {
                onChange({ selectedTagIds: [...selectedTagIds, tagId] });
              }
            }}
          >
            <SelectTrigger className="bg-muted border-2 border-transparent">
              <SelectValue placeholder="Select tags" />
            </SelectTrigger>
            <SelectContent>
              {availableTags.map((tag) => (
                <SelectItem
                  key={tag.id}
                  value={tag.id}
                  disabled={selectedTagIds.includes(tag.id)}
                >
                  {tag.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Feature Post Toggle */}
        <div className="flex items-center justify-between bg-card p-4 rounded-md border border-border">
          <div className="flex items-center gap-2 h-6">
            <Star
              className="size-5"
              fill={isFeatured ? "green" : "transparent"}
              stroke={isFeatured ? "green" : "currentColor"}
            />
            <Label htmlFor="feature-post" className="leading-none">
              Feature this post
            </Label>
          </div>
          <Switch
            id="feature-post"
            checked={isFeatured}
            onCheckedChange={(checked) => onChange({ isFeatured: checked })}
          />
        </div>

        {/* SEO & Social */}
        <div className="mt-4">
          <Label className="text-2xl font-semibold">SEO & Social</Label>
        </div>
        <Separator />

        {/* SEO Keywords */}
        <div>
          <Label htmlFor="SEOKeywords" className="text-[13px]">
            SEO Keywords
          </Label>
          <Textarea
            id="SEOKeywords"
            placeholder="SEO Keywords"
            value={metadataKeywords || ""}
            onChange={(e) =>
              onChange({ metadataKeywords: e.target.value || null })
            }
            className="mt-2 bg-muted border-2 border-transparent focus-within:border-green-500 text-sm"
          />
          <div className="text-muted-foreground text-[12px]">
            Recommended: 10 words (Max: 500 characters).
            <br /> You&apos;ve used{" "}
            <span
              className={
                keywordCount === 0
                  ? ""
                  : (metadataKeywords?.length || 0) <= 500
                    ? "text-green-500"
                    : "text-red-500"
              }
            >
              {keywordCount}
            </span>
            .
          </div>
        </div>

        {/* Meta Data Title */}
        <div className="space-y-2">
          <Label htmlFor="MetaDataTitle" className="text-[13px]">
            Meta Data Title
          </Label>
          <input
            id="MetaDataTitle"
            type="text"
            placeholder="Meta Data Title"
            value={metadataTitle || ""}
            onChange={(e) =>
              onChange({ metadataTitle: e.target.value || null })
            }
            className="flex h-10 w-full rounded-md bg-muted text-foreground ring-0 focus:ring-0 focus:outline-none px-3 py-2 text-sm placeholder:text-muted-foreground border-2 border-transparent focus-within:border-green-500"
          />
          <div className="text-muted-foreground text-[12px]">
            Recommended: 50 characters. You&apos;ve used{" "}
            <span
              className={
                (metadataTitle?.length || 0) === 0
                  ? ""
                  : (metadataTitle?.length || 0) <= 100
                    ? "text-green-500"
                    : "text-red-500"
              }
            >
              {metadataTitle?.length || 0}
            </span>
            .
          </div>
        </div>

        {/* Meta Data Description */}
        <div>
          <Label htmlFor="MetaDataDescription" className="text-[13px]">
            Meta Data Description
          </Label>
          <Textarea
            id="MetaDataDescription"
            placeholder="Meta Data Description"
            value={metadataDescription || ""}
            onChange={(e) =>
              onChange({ metadataDescription: e.target.value || null })
            }
            className="mt-2 bg-muted border-2 border-transparent focus-within:border-green-500 text-sm"
          />
          <div className="text-muted-foreground text-[12px]">
            Recommended: 160 characters. You&apos;ve used{" "}
            <span
              className={
                (metadataDescription?.length || 0) === 0
                  ? ""
                  : (metadataDescription?.length || 0) <= 500
                    ? "text-green-500"
                    : "text-red-500"
              }
            >
              {metadataDescription?.length || 0}
            </span>
            .
          </div>
        </div>
      </div>
    </div>
  );
}
