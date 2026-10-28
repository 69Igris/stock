import { z } from "zod";

export const MutualFundFormSchema = z.object({
  schemeName: z.string().min(1, "Scheme name is required"),
  schemeCode: z.string().optional().nullable(),
  amcName: z.string().optional().nullable(),
  folioNumber: z.string().optional(),
  category: z.string().optional().default("Equity"),
  units: z
    .number()
    .positive("Units must be positive")
    .finite("Units must be a finite number"),
  averageNav: z
    .number()
    .positive("Average NAV must be positive")
    .finite("Average NAV must be a finite number"),
  currentNav: z
    .number()
    .positive("Current NAV must be positive")
    .finite("Current NAV must be a finite number")
    .optional(),
  sipActive: z.boolean().default(false),
  sipAmount: z.number().positive().finite().optional().nullable(),
  sipDate: z.number().min(1).max(28).optional().nullable(),
  brokerName: z.string().optional().default("manual"),
});

export type MutualFundFormInput = z.infer<typeof MutualFundFormSchema>;
