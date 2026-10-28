"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import Image from "next/image";
import { Upload, X, Loader2, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export interface UploadedImage {
  file?: File;
  preview: string;
  path?: string; // GCS path after upload
  status: "uploading" | "uploaded" | "error";
}

interface ImageDropZoneProps {
  images: UploadedImage[];
  onImagesChange: (images: UploadedImage[]) => void;
  maxImages?: number;
  maxSizeMB?: number;
  disabled?: boolean;
}

const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

export function ImageDropZone({
  images,
  onImagesChange,
  maxImages = 5,
  maxSizeMB = 5,
  disabled = false,
}: ImageDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const uploadFile = useCallback(async (file: File): Promise<UploadedImage> => {
    const preview = URL.createObjectURL(file);
    const img: UploadedImage = { file, preview, status: "uploading" };

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/feedback/upload", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Upload failed");
      }

      const data = await res.json();
      return { ...img, path: data.path, preview: data.url, status: "uploaded" };
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to upload image"
      );
      return { ...img, status: "error" };
    }
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (disabled) return;

      const remaining = maxImages - images.length;
      if (remaining <= 0) {
        toast.error(`Maximum ${maxImages} images allowed`);
        return;
      }

      const validFiles = files.slice(0, remaining).filter((f) => {
        if (!ALLOWED_TYPES.has(f.type)) {
          toast.error(`${f.name}: Only PNG, JPEG, WebP, and GIF are allowed`);
          return false;
        }
        if (f.size > maxSizeMB * 1024 * 1024) {
          toast.error(`${f.name}: File must be under ${maxSizeMB}MB`);
          return false;
        }
        return true;
      });

      if (validFiles.length === 0) return;

      // Add placeholders immediately
      const placeholders: UploadedImage[] = validFiles.map((f) => ({
        file: f,
        preview: URL.createObjectURL(f),
        status: "uploading" as const,
      }));
      const updatedImages = [...images, ...placeholders];
      onImagesChange(updatedImages);

      // Upload in parallel
      const results = await Promise.all(validFiles.map(uploadFile));

      // Replace placeholders with results
      onImagesChange([
        ...images,
        ...results.filter((r) => r.status === "uploaded"),
      ]);
    },
    [images, onImagesChange, maxImages, maxSizeMB, disabled, uploadFile]
  );

  const removeImage = useCallback(
    (index: number) => {
      const updated = images.filter((_, i) => i !== index);
      onImagesChange(updated);
    },
    [images, onImagesChange]
  );

  // Paste handler
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (disabled) return;
      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        addFiles(imageFiles);
      }
    };

    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [addFiles, disabled]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      addFiles(files);
    },
    [addFiles]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  return (
    <div className="space-y-3">
      {/* Image previews */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((img, i) => (
            <div
              key={i}
              className="relative h-20 w-20 rounded-lg border border-border overflow-hidden group"
            >
              {img.status === "uploading" ? (
                <div className="h-full w-full flex items-center justify-center bg-muted">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <Image
                  src={img.preview}
                  alt={`Attachment ${i + 1}`}
                  fill
                  className="object-cover"
                  unoptimized
                />
              )}
              <button
                type="button"
                onClick={() => removeImage(i)}
                className="absolute top-1 right-1 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Drop zone */}
      {images.length < maxImages && (
        <div
          ref={dropZoneRef}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            "border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors",
            isDragging
              ? "border-primary bg-primary/5"
              : "border-border hover:border-muted-foreground",
            disabled && "opacity-50 cursor-not-allowed"
          )}
        >
          <div className="flex flex-col items-center gap-1">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Upload className="h-4 w-4" />
              <ImageIcon className="h-4 w-4" />
            </div>
            <p className="text-xs text-muted-foreground">
              Drop images, paste, or{" "}
              <span className="text-primary underline">browse</span>
            </p>
            <p className="text-[10px] text-muted-foreground/70">
              PNG, JPEG, WebP, GIF · Max {maxSizeMB}MB · {images.length}/
              {maxImages}
            </p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="hidden"
            disabled={disabled}
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              if (files.length > 0) addFiles(files);
              e.target.value = "";
            }}
          />
        </div>
      )}
    </div>
  );
}
