export const dynamic = "force-dynamic";

import RoastDetailClient from "./client";

export default async function RoastDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // id can be either a MongoDB ObjectId (from history) or a UUID sessionId (from async flow)
  const { id } = await params;
  return <RoastDetailClient roastId={id} />;
}
