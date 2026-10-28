"use client";

import {
  useCallback,
  useState,
  useRef,
  forwardRef,
  useImperativeHandle,
} from "react";
import { Upload, FileText, Loader2 } from "lucide-react";
import { cn } from "@usemoney/utils";
import {
  ACCEPT_ATTRIBUTE,
  partitionUploadFiles,
  describeRejections,
} from "@/lib/documents/upload-accept";

const MAX_FILES = 10;

interface UploadZoneProps {
  onUpload: (file: File, category: string) => Promise<void>;
  isUploading: boolean;
}

export interface UploadZoneHandle {
  /**
   * Open the file picker. Exposed so the page header's "Upload document"
   * CTA can actually start an upload (MONEY-1167) — it previously only
   * scrolled to this component, which is a no-op when the zone is already
   * on screen, so the primary upload button appeared to do nothing.
   */
  openPicker: () => void;
}

export const UploadZone = forwardRef<UploadZoneHandle, UploadZoneProps>(
  function UploadZone({ onUpload, isUploading }, ref) {
    const [isDragging, setIsDragging] = useState(false);
    const [uploadProgress, setUploadProgress] = useState<{
      current: number;
      total: number;
    } | null>(null);
    const [rejectionMessage, setRejectionMessage] = useState<string | null>(
      null
    );
    const fileInputRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({
      openPicker: () => fileInputRef.current?.click(),
    }));

    const processFiles = useCallback(
      async (files: File[]) => {
        // MONEY-1167: this used to filter on the browser-reported `file.type`
        // alone and `return` when nothing survived — so picking a .csv (whose
        // type is "" on macOS) did NOTHING AT ALL, with no error shown. Accept on
        // extension when the reported type is unusable, and always say what was
        // dropped and why.
        const { accepted, rejected } = partitionUploadFiles(files, MAX_FILES);
        setRejectionMessage(
          rejected.length > 0 ? describeRejections(rejected) : null
        );

        if (accepted.length === 0) return;

        setUploadProgress({ current: 0, total: accepted.length });
        for (let i = 0; i < accepted.length; i++) {
          setUploadProgress({ current: i + 1, total: accepted.length });
          await onUpload(accepted[i].file, "OTHER");
        }
        setUploadProgress(null);
      },
      [onUpload]
    );

    const handleDragOver = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
    }, []);

    const handleDrop = useCallback(
      async (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);

        const files = Array.from(e.dataTransfer.files);
        await processFiles(files);
      },
      [processFiles]
    );

    const handleFileSelect = useCallback(
      async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (files.length > 0) {
          await processFiles(files);
          // Reset input so same file can be selected again
          e.target.value = "";
        }
      },
      [processFiles]
    );

    const isBusy = isUploading || uploadProgress !== null;

    return (
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "rounded-[14px] p-8 text-center transition-colors",
          isDragging && "bg-[var(--emerald-bg)]"
        )}
        style={{
          border: `2px dashed ${isDragging ? "var(--emerald)" : "var(--rule-soft)"}`,
          background: isDragging ? "var(--emerald-bg)" : "var(--paper)",
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT_ATTRIBUTE}
          onChange={handleFileSelect}
          className="hidden"
        />

        {isBusy ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2
              className="h-8 w-8 animate-spin"
              style={{ color: "var(--emerald)" }}
            />
            <p className="text-[var(--ink-3)] text-sm">
              {uploadProgress && uploadProgress.total > 1
                ? `Uploading ${uploadProgress.current} of ${uploadProgress.total}...`
                : "Uploading..."}
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2">
              <Upload className="h-6 w-6 text-[var(--ink-3)]" />
              <FileText className="h-6 w-6 text-[var(--ink-3)]" />
            </div>
            <div>
              <p className="text-[var(--ink-2)] text-sm">
                Drag &amp; drop files here, or{" "}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="underline"
                  style={{ color: "var(--emerald-text)" }}
                >
                  browse
                </button>
              </p>
              <p className="mono text-[var(--ink-3)] text-xs mt-1">
                PDF, Images (PNG/JPEG), CSV, Excel - Max 50MB per file, up to{" "}
                {MAX_FILES} files
              </p>
            </div>
          </div>
        )}

        {/* A rejected file must never look like a broken button (MONEY-1167). */}
        {rejectionMessage && !isBusy && (
          <p
            role="alert"
            className="text-xs mt-3"
            style={{ color: "var(--danger, #d9534f)" }}
          >
            {rejectionMessage}
          </p>
        )}
      </div>
    );
  }
);
