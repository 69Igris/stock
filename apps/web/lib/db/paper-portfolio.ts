import prisma from "@/lib/prisma";

/**
 * Get or create paper portfolio for a user
 */
export async function getOrCreatePaperPortfolio(userId: string) {
  let portfolio = await prisma.paperPortfolio.findUnique({
    where: { userId },
  });

  if (!portfolio) {
    portfolio = await prisma.paperPortfolio.create({
      data: {
        userId,
        initialCapital: 1000000,
        cash: 1000000,
      },
    });
  }

  return portfolio;
}

/**
 * Update portfolio cash balance (increment/decrement)
 */
export async function updatePortfolioCash(portfolioId: string, amount: number) {
  return prisma.paperPortfolio.update({
    where: { id: portfolioId },
    data: {
      cash: { increment: amount },
    },
  });
}

/**
 * Reset portfolio to initial state
 */
export async function resetPortfolio(userId: string) {
  const portfolio = await prisma.paperPortfolio.findUnique({
    where: { userId },
  });

  if (!portfolio) return null;

  // Delete all orders and positions linked to this portfolio
  await prisma.$transaction([
    prisma.paperOrder.deleteMany({ where: { portfolioId: portfolio.id } }),
    prisma.paperPosition.updateMany({
      where: { portfolioId: portfolio.id },
      data: { status: "CLOSED", exitDate: new Date() },
    }),
    prisma.paperPortfolio.update({
      where: { id: portfolio.id },
      data: {
        cash: portfolio.initialCapital,
      },
    }),
  ]);

  return prisma.paperPortfolio.findUnique({ where: { userId } });
}
