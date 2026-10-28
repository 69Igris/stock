import { z } from "zod";

export const PlaceOrderSchema = z.object({
  symbol: z.string().min(1, "Symbol is required"),
  name: z.string().min(1, "Name is required"),
  exchange: z.string().default("NSE"),
  instrumentType: z.string().default("EQUITY"),
  side: z.enum(["BUY", "SELL"]),
  orderType: z.enum(["MARKET", "LIMIT", "SL", "SL_M"]).default("MARKET"),
  quantity: z.number().int().positive("Quantity must be positive"),
  price: z.number().positive().finite().optional(),
  triggerPrice: z.number().positive().finite().optional(),
  stopLoss: z.number().positive().finite().optional(),
  target: z.number().positive().finite().optional(),
  strategy: z.string().optional(),
  optionType: z.string().optional(),
  strikePrice: z.number().positive().finite().optional(),
  expiry: z.coerce.date().optional(),
  lotSize: z.number().int().positive().optional(),
});

export type PlaceOrderInput = z.input<typeof PlaceOrderSchema>;
export type PlaceOrderData = z.output<typeof PlaceOrderSchema>;
