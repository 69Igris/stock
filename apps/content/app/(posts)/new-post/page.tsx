"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  ChevronLeft,
  PanelRightOpen,
  PanelRightClose,
  Save,
  Check,
  Loader2,
  AlertTriangle,
  ImagePlus,
} from "lucide-react";
import { Button } from "@usemoney/ui/button";
import { Label } from "@usemoney/ui/label";
import { Separator } from "@usemoney/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@usemoney/ui/dialog";
import { MetadataSidebar } from "@/components/posts/metadata-sidebar";
import { EditorErrorBoundary } from "@/components/editor/editor-error-boundary";
import { createPost, listTags } from "@/lib/actions";
import type { Tag } from "@usemoney/types";

const CONTENT_TYPE_PREFIXES: Record<string, string> = {
  BLOG: "blog",
  GLOSSARY: "glossary",
  NEWSLETTER: "newsletter",
  DOCS: "docs",
  LEGAL: "legal",
};

const WEB_URL = process.env.NEXT_PUBLIC_WEB_URL || "https://usemoney.ai";

const BlockNoteEditorDynamic = dynamic(
  () =>
    import("@/components/editor/blocknote-editor").then(
      (mod) => mod.BlockNoteEditorComponent,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    ),
  },
);

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

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default function NewPostPage() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [contentType, setContentType] = useState<
    "BLOG" | "GLOSSARY" | "NEWSLETTER" | "DOCS" | "LEGAL"
  >("BLOG");
  const [postUrl, setPostUrl] = useState("");
  const [featureImage, setFeatureImage] = useState<string | null>(null);
  const [excerpt, setExcerpt] = useState<string | null>(null);
  const [isFeatured, setIsFeatured] = useState(false);
  const [isPremium, setIsPremium] = useState(false);
  const [metadataTitle, setMetadataTitle] = useState<string | null>(null);
  const [metadataDescription, setMetadataDescription] = useState<string | null>(
    null,
  );
  const [metadataKeywords, setMetadataKeywords] = useState<string | null>(null);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [isMetadataVisible, setIsMetadataVisible] = useState(true);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  const [isSaving, setIsSaving] = useState(false);
  const [isSavingSuccess, setIsSavingSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isUploadingFeatureImage, setIsUploadingFeatureImage] = useState(false);
  const autoSaveTriggered = useRef(false);
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Auto-generate URL from title
  useEffect(() => {
    setPostUrl(slugify(title));
  }, [title]);

  // Fetch tags
  useEffect(() => {
    const fetchTags = async () => {
      try {
        const result = await listTags();
        if (result.success && result.data) {
          setAvailableTags(result.data as unknown as Tag[]);
        }
      } catch {
        // Tags are optional
      }
    };
    fetchTags();
  }, []);

  const handleSave = async (options?: { openPublish?: boolean }) => {
    if (!title.trim() || !postUrl.trim()) return;

    setIsSaving(true);
    setSaveError(null);

    try {
      const result = await createPost({
        title: title.trim(),
        contentType,
        postUrl,
        content:
          content ||
          JSON.stringify([
            {
              id: crypto.randomUUID(),
              type: "paragraph",
              props: {
                textColor: "default",
                backgroundColor: "default",
                textAlignment: "left",
              },
              content: [],
              children: [],
            },
          ]),
        status: "DRAFT",
        featureImage: featureImage || undefined,
        excerpt: excerpt || undefined,
        isFeatured,
        isPremium,
        metadataTitle: metadataTitle || undefined,
        metadataDescription: metadataDescription || undefined,
        metadataKeywords: metadataKeywords || undefined,
        tagIds: selectedTagIds,
      });

      if (result.success && result.data) {
        setIsSavingSuccess(true);
        setTimeout(() => {
          setIsSavingSuccess(false);
        }, 3000);
        const url = options?.openPublish
          ? `/editor/${result.data.id}?publish=true`
          : `/editor/${result.data.id}`;
        router.push(url);
      } else {
        setSaveError(result.error || "Failed to save post");
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save post");
    } finally {
      setIsSaving(false);
    }
  };

  // Auto-save: when user has a title and content, auto-create draft after 3s idle
  useEffect(() => {
    if (autoSaveTriggered.current) return;
    if (!title.trim() || !content.trim()) return;

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = setTimeout(() => {
      if (!autoSaveTriggered.current && title.trim() && postUrl.trim()) {
        autoSaveTriggered.current = true;
        handleSave();
      }
    }, 3000);

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [title, content]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleMetadataChange = (updates: Record<string, unknown>) => {
    if ("postUrl" in updates) setPostUrl(updates.postUrl as string);
    if ("featureImage" in updates)
      setFeatureImage(updates.featureImage as string | null);
    if ("excerpt" in updates) setExcerpt(updates.excerpt as string | null);
    if ("isFeatured" in updates) setIsFeatured(updates.isFeatured as boolean);
    if ("isPremium" in updates) setIsPremium(updates.isPremium as boolean);
    if ("metadataTitle" in updates)
      setMetadataTitle(updates.metadataTitle as string | null);
    if ("metadataDescription" in updates)
      setMetadataDescription(updates.metadataDescription as string | null);
    if ("metadataKeywords" in updates)
      setMetadataKeywords(updates.metadataKeywords as string | null);
    if ("selectedTagIds" in updates)
      setSelectedTagIds(updates.selectedTagIds as string[]);
  };

  const isDisabled = !title.trim() || !postUrl.trim();

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* PostsEditNavbar */}
      <div
        className={`sticky top-0 z-50 transition-all duration-200 ${isMetadataVisible ? "mr-[400px]" : ""}`}
      >
        <nav className="w-full flex flex-row justify-between px-5 py-4 border-b border-border bg-background">
          <div className="flex flex-row gap-2 items-center">
            <Link
              href="/posts"
              className="flex flex-row items-center text-sm rounded-md hover:bg-accent p-2"
            >
              <ChevronLeft className="size-4 mr-3" />
              Posts
            </Link>
            <Separator orientation="vertical" className="h-4" />
            <Label className="flex flex-row items-center text-sm font-light text-muted-foreground p-2">
              New Post
            </Label>
          </div>

          <div className="flex flex-row items-center gap-2 mr-2">
            <div className="flex flex-row gap-4 items-center">
              {/* Content Type */}
              <Select
                value={contentType.toLowerCase()}
                onValueChange={(value) =>
                  setContentType(
                    value.toUpperCase() as
                      | "BLOG"
                      | "GLOSSARY"
                      | "NEWSLETTER"
                      | "DOCS"
                      | "LEGAL",
                  )
                }
              >
                <SelectTrigger className="w-auto border-none bg-transparent text-green-500">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="blog">Blog</SelectItem>
                  <SelectItem value="glossary">Glossary</SelectItem>
                  <SelectItem value="newsletter">Newsletter</SelectItem>
                  <SelectItem value="docs">Docs</SelectItem>
                  <SelectItem value="legal">Legal</SelectItem>
                </SelectContent>
              </Select>

              <button
                type="button"
                onClick={() => setIsPreviewOpen(true)}
                className="flex flex-row items-center text-sm rounded-md hover:bg-accent p-2"
              >
                Preview
              </button>

              <Button
                variant="link"
                size="sm"
                className="text-green-500"
                disabled={isDisabled || isSaving}
                onClick={async () => {
                  await handleSave({ openPublish: true });
                }}
              >
                Publish
              </Button>

              {/* Save Button */}
              <Button
                variant="ghost"
                onClick={async () => {
                  await handleSave();
                }}
                disabled={isDisabled}
                className="flex items-center"
              >
                {isSaving && !isSavingSuccess ? (
                  <>
                    <Loader2 className="size-4 mr-1 animate-spin" />
                    Saving...
                  </>
                ) : saveError ? (
                  <span className="flex flex-row items-center text-red-500">
                    <AlertTriangle className="size-4 mr-1" />
                    Error
                  </span>
                ) : !isSaving && !isSavingSuccess && !saveError ? (
                  <>
                    <Save className="size-4 mr-1" />
                    Save
                  </>
                ) : (
                  <span className="flex flex-row items-center text-green-500">
                    <Check className="size-4 mr-1" />
                    Saved
                  </span>
                )}
              </Button>
            </div>

            {/* Metadata Toggle */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsMetadataVisible((prev) => !prev)}
            >
              {!isMetadataVisible ? (
                <PanelRightOpen className="size-5" />
              ) : (
                <PanelRightClose className="size-5" />
              )}
            </Button>
          </div>
        </nav>
      </div>

      {/* Main Content */}
      <div className="flex relative flex-1">
        <div
          className={`flex-1 transition-all duration-200 ${isMetadataVisible ? "mr-[400px]" : ""}`}
        >
          <div className="mx-auto rounded-md lg:max-w-screen-2xl">
            {/* Feature Image */}
            <div className="ml-10 max-w-screen-md lg:max-w-screen-lg">
              <label className="flex items-center gap-2 text-muted-foreground font-light hover:text-foreground mt-10 text-sm cursor-pointer">
                {isUploadingFeatureImage ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ImagePlus className="size-4" />
                )}
                {isUploadingFeatureImage
                  ? "Uploading..."
                  : featureImage
                    ? "Change feature image"
                    : "+ Add feature image"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  className="hidden"
                  disabled={isUploadingFeatureImage}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setIsUploadingFeatureImage(true);
                    try {
                      const formData = new FormData();
                      formData.append("file", file);
                      const res = await fetch("/api/upload", {
                        method: "POST",
                        body: formData,
                      });
                      if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        throw new Error(
                          (err as Record<string, string>).error ||
                            "Upload failed",
                        );
                      }
                      const data = (await res.json()) as { url: string };
                      setFeatureImage(data.url);
                    } catch (err) {
                      console.error("Feature image upload failed:", err);
                      setSaveError(
                        err instanceof Error
                          ? err.message
                          : "Failed to upload image",
                      );
                    } finally {
                      setIsUploadingFeatureImage(false);
                      e.target.value = "";
                    }
                  }}
                />
              </label>
              {featureImage && (
                <div className="mt-2 relative">
                  <img
                    src={featureImage}
                    alt="Feature"
                    className="w-full max-h-64 object-cover rounded-lg"
                  />
                  <button
                    type="button"
                    onClick={() => setFeatureImage(null)}
                    className="absolute top-2 right-2 bg-black/50 text-white rounded-full p-1 hover:bg-black/70"
                  >
                    ×
                  </button>
                </div>
              )}
            </div>

            {/* Title */}
            <div>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Post title"
                className="w-full ml-12 mt-4 bg-transparent text-5xl font-semibold outline-none ring-0 placeholder:text-muted-foreground/40"
              />
            </div>

            {/* Editor Area */}
            <div className="mt-8 ml-4 mr-8">
              <EditorErrorBoundary
                fallbackContent={content}
                onChange={setContent}
              >
                <BlockNoteEditorDynamic
                  initialContent={content || undefined}
                  onChange={setContent}
                />
              </EditorErrorBoundary>
            </div>
          </div>
        </div>

        {/* Metadata Sidebar */}
        <MetadataSidebar
          postUrl={postUrl}
          contentType={contentType}
          featureImage={featureImage}
          excerpt={excerpt}
          isFeatured={isFeatured}
          isPremium={isPremium}
          metadataTitle={metadataTitle}
          metadataDescription={metadataDescription}
          metadataKeywords={metadataKeywords}
          selectedTagIds={selectedTagIds}
          availableTags={availableTags}
          onChange={handleMetadataChange}
          isVisible={isMetadataVisible}
        />
      </div>

      {/* Preview Dialog */}
      <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{title || "Untitled"}</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            {content ? (
              <EditorErrorBoundary fallbackContent={content}>
                <BlockNoteRenderDynamic content={content} />
              </EditorErrorBoundary>
            ) : (
              <p className="text-muted-foreground text-center py-8">
                No content to preview
              </p>
            )}
          </div>
          <DialogFooter>
            <a
              href={`${WEB_URL}/${CONTENT_TYPE_PREFIXES[contentType] || "blog"}/${postUrl}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2"
            >
              Open on site
            </a>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
