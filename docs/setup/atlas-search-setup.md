# MongoDB Atlas Production Setup Guide

Complete guide for indexes required on MongoDB Atlas in production. Prisma
`@@index` directives auto-create standard indexes on `prisma db push`. This doc
covers **Atlas-only indexes** that must be created manually via the Atlas UI.

## Prerequisites

- MongoDB Atlas cluster (M10+ recommended for dedicated search nodes)
- Production database: `stockbook`
- Environment variable: `MONGODB_VECTOR_SEARCH_ENABLED=true` (for RAG vector
  search)

---

## Part 1: Atlas Search Indexes

These power the instrument/MF autocomplete search. Created in **Atlas UI → Atlas
Search tab**.

### Step 1: Instrument Search Index

1. Go to **MongoDB Atlas** → Your Cluster → **Atlas Search** tab
2. Click **Create Search Index**
3. Select **JSON Editor**
4. Choose database: `stockbook`, collection: `instrument_mappings`
5. Index name: `instrument_search`
6. Paste this definition:

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "symbol": [
        {
          "type": "autocomplete",
          "tokenization": "edgeGram",
          "minGrams": 2,
          "maxGrams": 15
        },
        {
          "type": "string",
          "analyzer": "lucene.keyword"
        }
      ],
      "name": [
        {
          "type": "autocomplete",
          "tokenization": "edgeGram",
          "minGrams": 2,
          "maxGrams": 30
        },
        {
          "type": "string",
          "analyzer": "lucene.standard"
        }
      ],
      "sector": [
        {
          "type": "autocomplete",
          "tokenization": "edgeGram",
          "minGrams": 2,
          "maxGrams": 30
        },
        {
          "type": "string",
          "analyzer": "lucene.standard"
        }
      ],
      "exchange": {
        "type": "token"
      },
      "instrumentType": {
        "type": "token"
      },
      "isActive": {
        "type": "boolean"
      }
    }
  }
}
```

7. Click **Create Search Index**

### Step 2: Mutual Fund Search Index

1. Same steps as above, but:
   - Collection: `mutual_fund_masters`
   - Index name: `mf_search`
2. Paste this definition:

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "schemeName": [
        {
          "type": "autocomplete",
          "tokenization": "edgeGram",
          "minGrams": 2,
          "maxGrams": 50
        },
        {
          "type": "string",
          "analyzer": "lucene.standard"
        }
      ],
      "amcName": [
        {
          "type": "autocomplete",
          "tokenization": "edgeGram",
          "minGrams": 2,
          "maxGrams": 30
        },
        {
          "type": "string",
          "analyzer": "lucene.standard"
        }
      ],
      "schemeCode": {
        "type": "string",
        "analyzer": "lucene.keyword"
      },
      "category": [
        {
          "type": "string",
          "analyzer": "lucene.standard"
        },
        {
          "type": "token"
        }
      ],
      "isActive": {
        "type": "boolean"
      }
    }
  }
}
```

3. Click **Create Search Index**

### Step 2b: US Instrument Search Index (MONEY-980)

Collection: **`us_instruments`** · Index name: **`us_instrument_search`**

A SECOND index, not a widening of `instrument_search`. US listings live in their
own collection because `instrument_mappings` is unique on `yahooSymbol` — one
row per ticker — which cannot hold the 2,196 repeated US tickers, and because 37
India-facing readers carry no venue clause. The search index follows the
collection.

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "symbol": [
        {
          "type": "autocomplete",
          "tokenization": "edgeGram",
          "minGrams": 1,
          "maxGrams": 15
        },
        {
          "type": "string",
          "analyzer": "lucene.keyword"
        }
      ],
      "name": [
        {
          "type": "autocomplete",
          "tokenization": "edgeGram",
          "minGrams": 2,
          "maxGrams": 30
        },
        {
          "type": "string",
          "analyzer": "lucene.standard"
        }
      ],
      "exchange": {
        "type": "token"
      },
      "assetType": {
        "type": "token"
      },
      "listingStatus": {
        "type": "token"
      }
    }
  }
}
```

Four things here differ from `instrument_search`, each for a measured reason:

- **`minGrams: 1` on `symbol`**, not 2. US tickers go down to one character —
  `F` (Ford), `T` (AT&T), `V` (Visa). With `minGrams: 2` those are unreachable
  by prefix and the failure is silent: the query runs, returns nothing, and
  looks like "no such ticker".
- **`listingStatus` is mapped, and mapped as a `token`.** It is what lets a
  delisted result be filtered and badged rather than hidden. Token fields answer
  `in` / `equals` and **silently match nothing under `text`** — that is
  MONEY-1128, and it fails without an error, so a query written against this
  field must use `equals`.
- **No `isActive`.** This collection has no such field; a delisted listing is
  `listingStatus: "DELISTED"`, and it is deliberately RETAINED rather than
  deactivated. Mapping a field that does not exist would make every filter on it
  return zero.
- **`name` is nullable here**, unlike India. `supported_tickers.zip` carries no
  company name, so `name` is filled by a separate paced leg reading
  `/tiingo/daily/<ticker>`. Rows the leg has not reached yet are searchable by
  symbol only — rank them last rather than treating a null name as a match.

`dynamic: false` means an unmapped field is invisible to search. Adding one to
the schema is not enough; this definition has to change too, in the Atlas UI,
which is why it is written down here rather than left to `prisma db push`.

**Until this index exists, US search still works.** `apps/web/lib/market/
us-instrument-search.ts` runs the same Atlas-then-Prisma ladder the India path
uses: the shared gate (`@usemoney/core/search/atlas-gate`) latches
`us_instrument_search` on an "index not found", and every subsequent query goes
to a Prisma `startsWith` / `contains` pass over `us_instruments`. That is also
what QA and local get permanently — neither has Atlas Search — so a US path
that only worked on Atlas would be a path nothing but production could ever
exercise. Creating the index is a performance and relevance upgrade, not the
switch that turns the feature on.

The fallback is deliberately TWO queries (symbol, then name) rather than one
`$or`: `UsInstrument` indexes `[symbol, exchange]` but not `name`, and Mongo
only index-serves an `$or` when every branch has an index — a combined `$or`
would drag the cheap symbol prefix down into the collection scan with it.

### Step 3: Content Search Index

Powers full-text search across blog posts, glossary terms, newsletters, and
docs.

1. Same steps as above, but:
   - Collection: `content_posts`
   - Index name: `content_search`
2. Paste this definition:

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "title": [
        {
          "type": "autocomplete",
          "tokenization": "edgeGram",
          "minGrams": 2,
          "maxGrams": 30
        },
        {
          "type": "string",
          "analyzer": "lucene.standard"
        }
      ],
      "content": {
        "type": "string",
        "analyzer": "lucene.standard"
      },
      "excerpt": {
        "type": "string",
        "analyzer": "lucene.standard"
      },
      "contentType": {
        "type": "token"
      },
      "contentPlatform": {
        "type": "token"
      },
      "status": {
        "type": "token"
      }
    }
  }
}
```

3. Click **Create Search Index**

---

## Part 2: Atlas Vector Search Index

Required for the RAG pipeline (AI chat context retrieval). Created in **Atlas UI
→ Atlas Search tab → Vector Search**.

### Step 4: Document Embeddings Vector Index

1. Go to **Atlas Search** tab → **Create Search Index**
2. Select **Atlas Vector Search** (not regular Search)
3. Choose database: `stockbook`, collection: `document_embeddings`
4. Index name: `document_embeddings_vector_index`
5. Paste this definition:

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 768,
      "similarity": "cosine"
    },
    {
      "type": "filter",
      "path": "userId"
    },
    {
      "type": "filter",
      "path": "docType"
    }
  ]
}
```

6. Click **Create Search Index**

**Environment variable:** Set `MONGODB_VECTOR_SEARCH_ENABLED=true` in production
to use native `$vectorSearch`. Without this, the app falls back to
application-level cosine similarity (slower but functional).

---

## Part 3: Recommended Compound Indexes

Prisma auto-creates the indexes defined via `@@index` in the schema. However,
the following indexes are **not in the Prisma schema** and should be created
manually in Atlas for production query performance.

### Step 5: Create via mongosh or Atlas UI

Connect to the Atlas cluster via `mongosh` and run:

```javascript
// ─── Holding: sector-based portfolio filtering ───
// Used by: getHoldingsAction({ sector: "IT" }), holdings page sector filter
// Without this, sector queries scan all user holdings
db.Holding.createIndex(
  { userId: 1, sector: 1 },
  { name: "userId_sector", background: true },
);

// ─── Trade: groupBy symbol within broker ───
// Used by: trade import duplicate detection (groupBy symbol with userId + broker filter)
// Existing indexes cover userId+broker but not the triple compound
db.Trade.createIndex(
  { userId: 1, broker: 1, symbol: 1 },
  { name: "userId_broker_symbol", background: true },
);

// ─── Holding: exchange-based filtering ───
// Used by: holdings view when filtering by NSE/BSE exchange
db.Holding.createIndex(
  { userId: 1, exchange: 1 },
  { name: "userId_exchange", background: true },
);

// ─── TokenUsage: cost breakdown by model + date range ───
// Used by: getUsageByModel(), getDailyUsage() in cost-tracker.ts
// Existing userId+createdAt index covers basic date queries;
// this adds model breakdown without full collection scan
db.TokenUsage.createIndex(
  { userId: 1, modelName: 1, createdAt: -1 },
  { name: "userId_model_createdAt", background: true },
);

// ─── UserDocument: source type filtering ───
// Used by: getDocumentsAction({ sourceType: "UPLOAD" })
db.UserDocument.createIndex(
  { userId: 1, sourceType: 1, isDeleted: 1 },
  { name: "userId_sourceType_isDeleted", background: true },
);
```

### Index Priority Reference

| Collection     | Index                               | Query Pattern                                     | Priority   |
| -------------- | ----------------------------------- | ------------------------------------------------- | ---------- |
| `Holding`      | `{ userId, sector }`                | Sector allocation, sector filter on holdings page | **High**   |
| `Trade`        | `{ userId, broker, symbol }`        | Trade import groupBy, duplicate detection         | **Medium** |
| `Holding`      | `{ userId, exchange }`              | Exchange filter (NSE/BSE toggle)                  | **Medium** |
| `TokenUsage`   | `{ userId, modelName, createdAt }`  | Cost breakdown by model                           | **Low**    |
| `UserDocument` | `{ userId, sourceType, isDeleted }` | Filter documents by source type                   | **Low**    |

---

## Part 4: Verify All Indexes

### Search Indexes

After creation, search indexes take 1-5 minutes to build.

**Check status:**

- Atlas UI: Search tab → all indexes should show **Active** status
- Or via `mongosh`:

```javascript
// Test instrument search
db.instrument_mappings.aggregate([
  {
    $search: {
      index: "instrument_search",
      text: { query: "RELIANCE", path: "symbol" },
    },
  },
  { $limit: 3 },
  {
    $project: {
      symbol: 1,
      name: 1,
      exchange: 1,
      score: { $meta: "searchScore" },
    },
  },
]);

// Test vector search
db.document_embeddings.aggregate([
  {
    $vectorSearch: {
      index: "document_embeddings_vector_index",
      path: "embedding",
      queryVector: new Array(768).fill(0.1), // dummy vector
      numCandidates: 10,
      limit: 3,
    },
  },
  {
    $project: {
      docType: 1,
      content: { $substr: ["$content", 0, 50] },
      score: { $meta: "vectorSearchScore" },
    },
  },
]);
```

### Compound Indexes

```javascript
// Verify compound indexes were created
db.Holding.getIndexes().filter((i) => i.name.includes("sector"));
db.Trade.getIndexes().filter((i) => i.name.includes("broker_symbol"));
db.TokenUsage.getIndexes().filter((i) => i.name.includes("model"));
```

### Test from the App

Once indexes are active, the search API automatically uses Atlas Search:

```
GET /api/market/search?q=reliance&limit=10
```

Response will include `"source": "atlas"` when Atlas Search is being used.

The autocomplete endpoint is also available:

```
GET /api/market/autocomplete?q=rel&limit=5
```

---

## How Fallback Works

The code gracefully handles environments without Atlas-specific indexes:

| Feature              | Production (Atlas)                    | QA / Local (DigitalOcean)                       |
| -------------------- | ------------------------------------- | ----------------------------------------------- |
| **Text Search**      | Atlas Search (`$search` aggregation)  | Prisma `contains` (regex fallback)              |
| **Content Search**   | Atlas Search (`content_search`)       | Prisma `contains` (regex fallback)              |
| **News Feed Search** | Atlas Search (`news_search`)          | Prisma `contains` (regex fallback)              |
| **User Search**      | Atlas Search (`user_search`)          | Prisma `contains` (regex fallback)              |
| **US Instruments**   | Atlas Search (`us_instrument_search`) | Prisma `startsWith`/`contains` (regex fallback) |
| **Vector Search**    | Native `$vectorSearch`                | Application-level cosine similarity             |
| **Compound Indexes** | Manual + Prisma auto                  | Prisma auto only                                |
| **DB Down**          | N/A                                   | Yahoo Finance + hardcoded mappings              |

When Atlas Search indexes are not found, the `$search` command throws an error
that is caught, and the code falls back to the existing `contains`-based search.
No configuration needed - it's automatic.

---

## Index Field Reference

### instrument_search (Atlas Search)

| Field            | Type                    | Purpose                                        |
| ---------------- | ----------------------- | ---------------------------------------------- |
| `symbol`         | autocomplete + keyword  | Prefix search ("REL" → RELIANCE) + exact match |
| `name`           | autocomplete + standard | Prefix search on company names                 |
| `sector`         | autocomplete + standard | Prefix search + full-text sector search        |
| `exchange`       | token                   | Faceted filtering (NSE/BSE)                    |
| `instrumentType` | token                   | Faceted filtering (EQUITY/ETF/INDEX)           |
| `isActive`       | boolean                 | Filter out deactivated instruments             |

### us_instrument_search (Atlas Search)

| Field           | Type                    | Notes                                               |
| --------------- | ----------------------- | --------------------------------------------------- |
| `symbol`        | autocomplete + keyword  | `minGrams: 1` — US has 1-char tickers (F, T, V)     |
| `name`          | autocomplete + standard | NULLABLE until the Tiingo name leg reaches the row  |
| `exchange`      | token                   | NASDAQ, NYSE, AMEX, NYSE ARCA, BATS, NMFQS, …       |
| `assetType`     | token                   | Stock, ETF, Mutual Fund — VERBATIM casing           |
| `listingStatus` | token                   | ACTIVE, DELISTED — `in`/`equals` only, never `text` |

Queried by `apps/web/lib/market/us-instrument-search.ts`, which is in the
`QUERY_BUILDERS` list of
`apps/web/__tests__/market/atlas-filter-operators.test.ts` — that test parses
the tables above and fails the build if any `token` field here is ever queried
with `text`.

The `symbol` and `name` rows previously read `autocomplete + token` and
`autocomplete + text`, contradicting this section's own JSON (which maps them
`lucene.keyword` and `lucene.standard`). Corrected, because that table is not
prose: the operator guard reads it, and calling an analysed string field a
`token` would make it reject the one operator that is correct for it.

### mf_search (Atlas Search)

| Field        | Type                    | Purpose                              |
| ------------ | ----------------------- | ------------------------------------ |
| `schemeName` | autocomplete + standard | Prefix search on fund names          |
| `amcName`    | autocomplete + standard | Prefix search + full-text AMC search |
| `schemeCode` | keyword                 | Exact AMFI code lookup               |
| `category`   | string + token          | Full-text search + faceted filtering |
| `isActive`   | boolean                 | Filter out deactivated funds         |

### content_search (Atlas Search)

| Field             | Type                    | Purpose                                       |
| ----------------- | ----------------------- | --------------------------------------------- |
| `title`           | autocomplete + standard | Prefix search + full-text on post titles      |
| `content`         | string (standard)       | Full-text search on post body content         |
| `excerpt`         | string (standard)       | Full-text search on post excerpts             |
| `contentType`     | token                   | Filter by BLOG / GLOSSARY / NEWSLETTER / DOCS |
| `contentPlatform` | token                   | Filter by platform (STOCKBOOK)                |
| `status`          | token                   | Filter by status (PUBLISHED)                  |

### user_search (Atlas Search)

| Field      | Type                    | Purpose                                      |
| ---------- | ----------------------- | -------------------------------------------- |
| `email`    | autocomplete + keyword  | Prefix search on emails + exact-match lookup |
| `name`     | autocomplete + standard | Prefix + full-text search on user names      |
| `isActive` | boolean                 | Filter out soft-deleted (inactive) users     |

### document_embeddings_vector_index (Vector Search)

| Field       | Type                      | Purpose                                          |
| ----------- | ------------------------- | ------------------------------------------------ |
| `embedding` | vector (768 dims, cosine) | Semantic similarity search for RAG               |
| `userId`    | filter                    | Scope vector search to a single user             |
| `docType`   | filter                    | Filter by document type (holdings, trades, etc.) |

---

## Part 5: Stock Ratios Search Index (Screener)

For the in-house screener engine to efficiently filter stocks by ratios.

1. Collection: `stock_ratios`
2. Index name: `stock_ratios_screener`
3. Definition:

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "symbol": { "type": "string", "analyzer": "lucene.keyword" },
      "exchange": { "type": "string", "analyzer": "lucene.keyword" },
      "pe": { "type": "number" },
      "pb": { "type": "number" },
      "roe": { "type": "number" },
      "roce": { "type": "number" },
      "marketCap": { "type": "number" },
      "dividendYield": { "type": "number" },
      "debtToEquity": { "type": "number" },
      "revenueGrowth": { "type": "number" },
      "earningsGrowth": { "type": "number" },
      "operatingMargin": { "type": "number" },
      "netMargin": { "type": "number" },
      "beta": { "type": "number" },
      "currentRatio": { "type": "number" },
      "pegRatio": { "type": "number" },
      "targetPrice": { "type": "number" }
    }
  }
}
```

## Part 6: Stock News Search Index

For searching news articles by stock symbol and full-text content.

1. Collection: `stock_news`
2. Index name: `stock_news_search`
3. Definition:

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "symbol": { "type": "string", "analyzer": "lucene.keyword" },
      "title": {
        "type": "string",
        "analyzer": "lucene.standard"
      },
      "snippet": {
        "type": "string",
        "analyzer": "lucene.standard"
      },
      "source": { "type": "string", "analyzer": "lucene.keyword" },
      "sentiment": { "type": "string", "analyzer": "lucene.keyword" },
      "pubDate": { "type": "date" }
    }
  }
}
```

## Part 7: Stock Financials Index

For querying financials by symbol, period, and statement type.

1. Collection: `stock_financials`
2. Index name: `stock_financials_search`
3. Definition:

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "symbol": { "type": "string", "analyzer": "lucene.keyword" },
      "exchange": { "type": "string", "analyzer": "lucene.keyword" },
      "statementType": { "type": "string", "analyzer": "lucene.keyword" },
      "periodType": { "type": "string", "analyzer": "lucene.keyword" },
      "period": { "type": "string", "analyzer": "lucene.keyword" },
      "revenue": { "type": "number" },
      "netIncome": { "type": "number" },
      "ebitda": { "type": "number" }
    }
  }
}
```

## Part 8: News Article Search Index

For full-text search across the RSS news feed (MONEY-408), used by the news
filter chip in the news page. Distinct from Part 6 — Part 6's `stock_news`
collection holds Tickertape/Screener stock-tagged news; this index covers the
RSS-ingested feed in `news_articles`. `stringFacet` is used for `symbols` and
`sectors` (instead of `token`) so the filter chip can use `$searchMeta` facet
counts on the multi-value arrays.

1. Collection: `news_articles`
2. Index name: `news_search`
3. Definition:

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "title": { "type": "string", "analyzer": "lucene.english" },
      "summary": { "type": "string", "analyzer": "lucene.english" },
      "symbols": { "type": "stringFacet" },
      "sectors": { "type": "stringFacet" },
      "publishedAt": { "type": "date" }
    }
  }
}
```

## Part 9: User Search Index

Powers the Individual-Emails people-picker in the content CMS
(`searchUsersForIndividualSend`). Lets admins fuzzy/autocomplete-search ANY app
user by email or name when composing an individual send. In PROD the
`searchUsersAtlas` helper uses this `$search` index; on QA/dev (DigitalOcean,
no `$search`) it returns null and the action falls back to the Prisma
`contains` (regex) query.

1. Collection: `User`
2. Index name: `user_search`
3. Definition:

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "email": [
        {
          "type": "autocomplete",
          "tokenization": "edgeGram",
          "minGrams": 2,
          "maxGrams": 30
        },
        {
          "type": "string",
          "analyzer": "lucene.keyword"
        }
      ],
      "name": [
        {
          "type": "autocomplete",
          "tokenization": "edgeGram",
          "minGrams": 2,
          "maxGrams": 30
        },
        {
          "type": "string",
          "analyzer": "lucene.standard"
        }
      ],
      "isActive": {
        "type": "boolean"
      }
    }
  }
}
```

---

## Capabilities Enabled

- **Fuzzy matching**: "RELIANSE" finds "RELIANCE" (maxEdits: 1)
- **Relevance scoring**: Exact symbol matches rank highest
- **Autocomplete**: "rel" instantly suggests RELIANCE, RELAXO, etc.
- **Type filtering**: Search only EQUITY, ETF, MF, or INDEX
- **Exchange filtering**: Limit to NSE or BSE
- **Content search**: Full-text search across blog, glossary, newsletter, docs
- **RAG vector search**: Semantic retrieval of user portfolio/trade data for AI
  chat
- **Sector allocation queries**: Fast sector-based filtering without collection
  scan
- **Screener search**: Filter stocks by 15+ ratio fields with range queries
- **Stock news search**: Full-text search across stock-tagged news (Tickertape/
  Screener) with sentiment filtering
- **News feed search**: Full-text search across the RSS news feed with
  symbol/sector facet counts via `$searchMeta`
- **Financial search**: Query by symbol, period, statement type with numeric
  ranges
- **< 50ms latency**: Same-cluster execution, no external API calls
