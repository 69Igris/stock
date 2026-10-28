import { z } from "zod";

export const TradeFormSchema = z.object({
  tradeDate: z.string().min(1, "Trade date is required"),
  symbol: z
    .string()
    .min(1, "Symbol is required")
    .max(50)
    .transform((s) => s.toUpperCase()),
  broker: z.string().optional().default("manual"),
  exchange: z
    .enum(["NSE", "BSE", "NFO", "MCX", "NCDEX", "CDS", "CRYPTO"])
    .default("NSE"),
  segment: z
    .enum(["EQUITY", "FUTURES", "OPTIONS", "COMMODITY", "CASH", "CRYPTO"])
    .default("EQUITY"),
  positionType: z.enum(["LONG", "SHORT"]).default("LONG"),
  tradeType: z.enum(["BUY", "SELL"]).default("BUY"),
  orderType: z.enum(["MARKET", "LIMIT", "SL", "SL-M"]).default("MARKET"),
  quantity: z
    .string()
    .min(1, "Quantity is required")
    .transform(Number)
    .pipe(
      z
        .number()
        .positive("Quantity must be positive")
        .finite("Quantity must be a finite number"),
    ),
  price: z
    .string()
    .min(1, "Price is required")
    .transform(Number)
    .pipe(
      z
        .number()
        .positive("Price must be positive")
        .finite("Price must be a finite number"),
    ),
  exitPrice: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : null)),
  brokerage: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : 20)),
  realizedPnL: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : null)),
  productType: z.enum(["CNC", "MIS", "NRML"]).default("CNC"),
  tags: z
    .string()
    .optional()
    .transform((val) =>
      val
        ? val
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
    ),
  notes: z.string().optional().nullable(),
});

export type TradeFormInput = z.input<typeof TradeFormSchema>;
export type TradeFormData = z.output<typeof TradeFormSchema>;

export const ClosePositionSchema = z.object({
  positionId: z.string().min(1, "Position ID is required"),
  exitPrice: z
    .number()
    .positive("Exit price must be positive")
    .finite("Exit price must be a finite number"),
});

export type ClosePositionInput = z.infer<typeof ClosePositionSchema>;

export const TradeFilterSchema = z.object({
  symbol: z.string().optional(),
  broker: z.string().optional(),
  segment: z.string().optional(),
  tradeType: z.string().optional(),
  // MONEY-839: productType (MIS / CNC) drives the Tradebook Intraday/Delivery
  // pills server-side, so they filter ALL trades, not just the loaded page.
  productType: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  limit: z.number().min(1).max(100).default(20),
  skip: z.number().min(0).default(0),
});

export type TradeFilterInput = z.infer<typeof TradeFilterSchema>;
