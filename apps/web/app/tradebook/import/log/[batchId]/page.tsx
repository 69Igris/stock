// Next 15+ : this authenticated app page renders the shared <Sidebar/> shell
// (which reads request-time useSearchParams), so static prerendering bails.
// It was never beneficially static (auth-gated, per-user data) — render it
// dynamically, matching the rest of the app. No user-visible behavior change.
export const dynamic = "force-dynamic";

import ImportLogDetailClient from "./client";

export const metadata = {
  title: "Import Log Details",
  description: "View detailed import log information",
};

interface PageProps {
  params: Promise<{ batchId: string }>;
}

export default async function ImportLogDetailPage(props: PageProps) {
  const params = await props.params;
  return <ImportLogDetailClient batchId={params.batchId} />;
}
