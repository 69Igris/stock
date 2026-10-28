# Vercel Deployment Guide - Google Cloud Gemini Integration

This guide explains how to deploy your TradeBook application to Vercel with Google Cloud Vertex AI (Gemini) integration using secure authentication.

## Prerequisites

- Vercel account
- Google Cloud project with Vertex AI API enabled
- Service account JSON key file

---

## Step 1: Prepare Google Cloud Service Account Key

### 1.1 Download Your Service Account Key

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Navigate to **IAM & Admin > Service Accounts**
3. Select your service account (or create a new one with "Vertex AI User" role)
4. Click **Keys > Add Key > Create New Key**
5. Select **JSON** format and download the key file
6. Save it securely (e.g., `gcp-service-account.json`)

⚠️ **IMPORTANT**: Never commit this file to git!

---

## Step 2: Convert JSON Key to Base64

Since Vercel doesn't support uploading files as environment variables, we need to encode the JSON key as a base64 string.

### On macOS/Linux:

```bash
cat gcp-service-account.json | base64
```

### On Windows (PowerShell):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("gcp-service-account.json"))
```

### On Windows (Git Bash):

```bash
cat gcp-service-account.json | base64 -w 0
```

**Copy the entire output** (it will be a long string starting with something like `ewogICJ0eXBlIjogInNlcnZpY2VfYWNjb3VudCIsC...`)

---

## Step 3: Set Environment Variables in Vercel

### 3.1 Via Vercel Dashboard (Recommended)

1. Go to your project in [Vercel Dashboard](https://vercel.com/dashboard)
2. Navigate to **Settings > Environment Variables**
3. Add the following environment variables:

| Variable Name                    | Value                                                    | Environment                      |
| -------------------------------- | -------------------------------------------------------- | -------------------------------- |
| `GCP_PROJECT_ID`                 | Your Google Cloud project ID (e.g., `my-project-123456`) | Production, Preview, Development |
| `GCP_LOCATION`                   | `us-central1` (or your preferred region)                 | Production, Preview, Development |
| `GCP_SERVICE_ACCOUNT_KEY_BASE64` | The base64 string from Step 2                            | Production, Preview, Development |
| `USE_GEMINI`                     | `true`                                                   | Production, Preview, Development |
| `GEMINI_MAX_RETRIES`             | `3`                                                      | Production, Preview, Development |
| `GEMINI_TIMEOUT_MS`              | `30000`                                                  | Production, Preview, Development |

4. Click **Save**

### 3.2 Via Vercel CLI (Alternative)

```bash
# Install Vercel CLI if you haven't
npm i -g vercel

# Login to Vercel
vercel login

# Set environment variables
vercel env add GCP_PROJECT_ID production
# Paste your project ID when prompted

vercel env add GCP_SERVICE_ACCOUNT_KEY_BASE64 production
# Paste your base64 string when prompted

vercel env add GCP_LOCATION production
# Enter: us-central1

vercel env add USE_GEMINI production
# Enter: true

vercel env add GEMINI_MAX_RETRIES production
# Enter: 3

vercel env add GEMINI_TIMEOUT_MS production
# Enter: 30000
```

---

## Step 4: Deploy to Vercel

### Via Vercel Dashboard:

1. Push your code to GitHub/GitLab/Bitbucket
2. Import the repository in Vercel
3. Vercel will automatically detect Next.js and deploy
4. Wait for deployment to complete

### Via Vercel CLI:

```bash
# Deploy to production
vercel --prod

# Or just deploy (creates preview)
vercel
```

---

## Step 5: Verify Deployment

### 5.1 Test the Health Endpoint

Visit: `https://your-app.vercel.app/api/chat`

You should see:

```json
{
  "status": "ok",
  "geminiEnabled": true,
  "message": "Gemini integration is enabled"
}
```

### 5.2 Test a Chat Query

Use the chat feature in your app or test via API:

```bash
curl -X POST https://your-app.vercel.app/api/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  -d '{
    "message": "What is portfolio diversification?",
    "queryType": "fast",
    "pagePath": "/tutor"
  }'
```

---

## Troubleshooting

### Issue: "Failed to initialize Vertex AI"

**Cause**: Invalid or missing GCP credentials

**Solution**:

1. Verify `GCP_SERVICE_ACCOUNT_KEY_BASE64` is set correctly in Vercel
2. Check that the base64 string is complete (no truncation)
3. Verify your service account has "Vertex AI User" role
4. Check Vercel deployment logs for specific errors

### Issue: "GCP_PROJECT_ID environment variable is required"

**Cause**: Missing project ID

**Solution**: Add `GCP_PROJECT_ID` environment variable in Vercel settings

### Issue: Base64 decoding error

**Cause**: Corrupted or incorrect base64 string

**Solution**:

1. Re-encode your JSON key file
2. Make sure you copied the ENTIRE base64 output
3. Check for extra spaces or line breaks
4. On Windows, use `-w 0` flag: `base64 -w 0 < gcp-service-account.json`

### Issue: "Quota exceeded" or "Rate limit"

**Cause**: Exceeded Vertex AI API limits

**Solution**:

1. Enable billing on your Google Cloud project
2. Check your quota limits in [Google Cloud Console](https://console.cloud.google.com/apis/api/aiplatform.googleapis.com/quotas)
3. Request quota increase if needed

### Issue: Deployment succeeds but AI responses are mock

**Cause**: `USE_GEMINI` is not set to `true`

**Solution**: Set `USE_GEMINI=true` in Vercel environment variables

---

## Security Best Practices

### ✅ DO:

- Use base64-encoded credentials for Vercel
- Set environment variables in Vercel dashboard (encrypted at rest)
- Use different service accounts for production/staging
- Rotate service account keys periodically (every 90 days)
- Monitor API usage in Google Cloud Console

### ❌ DON'T:

- Commit `gcp-service-account.json` to git
- Share base64 credentials in public channels
- Use the same credentials for local development and production
- Store credentials in client-side code

---

## Cost Monitoring

### Track Gemini API Costs

1. Go to [Google Cloud Console > Billing](https://console.cloud.google.com/billing)
2. Navigate to **Reports**
3. Filter by **Vertex AI** service
4. Monitor daily/monthly usage

### Expected Costs (Approximate)

- **Gemini Flash** (Fast mode): $0.075/$0.30 per 1M input/output tokens
- **Gemini Pro** (Advanced mode): $1.25/$5.00 per 1M input/output tokens

**Example**: 1000 users, 50 fast + 5 advanced queries/month

- Cost per user: ~₹50-100/month
- Total cost: ~₹50,000-100,000/month

Use the built-in cost tracking dashboard at `/admin/costs` (create this page) to monitor actual usage.

---

## Alternative: Using Individual Environment Variables

If you prefer not to use base64 encoding, you can set individual fields from the JSON key:

```bash
vercel env add GCP_CLIENT_EMAIL production
# Enter: your-sa@project.iam.gserviceaccount.com

vercel env add GCP_PRIVATE_KEY production
# Paste the private key (including -----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY-----)
```

Then update `lib/gemini/client.ts` to construct credentials from individual variables. However, base64 encoding is simpler and less error-prone.

---

## Local Development vs Production

### Local Development (.env):

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/gcp-service-account.json
GCP_PROJECT_ID=my-project-123456
GCP_LOCATION=us-central1
USE_GEMINI=true
```

### Vercel Production (Environment Variables):

```bash
GCP_SERVICE_ACCOUNT_KEY_BASE64=ewogICJ0eXBlIjogInNlcnZpY2VfYWNjb3VudCIsC...
GCP_PROJECT_ID=my-project-123456
GCP_LOCATION=us-central1
USE_GEMINI=true
```

The code automatically detects which authentication method to use.

---

## Support

If you encounter issues:

1. Check Vercel deployment logs: `vercel logs`
2. Check Google Cloud logs: [Logs Explorer](https://console.cloud.google.com/logs)
3. Review the [Vertex AI documentation](https://cloud.google.com/vertex-ai/docs)
4. Open an issue in the GitHub repository

---

## Next Steps

After successful deployment:

1. ✅ Run database migration: `npx prisma migrate deploy`
2. ✅ Test all chat endpoints (FIRE, Tutor, Analysis, Holdings)
3. ✅ Monitor costs in Google Cloud Console
4. ✅ Set up alerts for quota limits
5. ✅ Configure rate limiting if needed
6. ✅ Test action confirmations (create scenario, add holdings, etc.)

Happy deploying! 🚀
