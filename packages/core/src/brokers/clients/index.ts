/**
 * Broker Client Factory
 * Creates appropriate client based on broker type
 */

import { BrokerType } from "../config";
import { BaseBrokerClient, BrokerCredentials } from "./base-client";
import { ZerodhaClient } from "./zerodha";
import { UpstoxClient } from "./upstox";
import { DhanClient } from "./dhan";
import { FyersClient } from "./fyers";
import { AngelOneClient } from "./angel-one";
import { GrowwClient } from "./groww";
import { IciciClient } from "./icici";
import { HdfcClient } from "./hdfc";
import { InteractiveBrokersClient } from "./interactive-brokers";

export function createBrokerClient(
  broker: BrokerType,
  credentials: BrokerCredentials,
): BaseBrokerClient {
  switch (broker) {
    case "ZERODHA":
      return new ZerodhaClient(credentials);
    case "UPSTOX":
      return new UpstoxClient(credentials);
    case "DHAN":
      return new DhanClient(credentials);
    case "FYERS":
      return new FyersClient(credentials);
    case "ANGEL_ONE":
      return new AngelOneClient(credentials);
    case "GROWW":
      return new GrowwClient(credentials);
    case "ICICI":
      return new IciciClient(credentials);
    case "HDFC":
      return new HdfcClient(credentials);
    case "INTERACTIVE_BROKERS":
      return new InteractiveBrokersClient(credentials);
    default:
      throw new Error(`Unsupported broker: ${broker}`);
  }
}

export {
  ZerodhaClient,
  UpstoxClient,
  DhanClient,
  FyersClient,
  AngelOneClient,
  GrowwClient,
  IciciClient,
  HdfcClient,
  InteractiveBrokersClient,
};

// MONEY-1158 — the shared OAuth token-exchange guards. Exported so callers can
// branch on `kind` ("transport" vs "payload") when recording a broker failure,
// rather than pattern-matching an error message.
export {
  BrokerTokenExchangeError,
  brokerTransportFailure,
  requireAccessToken,
  requireTokenField,
  type BrokerTokenFailureKind,
} from "./token-exchange";
