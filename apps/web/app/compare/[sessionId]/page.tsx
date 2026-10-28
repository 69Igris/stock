/**
 * Deep Compare result page — Server Component (MONEY-550).
 *
 * Renders an async deep stock/MF comparison run by the comparison worker.
 * `sessionId` is the UUID returned by `startComparisonAction`. The client
 * polls `getComparisonStatusAction` while the job runs and renders the
 * `ComparisonSession.result` (sections/contentBlocks + holdings overlap)
 * once COMPLETED.
 *
 * The quick synchronous side-by-side compare still lives at /compare
 * (the `?items=` flow). This route is the richer worker-backed path.
 */

export const dynamic = "force-dynamic";

import CompareResultClient from "./client";

export default async function CompareResultPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <CompareResultClient sessionId={sessionId} />;
}

export function generateMetadata() {
  return {
    title: "Deep Compare",
    description: "AI-powered side-by-side comparison of funds and stocks",
  };
}
