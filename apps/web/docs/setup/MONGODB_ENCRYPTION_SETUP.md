# MongoDB Encryption at Rest Setup Guide

> **Status:** Deferred - Can be implemented anytime in the future
> **Last Updated:** January 2026

## Executive Summary

**Current Status:** Your application already follows industry standards for encryption.

| Data Type         | Current Status             | Industry Standard            | Action Needed                     |
| ----------------- | -------------------------- | ---------------------------- | --------------------------------- |
| API Keys, Tokens  | ✅ Encrypted (AES-256-GCM) | Encrypt                      | None                              |
| Broker User IDs   | Not encrypted              | Usually not encrypted        | None                              |
| Financial Data    | Not encrypted              | Database-level encryption    | Enable MongoDB Encryption at Rest |
| PAN/Aadhaar/SSN   | Not stored                 | Don't store or encrypt       | None                              |
| Payment Card Data | Not stored (Dodo handles)  | Tokenize via payment gateway | None                              |

**Recommendation:** Enable MongoDB Encryption at Rest (database-level) - no code changes needed.

---

## Part 1: Sensitive Fields Audit

### ✅ Already Properly Encrypted

- `encryptedCreds` in BrokerConnection (AES-256-GCM with IV and authTag)
- Contains: apiKey, apiSecret, accessToken, refreshToken

### ✅ Not Stored (Good Practice)

- No PAN numbers
- No Aadhaar numbers
- No bank account numbers
- No credit card data (handled by Dodo Payments)
- No phone numbers or addresses
- No KYC documents

### ⚠️ Cleanup Recommended (Low Priority)

Legacy deprecated fields still in schema:

- `accessToken`, `refreshToken`, `apiKey`, `apiSecret` (old plaintext fields)
- These should be empty if migration to `encryptedCreds` was done

---

## Part 2: MongoDB Encryption at Rest Setup

### Option A: MongoDB Atlas (Recommended)

If using MongoDB Atlas, encryption at rest is **automatic and free** on M10+ clusters.

#### Steps:

1. **Log into MongoDB Atlas Dashboard**
   - Go to https://cloud.mongodb.com

2. **Navigate to your Cluster**
   - Click on your cluster name (e.g., "stockbook-prod")

3. **Verify Encryption Status**
   - Go to **Security** → **Advanced** or **Cluster Settings**
   - Look for "Encryption at Rest"
   - For M10+ clusters: Already enabled by default with MongoDB-managed keys
   - For M0/M2/M5 (free/shared): Encryption at rest is included

4. **For Customer-Managed Keys (Optional - Enterprise)**
   - Go to **Security** → **Advanced**
   - Enable "Customer Key Management"
   - Configure AWS KMS, Azure Key Vault, or Google Cloud KMS
   - Requires M10+ cluster

#### Atlas Encryption Features (Automatic):

- ✅ All data encrypted on disk (AES-256)
- ✅ All backups encrypted
- ✅ All snapshots encrypted
- ✅ Transparent to application (no code changes)

---

### Option B: Self-Hosted MongoDB

If running MongoDB on your own servers:

#### 1. Enable Encryption at Rest in mongod.conf

```yaml
# /etc/mongod.conf

security:
  enableEncryption: true
  encryptionCipherMode: AES256-CBC
  encryptionKeyFile: /etc/mongodb/encryption-keyfile

# For WiredTiger storage engine (default)
storage:
  wiredTiger:
    engineConfig:
      encryptionCipherMode: AES256-CBC
```

#### 2. Generate Encryption Key

```bash
# Generate a 256-bit key
openssl rand -base64 32 > /etc/mongodb/encryption-keyfile

# Secure the keyfile
chmod 600 /etc/mongodb/encryption-keyfile
chown mongodb:mongodb /etc/mongodb/encryption-keyfile
```

#### 3. Restart MongoDB

```bash
sudo systemctl restart mongod
```

#### 4. Verify Encryption

```javascript
// In mongo shell
db.serverStatus().wiredTiger.encryptionAtRest;
// Should show: { "enabled": true }
```

---

### Option C: Google Cloud KMS Integration (For Future)

If you want customer-managed keys with GCP:

#### Prerequisites

- MongoDB Atlas M10+ cluster
- Google Cloud account with KMS enabled
- Service account with KMS permissions

#### Steps:

1. **Create a Key Ring in GCP**

   ```bash
   gcloud kms keyrings create stockbook-keyring --location=global
   ```

2. **Create an Encryption Key**

   ```bash
   gcloud kms keys create stockbook-mongodb-key \
     --location=global \
     --keyring=stockbook-keyring \
     --purpose=encryption
   ```

3. **Create Service Account**

   ```bash
   gcloud iam service-accounts create mongodb-encryption \
     --display-name="MongoDB Encryption Service Account"
   ```

4. **Grant Permissions**

   ```bash
   gcloud kms keys add-iam-policy-binding stockbook-mongodb-key \
     --location=global \
     --keyring=stockbook-keyring \
     --member="serviceAccount:mongodb-encryption@PROJECT_ID.iam.gserviceaccount.com" \
     --role="roles/cloudkms.cryptoKeyEncrypterDecrypter"
   ```

5. **Configure in MongoDB Atlas**
   - Go to Security → Advanced → Customer Key Management
   - Select "Google Cloud KMS"
   - Enter service account credentials
   - Select key ring and key

---

## Part 3: Additional Security Checklist

### Environment Variables (Vercel/Production)

Ensure these are set securely in Vercel dashboard (not in git):

```
ENCRYPTION_KEY=<your-32-byte-hex-key>
DATABASE_URL=<mongodb-connection-string>
CLERK_SECRET_KEY=<clerk-secret>
DODO_PAYMENTS_API_KEY=<dodo-key>
DODO_WEBHOOK_SECRET=<webhook-secret>
```

### Connection String Security

Ensure your MongoDB connection string uses:

- ✅ `mongodb+srv://` (TLS/SSL encrypted connection)
- ✅ Username/password authentication
- ✅ IP whitelist in Atlas (only allow Vercel IPs)

Example secure connection string:

```
mongodb+srv://user:password@cluster.mongodb.net/stockbook?retryWrites=true&w=majority
```

---

## Part 4: Verification Steps

### 1. Verify Atlas Encryption (if using Atlas)

```bash
# Using Atlas CLI
atlas clusters describe stockbook-prod --output json | grep encryption
```

Or check in Atlas UI:

- Cluster → Security → Advanced → "Encryption at Rest: Enabled"

### 2. Verify TLS in Connection

Check your Prisma connection in logs:

```
[prisma] Connecting with TLS enabled
```

### 3. Test Credential Encryption

```typescript
// In your app, credentials should be encrypted
const conn = await prisma.brokerConnection.findFirst();
console.log(conn.encryptedCreds); // Should be encrypted hex string
console.log(conn.accessToken); // Should be null (deprecated)
```

---

## Summary of Actions

| Action                                  | Priority | Effort | Type          |
| --------------------------------------- | -------- | ------ | ------------- |
| Verify MongoDB Atlas Encryption at Rest | High     | 5 min  | Configuration |
| Check TLS is enabled on DB connection   | High     | 2 min  | Verification  |
| Ensure env vars are in Vercel, not git  | High     | 5 min  | Configuration |
| Clean up deprecated credential fields   | Low      | 30 min | Code cleanup  |
| Setup GCP KMS (optional)                | Low      | 1 hour | Configuration |

---

## No Code Changes Required

Your current encryption implementation is correct:

- ✅ Credentials encrypted with AES-256-GCM
- ✅ Payment data handled by Dodo (PCI compliant)
- ✅ Auth handled by Clerk (SOC 2 compliant)
- ✅ No sensitive PII stored

Just enable/verify MongoDB Encryption at Rest for complete protection.

---

## Related Documentation

- [Dodo Payments Setup](./DODO_PAYMENTS_SETUP.md) - Payment gateway configuration
- [Broker Integration](./BROKER_INTEGRATION.md) - Broker API credentials handling
