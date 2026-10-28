export const dynamic = "force-dynamic";

import { Suspense } from "react";
import RoastClient from "./client";
import { isDemoSession } from "@/lib/demo/session";
import { RoastSkeleton } from "@/components/skeletons";

export default async function RoastPage() {
  const isDemo = await isDemoSession();
  return (
    <Suspense fallback={<RoastSkeleton />}>
      <RoastClient isDemo={isDemo} />
    </Suspense>
  );
}
