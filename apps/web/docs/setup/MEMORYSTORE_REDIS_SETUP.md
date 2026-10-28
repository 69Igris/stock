# Redis Setup Guide

This guide walks you through setting up Redis for feature flag caching in the Tradebook application. Choose the provider that best fits your infrastructure.

## Supported Providers

| Provider                     | Connection Method           | TLS             | Best For                   |
| ---------------------------- | --------------------------- | --------------- | -------------------------- |
| **DigitalOcean Redis**       | `REDIS_URL`                 | Yes (rediss://) | DO App Platform, Droplets  |
| **Google Cloud Memorystore** | `REDIS_HOST` + `REDIS_PORT` | No (VPC only)   | Cloud Run, GKE, App Engine |
| **Redis Cloud**              | `REDIS_URL`                 | Yes (rediss://) | Any platform               |
| **Upstash**                  | `REDIS_URL`                 | Yes (rediss://) | Serverless, Edge           |
| **Self-hosted**              | Either method               | Optional        | Full control               |

---

# Option A: DigitalOcean Redis

DigitalOcean Managed Redis is the easiest option if you're deploying on DigitalOcean.

## Prerequisites

- DigitalOcean account
- Application deployed on DigitalOcean (App Platform, Droplets, or Kubernetes)

## Step 1: Create a Redis Database

1. Go to [DigitalOcean Control Panel](https://cloud.digitalocean.com/databases)
2. Click **Create Database**
3. Select **Redis**
4. Configure:
   - **Region**: Choose the same region as your app
   - **Node Plan**: Basic ($15/month) or higher
   - **Cluster Name**: `tradebook-redis`
5. Click **Create Database Cluster**

## Step 2: Get Connection Details

1. Go to your Redis cluster in the Control Panel
2. Click on **Connection Details**
3. Copy the **Connection String** (it looks like):

```
rediss://default:PASSWORD@tradebook-redis-do-user-xxxxx-0.db.ondigitalocean.com:25061
```

Note: `rediss://` (with double 's') indicates TLS is enabled.

## Step 3: Configure Environment Variable

Add the connection URL to your environment:

```bash
REDIS_URL=rediss://default:PASSWORD@tradebook-redis-do-user-xxxxx-0.db.ondigitalocean.com:25061
```

### For App Platform

1. Go to your app in DigitalOcean
2. Click **Settings** → **App-Level Environment Variables**
3. Add:
   - **Key**: `REDIS_URL`
   - **Value**: Your connection string
   - Check **Encrypt** for security

### For Droplets

Add to your `.env` file or set in your deployment script:

```bash
export REDIS_URL="rediss://default:PASSWORD@your-redis-host:25061"
```

## Step 4: Restrict Access (Recommended)

1. Go to your Redis cluster → **Settings**
2. Under **Trusted Sources**, add your app's IP or VPC
3. This restricts access to only your application

## Step 5: Verify Connection

Check application logs for:

```
[Redis] Connected to Redis (URL)
[Redis] Redis client ready
```

---

# Option B: Google Cloud Memorystore

## Prerequisites

- Google Cloud Project with billing enabled
- `gcloud` CLI installed and configured
- Appropriate IAM permissions (Project Editor or Memorystore Admin)
- Application deployed on Google Cloud (Cloud Run, GKE, App Engine, etc.)

## Step 1: Enable Required APIs

Enable the Memorystore for Redis API:

```bash
gcloud services enable redis.googleapis.com
```

## Step 2: Create a Memorystore Redis Instance

### Option A: Using gcloud CLI

```bash
gcloud redis instances create tradebook-redis \
  --size=1 \
  --region=us-central1 \
  --network=projects/YOUR_PROJECT_ID/global/networks/default \
  --redis-version=redis_7_0 \
  --tier=basic \
  --display-name="Tradebook Feature Flags Cache"
```

**Parameters:**

- `--size`: Memory size in GB (1GB minimum for basic tier)
- `--region`: Choose a region close to your application
- `--network`: VPC network name (use `default` for default network)
- `--redis-version`: Redis version (recommended: `redis_7_0`)
- `--tier`: `basic` for development, `standard` for production with HA

### Option B: Using Google Cloud Console

1. Navigate to [Memorystore for Redis](https://console.cloud.google.com/memorystore/redis/instances)
2. Click **Create Instance**
3. Configure:
   - **Instance ID**: `tradebook-redis`
   - **Region**: Choose region close to your app
   - **Tier**: Basic (dev) or Standard (prod)
   - **Capacity**: 1 GB (minimum)
   - **Redis version**: 7.0
   - **Network**: Select your VPC network
4. Click **Create**

## Step 3: Get Connection Details

After creation, get the connection details:

```bash
gcloud redis instances describe tradebook-redis --region=us-central1
```

Note down:

- **Host IP**: The internal IP address
- **Port**: Usually 6379
- **Auth String**: If AUTH is enabled (check instance details)

## Step 4: Configure Network Access

### For Cloud Run / App Engine

Memorystore instances are accessible only from resources in the same VPC network. For Cloud Run:

1. Enable VPC connector:

```bash
gcloud compute networks vpc-access connectors create tradebook-connector \
  --region=us-central1 \
  --network=default \
  --range=10.8.0.0/28
```

2. Configure Cloud Run service to use VPC connector:

```bash
gcloud run services update YOUR_SERVICE_NAME \
  --vpc-connector=tradebook-connector \
  --region=us-central1
```

### For GKE

Ensure your GKE cluster is in the same VPC network as the Memorystore instance.

### For Compute Engine

Ensure your VM is in the same VPC network and has appropriate firewall rules.

## Step 5: Set Up Authentication (Optional but Recommended)

Enable AUTH on your Redis instance for production:

```bash
gcloud redis instances update tradebook-redis \
  --region=us-central1 \
  --auth-enabled
```

After enabling, get the AUTH string:

```bash
gcloud redis instances get-auth-string tradebook-redis --region=us-central1
```

## Step 6: Configure Environment Variables

Add the following environment variables to your application:

### Required Variables

```bash
# Redis Connection
REDIS_HOST=<memorystore-internal-ip>
REDIS_PORT=6379

# Optional: If AUTH is enabled
REDIS_AUTH_STRING=<auth-string-from-step-5>
```

### Example `.env` file

```bash
# Google Cloud Memorystore Redis
REDIS_HOST=10.0.0.3
REDIS_PORT=6379
REDIS_AUTH_STRING=your-auth-string-here
```

### Setting in Cloud Run

```bash
gcloud run services update YOUR_SERVICE_NAME \
  --set-env-vars="REDIS_HOST=10.0.0.3,REDIS_PORT=6379,REDIS_AUTH_STRING=your-auth-string" \
  --region=us-central1
```

### Setting in App Engine

Add to `app.yaml`:

```yaml
env_variables:
  REDIS_HOST: "10.0.0.3"
  REDIS_PORT: "6379"
  REDIS_AUTH_STRING: "your-auth-string"
```

### Setting in GKE

Add to your deployment YAML or ConfigMap:

```yaml
env:
  - name: REDIS_HOST
    value: "10.0.0.3"
  - name: REDIS_PORT
    value: "6379"
  - name: REDIS_AUTH_STRING
    valueFrom:
      secretKeyRef:
        name: redis-secret
        key: auth-string
```

## Step 7: Install Dependencies

The Redis client library (`ioredis`) is already added to `package.json`. Install it:

```bash
yarn install
# or
npm install
```

## Step 8: Verify Connection

The application will automatically connect to Redis on startup. Check logs for:

```
[Redis] Connected to Memorystore Redis
[Redis] Redis client ready
```

If Redis is unavailable, the application will gracefully fall back to in-memory caching.

## Step 9: Test Feature Flags

1. Access a page that uses feature flags
2. Check application logs for Redis cache hits:
   ```
   [FeatureFlags Server] Using Redis cached flags for user: user_xxx
   ```

## Troubleshooting

### Connection Timeout

**Issue**: Cannot connect to Redis instance

**Solutions**:

- Verify VPC connector is configured correctly
- Check firewall rules allow traffic on port 6379
- Ensure application is in the same VPC network
- Verify Redis instance is running: `gcloud redis instances describe tradebook-redis --region=us-central1`

### Authentication Error

**Issue**: `NOAUTH Authentication required`

**Solution**:

- Enable AUTH on Redis instance
- Set `REDIS_AUTH_STRING` environment variable
- Get auth string: `gcloud redis instances get-auth-string tradebook-redis --region=us-central1`

### High Latency

**Issue**: Slow Redis responses

**Solutions**:

- Deploy Redis instance in the same region as your application
- Use Standard tier for better performance
- Check network connectivity and VPC configuration

### Fallback to In-Memory Cache

**Issue**: Application uses in-memory cache instead of Redis

**Solutions**:

- Check `REDIS_HOST` and `REDIS_PORT` are set correctly
- Verify Redis instance is accessible from your application
- Check application logs for Redis connection errors
- Ensure VPC connector is properly configured

## Monitoring

### View Redis Metrics

1. Go to [Memorystore Monitoring](https://console.cloud.google.com/memorystore/redis/instances)
2. Select your instance
3. View metrics:
   - Connections
   - Memory usage
   - Commands per second
   - Cache hit ratio

### Set Up Alerts

Create alerts for:

- High memory usage (>80%)
- Connection count limits
- Error rates
- Latency spikes

## Cost Optimization

- **Basic Tier**: Suitable for development (~$30/month for 1GB)
- **Standard Tier**: Production with HA (~$60/month for 1GB)
- Monitor memory usage and scale down if needed
- Use appropriate instance size for your workload

## Security Best Practices

1. **Enable AUTH**: Always enable authentication in production
2. **VPC Network**: Keep Redis in private VPC, not public
3. **IAM**: Use least-privilege IAM roles
4. **Secrets**: Store `REDIS_AUTH_STRING` in Secret Manager
5. **Network Policies**: Restrict access to Redis port (6379) from authorized sources only

## Cleanup

To delete the Redis instance:

```bash
gcloud redis instances delete tradebook-redis --region=us-central1
```

**Warning**: This will permanently delete all cached data.

## Additional Resources

- [Memorystore for Redis Documentation](https://cloud.google.com/memorystore/docs/redis)
- [VPC Connector Documentation](https://cloud.google.com/vpc/docs/configure-serverless-vpc-access)
- [ioredis Documentation](https://github.com/redis/ioredis)
