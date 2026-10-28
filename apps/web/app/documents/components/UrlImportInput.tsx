"use client";

import { useState } from "react";
import { Link2, Loader2 } from "lucide-react";

interface UrlImportInputProps {
  onImport: (url: string) => Promise<void>;
  isImporting: boolean;
}

export function UrlImportInput({ onImport, isImporting }: UrlImportInputProps) {
  const [url, setUrl] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;

    await onImport(url.trim());
    setUrl("");
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <div className="relative flex-1">
        <Link2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ink-3)] z-10" />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a URL to import (e.g., research report, annual report)"
          className="pf-input"
          style={{ paddingLeft: 36 }}
          disabled={isImporting}
        />
      </div>
      <button
        type="submit"
        disabled={!url.trim() || isImporting}
        className="pf-bf"
        style={
          !url.trim() || isImporting
            ? { opacity: 0.5, cursor: "not-allowed" }
            : undefined
        }
      >
        {isImporting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Import"}
      </button>
    </form>
  );
}
