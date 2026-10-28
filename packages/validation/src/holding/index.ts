import { z } from "zod";

export const HoldingFormSchema = z.object({
  symbol: z
    .string()
    .min(1, "Symbol is required")
    .max(50)
    .transform((s) => s.toUpperCase()),
  name: z.string().optional(),
  sector: z.string().optional().default("Other"),
  exchange: z.enum(["NSE", "BSE"]).default("NSE"),
  quantity: z
    .number()
    .positive("Quantity must be positive")
    .finite("Quantity must be a finite number"),
  averagePrice: z
    .number()
    .positive("Average price must be positive")
    .finite("Average price must be a finite number"),
  currentPrice: z
    .number()
    .positive("Current price must be positive")
    .finite("Current price must be a finite number")
    .optional(),
  brokerName: z.string().optional().default("manual"),
});

export type HoldingFormInput = z.infer<typeof HoldingFormSchema>;
