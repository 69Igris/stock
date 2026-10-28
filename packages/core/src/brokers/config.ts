/**
 * Broker Configuration
 * Central configuration for all supported brokers
 */

import type { BrokerType, BrokerConfig } from "@usemoney/types";

// MONEY-837: the relocated rich clients import `BrokerType` from this config
// (mirrors what the old apps/web config re-exported), so re-export it here.
export type { BrokerType } from "@usemoney/types";

export const BROKER_CONFIGS: Record<BrokerType, BrokerConfig> = {
  ZERODHA: {
    id: "ZERODHA",
    name: "zerodha",
    displayName: "Zerodha (Kite)",
    logo: "/brokers/zerodha.png",
    authType: "oauth2",
    baseUrl: "https://api.kite.trade",
    authUrl: "https://kite.zerodha.com/connect/login",
    tokenUrl: "https://api.kite.trade/session/token",
    tokenRefreshStrategy: "daily",
    tokenValidity: "1 day",
    features: {
      holdings: true,
      positions: true,
      orders: true,
      trades: true,
      mutualFunds: true,
      margins: true,
    },
    envKeys: {
      apiKey: "ZERODHA_API_KEY",
      apiSecret: "ZERODHA_API_SECRET",
      redirectUri: "ZERODHA_REDIRECT_URI",
    },
  },
  // MONEY-837: founder-only PAID Kite Connect app (live data). Token-capture
  // only; kept in sync with apps/web/lib/brokers/config.ts.
  ZERODHA_CONNECT: {
    id: "ZERODHA_CONNECT",
    name: "zerodha-connect",
    displayName: "Zerodha Connect (live data)",
    logo: "/brokers/zerodha.png",
    authType: "oauth2",
    baseUrl: "https://api.kite.trade",
    authUrl: "https://kite.zerodha.com/connect/login",
    tokenUrl: "https://api.kite.trade/session/token",
    tokenRefreshStrategy: "daily",
    tokenValidity: "1 day",
    features: {
      holdings: false,
      positions: false,
      orders: false,
      trades: false,
      mutualFunds: false,
      margins: false,
    },
    envKeys: {
      apiKey: "ZERODHA_CONNECT_API_KEY",
      apiSecret: "ZERODHA_CONNECT_API_SECRET",
      redirectUri: "ZERODHA_CONNECT_REDIRECT_URI",
    },
  },
  UPSTOX: {
    id: "UPSTOX",
    name: "upstox",
    displayName: "Upstox",
    logo: "/brokers/upstox.png",
    authType: "oauth2",
    baseUrl: "https://api.upstox.com/v2",
    authUrl: "https://api.upstox.com/v2/login/authorization/dialog",
    tokenUrl: "https://api.upstox.com/v2/login/authorization/token",
    scopes: ["holdings", "positions", "orders"],
    tokenRefreshStrategy: "extended",
    tokenValidity: "1 year",
    features: {
      holdings: true,
      positions: true,
      orders: true,
      trades: true,
      mutualFunds: false,
      margins: true,
    },
    envKeys: {
      apiKey: "UPSTOX_API_KEY",
      apiSecret: "UPSTOX_API_SECRET",
      redirectUri: "UPSTOX_REDIRECT_URI",
    },
  },
  DHAN: {
    id: "DHAN",
    name: "dhan",
    displayName: "Dhan",
    logo: "/brokers/dhan.png",
    authType: "api_key",
    baseUrl: "https://api.dhan.co/v2",
    tokenRefreshStrategy: "none",
    tokenValidity: "30 days",
    features: {
      holdings: true,
      positions: true,
      orders: true,
      trades: true,
      mutualFunds: false,
      margins: true,
    },
    envKeys: {
      apiKey: "DHAN_CLIENT_ID",
      apiSecret: "DHAN_ACCESS_TOKEN",
    },
  },
  FYERS: {
    id: "FYERS",
    name: "fyers",
    displayName: "Fyers",
    logo: "/brokers/fyers.png",
    authType: "oauth2",
    baseUrl: "https://api-t1.fyers.in/api/v3",
    authUrl: "https://api-t1.fyers.in/api/v3/generate-authcode",
    tokenUrl: "https://api-t1.fyers.in/api/v3/validate-authcode",
    tokenRefreshStrategy: "on_expiry",
    tokenValidity: "1 day",
    features: {
      holdings: true,
      positions: true,
      orders: true,
      trades: true,
      mutualFunds: false, // No MF endpoint in Fyers API v3 as of 2026
      margins: true,
    },
    envKeys: {
      apiKey: "FYERS_APP_ID",
      apiSecret: "FYERS_SECRET_KEY",
      redirectUri: "FYERS_REDIRECT_URI",
    },
  },
  ANGEL_ONE: {
    id: "ANGEL_ONE",
    name: "angel_one",
    displayName: "Angel One",
    logo: "/brokers/angel.png",
    authType: "totp",
    baseUrl: "https://apiconnect.angelone.in",
    tokenRefreshStrategy: "daily",
    tokenValidity: "1 day",
    features: {
      holdings: true,
      positions: true,
      orders: true,
      trades: true,
      mutualFunds: false, // No MF endpoint in SmartAPI official SDKs
      margins: true,
    },
    envKeys: {
      apiKey: "ANGEL_API_KEY",
      apiSecret: "ANGEL_CLIENT_ID",
    },
  },
  GROWW: {
    id: "GROWW",
    name: "groww",
    displayName: "Groww",
    logo: "/brokers/groww.png",
    authType: "api_key", // API Key + SHA256 checksum or TOTP (not OAuth2)
    baseUrl: "https://api.groww.in",
    tokenRefreshStrategy: "none", // No refresh - new token daily
    tokenValidity: "1 day (expires 6AM IST)",
    features: {
      holdings: true,
      positions: true,
      orders: true,
      trades: true,
      mutualFunds: true,
      margins: false,
    },
    envKeys: {
      apiKey: "GROWW_API_KEY",
      apiSecret: "GROWW_API_SECRET",
    },
  },
  ICICI: {
    id: "ICICI",
    name: "icici",
    displayName: "ICICI Direct",
    logo: "/brokers/icici.png",
    authType: "oauth2",
    baseUrl: "https://api.icicidirect.com",
    authUrl: "https://api.icicidirect.com/apiuser/login",
    tokenUrl: "https://api.icicidirect.com/apiuser/session",
    tokenRefreshStrategy: "daily",
    tokenValidity: "1 day",
    features: {
      holdings: true,
      positions: true,
      orders: true,
      trades: true,
      mutualFunds: true,
      margins: true,
    },
    envKeys: {
      apiKey: "ICICI_API_KEY",
      apiSecret: "ICICI_API_SECRET",
      redirectUri: "ICICI_REDIRECT_URI",
    },
  },
  HDFC: {
    id: "HDFC",
    name: "hdfc",
    displayName: "HDFC Securities",
    logo: "/brokers/hdfc.png",
    authType: "oauth2",
    baseUrl: "https://api.hdfcsec.com",
    authUrl: "https://api.hdfcsec.com/oauth2/authorize",
    tokenUrl: "https://api.hdfcsec.com/oauth2/token",
    tokenRefreshStrategy: "daily",
    tokenValidity: "1 day",
    features: {
      holdings: true,
      positions: true,
      orders: true,
      trades: true,
      mutualFunds: true,
      margins: true,
    },
    envKeys: {
      apiKey: "HDFC_API_KEY",
      apiSecret: "HDFC_API_SECRET",
      redirectUri: "HDFC_REDIRECT_URI",
    },
  },
  INTERACTIVE_BROKERS: {
    id: "INTERACTIVE_BROKERS",
    name: "interactive_brokers",
    displayName: "Interactive Brokers",
    logo: "/brokers/ibkr.png",
    authType: "oauth2",
    baseUrl: "https://api.ibkr.com/v1/api",
    authUrl: "https://www.interactivebrokers.com/authorize",
    tokenUrl: "https://api.ibkr.com/v1/api/oauth/token",
    tokenRefreshStrategy: "on_expiry",
    tokenValidity: "24 hours",
    features: {
      holdings: true,
      positions: true,
      orders: true,
      trades: true,
      mutualFunds: false,
      margins: true,
    },
    envKeys: {
      apiKey: "INTERACTIVE_BROKERS_CLIENT_ID",
      apiSecret: "INTERACTIVE_BROKERS_CLIENT_SECRET",
      redirectUri: "INTERACTIVE_BROKERS_REDIRECT_URI",
    },
  },
};

export function getBrokerConfig(broker: BrokerType): BrokerConfig {
  return BROKER_CONFIGS[broker];
}

export function getBrokerEnvKeys(broker: BrokerType): {
  apiKey: string;
  apiSecret: string;
  redirectUri?: string;
} {
  const config = BROKER_CONFIGS[broker];
  return {
    apiKey: process.env[config.envKeys.apiKey] || "",
    apiSecret: process.env[config.envKeys.apiSecret] || "",
    redirectUri: config.envKeys.redirectUri
      ? process.env[config.envKeys.redirectUri]
      : undefined,
  };
}

export function getAllBrokerTypes(): BrokerType[] {
  return Object.keys(BROKER_CONFIGS) as BrokerType[];
}

export function getTier1Brokers(): BrokerType[] {
  return ["ZERODHA", "UPSTOX", "FYERS", "DHAN"];
}

export function getTier2Brokers(): BrokerType[] {
  return ["ANGEL_ONE", "GROWW", "ICICI", "HDFC"];
}
