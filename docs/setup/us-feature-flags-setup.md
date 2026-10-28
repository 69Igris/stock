# US Feature Flags - PostHog Setup

## Overview

US/International features are gated behind PostHog feature flags. These flags
are separate from the page-visibility flags and control cross-cutting features.

## Flags to Create in PostHog Dashboard

Go to [PostHog > Feature Flags](https://us.posthog.com/feature_flags) and create
these 5 flags:

### 1. `us-stocks-listing`

- **Description**: Show US stocks (NASDAQ/NYSE/AMEX) in the Discover page
- **Match conditions**: Person property `email` equals `deepshaswat@gmail.com`
- **Rollout**: 100% for matching users

### 2. `us-stocks-search`

- **Description**: Show US stocks in search results (command palette,
  autocomplete, `/api/market/search`)
- **Match conditions**: Person property `email` equals `deepshaswat@gmail.com`
- **Rollout**: 100% for matching users

### 3. `us-broker-ib`

- **Description**: Show Interactive Brokers as a broker option on the Brokers
  page
- **Match conditions**: Person property `email` equals `deepshaswat@gmail.com`
- **Rollout**: 100% for matching users

### 4. `global-mf`

- **Description**: Enable global mutual fund features (cross-border comparison,
  international fund search)
- **Match conditions**: Person property `email` equals `deepshaswat@gmail.com`
- **Rollout**: 100% for matching users

### 5. `us-stock-research`

- **Description**: Allow US stock research queries in the AI agent (e.g.,
  "Analyze AAPL")
- **Match conditions**: Person property `email` equals `deepshaswat@gmail.com`
- **Rollout**: 100% for matching users

## How to Set Up Each Flag

1. Click **New feature flag**
2. Set **Key** to the flag name (e.g., `us-stocks-listing`)
3. Under **Release conditions**:
   - Click **Add condition**
   - Select **Person properties**
   - Property: `email`
   - Operator: `equals`
   - Value: `deepshaswat@gmail.com`
4. Set **Rollout percentage** to `100%`
5. Click **Save**

## How Flags Are Used in Code

| Flag                | Where Used                             | Effect When OFF                                     |
| ------------------- | -------------------------------------- | --------------------------------------------------- |
| `us-stocks-listing` | Discover page                          | US stocks hidden from listings                      |
| `us-stocks-search`  | `/api/market/search`, Command Palette  | US stocks filtered from search results              |
| `us-broker-ib`      | Broker config (`featureFlagRequired`)  | Interactive Brokers hidden from broker list         |
| `global-mf`         | MF comparison pages, global fund tools | Global MF features hidden                           |
| `us-stock-research` | Research agent                         | US stock queries rejected with "Indian stocks only" |

## Client Hook

```tsx
import { useUsFeatureFlags } from "@/lib/hooks/useUsFeatureFlags";

function MyComponent() {
  const { flags, isLoading } = useUsFeatureFlags();

  if (flags["us-stocks-listing"]) {
    // Show US stock content
  }
}
```

## Server Action

```tsx
import { getUsFeatureFlags } from "@/lib/actions/feature-flags";

const { flags } = await getUsFeatureFlags();
if (flags["us-broker-ib"]) {
  // Include IB in broker list
}
```

## Rolling Out to More Users

To enable for all users:

1. Go to the flag in PostHog
2. Change release conditions to **100% of all users** (remove the email filter)
3. Save - cache clears automatically within 5 minutes

## Caching

US feature flags share the same 3-layer cache as page-visibility flags:

- Client: localStorage (5min TTL)
- Server: Redis (5min TTL)
- Fallback: in-memory Map (5min TTL)

Clear cache: `GET /api/debug/clear-ff-cache`
