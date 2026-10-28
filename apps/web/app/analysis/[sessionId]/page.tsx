// Next 15+ : this authenticated app page renders the shared <Sidebar/> shell
// (which reads request-time useSearchParams), so static prerendering bails.
// It was never beneficially static (auth-gated, per-user data) — render it
// dynamically, matching the rest of the app. No user-visible behavior change.
export const dynamic = "force-dynamic";

import AnalysisDetailClient from "./client";

interface Props {
  params: Promise<{ sessionId: string }>;
}

export default async function AnalysisDetailPage({ params }: Props) {
  const { sessionId } = await params;
  return <AnalysisDetailClient sessionId={sessionId} />;
}
