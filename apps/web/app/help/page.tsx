import HelpPage from "./client";

/**
 * force-dynamic: the shared <Sidebar/> reads request-time `useSearchParams`,
 * so this page was never statically prerenderable regardless.
 *
 * It no longer awaits anything. It used to `await getGlossaryTermsForHelpAction()`
 * and pass the result down — ~190ms for 132 rows / 25KB blocking the server
 * render on EVERY visit, for data exactly one of the six tabs displays. The
 * default tab is Prompts, so five out of six visitors waited for a payload
 * they never saw. GlossaryTab now fetches it itself, and only mounts when that
 * tab is open.
 */
export const dynamic = "force-dynamic";

export default function Page() {
  return <HelpPage />;
}
