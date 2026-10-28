"use client";

import { Copy, Bookmark } from "lucide-react";
import { PfPageHead } from "@/components/playful/PfPageHead";

interface FireHeaderProps {
  onClone: () => void;
  onSave: () => void;
  isPending: boolean;
}

export function FireHeader({ onClone, onSave, isPending }: FireHeaderProps) {
  return (
    <PfPageHead
      eyebrow="FIRE · TOOLS · CORPUS PLAN"
      title={
        <>
          How much <span className="hl-gold">heat</span> can your retirement{" "}
          <span className="ser">take.</span>
        </>
      }
      sub="Project your corpus across age, contribution, and return assumptions. Drag the dials, watch the curve move."
      right={
        <>
          <button
            type="button"
            className="pf-bf sm"
            onClick={onClone}
            disabled={isPending}
            aria-label="Clone scenario"
          >
            <Copy className="h-3 w-3" />
            <span className="hidden sm:inline">Clone</span>
          </button>
          <button
            type="button"
            className="pf-bs sm"
            onClick={onSave}
            disabled={isPending}
            aria-label="Save scenario"
          >
            <Bookmark className="h-3 w-3" />
            <span className="hidden sm:inline">Save scenario</span>
            <span className="sm:hidden">Save</span>
          </button>
        </>
      }
    />
  );
}
