/**
 * Shared authenticated user resolution with React `cache()`.
 *
 * React's `cache()` deduplicates calls within the same server request.
 * When a page calls 3-4 server actions in parallel, this ensures
 * `auth()` + `getOrCreateDbUser()` only runs once per request instead of 3-4x.
 */

import { cache } from "react";
import { auth } from "@clerk/nextjs/server";
import { getOrCreateDbUser } from "@/lib/db/user";

export const getAuthenticatedUser = cache(
  async (): Promise<{ userId: string } | null> => {
    const { userId: clerkUserId } = await auth();

    if (!clerkUserId) {
      return null;
    }

    const dbUser = await getOrCreateDbUser(clerkUserId);
    if (!dbUser) {
      return null;
    }

    return { userId: dbUser.id };
  }
);
