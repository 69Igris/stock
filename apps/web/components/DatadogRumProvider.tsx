"use client";

import { useEffect } from "react";
import { useUser } from "@clerk/nextjs";
// MONEY-726 — the init object moved to a leaf module so `app/global-error.tsx`
// (which renders ABOVE this provider and therefore never has it mounted) can
// initialise RUM with the identical configuration instead of a second copy
// that drifts silently. See lib/datadog/rum-init.ts.
import { rumInitConfig } from "@/lib/datadog/rum-init";

/**
 * Client-side Datadog RUM + Session Replay initialization.
 *
 * Loads @datadog/browser-rum lazily to avoid blocking the main bundle.
 * Identifies the user via Clerk context for session attribution.
 */
export function DatadogRumProvider() {
  const { user, isLoaded } = useUser();

  useEffect(() => {
    const cfg = rumInitConfig();
    if (!cfg) return;

    import("@datadog/browser-rum")
      .then(({ datadogRum }) => {
        if (datadogRum.getInitConfiguration()) return; // already initialized

        datadogRum.init(cfg);
      })
      // MONEY-1220 — a monitoring provider must never be able to break the app.
      //
      // `import()` REJECTS when the chunk cannot be fetched, and with no catch
      // that becomes an unhandled rejection:
      //
      //   unhandledRejection: ChunkLoadError: Loading chunk
      //   _app-pages-browser_node_modules_datadog_browser-rum_… failed
      //     at DatadogRumProvider.useEffect (DatadogRumProvider.tsx:51:5)
      //
      // It is reachable in ordinary conditions, not just exotic ones: a dev
      // server recompiling mid-navigation, a deploy rotating chunk hashes while
      // a tab is open, an ad blocker, or a flaky network. Observability failing
      // is acceptable; observability taking navigation down with it is not.
      .catch((err: unknown) => {
        console.warn("[datadog-rum] init skipped — chunk unavailable", err);
      });
  }, []);

  useEffect(() => {
    if (!isLoaded) return;

    import("@datadog/browser-rum")
      .then(({ datadogRum }) => {
        if (user) {
          datadogRum.setUser({
            id: user.id,
            name: user.fullName || user.firstName || undefined,
            email: user.emailAddresses?.[0]?.emailAddress,
          });
        } else {
          datadogRum.clearUser();
        }
      })
      // Same reasoning as the init effect above: identifying the user is a
      // best-effort side channel, and it must not reject into the void.
      .catch((err: unknown) => {
        console.warn("[datadog-rum] setUser skipped — chunk unavailable", err);
      });
  }, [user, isLoaded]);

  return null;
}
