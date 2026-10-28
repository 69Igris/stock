# Vercel Deployment - Quick Start Guide

## 🚀 Deploy in 5 Minutes

### 1️⃣ Encode Your Google Cloud Key

```bash
# macOS/Linux
cat gcp-service-account.json | base64

# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("gcp-service-account.json"))
```

Copy the output (long base64 string).

---

### 2️⃣ Set Environment Variables in Vercel

Go to: **Vercel Dashboard > Your Project > Settings > Environment Variables**

Add these variables (apply to Production, Preview, Development):

```env
GCP_PROJECT_ID=your-project-id
GCP_LOCATION=us-central1
GCP_SERVICE_ACCOUNT_KEY_BASE64=<paste-your-base64-string-here>
USE_GEMINI=true
GEMINI_MAX_RETRIES=3
GEMINI_TIMEOUT_MS=30000
```

---

### 3️⃣ Deploy

```bash
# Push to git (if connected to Vercel)
git push origin main

# OR deploy via CLI
vercel --prod
```

---

### 4️⃣ Verify

Visit: `https://your-app.vercel.app/api/chat`

Expected response:

```json
{
  "status": "ok",
  "geminiEnabled": true,
  "message": "Gemini integration is enabled"
}
```

---

## ✅ Checklist

- [ ] Downloaded Google Cloud service account JSON key
- [ ] Converted key to base64
- [ ] Set `GCP_SERVICE_ACCOUNT_KEY_BASE64` in Vercel
- [ ] Set `GCP_PROJECT_ID` in Vercel
- [ ] Set `GCP_LOCATION` in Vercel
- [ ] Set `USE_GEMINI=true` in Vercel
- [ ] Deployed to Vercel
- [ ] Tested `/api/chat` health endpoint
- [ ] Tested chat functionality in app

---

## ⚠️ Common Issues

| Error                             | Fix                                          |
| --------------------------------- | -------------------------------------------- |
| "GCP_PROJECT_ID is required"      | Add `GCP_PROJECT_ID` env var                 |
| "Failed to initialize Vertex AI"  | Check base64 string is complete              |
| Mock responses instead of real AI | Set `USE_GEMINI=true`                        |
| Base64 decode error               | Re-encode without line breaks: `base64 -w 0` |

---

## 📊 Environment Variables Summary

| Variable                         | Value               | Required        |
| -------------------------------- | ------------------- | --------------- |
| `GCP_PROJECT_ID`                 | Your GCP project ID | ✅ Yes          |
| `GCP_LOCATION`                   | `us-central1`       | ✅ Yes          |
| `GCP_SERVICE_ACCOUNT_KEY_BASE64` | Base64 key          | ✅ Yes (Vercel) |
| `GOOGLE_APPLICATION_CREDENTIALS` | File path           | ✅ Yes (Local)  |
| `USE_GEMINI`                     | `true`              | ✅ Yes          |
| `GEMINI_MAX_RETRIES`             | `3`                 | Optional        |
| `GEMINI_TIMEOUT_MS`              | `30000`             | Optional        |

---

## 🔐 Security Notes

- ✅ Use base64-encoded credentials for Vercel
- ❌ Never commit JSON key files to git
- ✅ Add `*.json` to `.gitignore` (except `package.json`)
- ✅ Rotate service account keys every 90 days
- ✅ Monitor API usage in Google Cloud Console

---

## 💰 Cost Estimate

**Per 1000 users/month** (50 fast + 5 advanced queries each):

- Fast queries: 50,000 queries × ₹0.02 = ₹1,000
- Advanced queries: 5,000 queries × ₹0.80 = ₹4,000
- **Total**: ~₹5,000/month

Track costs: [Google Cloud Console > Billing](https://console.cloud.google.com/billing)

---

## 🆘 Need Help?

1. Check logs: `vercel logs`
2. Check Google Cloud logs: [Logs Explorer](https://console.cloud.google.com/logs)
3. See full guide: `VERCEL_DEPLOYMENT.md`
4. Open GitHub issue

---

**That's it! Your Gemini integration is now live on Vercel.** 🎉
