"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Gift, ArrowRight, Loader2 } from "lucide-react";
import { createCheckoutAction } from "@/lib/actions/subscription";

interface Props {
  token: string;
  planId: string;
  planName: string;
  discountCode: string | null;
  isAuthenticated: boolean;
}

export default function InviteClient({
  token,
  planId,
  planName,
  discountCode,
  isAuthenticated,
}: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClaim = async () => {
    if (!isAuthenticated) {
      // Redirect to sign-in with return URL
      router.push(`/sign-in?redirect_url=/invite/${token}`);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // First redeem the token
      const redeemRes = await fetch(`/api/invite/${token}/redeem`, {
        method: "POST",
      });
      const redeemData = await redeemRes.json();

      if (!redeemRes.ok) {
        setError(redeemData.error || "Failed to redeem invite");
        return;
      }

      // Now create checkout with discount
      const result = await createCheckoutAction(
        redeemData.planId,
        undefined,
        redeemData.discountCode || undefined
      );

      if (!result?.success) {
        setError(result?.error || "Failed to create checkout");
        return;
      }

      if (result.checkoutUrl) {
        window.location.href = result.checkoutUrl;
      } else {
        // Free plan or direct upgrade
        router.push("/settings?upgraded=true");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="max-w-md w-full mx-4">
        <div className="rounded-2xl border bg-card p-8 text-center space-y-6 shadow-lg">
          <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
            <Gift className="h-8 w-8 text-primary" />
          </div>

          <div className="space-y-2">
            <h1 className="text-2xl font-bold text-foreground">
              You&apos;re Invited!
            </h1>
            <p className="text-muted-foreground">
              You&apos;ve been invited to join UseMoney with the{" "}
              <span className="font-semibold text-primary">{planName}</span>{" "}
              plan.
            </p>
          </div>

          {discountCode && (
            <div className="rounded-lg bg-green-500/10 border border-green-500/20 p-3">
              <p className="text-sm text-green-400">
                Discount code{" "}
                <code className="px-1.5 py-0.5 rounded bg-green-500/20 font-mono text-xs">
                  {discountCode}
                </code>{" "}
                will be applied at checkout
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <button
            onClick={handleClaim}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 font-medium transition-colors"
          >
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <>
                {isAuthenticated ? "Claim This Offer" : "Sign In to Claim"}
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </button>

          <p className="text-xs text-muted-foreground">
            By claiming this offer, you agree to our Terms of Service.
          </p>
        </div>
      </div>
    </div>
  );
}
