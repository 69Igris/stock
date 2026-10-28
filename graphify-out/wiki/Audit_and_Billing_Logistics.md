# Audit and Billing Logistics

> 108 nodes

## Key Concepts

- **gst/index.ts** (68 connections) — `packages/services/src/gst/index.ts`
- **invoice-engine.service.ts** (31 connections) — `packages/services/src/gst/invoice-engine.service.ts`
- **domestic-engine.service.ts** (22 connections) — `packages/services/src/gst/domestic-engine.service.ts`
- **pdf-renderer.ts** (22 connections) — `packages/services/src/gst/pdf-renderer.ts`
- **dodo-csv-parser.ts** (13 connections) — `packages/services/src/gst/dodo-csv-parser.ts`
- **numbering.ts** (13 connections) — `packages/services/src/gst/numbering.ts`
- **generateGstInvoice()** (12 connections) — `packages/services/src/gst/invoice-engine.service.ts`
- **pure-helpers.test.ts** (12 connections) — `packages/services/__tests__/pure-helpers.test.ts`
- **generateDomesticInvoiceForPayment()** (11 connections) — `packages/services/src/gst/domestic-engine.service.ts`
- **gstr1-export.ts** (11 connections) — `packages/services/src/gst/gstr1-export.ts`
- **staging.service.ts** (11 connections) — `packages/services/src/gst/staging.service.ts`
- **user-profile.ts** (11 connections) — `packages/services/src/gst/user-profile.ts`
- **getRbiReferenceRate()** (10 connections) — `packages/services/src/gst/rbi-fx.ts`
- **audit-log.ts** (10 connections) — `packages/services/src/gst/audit-log.ts`
- **rbi-fx.ts** (10 connections) — `packages/services/src/gst/rbi-fx.ts`
- **recordAuditEvent()** (9 connections) — `packages/services/src/gst/audit-log.ts`
- **firc.service.ts** (9 connections) — `packages/services/src/gst/firc.service.ts`
- **roundCurrency()** (8 connections) — `packages/services/src/gst/invoice-engine.service.ts`
- **allocateUmaiNumber()** (8 connections) — `packages/services/src/gst/numbering.ts`
- **billing-period.ts** (8 connections) — `packages/services/src/gst/billing-period.ts`
- **renderInvoicePdf()** (7 connections) — `packages/services/src/gst/pdf-renderer.ts`
- **RbiRateUnavailableError** (6 connections) — `packages/services/src/gst/rbi-fx.ts`
- **getBillingPeriod()** (6 connections) — `packages/services/src/gst/billing-period.ts`
- **getFinancialYear()** (6 connections) — `packages/services/src/gst/billing-period.ts`
- **parseDodoCsv()** (6 connections) — `packages/services/src/gst/dodo-csv-parser.ts`
- *... and 83 more nodes in this community*

## Relationships

- [Content Access and Pagination](Content_Access_and_Pagination.md) (9 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (9 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (5 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (4 shared connections)
- [Trade History Analytics](Trade_History_Analytics.md) (4 shared connections)
- [Domestic Invoice Generation](Domestic_Invoice_Generation.md) (2 shared connections)
- [Export Invoice Generation](Export_Invoice_Generation.md) (2 shared connections)
- [PDF Report Templates](PDF_Report_Templates.md) (1 shared connections)
- [Comprehensive Analysis Service](Comprehensive_Analysis_Service.md) (1 shared connections)

## Source Files

- `packages/services/__tests__/pure-helpers.test.ts`
- `packages/services/src/gst/audit-log.ts`
- `packages/services/src/gst/billing-period.ts`
- `packages/services/src/gst/dodo-csv-parser.ts`
- `packages/services/src/gst/domestic-engine.service.ts`
- `packages/services/src/gst/firc.service.ts`
- `packages/services/src/gst/gstr1-export.ts`
- `packages/services/src/gst/index.ts`
- `packages/services/src/gst/invoice-engine.service.ts`
- `packages/services/src/gst/numbering.ts`
- `packages/services/src/gst/pdf-renderer.ts`
- `packages/services/src/gst/rbi-fx.ts`
- `packages/services/src/gst/staging.service.ts`
- `packages/services/src/gst/user-profile.ts`

## Audit Trail

- EXTRACTED: 285 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*