"use client";

import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { Youtube } from "./blocks";

/**
 * Shared BlockNote schema with custom block specifications.
 * Used by both editor and renderer for consistency.
 */
export const blocknoteSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    youtube: Youtube(),
  },
});

export type BlockNoteEditorType = typeof blocknoteSchema.BlockNoteEditor;
