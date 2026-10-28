# RCA — every chart went blank when the cutover flag was flipped

**2026-09-18. MONEY-1476.** Duration: from the `MARKET_DATA_TILES` flip until
the flag was set back off. Product impact: the price chart on every stock page
rendered **"Symbol Error · invalid symbol"**, with `₹0.00` LTP and dashed key
metrics. Every other surface — Overview, Fundamentals, Technicals, Returns —
kept working, because that data comes from Mongo and not from this service.

---

## 1. What happened

`MARKET_DATA_TILES` was set `true` on prod, which points the chart's `/udf`
origin at `usemoney-market-data` instead of the legacy `apps/web` route.
Measured immediately after the report:

```
/udf/history  -> 200  {"s":"ok","t":[...]}        serving real bars
/udf/symbols  -> 501  "not implemented (A2)"      THE BUG
/udf/search   -> 501  "not implemented (A2)"
```

TradingView's UDF datafeed calls **`resolveSymbol` first** and will not request
a single bar until it succeeds. So the endpoint that worked was the only one
anyone had exercised, and the endpoint that was unimplemented was the first one
the widget hit.

**The failure looked like a chart bug and was a routing decision.** That is why
it was reported as "the chart is broken" rather than "the flag is wrong".

---

## 2. Why four independent safeguards all said go

This is the part worth keeping. No single missing test explains it.

### 2.1 The smoke suite passed 21/21 — throughout the outage

`market-data-smoke.sh` is the post-deploy proof for this service. It probed
`/udf/config`, `/udf/time` and `/udf/history`, and never `/udf/symbols`.

Not an oversight so much as a fossil. The suite was written by **A1
(MONEY-1466)**, when `/udf/history` was _also_ 501 — at birth the only routes
worth probing were the two constants. A2 implemented history and added a history
check. Nobody added a symbols check, because symbols was still 501 and
_correctly_ so.

Each increment was locally reasonable. The suite grew to track what had been
built, never what the widget needs.

### 2.2 A test ASSERTED the 501 as the contract

`apps/market-data/__tests__/routes.test.ts`, written in `4de38de4`
(MONEY-1466) — the same commit that created the stubs:

```ts
test("the routes still awaiting their prompt answer 501, and are NOT cacheable", ...)
    `${path} should be 501 until its prompt lands`
```

Correct when written. But it converted an **absence** into a **defended
invariant**: implementing `/udf/symbols` would have failed a test, and the
failure message reads like deliberate policy rather than a TODO. A test that
encodes "not done yet" as an assertion makes the gap look like a decision.

### 2.3 The parity harness built to de-risk THIS cutover compared bars only

A3 (MONEY-1468) shipped `scripts/ops/udf-parity.ts`. Its own header:

> Every request is a GET against two `/udf/history` endpoints.

`parity-logic.ts` exports `PRICE_TOLERANCE_PCT`, `VOLUME_TOLERANCE_PCT`,
`UdfSeries`, `BarDiff`. There is no mention of symbol resolution anywhere in it.

So the instrument whose entire purpose was to prove the cutover safe compared
the endpoint that already worked, on both sides, and reported agreement. It was
correct and useless: the chart never got far enough to request a bar.

### 2.4 The service's own documentation said so, in a table I read that night

`apps/market-data/CLAUDE.md` carried:

```
| GET /udf/symbols | 501 (A2) | no-store | resolver already in core |
| GET /udf/search  | 501 (A2) | no-store | resolver already in core |
```

I read that table hours before flipping the flag — for the `Cache-Control`
column, while fixing MONEY-1475. The status column was right there.

---

## 3. The single root cause

**Every safeguard was scoped to the endpoint being MIGRATED. The flag switches
an ORIGIN.**

`MARKET_DATA_TILES` does not route `/udf/history`; it routes _the datafeed_. The
correct blast radius was "every UDF call the widget makes". Every check —
smoke, parity harness, route tests — was built around the one endpoint the
ticket in hand was about.

That mismatch is invisible while the flag is off, because nothing exercises the
other routes through the real client. It becomes total the instant the flag
flips.

---

## 4. Why the tests could not have found it

Worth stating plainly, because "add a test" is not the lesson:

- **Unit tests passed because each route was correct in isolation.** A 501 stub
  that returns a well-formed 501 satisfies its own test. There was no defect in
  any individual route.
- **No test drives the widget's call SEQUENCE.** The failure is entirely in the
  ordering — resolve, then bars — and nothing in the repo models that.
- **The parity harness compared like with like** on the one endpoint where both
  sides worked.

The defect lived in the space _between_ correct components, which is exactly
where per-component tests cannot look.

---

## 5. What changed

|                               |                                                                                                                                                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/udf/symbols`, `/udf/search` | implemented (`apps/market-data/src/routes/symbols.ts`), sharing `apps/web`'s logic via core rather than a second copy                                                                                                                                           |
| `INDEX_MAPPINGS`              | moved to core and consulted BEFORE the database — `instrument_mappings` holds zero `INDEX` rows on prod, so a DB-first order answers "unknown symbol" for NIFTY 50                                                                                              |
| smoke: targeted               | probes `/udf/symbols` and `/udf/search`, catching a 501 **by name** with the outage in the message                                                                                                                                                              |
| smoke: **general**            | a sweep asserting **no UDF route answers 501**, with `/udf/marks` named as the one expected exception (C4). This is the check that would have caught the outage without anyone reasoning about TradingView's call order — and it catches the NEXT stub for free |
| `routes.test.ts`              | no longer asserts the gap as the contract                                                                                                                                                                                                                       |
| `CLAUDE.md`                   | table corrected; the resolve-first ordering documented as load-bearing                                                                                                                                                                                          |

Run against the still-broken prod service, the suite now reports **4 FAILs**
where it previously reported 21/21 green.

---

## 6. The generalisable rule

> A flag that switches an ORIGIN must be gated on every call that origin
> serves — not on the endpoint the migration ticket was about.

Operationally: **before flipping a traffic-routing flag, assert that no route on
the target answers 501.** That is one check, it needs no knowledge of the
client's call order, and it survives the next unimplemented endpoint.

The narrower lesson — "the smoke suite should have probed `/udf/symbols`" — is
true and would have fixed this one outage. The rule above is what prevents the
next one.

---

## 6a. The fix's OWN review found the same shape again

Worth recording, because it is the sharpest evidence for the rule above.

The first implementation of `/udf/symbols` parsed the symbol itself rather than
asking `/udf/history`'s `resolveListing`. The two then disagreed in BOTH
directions — measured:

| symbol                   | `/udf/symbols`                                      | `/udf/history`                                                    |
| ------------------------ | --------------------------------------------------- | ----------------------------------------------------------------- |
| `NSE:NIFTY 50`           | resolved                                            | **leaked the tile store's internal regex message into the chart** |
| `MF:120503`              | resolved                                            | "unrecognised symbol"                                             |
| `NSE:NIFTYBEES`          | resolved                                            | `no_data` for ever — not tiled (~541 active ETFs)                 |
| `nse:reliance`           | refused (prefix never uppercased)                   | served                                                            |
| `AAPL:NASDAQ:1980-12-12` | refused (split on the first colon -> prefix "AAPL") | served                                                            |

So the fix for "the two endpoints disagree about whether a symbol exists"
shipped a NEW disagreement about the same thing — and the index case was
strictly worse than the 501 it replaced, because a 501 renders as "invalid
symbol" while the new path rendered the tile store's internal safety text.

Both endpoints call `resolveListing` now, so they agree by CONSTRUCTION rather
than by review. `/udf/symbols` also refuses any instrument type
`tile-build-d1` does not tile, by name, rather than resolving into a blank
chart.

**The service cannot yet serve what the legacy route serves** — indices with a
space in the name, mutual funds, ETFs and renamed tickers all work on
`apps/web` and are refused here. `MARKET_DATA_TILES` must stay OFF until
MONEY-1478 closes that, independently of any fix on this branch.

---

## 7. Related

This is the second time in two days that a check on this service was green in
exactly the state it existed to catch. MONEY-1475 found `/udf/history`'s
Cache-Control assertion passing in a platform-wide blank-chart state, because a
`no_data` response takes no error path at all — `readTile` returns `absent`, not
`failed`, when the tile store is unconfigured.

Both share a shape: **the healthy-looking path and the broken path are the same
path**, distinguished only by something no assertion was looking at.
