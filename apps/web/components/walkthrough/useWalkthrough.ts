"use client";

import { useContext } from "react";
import { WalkthroughContext } from "./WalkthroughProvider";
import type { WalkthroughContextValue } from "./types";

export function useWalkthrough(): WalkthroughContextValue {
  const ctx = useContext(WalkthroughContext);
  if (!ctx) {
    throw new Error("useWalkthrough must be used inside <WalkthroughProvider>");
  }
  return ctx;
}
