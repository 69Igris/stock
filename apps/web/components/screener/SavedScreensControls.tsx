"use client";

/**
 * SavedScreensControls - Save / Load / Rename / Delete UI for the
 * screener's saved-screens feature (MONEY-201).
 *
 * Playful-redesign: SaveDialog now matches the design-bundle
 * SaveScreenDialog (name + description + folder + tags + alert toggle),
 * while preserving all existing save wiring via saveScreenAction.
 * LoadDropdown is restyled to match the playful language.
 */

import { useCallback, useEffect, useState } from "react";
import { usePfConfirm } from "@/components/ui/use-confirm";
import {
  Bell,
  Bookmark,
  ChevronDown,
  Clock,
  FolderOpen,
  Pencil,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  saveScreenAction,
  listSavedScreensAction,
  loadSavedScreenAction,
  renameSavedScreenAction,
  deleteSavedScreenAction,
  type ScreenerModeId,
  type SavedScreenSummary,
  type SavedScreenDetail,
} from "@/lib/actions/saved-screens";

export interface SavedScreensControlsProps {
  /** Current screener mode - saves stamp this; loads filter to it. */
  mode: ScreenerModeId;
  /** Current filter object for the active mode (gets POSTed on save). */
  filters: Record<string, unknown>;
  /** Optional text query stored alongside the filters. */
  query?: string;
  /** True for demo sessions - disables save/load + shows CTA. */
  isDemoMode: boolean;
  /** Called when user picks a saved screen - apply the filters + query. */
  onLoad: (screen: SavedScreenDetail) => void;
}

export function SavedScreensControls({
  mode,
  filters,
  query,
  isDemoMode,
  onLoad,
}: SavedScreensControlsProps) {
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);

  return (
    <div className="relative flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => {
          if (isDemoMode) {
            toast.info("Sign up to save screens");
            return;
          }
          setSaveDialogOpen(true);
        }}
        className="pf-bf sm"
        style={{ fontSize: 12 }}
        title="Save current filters as a named screen"
      >
        <Bookmark className="h-3 w-3" />
        Save screen
      </button>

      <button
        type="button"
        onClick={() => {
          if (isDemoMode) {
            toast.info("Sign up to load saved screens");
            return;
          }
          setLoadOpen((o) => !o);
        }}
        className="pf-bf sm"
        style={{ fontSize: 12 }}
        title="Load a saved screen"
      >
        Saved
        <ChevronDown className="h-3 w-3" />
      </button>

      {saveDialogOpen && (
        <SaveDialog
          mode={mode}
          filters={filters}
          query={query}
          onClose={() => setSaveDialogOpen(false)}
        />
      )}

      {loadOpen && (
        <LoadDropdown
          mode={mode}
          onClose={() => setLoadOpen(false)}
          onPick={(s) => {
            setLoadOpen(false);
            onLoad(s);
          }}
        />
      )}
    </div>
  );
}

// ── Save dialog ────────────────────────────────────────────────────
// Matches design: name + description + folder select + tags + alert toggle.
// Only `name` is wired to saveScreenAction; folder/description/tags are
// UI-only for now (the DB schema stores only name+mode+filters+query).

const FOLDER_OPTIONS = [
  "Compounders",
  "Momentum",
  "Value picks",
  "Sector plays",
  "Watchlist candidates",
] as const;

function SaveDialog({
  mode,
  filters,
  query,
  onClose,
}: {
  mode: ScreenerModeId;
  filters: Record<string, unknown>;
  query?: string;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [folder, setFolder] = useState<(typeof FOLDER_OPTIONS)[number]>(
    FOLDER_OPTIONS[0]
  );
  const [folderOpen, setFolderOpen] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [alertOn, setAlertOn] = useState(false);
  const [busy, setBusy] = useState(false);

  // Active filter count for the sub-header line
  const filterCount = Object.values(filters).filter(
    (v) => v != null && v !== ""
  ).length;

  function addTag(raw: string) {
    const cleaned = raw.trim().replace(/^#/, "");
    if (cleaned && !tags.includes(cleaned)) {
      setTags((prev) => [...prev, cleaned]);
    }
    setTagInput("");
  }

  function removeTag(t: string) {
    setTags((prev) => prev.filter((x) => x !== t));
  }

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      toast.error("Give your screen a name");
      return;
    }
    setBusy(true);
    const res = await saveScreenAction({
      name: name.trim(),
      mode,
      filters,
      query,
    });
    setBusy(false);
    if (res.success) {
      toast.success(`Saved "${res.data.name}"`);
      onClose();
    } else {
      toast.error(res.error);
    }
  }, [name, mode, filters, query, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[94vw] max-h-[92vh] overflow-y-auto"
        style={{
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          borderRadius: 14,
          boxShadow: "var(--shadow-soft)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-[22px] py-4 sticky top-0 z-10"
          style={{
            borderBottom: "2px solid var(--ink)",
            background: "var(--paper-2)",
          }}
        >
          <div className="flex items-center gap-2.5">
            <div
              className="grid place-items-center shrink-0"
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "var(--ink)",
                color: "var(--pop-2)",
                transform: "rotate(-3deg)",
              }}
            >
              <Bookmark className="h-4 w-4" />
            </div>
            <div>
              <div
                className="font-bold text-[var(--ink)]"
                style={{ fontSize: 16, letterSpacing: -0.3 }}
              >
                Save this screen
              </div>
              <div
                className="mono text-[var(--ink-3)]"
                style={{ fontSize: 10.5, letterSpacing: 0.5, marginTop: 1 }}
              >
                {filterCount} FILTER{filterCount === 1 ? "" : "S"} APPLIED ·{" "}
                {mode.toUpperCase()}
                {query ? ` · Q:"${query}"` : ""}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid place-items-center cursor-pointer"
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "1.5px solid var(--ink)",
              background: "var(--paper)",
              color: "var(--ink)",
            }}
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-[22px] py-5 flex flex-col gap-4">
          {/* Name */}
          <div>
            <label
              className="block mono font-bold text-[var(--ink-2)] mb-1.5"
              style={{ fontSize: 12 }}
            >
              Screen name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleSave()}
              autoFocus
              maxLength={60}
              placeholder="e.g. High-ROE IT compounders"
              className="pf-input"
              style={{ fontSize: 13.5 }}
            />
          </div>

          {/* Description */}
          <div>
            <label
              className="block mono font-bold text-[var(--ink-2)] mb-1.5"
              style={{ fontSize: 12 }}
            >
              Description{" "}
              <span className="text-[var(--ink-3)]" style={{ fontWeight: 400 }}>
                · optional
              </span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Briefly describe what this screen finds…"
              className="pf-input"
              style={{
                resize: "vertical",
                fontFamily: "Inter, sans-serif",
                fontSize: 13,
              }}
            />
          </div>

          {/* Folder + Refresh row */}
          <div className="grid grid-cols-2 gap-3">
            {/* Folder */}
            <div className="relative">
              <label
                className="block mono font-bold text-[var(--ink-2)] mb-1.5"
                style={{ fontSize: 12 }}
              >
                Folder
              </label>
              <button
                type="button"
                onClick={() => setFolderOpen((o) => !o)}
                className="w-full flex items-center gap-2 cursor-pointer"
                style={{
                  padding: "10px 12px",
                  border: "1.5px solid var(--ink)",
                  borderRadius: 8,
                  background: "var(--paper)",
                  color: "var(--ink)",
                  fontSize: 13.5,
                }}
              >
                <FolderOpen
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: "var(--emerald-text)" }}
                />
                <span className="flex-1 text-left truncate">{folder}</span>
                <ChevronDown
                  className={`h-3 w-3 shrink-0 transition-transform text-[var(--ink-3)] ${folderOpen ? "rotate-180" : ""}`}
                />
              </button>
              {folderOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setFolderOpen(false)}
                  />
                  <div
                    className="absolute left-0 top-full mt-1 w-full z-20 overflow-hidden"
                    style={{
                      background: "var(--paper)",
                      border: "2px solid var(--ink)",
                      borderRadius: 10,
                      boxShadow: "var(--shadow-soft)",
                    }}
                  >
                    {FOLDER_OPTIONS.map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => {
                          setFolder(f);
                          setFolderOpen(false);
                        }}
                        className="w-full text-left px-3 py-2 text-[13px] font-semibold cursor-pointer transition-colors hover:bg-[var(--rule-softer)] flex items-center gap-2"
                        style={{
                          color:
                            folder === f ? "var(--emerald-text)" : "var(--ink)",
                        }}
                      >
                        <FolderOpen className="h-3 w-3 shrink-0" />
                        {f}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Refresh cadence (UI-only label) */}
            <div>
              <label
                className="block mono font-bold text-[var(--ink-2)] mb-1.5"
                style={{ fontSize: 12 }}
              >
                Refresh
              </label>
              <div
                className="flex items-center gap-2"
                style={{
                  padding: "10px 12px",
                  border: "1.5px solid var(--ink)",
                  borderRadius: 8,
                  background: "var(--paper)",
                  color: "var(--ink)",
                  fontSize: 13.5,
                }}
              >
                <Clock
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: "var(--emerald-text)" }}
                />
                <span className="flex-1 truncate text-[var(--ink-2)]">
                  On demand
                </span>
              </div>
            </div>
          </div>

          {/* Tags */}
          <div>
            <label
              className="block mono font-bold text-[var(--ink-2)] mb-1.5"
              style={{ fontSize: 12 }}
            >
              Tags
            </label>
            <div
              className="flex flex-wrap gap-1.5 items-center min-h-[42px]"
              style={{
                padding: 10,
                border: "1.5px solid var(--ink)",
                borderRadius: 8,
              }}
            >
              {tags.map((t) => (
                <span
                  key={t}
                  className="pf-pill emerald"
                  style={{ fontSize: 10.5, gap: 5 }}
                >
                  <Tag className="h-2.5 w-2.5" />#{t}
                  <button
                    type="button"
                    onClick={() => removeTag(t)}
                    className="cursor-pointer"
                    aria-label={`Remove tag ${t}`}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addTag(tagInput);
                  }
                }}
                onBlur={() => tagInput.trim() && addTag(tagInput)}
                placeholder={tags.length === 0 ? "+ Add tag" : "+"}
                className="flex-1 min-w-[80px] outline-none bg-transparent"
                style={{
                  fontSize: 12.5,
                  color: "var(--ink)",
                  fontFamily: "inherit",
                  border: 0,
                }}
              />
            </div>
          </div>

          {/* Alert toggle */}
          <div
            className="flex items-center gap-3 cursor-pointer"
            style={{
              padding: 14,
              background: alertOn ? "var(--emerald-bg)" : "var(--rule-softer)",
              border: `1.5px solid ${alertOn ? "var(--emerald)" : "var(--rule-soft)"}`,
              borderRadius: 10,
              transition: "border-color 0.15s, background 0.15s",
            }}
            onClick={() => setAlertOn((a) => !a)}
          >
            <Bell
              className="shrink-0"
              style={{
                color: alertOn ? "var(--emerald-text)" : "var(--ink-3)",
                width: 18,
                height: 18,
              }}
            />
            <div className="flex-1">
              <div
                className="font-bold text-[var(--ink)]"
                style={{ fontSize: 14 }}
              >
                Alert me when this screen changes
              </div>
              <div
                className="text-[var(--ink-3)]"
                style={{ fontSize: 12, marginTop: 2 }}
              >
                Push + email when stocks enter or exit the list.
              </div>
            </div>
            {/* pf-toggle */}
            <div
              className={`pf-toggle ${alertOn ? "on" : ""}`}
              style={{ flexShrink: 0 }}
            />
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-[22px] py-4 sticky bottom-0"
          style={{
            borderTop: "1.5px dashed var(--rule-soft)",
            background: "var(--paper-2)",
          }}
        >
          <span className="mono text-[var(--ink-3)]" style={{ fontSize: 10.5 }}>
            Saving filters for{" "}
            <span className="text-[var(--ink-2)] font-bold">
              {mode.toUpperCase()}
            </span>
          </span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="pf-bf sm">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={busy || !name.trim()}
              className="pf-bs sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Bookmark className="h-3 w-3" />
              {busy ? "Saving…" : "Save screen"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Load dropdown ──────────────────────────────────────────────────

function LoadDropdown({
  mode,
  onClose,
  onPick,
}: {
  mode: ScreenerModeId;
  onClose: () => void;
  onPick: (s: SavedScreenDetail) => void;
}) {
  const [screens, setScreens] = useState<SavedScreenSummary[] | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const { confirm, confirmDialog } = usePfConfirm();

  useEffect(() => {
    let cancelled = false;
    void listSavedScreensAction(mode).then((res) => {
      if (cancelled) return;
      setScreens(res.success ? res.data : []);
    });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  const handlePick = useCallback(
    async (id: string) => {
      const res = await loadSavedScreenAction(id);
      if (res.success) {
        onPick(res.data);
      } else {
        toast.error(res.error);
      }
    },
    [onPick]
  );

  const handleRenameSubmit = useCallback(
    async (id: string) => {
      const next = renameValue.trim();
      if (!next) {
        setRenamingId(null);
        return;
      }
      const res = await renameSavedScreenAction({ id, name: next });
      if (res.success) {
        setScreens(
          (prev) =>
            prev?.map((s) => (s.id === id ? { ...s, name: next } : s)) ?? null
        );
        toast.success("Renamed");
      } else {
        toast.error(res.error);
      }
      setRenamingId(null);
    },
    [renameValue]
  );

  const handleDelete = useCallback(
    async (id: string, name: string) => {
      const ok = await confirm({
        title: `Delete "${name}"?`,
        description: "This saved screen will be gone for good.",
        confirmLabel: "Delete",
        variant: "destructive",
      });
      if (!ok) return;
      const res = await deleteSavedScreenAction(id);
      if (res.success) {
        setScreens((prev) => prev?.filter((s) => s.id !== id) ?? null);
        toast.success("Deleted");
      } else {
        toast.error(res.error);
      }
    },
    [confirm]
  );

  return (
    <>
      {confirmDialog}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="absolute right-0 top-full mt-1.5 w-[300px] z-50 overflow-hidden"
        style={{
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          borderRadius: 12,
          boxShadow: "var(--shadow-soft)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Dropdown header */}
        <div
          className="px-3 py-2.5 flex items-center gap-2"
          style={{
            borderBottom: "2px solid var(--ink)",
            background: "var(--paper-2)",
          }}
        >
          <Bookmark
            className="h-3 w-3 shrink-0"
            style={{ color: "var(--emerald-text)" }}
          />
          <span className="mono text-[10px] tracking-[1.2px] uppercase text-[var(--ink-3)] flex-1">
            Saved · {mode}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="grid place-items-center cursor-pointer"
            style={{ color: "var(--ink-3)" }}
            aria-label="Close"
          >
            <X className="h-3 w-3" />
          </button>
        </div>

        <div className="max-h-[320px] overflow-y-auto p-1.5">
          {screens === null ? (
            <div className="px-3 py-6 text-center text-[12px] text-[var(--ink-3)]">
              Loading…
            </div>
          ) : screens.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <div
                className="grid place-items-center mx-auto mb-3"
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 9,
                  background: "var(--rule-softer)",
                  border: "1.5px dashed var(--rule-soft)",
                  color: "var(--ink-3)",
                  transform: "rotate(-3deg)",
                }}
              >
                <Bookmark className="h-4 w-4" />
              </div>
              <div className="font-bold text-[13px] text-[var(--ink)] mb-1">
                No saved screens yet
              </div>
              <div className="text-[11.5px] ser text-[var(--ink-3)] italic">
                Save your first {mode} screen above.
              </div>
            </div>
          ) : (
            screens.map((s) => (
              <div
                key={s.id}
                className="group flex items-center gap-1.5 px-2 py-2 rounded-[8px] transition-colors hover:bg-[var(--rule-softer)]"
              >
                {renamingId === s.id ? (
                  <input
                    autoFocus
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleRenameSubmit(s.id);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    onBlur={() => void handleRenameSubmit(s.id)}
                    className="flex-1 px-2 py-1 text-[12px] text-[var(--ink)] outline-none rounded-[6px]"
                    style={{
                      background: "var(--paper)",
                      border: "1.5px solid var(--emerald)",
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => void handlePick(s.id)}
                    className="flex-1 text-left min-w-0 cursor-pointer"
                  >
                    <div className="truncate text-[13px] font-bold text-[var(--ink)]">
                      {s.name}
                    </div>
                    <div className="mono text-[10px] text-[var(--ink-3)]">
                      {s.filterCount} filter{s.filterCount === 1 ? "" : "s"}
                      {s.query ? ` · "${s.query}"` : ""}
                    </div>
                  </button>
                )}
                {renamingId !== s.id && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setRenameValue(s.name);
                        setRenamingId(s.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 grid place-items-center rounded text-[var(--ink-3)] hover:text-[var(--ink)] cursor-pointer"
                      style={{ width: 22, height: 22 }}
                      aria-label="Rename"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(s.id, s.name)}
                      className="opacity-0 group-hover:opacity-100 grid place-items-center rounded cursor-pointer"
                      style={{
                        width: 22,
                        height: 22,
                        color: "var(--pop-1-text)",
                      }}
                      aria-label="Delete"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
