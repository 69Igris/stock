// Next 15+ : this authenticated app page renders the shared <Sidebar/> shell
// (which reads request-time useSearchParams), so static prerendering bails.
// It was never beneficially static (auth-gated, per-user data) — render it
// dynamically, matching the rest of the app. No user-visible behavior change.
export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { PLAN_CONFIG, type PlanId } from "@usemoney/core/subscription";
import InviteClient from "./client";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function InvitePage(props: Props) {
  const params = await props.params;
  const invite = await prisma.inviteToken.findUnique({
    where: { token: params.token },
  });

  if (!invite) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-4 p-8">
          <h1 className="text-2xl font-bold text-foreground">
            Invalid Invite Link
          </h1>
          <p className="text-muted-foreground">
            This invite link is not valid or has been removed.
          </p>
          <a
            href="/pricing"
            className="inline-block px-6 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
          >
            View Plans
          </a>
        </div>
      </div>
    );
  }

  // Validate invite token
  const now = new Date();
  const isExpired = invite.expiresAt && invite.expiresAt < now;
  const isMaxedOut =
    invite.maxUses !== -1 && invite.usedCount >= invite.maxUses;
  const isInactive = !invite.isActive;

  if (isExpired || isMaxedOut || isInactive) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-4 p-8">
          <h1 className="text-2xl font-bold text-foreground">Invite Expired</h1>
          <p className="text-muted-foreground">
            {isExpired
              ? "This invite link has expired."
              : isMaxedOut
                ? "This invite link has reached its usage limit."
                : "This invite link is no longer active."}
          </p>
          <a
            href="/pricing"
            className="inline-block px-6 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
          >
            View Plans
          </a>
        </div>
      </div>
    );
  }

  // Check if invite is for a specific user
  const { userId } = await auth();
  if (invite.assignedTo && userId) {
    // Will be checked during redemption - just pass through for now
  }

  const planConfig = PLAN_CONFIG[invite.planId as PlanId];
  const planName =
    planConfig?.name ||
    invite.planId.charAt(0) + invite.planId.slice(1).toLowerCase();

  return (
    <InviteClient
      token={params.token}
      planId={invite.planId}
      planName={planName}
      discountCode={invite.discountCode}
      isAuthenticated={!!userId}
    />
  );
}
