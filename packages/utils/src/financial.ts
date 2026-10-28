/**
 * Calculate XIRR (simplified approximation)
 * Extended Internal Rate of Return - annualized return accounting for timing
 *
 * @param invested - Total amount invested
 * @param current - Current value of investment
 * @param days - Number of days since investment
 * @returns Annualized return percentage
 */
export function calculateXIRR(
  invested: number,
  current: number,
  days: number,
): number {
  if (invested <= 0 || days <= 0) return 0;
  const years = days / 365;
  if (years < 0.1) return 0;
  const xirr = (Math.pow(current / invested, 1 / years) - 1) * 100;
  return Math.min(Math.max(xirr, -99), 999);
}

/**
 * Calculate CAGR (Compound Annual Growth Rate)
 *
 * @param beginValue - Starting value
 * @param endValue - Ending value
 * @param years - Number of years
 * @returns CAGR as a percentage
 */
export function calculateCAGR(
  beginValue: number,
  endValue: number,
  years: number,
): number {
  if (beginValue <= 0 || years <= 0) return 0;
  const cagr = (Math.pow(endValue / beginValue, 1 / years) - 1) * 100;
  return Math.min(Math.max(cagr, -99), 999);
}

/**
 * Calculate absolute return percentage
 *
 * @param invested - Initial investment
 * @param current - Current value
 * @returns Absolute return as a percentage
 */
export function calculateAbsoluteReturn(
  invested: number,
  current: number,
): number {
  if (invested <= 0) return 0;
  return ((current - invested) / invested) * 100;
}

/**
 * Calculate profit/loss amount
 *
 * @param invested - Initial investment
 * @param current - Current value
 * @returns Profit or loss amount
 */
export function calculatePnL(invested: number, current: number): number {
  return current - invested;
}

/**
 * Calculate win rate from trades
 *
 * @param winners - Number of winning trades
 * @param losers - Number of losing trades
 * @returns Win rate as a percentage
 */
export function calculateWinRate(winners: number, losers: number): number {
  const total = winners + losers;
  if (total === 0) return 0;
  return (winners / total) * 100;
}
