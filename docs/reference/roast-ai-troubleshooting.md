# Portfolio Roast & Analysis AI Troubleshooting

When the Portfolio Roast fails with "The AI service encountered an error" or
when Investment Analysis shows ₹N/A for price targets, use this guide to
diagnose and fix.

---

## Roast Failure: "The AI service encountered an error"

The roast uses **Google Vertex AI (Gemini 2.5 Pro)** via
`@usemoney/core/gemini`. Failures typically stem from one of these causes.

### 1. Check Cloud Run Service Account Permissions

The workers run on GCP Cloud Run. The service uses **Application Default
Credentials** (the Cloud Run service account). Ensure it has:

- **Vertex AI User** (`roles/aiplatform.user`) - required for Gemini API calls

```bash
# List current IAM bindings for the Cloud Run service account
gcloud projects get-iam-policy stock-book-483718 \
  --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:*-compute@developer.gserviceaccount.com"
```

Add the role if missing:

```bash
gcloud projects add-iam-policy-binding stock-book-483718 \
  --member="serviceAccount:YOUR_SERVICE_ACCOUNT@stock-book-483718.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

### 2. Enable Vertex AI API

```bash
gcloud services enable aiplatform.googleapis.com --project=stock-book-483718
```

### 3. Verify Model Availability

The roast uses `gemini-2.5-pro`. Confirm it's available in your region:

- Default region: `us-central1` (set via `GCP_LOCATION` env var)
- [Vertex AI model availability](https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models#gemini-models)

If the model isn't available, set `GCP_LOCATION` to a supported region (e.g.
`us-central1`).

### 4. Inspect Actual Error (for ops)

The raw error is stored in `PortfolioRoast.errorMessage` (truncated to 500
chars). To view:

```javascript
// In MongoDB or admin tool
db.PortfolioRoast.find({ status: "FAILED" }).sort({ createdAt: -1 }).limit(5);
```

Common raw errors:

| Raw Error Pattern                                 | Cause                          | Fix                                      |
| ------------------------------------------------- | ------------------------------ | ---------------------------------------- |
| `GCP_PROJECT_ID environment variable is required` | Env not set                    | Add `GCP_PROJECT_ID` to Cloud Run        |
| `403` / `Permission denied`                       | SA lacks Vertex AI role        | Add `roles/aiplatform.user`              |
| `404` / `Model not found`                         | Wrong region or model name     | Check `GCP_LOCATION`, model availability |
| `429` / `Resource exhausted`                      | Rate limit or quota            | Retry later, check quotas                |
| `ECONNREFUSED`                                    | Network / endpoint unreachable | Verify VPC, firewall, region             |

### 5. Local Development

For local worker testing, set:

```bash
export GCP_PROJECT_ID=stock-book-483718
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

Or use base64 credentials (e.g. for Docker):

```bash
export GCP_SERVICE_ACCOUNT_KEY_BASE64=$(cat sa-key.json | base64)
```

---

## Analysis: Price Targets Showing ₹N/A

Investment Analysis gets price data from:

1. **fetch_stock_price** (Yahoo Finance) → current price
2. **compute_dcf** → intrinsic value, target range
3. **compute_scenario_analysis** → bull/base/bear targets

If all show N/A, likely causes:

### 1. Yahoo Finance Fetch Failing

The research worker calls `yahooFetchQuotes()` from
`@usemoney/core/market-data`. Failures can occur if:

- Yahoo blocks or rate-limits Cloud Run IPs
- Cookie/crumb auth fails (401/403)
- Symbol format wrong (use `RELIANCE.NS` for NSE)

**Mitigation:** The synthesizer now enriches `priceTarget` from whatever task
data is available. If `fetch_stock_price` fails but `compute_dcf` or
`compute_scenario_analysis` succeed (using `fetch_key_ratios.currentPrice`),
targets can still be populated.

### 2. DCF / Scenario Tools Failing

These need `currentPrice` from `fetch_stock_price` or `fetch_key_ratios`. If
both fail, DCF and scenario analysis cannot run.

**Check:** Research session logs for `fetch_stock_price` and `fetch_key_ratios`
task status. If they show `failed`, the Yahoo or financial data pipeline is the
bottleneck.

### 3. LLM Omitting priceTarget

The synthesizer prompt instructs the LLM to include `priceTarget` when data
exists. If the LLM omits it (e.g. due to "never invent numbers"), the
**enrichment step** in `synthesize-report.ts` now extracts prices from task
results and merges them into the report.

---

## Quick Checklist

- [ ] Vertex AI API enabled
- [ ] Cloud Run SA has `roles/aiplatform.user`
- [ ] `GCP_PROJECT_ID` set in workers
- [ ] `GCP_LOCATION` = `us-central1` (or supported region)
- [ ] For local dev: `GOOGLE_APPLICATION_CREDENTIALS` or
      `GCP_SERVICE_ACCOUNT_KEY_BASE64`
