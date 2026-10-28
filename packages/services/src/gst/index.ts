/**
 * GST / Billing services - barrel export.
 *
 * MONEY-213 - CSV ingestion (this PR)
 * MONEY-214 - Invoice generation engine (next PR)
 * MONEY-215 - PDF rendering
 * MONEY-216 - Admin UI
 * MONEY-217 - GSTR-1 export + FIRC
 */

export { parseDodoCsv } from "./dodo-csv-parser";
export type { ParsedDodoRow, ParseResult } from "./dodo-csv-parser";

export { stageDodoRows } from "./staging.service";
export type { StageResult } from "./staging.service";

export { getBillingPeriod, getFinancialYear } from "./billing-period";

export {
  allocateUmaiNumber,
  peekNextUmaiSequence,
  type DocumentType,
  type AllocatedNumber,
} from "./numbering";

export {
  getRbiReferenceRate,
  RbiRateUnavailableError,
  type FxRateLookup,
} from "./rbi-fx";

export {
  generateGstInvoice,
  cancelInvoice,
  roundCurrency,
  LutArnNotConfiguredError,
  NoPendingPayoutsError,
  type GenerateInvoiceInput,
  type GenerateInvoiceResult,
} from "./invoice-engine.service";

export {
  buildInvoiceStorageKey,
  uploadInvoicePdf,
  getInvoiceDownloadUrl,
  renderInvoicePdf,
  finaliseInvoice,
  INVOICE_PDF_DEFAULTS,
} from "./pdf-renderer";

export {
  recordAuditEvent,
  getAuditHistory,
  type GstAuditAction,
  type AuditEventInput,
} from "./audit-log";

export {
  buildGstr1Table6aCsv,
  GSTR1_TABLE_6A_HEADERS,
  type Gstr1ExportInput,
  type Gstr1ExportRow,
  type Gstr1ExportResult,
} from "./gstr1-export";

export {
  markFircReceived,
  markFircNotApplicable,
  getFircReconciliation,
  FIRC_RECONCILIATION_THRESHOLD,
  type MarkFircReceivedInput,
  type FircReconciliationItem,
} from "./firc.service";

export {
  getUserGstProfile,
  setUserGstProfile,
  clearUserGstProfile,
  userGstProfileSchema,
  GST_PROFILE_REGEXES,
  type UserGstProfile,
  type UserGstProfileInput,
} from "./user-profile";

export {
  generateDomesticInvoiceForPayment,
  computeTaxBreakdown,
  GstProfileMissingError,
  PaymentNotEligibleError,
  type GenerateDomesticInvoiceInput,
  type DomesticInvoiceTaxBreakdown,
} from "./domestic-engine.service";
