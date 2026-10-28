/**
 * Shared Tickertape mutual-fund types — kept network-free so the response
 * mappers in `tickertape-mf-client-logic.ts` (and their tests) can import them
 * without pulling `ky` / the live client.
 */

export interface MfOverview {
  sid: string;
  name: string;
  category: string;
  subCategory: string;
  aum: number | null; // in crores
  expenseRatio: number | null;
  nav: number | null;
  navDate: string | null;
  returns: {
    oneMonth?: number;
    threeMonth?: number;
    sixMonth?: number;
    oneYear?: number;
    threeYear?: number;
    fiveYear?: number;
  };
  riskRating: string | null;
  exitLoad: string | null;
  minInvestment: number | null;
  rawData: Record<string, unknown>;
}

export interface MfHolding {
  name: string;
  symbol: string | null;
  sector: string | null;
  weight: number; // % of portfolio
  value: number | null;
}

export interface MfPeer {
  sid: string;
  name: string;
  category: string;
  returns1Y: number | null;
  returns3Y: number | null;
  aum: number | null;
  expenseRatio: number | null;
}
