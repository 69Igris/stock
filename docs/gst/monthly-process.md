# GST Monthly Invoicing Runbook

This is the operator playbook for running UseMoney's monthly GST cycle. The
whole flow is gated behind admin auth at `/admin/gst/invoices`.

## Prerequisites (one-time per FY)

- `GST_LUT_ARN` env populated with the current FY's LUT acknowledgement number.
  **Invoice generation is hard-blocked when this is missing.**
- `GST_SELLER_*` env vars (legal name, address, GSTIN, PAN, state code) set in
  production secret manager.
- `GST_BANK_*` env vars for the export-account beneficiary line printed on every
  PDF.
- The first time invoices are generated for a new FY, the counter is auto-
  initialised at sequence 1; no manual seeding required.

## Monthly cycle

Run once around the 1st of each calendar month, for the prior month's invoicing.

### 1. Pull the DodoPayments wallet ledger

From DodoPayments dashboard → Wallet → Export. Filter to last month. Download
the CSV.

### 2. Upload + preview

Open `/admin/gst/invoices` → "Generate from payout" drawer.

- Paste the CSV body. Idempotent - re-uploading the same CSV shows "Already
  ingested" and no rows are duplicated.
- Preview lists pending (period × currency) groups with row counts and net
  amounts in foreign currency.

### 3. Confirm generation

Click "Generate N invoices". The process is sequential per group:

- For each (period, currency): the engine sums staged rows, resolves the RBI
  reference rate on the invoice date, allocates the next UMAI number, inserts a
  DRAFT row, then renders + uploads the PDF. Status flips DRAFT → ISSUED on
  success.
- Refund-heavy periods (net < 0) generate a credit note instead, with reason
  `REFUND`.
- Failures preserve the audited number (status: CANCELLED with reason) rather
  than leaving sequence holes.

### 4. Download + share with CA

For each issued invoice the table shows a download button → 15-min signed URL.
Share the bundle with the CA via secure channel (encrypted zip in email is fine;
never paste signed URLs into Slack/email).

### 5. GSTR-1 Table 6A export

Once the CA has confirmed the period, open the GSTR-1 export action (coming in
admin UI extension). It outputs a CSV in the GST portal's exact column order -
import into the offline utility verbatim.

### 6. FIRC reconciliation (T+30 onwards)

When bank statements arrive showing the foreign credits:

- For each invoice, click "Mark FIRC received" → upload FIRC PDF + enter bank
  credit date and bank credit amount in INR.
- The reconciliation view flags invoices where bank-credit INR diverges from
  invoiced INR by more than 1% (currency-shift signal). CA reviews flagged rows.
- INR invoices: mark FIRC status = NA (no remittance occurred).

## FY rollover (March 31 → April 1)

- Verify next FY's LUT filing has been initiated by the CA.
- Once the new ARN is issued, update `GST_LUT_ARN` in production secret manager.
  Do this BEFORE generating any April invoices - the engine hard-blocks if the
  env is empty.
- Run the QA cycle first to confirm: counter resets to 1, invoice numbers come
  out as `UMAI/EXP/YY-YY/0001` for the new FY, and the prior FY's counter is
  left untouched.
- Backfill any straggling March invoices BEFORE the rollover. Backfilled
  invoices use the FY they belong to, not the current FY - pass an explicit
  `invoiceDateOverride` in March 31 to land them in the prior FY's counter.

## Pre-merge CA gate

Before the first prod release, the CA reviews sample PDFs:

- One per currency (USD, GBP, EUR, INR)
- Verifies all mandatory CGST Rules fields, declaration wording, FX disclosure,
  and place of supply

The CA's written sign-off is captured in MONEY-217's Linear comment with date
and signature. **No code change ships without sign-off.**
