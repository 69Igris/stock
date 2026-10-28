# India intraday — what it would take, and why it is not on

**Status: NOT ACTIVATED. Do not activate Kite Connect to make it so.**
MONEY-1470 (data-platform A5).

India intraday charts are served today, from the 5-minute bars
`intraday-sync` already fetches. What is _not_ served, and cannot be from the
feeds we have, is **1-minute**. This document is the arithmetic behind that,
so the next person to look does not re-derive it — or, worse, switch on a paid
realtime connector to fix a problem that a paid realtime connector is not the
cheapest answer to.

---

## What is live

| Piece                                      | State                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `ib:IN:{SYMBOL}:{EXCHANGE}:5m` ring buffer | **written**, by `backfillIntradayBars` on every `intraday-sync` run   |
| `/udf/history` at resolution 5 / 15 / 60   | **served**, rolled up from the 5m base                                |
| `/udf/history` at resolution 1             | **refused by name**, with the reason and the alternatives             |
| Entitlement                                | `MARKET_DATA_INTRADAY` (PlatformConfig), per-tier, default **nobody** |

The buffer holds `BUFFER_SESSIONS = 45` sessions × `MINUTES_PER_SESSION.IN = 375`
minutes. That is the _capacity_; at a 5-minute base it is 45 sessions with room
to spare, and it is sized in minutes so the same constant survives a 1m base
arriving later.

---

## Why the base is 5m and not 1m

Not a preference — a **retention** fact about the feed we have.

| Interval | Yahoo retention | 45 sessions needs  |
| -------- | --------------- | ------------------ |
| 1m       | **7 days**      | ~45 trading days   |
| 5m       | 60 days         | ~45 trading days ✓ |
| 15m      | 60 days         | ✓                  |
| 60m      | 730 days        | ✓                  |

A 45-session 1-minute India buffer **cannot be filled from Yahoo**. Backfilling
it would reach seven days and then stop, and the chart would show a 1-minute
series that silently ends a week ago — which renders as a chart, not as an
error.

`intraday-sync`'s own header has said this since MONEY-123: _"Yahoo's retention
(60 days for 5m/15m/30m, 7 days for 1m, 730 days for 60m) is enough for our
90-day rolling window except for 1m."_

---

## Why a wider bar cannot become a narrower one

`rollUp` **refuses** a target narrower than the base
(`IntervalNotDerivableError`). This is worth stating because the first cut of
that function did the opposite, silently: asked for `1m` it returned its input
unchanged, so a 5-minute India buffer answered a 1-minute request with
**five-minute bars labelled as one-minute**. Every one of them plots at a real
minute, with an OHLC describing four minutes it does not claim, and nothing
downstream can detect it.

Rolling **up** aggregates bars that happened. Rolling **down** invents prices
that never traded.

---

## What activating Kite Connect would buy, and what it would cost

Kite Connect's historical endpoint serves genuine 1-minute candles with real
volume — which would make `BASE_INTERVAL.IN = "1m"` true and give India the
same shape as US.

**It is not switched on, and this is a founder decision, not an oversight.**

- **The paid app is founder-only.** `ZERODHA_CONNECT_API_KEY` /
  `_API_SECRET` belong to the paid "Connect" app, which in this codebase is a
  founder-only connector (`/api/brokers/zerodha-connect`) whose token is stored
  for the **dormant** `workers/src/connect` code and syncs nothing. The
  _Personal_ app — the one that powers portfolio sync for every user — has no
  live quotes, no charts and no WebSockets at all. See the MONEY-837 notes in
  the root `CLAUDE.md`.
- **It is per-user OAuth, not a service credential.** Kite tokens expire daily
  and are minted by a human completing a login. A platform-wide 1-minute
  backfill cannot run on one founder's token without that token becoming a
  shared credential for every user's chart — which is both a licence question
  and a single point of failure with a 24-hour fuse.
- **The gap it closes is narrow.** 5m/15m/60m are served. 1m is the only
  missing rung, and it is the rung a retail portfolio app has the least use
  for.

### If it is ever activated, the sequence is

1. Decide the licence question first — whose credential, and may its data be
   shown to other users. Everything below is wasted if the answer is no.
2. `BASE_INTERVAL.IN = "1m"` in
   `packages/core/src/market-data/intraday/rollup-logic.ts`. **One constant.**
   `derivableIntervals` then admits 1m automatically and the route's refusal
   stops firing — no route change.
3. Point `intraday-sync`'s fetcher at Kite for the 1m interval. `mirrorToIntradayBuffer`
   already writes whatever `BASE_INTERVAL.IN` names; it needs no edit.
4. **Flush `ib:IN:*`.** The buffer would otherwise hold 5-minute entries under a
   key that now means 1-minute, and `decodeBar` cannot tell them apart — the
   tuple is identical. This is the step that is easy to skip and impossible to
   detect afterwards.
5. Re-measure `MINUTES_PER_SESSION.IN`. 375 is already the 1-minute count
   (09:15–15:30), so the capacity is correct as written — confirm rather than
   assume.
6. Only then widen `MARKET_DATA_INTRADAY`.

### What must NOT happen

- Do not set `BASE_INTERVAL.IN = "1m"` while Yahoo is still the fetcher. The
  refusal would stop firing, the buffer would fill seven days deep, and the
  chart would show a 1-minute series that ends a week ago with no error.
- Do not "fix" the 1m refusal by loosening `rollUp`. That is the bug in the
  section above, restored.

---

## The basis, which is a separate question

Every buffered bar carries a `basis`:

| basis       | meaning                             | volume           |
| ----------- | ----------------------------------- | ---------------- |
| `trade`     | built from prints                   | real             |
| `quote_mid` | built from the midpoint of the book | structural **0** |

India's bars are `trade` — Yahoo's India intraday is print-derived. The US
realtime feed is `quote_mid`, because that feed carries no trades at all
(MONEY-1309, measured across 236 captured frames), which is why the chart
badges it. A roll-up **refuses** to combine two bases; the reader picks one
(`trade` wins) and serves it, rather than blanking a chart that has good bars
in it.

Kite's 1-minute candles would be `trade`, so activation changes the interval
and not the basis.
