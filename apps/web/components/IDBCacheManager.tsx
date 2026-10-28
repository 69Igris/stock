"use client";

import { useEffect, useRef } from "react";
import { useUser } from "@clerk/nextjs";
import {
  gcExpiredEntries,
  clearIDBAllUserData,
  isIDBAvailable,
} from "@/lib/idb-cache";

/**
 * Handles IndexedDB cache lifecycle:
 * 1. On mount: garbage-collect expired entries
 * 2. On user switch: delete the previous user's IDB database
 *
 * Renders nothing.
 */
export default function IDBCacheManager() {
  const { user } = useUser();
  const prevUserId = useRef<string | null>(null);

  useEffect(() => {
    if (!isIDBAvailable()) return;

    const currentId = user?.id ?? null;

    // User switched - delete old DB
    if (prevUserId.current && prevUserId.current !== currentId) {
      clearIDBAllUserData(prevUserId.current).catch(() => {});
    }

    prevUserId.current = currentId;

    // GC on mount for current user
    if (currentId) {
      gcExpiredEntries(currentId).catch(() => {});
    }
  }, [user?.id]);

  return null;
}
