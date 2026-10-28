# Tiingo endpoints — what we call, what we cannot, and how to re-check

MONEY-980. Every status and byte count below was **measured against our live
token on 2026-08-28**, not read off a page. Where a measurement contradicts the
documentation, the measurement is what the code implements and the contradiction
is called out.

## In use

| Endpoint                                                              | Auth     | Notes                                                                                                           |
| --------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `https://apimedia.tiingo.com/docs/tiingo/daily/supported_tickers.zip` | **none** | Security master. 798,715 B zipped → 5,017,961 B CSV, 108,489 rows. Verified 200 with no `Authorization` header. |
| `https://api.tiingo.com/tiingo/daily/<ticker>`                        | Token    | Metadata: `ticker,name,description,startDate,endDate,exchangeCode`.                                             |
| `https://api.tiingo.com/tiingo/daily/<ticker>/prices`                 | Token    | EOD bars. Params `startDate`, `endDate`, `format=csv`, `columns=`.                                              |

Auth is `Authorization: Token <key>` — the scheme word is **`Token`**, not
`Bearer`. `?token=` also works.

### Three things the docs get wrong about `/prices`

1. **The CSV column order is not the documented one.** Live header is
   `date,close,high,low,open,volume,adjClose,adjHigh,adjLow,adjOpen,adjVolume,divCash,splitFactor`
   — `close` **second**, `open` **fifth**. A positional parser written from the
   docs silently swaps open and close: no error, correct row count, wrong candle
   for every US security. Parse by header **name**.
2. **`columns` works but is undocumented for this endpoint**, and it is
   load-bearing rather than an optimisation. AAPL's full 11,517-bar history:
   820,616 B as `csv+columns`, 1,591,394 B as full CSV, 2,918,110 B as JSON —
   and 2.4s versus 17.8s. Against a metered monthly allowance that is the
   difference between ~10 GB and ~35 GB for one backfill.
3. **There is no observed range cap.** One request returns a symbol's entire
   history, which is what makes the backfill ~73k requests rather than one per
   symbol-year.

## Corporate actions — BETA ACCESS GRANTED (re-probed 2026-08-28, later)

All five now answer **200**. The 403s recorded earlier in this file were beta
gating, and the beta is now open to us.

| Endpoint                                                                   | Status                               |
| -------------------------------------------------------------------------- | ------------------------------------ |
| `/tiingo/corporate-actions/<ticker>/splits`                                | 200                                  |
| `/tiingo/corporate-actions/<ticker>/distributions?startExDate=&endExDate=` | 200                                  |
| `/tiingo/corporate-actions/splits?exDate=`                                 | 200 — 54 rows across a 5-date sample |
| `/tiingo/corporate-actions/distributions?exDate=`                          | 200 — 387 rows for one day           |
| `/tiingo/corporate-actions/<ticker>/distribution-yield`                    | 200 — 731 KB for AAPL                |

### `splitStatus` DOES NOT EXIST, and that voids the reason to switch leg (c)

The documented field list includes `splitStatus` (`"a"` active / `"c"`
cancelled), and that field was the entire argument for moving leg (c) off the
derived path: a cancelled split applied as real mis-adjusts a whole series, and
`splitFactor` alone cannot express a cancellation.

**It is not in the live response.** Measured across 54 split rows from five
different ex-dates, the key union is exactly:

```
exDate, permaTicker, splitFactor, splitFrom, splitTo, ticker
```

So the endpoint offers no cancellation signal either. Leg (c) stays on the
derived path, which costs zero extra requests and cannot drift from the prices
because it _is_ the prices.

### `permaTicker` cannot replace `listingId` — it is missing exactly where needed

`permaTicker` is real (`US000000000038` for AAPL) and **prices can be queried by
it** (`/tiingo/daily/US000000000038/prices` → 200 with real bars). But:

- It is **absent from the metadata endpoint** — the key set is still
  `ticker,name,description,startDate,endDate,exchangeCode` — and absent from
  `supported_tickers.zip`.
- `/tiingo/daily/<permaTicker>` (metadata by permaTicker) **404s**.
- It is therefore obtainable ONLY from a corporate-actions response, which
  exists only for securities that have had a split or distribution.

Measured, and this is the decisive part: **`DOW` and `BRKL` both return ZERO
split rows, so no permaTicker can be obtained for either** — the two recycled
tickers that motivated the `listingId` design in the first place. The identifier
that would fix ticker recycling is unavailable precisely for the securities that
need fixing.

`Candle.listingId` and the fetch-time recycle guard stay. `permaTicker` is worth
storing opportunistically where a corporate-actions row supplies one, but it
cannot be the key.

### What the endpoints DO add

Genuinely new information the derived path cannot produce, because it is not in
the price bars at all:

- **Dividend metadata** — `paymentDate`, `recordDate`, `declarationDate`,
  `distributionFrequency` (`w, bm, m, tm, q, sa, a, ir, f, u, c`). The bar only
  carries `divCash` on the ex-date.
- **Split ratios** — `splitFrom` / `splitTo` (e.g. `7.0 -> 1.0`), populated on
  5/5 recent rows though NULL on AAPL's historical splits. The bar carries only
  the derived `splitFactor`.
- **A date-batch form** — one request returns a whole day across the market.

That serves the "Dividend tracking" roadmap item as a NEW capability, not as a
replacement for anything in MONEY-980.

## 403 means two different things

A status code alone cannot classify a Tiingo failure:

- **403 with `{"detail":"Invalid token."}`** — the token is rejected.
- **403 with a ZERO-byte body and no content-type** — the endpoint is not
  entitled.
- **401** is never sent.
- **429** is undocumented and we have not triggered one. It may also be a 403.

`tiingo-client.ts` cannot read the body, because `fetchExchangeAsset` throws
before the caller sees the `Response`. So its operator message names **both**
checks rather than asserting one — a client that guesses here sends the operator
to verify the wrong thing.

## Re-probe

Run after any plan or entitlement change.

```bash
#!/bin/bash
TK="${TIINGO_API_KEY:?set TIINGO_API_KEY}"
H="Authorization: Token $TK"
p() { printf "%-62s -> " "$2"
      curl -sS -o /tmp/tg -w "%{http_code}" -H "$H" "$1"
      printf "  bytes=%s  " "$(wc -c </tmp/tg | tr -d ' ')"
      head -c 90 /tmp/tg | tr '\n' ' '; echo; }

echo "== should already work =="
p "https://api.tiingo.com/tiingo/daily/AAPL" "metadata (permaTicker present?)"
p "https://api.tiingo.com/tiingo/daily/AAPL/prices?startDate=2026-08-20&format=csv" "EOD csv"

echo "== the entitlement question =="
p "https://api.tiingo.com/tiingo/corporate-actions/AAPL/splits" "splits per-ticker"
p "https://api.tiingo.com/tiingo/corporate-actions/AAPL/distributions?startExDate=2024-01-01&endExDate=2025-01-01" "distributions per-ticker"
p "https://api.tiingo.com/tiingo/corporate-actions/splits?exDate=2026-08-26" "splits date-batch"
p "https://api.tiingo.com/tiingo/corporate-actions/distributions?exDate=2026-08-26" "distributions date-batch"
```

**Reading it.** `403` + `bytes=0` = not entitled. `403` + a `detail` body = token
problem. Any `200` on a corporate-actions line means **leg (c) of `us-eod-sync`
should switch off the derived path** (MONEY-1262): the real endpoint carries
`splitStatus`, where a cancelled split is `"c"`, and applying a cancelled split
as real mis-adjusts an entire series. A bar's `splitFactor` column cannot
express a cancellation — the row looks like an ordinary split.

## Documentation links

The docs are a **JS-rendered SPA**; a raw `curl` of any of these returns an empty
shell, so a 200 from the command line proves nothing about a section's contents.

| Topic                                           | Page                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| EOD prices + metadata + `supported_tickers.zip` | <https://www.tiingo.com/documentation/end-of-day>                  |
| Splits                                          | <https://www.tiingo.com/documentation/corporate-actions/splits>    |
| Dividends / distributions                       | <https://www.tiingo.com/documentation/corporate-actions/dividends> |
| Auth                                            | <https://www.tiingo.com/documentation/general/connecting>          |
| Rate-limit metrics                              | <https://www.tiingo.com/documentation/general/overview>            |
| Symbology (dashes, share classes, recycling)    | <https://www.tiingo.com/documentation/appendix/symbology>          |
| Changelog                                       | <https://www.tiingo.com/documentation/general/changelog>           |
| Pricing / plan tiers                            | <https://www.tiingo.com/pricing>                                   |
| Docs index                                      | <https://www.tiingo.com/documentation/>                            |

## Symbology, and why a ticker is not a security

Dashes, never periods: `BRK-A`, `SPG-P-J` (preferred is
`{SYMBOL}-P-{CLASS}`). Measured anomalies the parser must survive: 13 tickers
in the master **do** contain a period despite the stated rule, and one begins
with a dash (`-P-HIZ`).

Tiingo supports "delisted data for tickers that have **not yet been recycled**",
and recycling is common: 2,196 tickers repeat in the master, 928 across
exchanges, 244 across `assetType`. `DOW` on NYSE is Dow Chemical (1972–2017)
**and** Dow Inc. (2019–), identical in exchange, assetType and currency. Asked
for `DOW` since 1962, the API returns 2019 onward — the current occupant only.
Hence `Candle.listingId` and the fetch-time recycle guard. `permaTicker` would
replace both.
