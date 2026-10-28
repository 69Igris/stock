"use server";

import { revalidatePath } from "next/cache";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  MutualFundFormSchema,
  type ActionResponse,
} from "@usemoney/validation";
import {
  getMutualFunds as getMutualFundsService,
  createMutualFund as createMutualFundService,
  deleteMutualFund as deleteMutualFundService,
  type MutualFundItem,
  type MutualFundSummary,
  type MutualFundFilters,
} from "@usemoney/services";
import { isDemoSession } from "@/lib/demo/session";
import { demoMutualFunds } from "@/lib/demo/data";

// Re-export types for consumers
export type {
  MutualFundItem,
  MutualFundSummary,
  MutualFundFilters,
} from "@usemoney/services";
// Backward compat alias
export type MutualFund = MutualFundItem;

/**
 * Get mutual funds
 */
export async function getMutualFundsAction(
  filters: MutualFundFilters = {}
): Promise<
  ActionResponse<{ funds: MutualFundItem[]; summary: MutualFundSummary }>
> {
  // Demo mode
  if (await isDemoSession()) {
    let filteredFunds = [...demoMutualFunds];

    if (filters.search) {
      filteredFunds = filteredFunds.filter((f) =>
        f.schemeName.toLowerCase().includes(filters.search!.toLowerCase())
      );
    }
    if (filters.category && filters.category !== "all") {
      filteredFunds = filteredFunds.filter(
        (f) => f.category === filters.category
      );
    }

    const totalInvested = filteredFunds.reduce(
      (sum, f) => sum + f.investedAmount,
      0
    );
    const totalCurrent = filteredFunds.reduce(
      (sum, f) => sum + f.currentValue,
      0
    );
    const totalPnL = filteredFunds.reduce(
      (sum, f) => sum + f.unrealizedGain,
      0
    );

    return {
      success: true,
      data: {
        // MONEY-846: demo fixtures predate the isin/subCategory fields on
        // MutualFundItem (real funds get them via the MutualFundMaster join).
        funds: filteredFunds.map((f) => ({
          ...f,
          isin: null,
          subCategory: null,
        })),
        summary: {
          totalInvested,
          totalCurrent,
          totalPnL,
          pnlPercentage:
            totalInvested > 0
              ? ((totalPnL / totalInvested) * 100).toFixed(2)
              : "0",
        },
      },
    };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  return getMutualFundsService(authUser.userId, filters);
}

/**
 * Create a mutual fund
 */
export async function createMutualFundAction(
  formData: unknown
): Promise<ActionResponse<MutualFundItem>> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to add mutual funds!",
    };
  }

  const validated = MutualFundFormSchema.parse(formData);
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  const result = await createMutualFundService(authUser.userId, validated);

  if (result?.success) {
    revalidatePath("/holdings");
    revalidatePath("/dashboard");
  }

  return result;
}

/**
 * Add a manual mutual fund holding.
 * A thin convenience wrapper over createMutualFundAction that accepts a
 * flat, validated-at-call-site shape (no schema import needed by callers).
 * Mirrors the addManualHoldingAction pattern for ergonomic modal wiring.
 */
export async function addManualMutualFundAction(data: {
  schemeName: string;
  schemeCode?: string | null;
  folioNumber?: string | null;
  category?: string | null;
  units: number;
  averageNav: number;
  sipActive?: boolean;
  sipAmount?: number | null;
}): Promise<ActionResponse<MutualFundItem>> {
  return createMutualFundAction({
    schemeName: data.schemeName,
    schemeCode: data.schemeCode ?? null,
    amcName: null,
    folioNumber: data.folioNumber ?? undefined,
    category: data.category ?? "Equity",
    units: data.units,
    averageNav: data.averageNav,
    currentNav: data.averageNav,
    sipActive: data.sipActive ?? false,
    sipAmount: data.sipAmount ?? null,
    sipDate: null,
    brokerName: "manual",
  });
}

/**
 * Delete a mutual fund (only manual entries)
 */
export async function deleteMutualFundAction(
  fundId: string
): Promise<ActionResponse<void>> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to delete mutual funds!",
    };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  const result = await deleteMutualFundService(authUser.userId, fundId);

  if (result?.success) {
    revalidatePath("/holdings");
    revalidatePath("/dashboard");
  }

  return result;
}
