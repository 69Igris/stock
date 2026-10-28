import prisma from "@/lib/prisma";

export interface CreatePaperOrderInput {
  symbol: string;
  name: string;
  exchange?: string;
  instrumentType?: string;
  side: string;
  orderType?: string;
  quantity: number;
  price?: number;
  triggerPrice?: number;
  executedPrice?: number;
  stopLoss?: number;
  target?: number;
  strategy?: string;
  optionType?: string;
  strikePrice?: number;
  expiry?: Date;
  lotSize?: number;
}

/**
 * Create a new paper order
 */
export async function createPaperOrder(
  userId: string,
  portfolioId: string,
  data: CreatePaperOrderInput
) {
  return prisma.paperOrder.create({
    data: {
      userId,
      portfolioId,
      symbol: data.symbol.toUpperCase(),
      name: data.name,
      exchange: data.exchange || "NSE",
      instrumentType: data.instrumentType || "EQUITY",
      side: data.side,
      orderType: data.orderType || "MARKET",
      status: "EXECUTED",
      quantity: data.quantity,
      price: data.price,
      triggerPrice: data.triggerPrice,
      executedPrice: data.executedPrice || data.price,
      executedAt: new Date(),
      stopLoss: data.stopLoss,
      target: data.target,
      strategy: data.strategy,
      optionType: data.optionType,
      strikePrice: data.strikePrice,
      expiry: data.expiry,
      lotSize: data.lotSize,
    },
  });
}

/**
 * Get paper orders for a user
 */
export async function getPaperOrders(
  userId: string,
  filters?: { status?: string; limit?: number }
) {
  return prisma.paperOrder.findMany({
    where: {
      userId,
      ...(filters?.status ? { status: filters.status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: filters?.limit || 50,
  });
}

/**
 * Cancel a pending paper order
 */
export async function cancelPaperOrder(userId: string, orderId: string) {
  const order = await prisma.paperOrder.findFirst({
    where: { id: orderId, userId, status: "PENDING" },
  });

  if (!order) return null;

  return prisma.paperOrder.update({
    where: { id: orderId },
    data: { status: "CANCELLED" },
  });
}
