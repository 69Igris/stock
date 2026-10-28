/**
 * The CRSP back-adjustment, in SQL. MONEY-1506 (data-platform B4).
 *
 * ## THIS IS THE THIRD IMPLEMENTATION OF ONE POLICY, AND THAT IS THE WHOLE RISK
 *
 *   TypeScript  `computeAdjustedSeries` (packages/core/.../tiingo/tiingo-logic.ts)
 *               — validated against Tiingo's own `adjClose` across AAPL's full
 *               11,517-bar series: worst error 0.023%, zero bars off by more
 *               than 0.1%. It is the reference.
 *   Python      `scripts/quant/read_candles.py` — retired by B7.
 *   SQL         this file.
 *
 * A SQL adjustment that merely LOOKS right is how a whole price history gets
 * silently restated: every bar parses, every chart draws, and the numbers are
 * wrong by a constant multiple that nobody can see without the other
 * implementation beside it. So this is not written as prose in a .sqlx file —
 * it is ONE exported function, and
 * `packages/core/__tests__/market-data/adjustment-sql-parity.test.ts` EXECUTES
 * the string this function returns and asserts it equals the TypeScript on
 * fixtures that include a split, a dividend, and a session carrying both.
 *
 * ## THE DIALECT IS DELIBERATELY THE COMMON SUBSET
 *
 * The parity test runs this SQL in `node:sqlite` (stdlib — no dependency, no
 * credentials, runs in CI), so the text uses only what BigQuery and SQLite
 * spell identically: `CASE`, `COALESCE`, `LN`, `EXP`, `ROW_NUMBER`, `LAG`,
 * `SUM(...) OVER`, a named `WINDOW`, and `CAST`. No `SELECT * EXCEPT(...)`, no
 * `SAFE_DIVIDE`, no `QUALIFY` — each of which BigQuery has and SQLite does not,
 * and each of which would make the one runnable proof of this file impossible.
 *
 * What that proof covers is the ALGEBRA: the direction of the walk, the
 * cumulation, which close a dividend divides by, and that volume is scaled by
 * the split alone. What it does NOT cover is BigQuery's parser or its NUMERIC
 * rounding — `scripts/ops/adjustment-parity.ts` covers those against the real
 * warehouse, and it needs credentials, so it is a `verify:push` proof rather
 * than a CI test.
 *
 * ## THE MATHS, AND WHY IT IS A SUFFIX PRODUCT
 *
 * The TypeScript walks BACKWARD from the most recent bar, which is the only
 * direction that makes the latest bar equal its raw price. The factor
 * contributed by bar `i` applies to every bar BEFORE it:
 *
 *     f_i = (1 - divCash_i / close_{i-1}) / splitFactor_i
 *
 * so for bar k the cumulative price factor is the product of f over every bar
 * STRICTLY AFTER k, and the cumulative split factor is the product of
 * 1/splitFactor over the same set. BigQuery has no cumulative-product window
 * function, so the identity `prod(x) = exp(sum(ln(x)))` does it — over the
 * frame `ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING`, which is empty for
 * the newest bar and therefore yields a factor of exactly 1 there.
 *
 * Measured cost of the log round-trip on the parity fixtures: worst relative
 * error 2.8e-16 against the TypeScript's sequential multiplication, which is
 * seven orders of magnitude inside the 1e-9 the parity test asserts.
 *
 * ## THE ONE DELIBERATE DIVERGENCE FROM THE TYPESCRIPT
 *
 * `LN` is undefined at or below zero, so a dividend greater than or equal to
 * the previous close is REFUSED here (the factor falls back to 1) where the
 * TypeScript would compute a zero or negative factor and multiply the entire
 * history by it. That input is a >100% single-day yield — a data fault, not a
 * corporate action — and the TypeScript's answer to it is catastrophic rather
 * than merely different. The parity test PINS the divergence in its own case so
 * it is recorded rather than discovered.
 *
 * ## THE FACTORS ARE FLOAT64 — AND IN BIGQUERY THEY WERE NOT — MONEY-1528 (A)
 *
 * Every input column is NUMERIC, and BigQuery keeps NUMERIC NUMERIC: `LN` and
 * `EXP` of a NUMERIC return NUMERIC, and even the literal in `1.0 / split_eff`
 * is COERCED to NUMERIC (measured: `1.0 / NUMERIC '1.5'` is 0.666666667). So
 * every factor was quantised to nine decimal places — `EXP(LN(10) + LN(5))`
 * is 49.999999979 and a lone ratio 2 is 2.000000001 — where SQLite and the
 * TypeScript both work in doubles. The quantisation is ABSOLUTE, so its
 * relative cost grows as a factor shrinks: a `price_factor` of 0.009927757
 * against the TypeScript's 0.0099277570277 is 2.8e-9, past the 1e-9 bound, and
 * a `split_factor_cum` of 0.666666667 moved one fixture bar's adjusted volume
 * by a share. `scripts/ops/adjustment-parity.ts` measured both the first time
 * it was fed an action row; the SQLite proof cannot see either, because SQLite
 * has no NUMERIC to quantise.
 *
 * So the three places a factor is BORN — an action's ratio, the bar's own split
 * factor, and the previous close a dividend divides by — are widened with
 * `CAST(... AS FLOAT64)`, and everything downstream inherits the type. SQLite
 * reads the type name as REAL, so the text stays in the common subset. Prices
 * stay NUMERIC: `adj_*` is still `CAST(... AS NUMERIC)`, because those are
 * money and the factors are not.
 *
 * ## WHERE THE FACTORS COME FROM — MONEY-1516 (b)
 *
 * They used to come from the BAR's own `div_cash` / `split_factor` columns and
 * nowhere else. Measured on prod 2026-09-22, all 14.3M India bars carry NULL in
 * both — bhavcopy publishes no corporate-action data — and `NULL > 0` is NULL
 * rather than true, so every `CASE` took its `ELSE`: `split_factor_cum = 1` and
 * `adj_close = close`, for every India row, reported as a success.
 * `assert_latest_bar_is_unadjusted` cannot see that: under CRSP back-adjustment
 * the newest bar is unadjusted BY CONSTRUCTION, which is precisely what it
 * asserts. `assert_india_split_is_adjusted.sqlx` is the one that can.
 *
 * So `lake_silver.corporate_action` is joined in. Which raises the only real
 * hazard in this change:
 *
 * ### DOUBLE APPLICATION IS UNREPRESENTABLE, NOT MERELY ABSENT
 *
 * US bars are NOT like India's. Tiingo's EOD response carries `divCash` and
 * `splitFactor` and `toPriceBarRow` maps both — and `Candle.divCash` is
 * `Float @default(0)` while `Candle.splitFactor` is `Float @default(1)`, so a
 * US bar arrives carrying a CONCRETE 0 and 1 on an ordinary day, never a NULL.
 * The moment MONEY-1513's US bars land beside a US corporate-action row, a
 * naive join would apply the bar's factor AND the action's and SQUARE the
 * adjustment — invisible today only because `corporate_action` happens to hold
 * India rows alone.
 *
 * The defence is structural rather than a rule anybody has to remember: each
 * factor is ONE expression yielding ONE number, `COALESCE(bar, action)`, so
 * there is no path through this SQL that multiplies both. And because a US bar's
 * columns are never NULL, the COALESCE cannot fall through there at all — an
 * action row is UNREACHABLE for a US bar rather than merely out-ranked.
 *
 * The BAR WINS, and the direction is not arbitrary:
 *   - `computeAdjustedSeries` — the reference this file is proven equal to —
 *     reads the bar's columns. Preferring them keeps the SQL identical to the
 *     validated reference wherever a bar carries data, so US parity survives by
 *     construction instead of needing to be re-established.
 *   - The vendor's per-bar column is the same row, same feed, same timestamp as
 *     the price it adjusts. The action table is a separate ingest that can and
 *     does disagree about the DATE (see the ex-date note below).
 *   - A fallback that can only FILL A GAP and never displace a known value is
 *     the same rule as `PRICE_SOURCE_AUTHORITY` and `FINANCIALS_AUTHORITY`.
 *
 * REJECTED — per-market sourcing (`CASE WHEN market = 'IN' THEN action ELSE
 * bar END`). It encodes today's coverage map as policy: the day a market has
 * both witnesses one is silently discarded with no counter, and the rule has to
 * be edited per market for ever. It also cannot express the state a
 * partly-loaded table is actually in, where one listing's bar column is null
 * and its neighbour's is not.
 *
 * REJECTED as the PRIMARY mechanism — refusing when both are present. Refusal
 * is the right polarity for a one-way write and the wrong one here:
 * `adjusted_bar_d1` is a VIEW computed at read time, so a refusal takes the
 * whole market dark because one listing has two witnesses. It survives as an
 * ASSERTION (`assert_no_double_adjustment_witness.sqlx`), which makes the
 * overlap loud on the day it first appears without making gold unreadable.
 *
 * ### WHAT A BAR STATES, AND THE WITNESS IT OVERRULES — MONEY-1528 (D)
 *
 * The COALESCE needs a notion of "the bar has a value", and it used to be
 * `IS NOT NULL` while the CASE after it asked "is it usable" (`> 0`). MONEY-1516
 * review #5 closed that gap for one value of one column
 * (`NULLIF(split_factor, 0)`). It is closed ONCE now, in `witnessed`, for both:
 *
 *   bar_split   split_factor when > 0, else NULL. Non-positive never states a
 *               split: `computeAdjustedSeries` reads it as 1, and the Candle
 *               layer rewrites it to 1 before storing (`positiveOr`).
 *   bar_cash    div_cash when >= 0, else NULL. ZERO IS A STATEMENT — "no
 *               dividend today" — and a negative amount is not one.
 *
 * WHY 0 AND 1 STAY STATEMENTS, which is the tempting fix and the wrong one.
 * What the US replay writes is `Candle.divCash` / `splitFactor` straight through
 * `toPriceBarRow`: a concrete 0 and 1 on every ordinary session, never NULL,
 * because the Candle layer turns an absent or non-finite value into exactly
 * those (`finite(d) ?? 0`, `positiveOr(sf, 1)`) on top of the Prisma defaults.
 * So a default and Tiingo saying "nothing happened today" are the same bytes,
 * and no rule over the VALUE can tell them apart. Reading 0/1 as "not stated"
 * (`NULLIF(div_cash, 0)`, `NULLIF(split_factor, 1)`) would let an action row
 * fill every session the vendor declared event-free — and the disagreement two
 * witnesses routinely have is the DATE, by a session. The vendor carries a split
 * on D, the action names D+1, both apply, and the history is divided by the
 * square: the hazard this section makes unrepresentable, back as a NULLIF. A
 * redundant witness discarded costs nothing; a real one applied twice does.
 *
 * So the bar still wins, and a DISCARD is REPORTED rather than applied.
 * `discardedActionSql` returns every carrier bar where the action table's
 * RESOLVED factor — latest observation, allowlisted, un-suppressed, composed —
 * was pre-empted by a bar value that DIFFERS from it, the 0 and 1 included, and
 * the double-witness assertion renders it. It reads THIS chain rather than a
 * copy of it, so it cannot disagree with what the view did. The assertion's
 * older half excludes trivial bar values by value, which is right for a ±3-day
 * window and is exactly why it saw the redundant overlap and never the discard.
 *
 * Measured on prod 2026-09-23: `price_bar_d1` holds 14,291,560 rows, all
 * market IN, NULL in both columns, and `corporate_action` is IN-only. Zero
 * discards today; the first can only appear when a market whose bars STATE
 * values also acquires action rows.
 *
 * ### `ratio` IS `split_factor`, IN THE SAME DIRECTION — verified, not assumed
 *
 * `CorporateAction.ratio` is documented post:pre (split 1:5 -> 5, bonus 1:1 ->
 * 2) and `price-adjust.ts` states the same model and was reverse-engineered
 * against Yahoo's own factors for RELIANCE. Verified again here against the
 * BARS on prod 2026-09-23, because an inverted factor produces plausible prices
 * that are wrong by exactly the split ratio: across SPLIT/BONUS rows with a
 * detectable cliff, `prev_close / ex_close` reproduces `ratio` (EICHERMOT
 * 21,702.40 -> 2,176.45 against ratio 10; TATASTEEL 959.40 -> 100.35 against
 * ratio 10; INFY 4,349.85 -> 2,126.60 against ratio 2). So `ratio` feeds
 * `split_eff` unchanged, and the existing `EXP(SUM(LN(1.0 / split_eff)))`
 * divides pre-event prices by it.
 *
 * ### WHICH `action_type` MOVES A PRICE — an ALLOWLIST, and the vocabulary is
 * ### wider than the schema comment says
 *
 * Measured on prod: FOURTEEN distinct values, not the six the Prisma comment
 * lists. `INTEREST_PAYMENT` (3,754), `OTHER` (3,330), `RIGHTS` (1,250),
 * `REDEMPTION` (386), `INCOME_DISTRIBUTION` (22), `AGM` (14) and `SUSPENSION`
 * (4) are all in the data. Part (a) deliberately does NOT gate `cash` on
 * DIVIDEND, so a denylist would apply a bond's coupon as an equity dividend the
 * day that column starts arriving filled. An allowlist ignores a fifteenth type
 * instead of guessing at it.
 *
 * ### THE EX-DATE NAMES THE FIRST EX-PRICED SESSION — AND IT DID NOT USED TO
 *
 * READ THIS BEFORE TOUCHING THE CARRIER RULE. The first draft of this file
 * carried the factor on the first bar STRICTLY AFTER `ex_date`, and that was
 * correct for the data as it then stood: `ex_date` was one calendar day early
 * for 48,224 of 59,087 rows, because `corp-action-logic.ts` rendered an
 * IST-midnight `Date` through `toISOString()`. The tell was in the dates
 * themselves — 6,857 SUNDAY ex-dates against 4,048 Friday, which no exchange
 * produces.
 *
 * THAT IS FIXED AT THE SOURCE (MONEY-1516 part (a)) and the table was reloaded,
 * so the compensation is gone with it. Re-measured on prod after the reload:
 *
 *                              before          after
 *   cliff ON the ex_date bar    55  (4.1%)    1,174 (98.2%)
 *   cliff at ex_date + 1     1,266 (94.1%)        5  (0.4%)
 *   SUNDAY ex-dates          6,857                0
 *   FRIDAY ex-dates          4,048           14,622
 *
 * So each action's factor is carried by THE FIRST BAR ON OR AFTER its
 * `ex_date`, and the window divides every bar STRICTLY BEFORE it. That is the
 * same rule `price-adjust.ts` states as `exDate > t`, and the two now agree
 * bar for bar rather than by two errors cancelling. DO NOT restore the `>`:
 * against corrected data it carries every factor one bar too late.
 *
 * ### SAME-EVENT DUPLICATES ARE STILL COLLAPSED, AS A NET RATHER THAN A FIX
 *
 * The shift used to MANUFACTURE these: one event written by two producers
 * landed on two adjacent dates, and applying both halves squares the
 * adjustment — a 10:1 split becomes 100:1. B4 measured 86 ratio pairs and 663
 * cash pairs one day apart.
 *
 * The source fix collapses those onto one natural key, and the prod re-measure
 * says so: of 26,609 factor-bearing candidate pairs, ZERO are now one day
 * apart, and 2,065 of the 2,070 that still collapse are listings price_bar_d1
 * holds no bars for at all (G-Secs, BSE debt), where there is no adjustment to
 * square either way. Five real pairs remain.
 *
 * It is KEPT anyway, and deliberately: it costs one join, it guards a class
 * that squares a factor when it fires, and a second producer arriving with a
 * third date convention is exactly the sort of thing that reaches this table
 * without anyone editing this file. Its span bounds are paired with the
 * carrier rule above — `[earlier, later)`, matching `>=` — so the two cannot
 * drift into disagreeing about what "shares a carrier bar" means.
 *
 * Two actions are treated as ONE when they name the same listing, carry the
 * same `ratio` and `cash`, and have AT MOST ONE trading session between them.
 * Counting bars keeps this to comparisons — no date arithmetic, which BigQuery
 * and SQLite do not spell alike. The EARLIEST of the cluster survives, which
 * with the carrier rule above leaves the cum bar on the earlier date divided
 * and the ex bar alone. `action_type` is deliberately NOT part of the match,
 * matching `dedupeActions`, which compares factors and dates and never types.
 *
 * "AT MOST ONE" RATHER THAN "EXACTLY ONE", AND THE DIFFERENCE IS MEASURED.
 * Exactly one session between means the two carriers are ADJACENT bars; ZERO
 * sessions between means they are the SAME bar, so not collapsing there does
 * not merely double-describe an event, it multiplies both factors into one
 * bar. Zero is reached two ways and only one of them is a duplicate: an
 * illiquid scrip whose ex-dates straddle days it did not trade, and a listing
 * with a long HOLE in its bar series (CORALFINAC:NSE has none between
 * 2001-03-12 and 2017-03-29, so its 2014, 2015 and 2016 dividends all land on
 * one 2017 carrier and read as repeats of each other).
 *
 * Measured on prod 2026-09-23, `<= 1` matches 745 pairs within three days and
 * 65,766 beyond — but those are almost all inert, because a pair with no
 * sessions between it usually has no CARRIER either. Against `= 1` the whole
 * difference is FIVE listings of 17,699, and the one with an unambiguous answer
 * says `<= 1`: HIIL:BSE files its 3:1 bonus on both 2026-07-09 and 2026-07-10
 * and trades ~47 sessions in six months, so the strict rule misses the
 * duplicate and cubes the adjustment to 9x. CORALFINAC is the case that argues
 * the other way and both its answers are junk — a `prev_close` sixteen years
 * stale is not a dividend yield either way.
 *
 * ### THE TABLE IS APPEND-ONLY
 *
 * A correction is a NEW ROW with a later `observed_at`, so the join takes the
 * latest observation per `(market, listing_id, action_type, ex_date)` — Mongo's
 * own `@@unique([symbol, exchange, type, exDate])` lifted into the lake, and
 * measured unique across all 59,087 rows today, so nothing is lost by it.
 * `source_record_key` was REJECTED as the key: it is the honest row identity
 * for ONE producer, but two producers describing one action would be two keys
 * and the event would apply twice, which is the hazard this whole section is
 * about.
 */

/**
 * Bumped when the adjustment POLICY changes, not when this file is edited.
 *
 * A STRING (`crsp-v1`) because it names a methodology, and a tile or a backtest
 * carrying `crsp-v1` has to be comparable with one built a year later by a
 * different engine. `ADJUSTMENT_POLICY_VERSION` in tile-logic.ts is the integer
 * the TILE header carries; these two answer different questions and are held in
 * agreement by `dataform-agreement.test.ts`.
 *
 *   crsp-v2  MONEY-1516: India factors from `corporate_action`, carrier `>=`.
 *   crsp-v3  MONEY-1528 / MONEY-1537 / MONEY-1541 (bumped together on
 *            fix/MONEY-1522): CAPITAL_ADJUSTMENT divides by its OBSERVED gap
 *            where silver carries one; FLOAT64 factor arithmetic; a detection
 *            suppressed by a TWIN (±1 session), COMPOSED or PARTIAL feed
 *            filing. The history below says why it was deferred until now.
 *
 * MONEY-1528 moved the policy again — a CAPITAL_ADJUSTMENT divides by its
 * OBSERVED gap where silver carries one — and did NOT bump this, on purpose.
 * `lake-release-logic.ts` holds a second copy that is written into every
 * release manifest and compared with nothing, so bumping this one alone makes
 * a manifest say crsp-v2 over rows stamped crsp-v3. The two move together or
 * not at all; `dataform-agreement.test.ts` now fails if they part. No release
 * has been cut under crsp-v2 yet (`lake_gold_prod` has never held
 * `adjusted_bar_d1`), so the bump is owed before the first cut, not overdue.
 * MONEY-1541 moved it once more — a detection is also suppressed by a COMPOSED
 * feed filing, and a PARTIAL filing is suppressed by the detection — under the
 * same owed bump.
 */
const ADJUSTMENT_POLICY_VERSION = "crsp-v3";

/**
 * Which PRODUCER wins when two describe one action — MONEY-1528.
 *
 * A mirror of `SOURCE_RANK` in `price-adjust.ts`, which has always resolved
 * this and which this SQL did not. `action_latest` reduced to one row per
 * (market, listing_id, action_type, ex_date) ordering by
 * `observed_at DESC, source_record_key DESC` with `source` not consulted at
 * all — so an NSE filing of SPLIT 10 and a BSE filing of SPLIT 2 for one
 * symbol and ex-date, loaded with the same Mongo `updatedAt`, were resolved by
 * whichever ObjectId STRING sorted higher. The losing ratio vanished with no
 * counter and the entire pre-split history was restated by the wrong multiple.
 *
 * The justification for leaving it was "measured unique across all 59,087 rows
 * today", and nothing asserted it stayed unique.
 *
 * NOTE WHAT THIS DOES NOT SETTLE. NSE and BSE are BOTH 90, deliberately — the
 * TypeScript says the same, because neither exchange is a more authoritative
 * witness to a corporate action than the other. So a genuine NSE-vs-BSE
 * disagreement about a ratio still falls through to `source_record_key` and is
 * still decided arbitrarily. The rank resolves the cases where one side IS
 * weaker — a DERIVED cliff detection or a SCREENER scrape against an exchange
 * filing — and refuses to invent an ordering for the case where it is not.
 *
 * `observed_at` still leads: a CORRECTION is a later observation of the same
 * event and must win regardless of who filed it. The rank only breaks a tie
 * between two observations recorded at the same instant, which is exactly the
 * both-exchanges-in-one-load case. `source_record_key` remains last so the
 * order is still total and a re-run is deterministic.
 *
 * Held EQUAL to the TypeScript table, both ways — MONEY-1537. `SOURCE_RANK` is
 * exported now, so adjustment-sql-parity.test.ts compares the two tables
 * rather than holding this one to a literal copy while the other drifted.
 */
const ACTION_SOURCE_RANK = Object.freeze({
  MANUAL: 110,
  NSE_HIST: 100,
  NSE: 90,
  BSE: 90,
  SCREENER: 50,
  SEED: 40,
  DERIVED: 10,
});
/** Unknown ranks 20 — above DERIVED, below every named feed. */
const ACTION_SOURCE_RANK_DEFAULT = 20;

/**
 * CONTAINS, not equals, and evaluated HIGHEST RANK FIRST.
 *
 * `mergeCorporateActions` writes `source` as a sorted `+`-joined UNION when
 * two feeds describe one event — prod holds `NSE+SCREENER` today. An equality
 * test misses every composite and falls to the unknown default of 20, BELOW a
 * bare SCREENER at 50, so the more-corroborated row loses.
 *
 * A `CASE` returns its first matching branch, so listing the tiers in
 * descending rank makes the result the MAX rank present — which is the right
 * reading: a union of witnesses is at least as good as its best member.
 *
 * ORDER MATTERS FOR A REASON BEYOND THAT: 'NSE' is a substring of 'NSE_HIST',
 * so NSE_HIST must be tested first or every historical row would score 90.
 *
 * DELIMITED, so this is EXACT TOKEN matching and not substring containment.
 * The TypeScript half splits on '+' and takes the max of exact tags; a bare
 * `INSTR(source, 'NSE')` would instead match any string CONTAINING "NSE" —
 * `NSE_BULK`, `BSE_HIST`, `NSE_ARCHIVE` would all score 90 in SQL and 20 in
 * TypeScript. Measured over 38 candidate spellings, the undelimited form
 * diverged from the TypeScript on 17 of them, and the worst polarity is
 * DERIVED at 10 sitting BELOW the unknown default of 20 — so a future
 * `DERIVED_V2` would push the two sides in OPPOSITE directions on a money
 * path. Wrapping both operand and needle in the delimiter makes the two
 * implementations one function again.
 *
 * `INSTR` AND NOT `STRPOS`, which is the portability trap this file has now
 * hit twice. `STRPOS` is BigQuery-only and node:sqlite answers "no such
 * function"; `INSTR` exists in both. The parity harness caught it on the first
 * run, which is what that harness is for — the same way it caught
 * `UNION DISTINCT` one change earlier.
 */
function actionSourceRankSql(column) {
  const whens = Object.entries(ACTION_SOURCE_RANK)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(
      ([name, rank]) =>
        `      WHEN INSTR('+' || ${column} || '+', '+${name}+') > 0 THEN ${rank}`,
    )
    .join("\n");
  return `CASE\n${whens}\n      ELSE ${ACTION_SOURCE_RANK_DEFAULT}\n    END`;
}

/**
 * Price-source precedence, mirroring `PRICE_SOURCE_AUTHORITY`
 * (packages/core/src/market-data/price-source-authority.ts).
 *
 * ## WHY GOLD HAS TO DEDUPLICATE AT ALL
 *
 * `lake_silver.price_bar_d1` is one row per (market, listing_id, session_date,
 * SOURCE) — its own DDL says so. Mongo's `DailyPrice` is unique on
 * (instrumentId, date) and `mayWritePriceSource` arbitrates there, but the lake
 * table deliberately KEEPS both witnesses. So a session that bhavcopy and Yahoo
 * both delivered is two rows, and a `LAG(close)` over an undeduplicated series
 * would take the previous SOURCE's close for the same day as "yesterday" —
 * which silently corrupts every dividend factor from that day backward.
 *
 * Unknown ranks LAST (1), never 0 and never absent: a new upstream may fill a
 * gap and must never displace a known source.
 */
const SOURCE_AUTHORITY = {
  BHAVCOPY: 100,
  BHAVCOPY_HIST: 100,
  TIINGO: 60,
  DATABENTO: 55,
  ZERODHA: 50,
  TIINGO_RT: 20,
  YAHOO: 10,
};

/** `CASE source WHEN 'BHAVCOPY' THEN 100 … ELSE 1 END`, the ranks as SQL. */
function sourceAuthoritySql(column) {
  const arms = Object.entries(SOURCE_AUTHORITY)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([source, rank]) => `      WHEN '${source}' THEN ${rank}`)
    .join("\n");
  return `CASE ${column}\n${arms}\n      ELSE 1\n    END`;
}

/**
 * `corporate_action.action_type` values that change the SHARE COUNT, and so the
 * price basis. Their `ratio` feeds `split_eff`.
 *
 * `CAPITAL_ADJUSTMENT` is in because `QTY_CHANGING_TYPES` (price-adjust.ts) has
 * it and because it is the only witness we have for 156 real cliffs: it is the
 * price-derived detector's output, written when a factor of exactly 2 is
 * equally a 1:1 bonus and a 2:1 split and the type cannot honestly be asserted.
 *
 * DEMERGER and RIGHTS are OUT, and neither is an oversight. A demerger's price
 * gap is the market's valuation of the spun-off entity and a rights issue's is
 * the subscription price and ratio — neither is expressible as a post:pre share
 * ratio, which is why all 804 DEMERGER and 1,250 RIGHTS rows on prod carry a
 * NULL `ratio`. `price-adjust.ts` adjusts a demerger through its OBSERVED gap,
 * and silver now carries one (`observed_ratio`, MONEY-1528) — but admitting
 * DEMERGER on the strength of that would apply the event TWICE: the DERIVED
 * detector files the same cliff as a CAPITAL_ADJUSTMENT, and `suppressed`
 * recognises a twin by its filed `ratio`, which no DEMERGER row has. The
 * detector's row already covers the cliff; until the twin rule can match a
 * ratio-less feed row, DEMERGER stays out.
 *
 * BUYBACK and MERGER are OUT on meaning: a tender buyback leaves a continuing
 * share's basis alone, and a merger ends the listing rather than rebasing it.
 */
const PRICE_BASIS_ACTION_TYPES = ["SPLIT", "BONUS", "CAPITAL_ADJUSTMENT"];

/**
 * Action types whose `cash` is a per-share distribution against the equity's
 * own price. DIVIDEND alone.
 *
 * INTEREST_PAYMENT and INCOME_DISTRIBUTION are bond and fund distributions —
 * `1 - cash / prev_close` against an equity close is not what they mean. Their
 * `cash` is NULL on prod today, which is exactly why they are excluded BY NAME:
 * part (a) does not gate `cash` on the type, so the day that column fills, a
 * denylist would have applied them and an allowlist ignores them.
 */
const CASH_ACTION_TYPES = ["DIVIDEND"];

/**
 * The types whose FILED ratio outranks the OBSERVED one — MONEY-1528 (B).
 *
 * `actionFactor` (price-adjust.ts) orders its candidates
 * `type === "SPLIT" || type === "BONUS" ? [ratio, observed] : [observed, ratio]`
 * and takes the first that is > 0 and != 1. The SQL read the filed `ratio` for
 * every type, because silver carried nothing else to read — so for the 156
 * CAPITAL_ADJUSTMENT cliffs on prod the chart divided by the OBSERVED gap (say
 * 9.71) while gold divided by the ratio the detector SNAPPED it to (10;
 * `SNAP_TOLERANCE` is 0.03). A level shift of up to 3% between what a user sees
 * and what a backtest reads, on the one type that exists because the ratio
 * could not honestly be asserted.
 *
 * PINNED BY EXECUTION, not by comparing lists: adjustment-sql-parity.test.ts
 * runs every PRICE_BASIS type through a matrix of (ratio, observed_ratio) pairs
 * and asserts the SQL divides by exactly what `actionFactor` returns, so
 * neither side can move alone.
 *
 * THE MAGNITUDE MOVED; THE IDENTITY DID NOT. `suppressed` still matches a
 * DERIVED twin and a near-duplicate on the filed `ratio`, deliberately. The
 * detector files the SNAPPED ratio, which is why a twin equals its feed filing
 * exactly (33 of 33 on prod); the observed gap also carries the ex-session's
 * own market move, so matching on it would miss every twin whose move strayed,
 * and a missed twin is applied twice.
 */
const RATIO_FIRST_ACTION_TYPES = ["SPLIT", "BONUS"];

/** `'SPLIT', 'BONUS', …` — a type list as a SQL `IN` body. */
function typeListSql(types) {
  return types.map((t) => `'${t}'`).join(", ");
}

/**
 * The CTE chain the view AND the discard report are built from, ending at
 * `witnessed` — one row per bar, what the bar STATES beside what the action
 * table resolved for it. No trailing SELECT. MONEY-1528 (D).
 *
 * One chain, two consumers, because the discard report is only worth anything
 * if it judges the witnesses the view actually resolved — the latest
 * observation, the allowlist, the suppression, the composition. A second copy
 * of that logic inside the assertion would be free to disagree with the first.
 *
 * @param {string} source        fully-qualified, quoted silver `price_bar_d1`
 *                               (Dataform's `ref()` output, or a bare table
 *                               name in the parity test's SQLite fixture).
 * @param {string} actionSource  the same, for silver `corporate_action`.
 * @returns {string} `WITH … witnessed AS (…)`.
 */
function witnessCtesSql(source, actionSource) {
  const basisTypes = typeListSql(PRICE_BASIS_ACTION_TYPES);
  const cashTypes = typeListSql(CASH_ACTION_TYPES);
  const ratioFirstTypes = typeListSql(RATIO_FIRST_ACTION_TYPES);
  return `WITH one_row_per_session AS (
  SELECT
    market, listing_id, symbol, exchange, session_date,
    open, high, low, close, volume, div_cash, split_factor, source,
    ROW_NUMBER() OVER (
      PARTITION BY market, listing_id, session_date
      ORDER BY ${sourceAuthoritySql("source")} DESC, source
    ) AS authority_rank
  FROM ${source}
),
lagged AS (
  SELECT
    market, listing_id, symbol, exchange, session_date,
    open, high, low, close, volume, div_cash, split_factor, source,
    -- FLOAT64 -- MONEY-1528 (A). A dividend's factor is born from this, and a
    -- NUMERIC close would keep it NUMERIC in BigQuery: nine decimal places,
    -- absolute, on a number that is then summed in log space.
    CAST(LAG(close) OVER (
      PARTITION BY market, listing_id ORDER BY session_date
    ) AS FLOAT64) AS prev_close,
    -- SAME partition and order as the LAG above, so this fuses into the sort
    -- that already exists and costs nothing. It turns "how many sessions lie
    -- between two ex-dates" into a SUBTRACTION -- see suppressed.
    ROW_NUMBER() OVER (
      PARTITION BY market, listing_id ORDER BY session_date
    ) AS session_idx
  FROM one_row_per_session
  WHERE authority_rank = 1
),
-- APPEND-ONLY: a correction is a NEW ROW with a later observed_at, so one
-- observation per (market, listing_id, action_type, ex_date) — Mongo's own
-- unique key, lifted. source_record_key is deliberately NOT the key: two
-- producers describing one action would be two keys and one event applied
-- twice.
action_latest AS (
  SELECT
    market, listing_id, action_type, ex_date, ratio, cash, source,
    -- THE RATIO A PRICE IS DIVIDED BY, in actionFactor's order -- MONEY-1528
    -- (B). The filed ratio first for a split or a bonus, the OBSERVED gap first
    -- for anything else, and the first of the two that is > 0 and <> 1, else
    -- NULL. The filed ratio stays the event's IDENTITY -- suppressed matches on it.
    CASE
      WHEN action_type IN (${ratioFirstTypes}) THEN
        CASE
          WHEN ratio > 0 AND ratio <> 1 THEN ratio
          WHEN observed_ratio > 0 AND observed_ratio <> 1 THEN observed_ratio
        END
      ELSE
        CASE
          WHEN observed_ratio > 0 AND observed_ratio <> 1 THEN observed_ratio
          WHEN ratio > 0 AND ratio <> 1 THEN ratio
        END
    END AS factor_ratio
  FROM (
    SELECT
      market, listing_id, action_type, ex_date, ratio, observed_ratio, cash, source,
      ROW_NUMBER() OVER (
        PARTITION BY market, listing_id, action_type, ex_date
        ORDER BY
          observed_at DESC,
          -- SOURCE AUTHORITY breaks a same-instant tie -- MONEY-1528. Without
          -- it the survivor was whichever source_record_key (a Mongo ObjectId)
          -- sorted higher, so a real NSE-vs-BSE disagreement about a ratio was
          -- resolved by a string nobody chose.
          ${actionSourceRankSql("source")} DESC,
          source_record_key DESC
      ) AS obs_rank
    FROM ${actionSource}
    WHERE ex_date IS NOT NULL
      AND action_type IN (${basisTypes}, ${cashTypes})
  ) observations
  WHERE obs_rank = 1
),
-- THE BAR THAT CARRIES THE FACTOR is the first one ON OR AFTER ex_date. The
-- cumulative window below applies a bar's factor to every EARLIER bar, so this
-- divides everything STRICTLY BEFORE the ex_date bar and leaves the ex_date bar
-- -- the first ex-priced session -- alone.
--
-- IT WAS A STRICT GREATER-THAN UNTIL MONEY-1516 PART (a) LANDED, and the
-- >= is the whole point of that fix rather than an adjacent tidy-up. The
-- strict form was compensating for an ex_date that was one calendar day early
-- for 48,224 of 59,087 rows; with the shift fixed at the source it would carry
-- every factor one bar TOO LATE, and the compensation would become a second,
-- opposite error. Re-measured on prod after the reload: the raw cliff sits ON
-- the ex_date bar in 1,174 of 1,195 locatable SPLIT/BONUS cases (98.2%),
-- against 5 at ex_date + 1. Before the fix it was the other way round --
-- 1,266 of 1,345 (94.1%) at ex_date + 1 and 55 on the bar.
--
-- >= is also what makes this agree with price-adjust.ts, which divides a bar
-- at t by every action whose exDate is strictly greater than t, so the ex_date
-- bar itself is never divided. The two spellings now say one thing. MIN still
-- handles an ex_date landing on a holiday or a weekend: the carrier is then
-- the next session that exists -- and carrier_idx is that session's ordinal,
-- which is what makes the proximity test below independent of the calendar.
action_carrier AS (
  SELECT
    a.market, a.listing_id, a.ex_date,
    MIN(b.session_date) AS carrier_date,
    MIN(b.session_idx) AS carrier_idx
  FROM action_latest a
  JOIN lagged b
    ON b.market = a.market
   AND b.listing_id = a.listing_id
   AND b.session_date >= a.ex_date
  GROUP BY a.market, a.listing_id, a.ex_date
),
-- EVERY PRICED FEED FILING WITHIN ONE SESSION OF A DETECTED CLIFF -- MONEY-1541.
-- The same reach as the twin rule below, which suppressed only a filing of the
-- detector's EXACT ratio. A feed can file one event as two rows (SUDARSCHEM
-- 2014: BONUS 2 + SPLIT 5 beside a detected 10) or record only part of it, and
-- then no single row equals the detection and both applied.
derived_window AS (
  SELECT
    d.market, d.listing_id, d.action_type AS d_type, d.ex_date AS d_ex_date,
    d.ratio AS d_ratio,
    f.action_type AS f_type, f.ex_date AS f_ex_date, f.ratio AS f_ratio
  FROM action_latest d
  JOIN action_carrier cd
    ON cd.market = d.market AND cd.listing_id = d.listing_id AND cd.ex_date = d.ex_date
  JOIN action_latest f
    ON f.market = d.market
   AND f.listing_id = d.listing_id
   AND f.source <> 'DERIVED'
   AND f.action_type IN (${basisTypes})
   AND f.ratio > 0
  JOIN action_carrier cf
    ON cf.market = f.market AND cf.listing_id = f.listing_id AND cf.ex_date = f.ex_date
  WHERE d.source = 'DERIVED'
    AND d.ratio > 0
    AND ABS(cd.carrier_idx - cf.carrier_idx) <= 1
),
-- One row per detection: the PRODUCT of the feed's DISTINCT (type, ratio)
-- events in reach -- one event filed by two producers is one factor, the way
-- dedupeActions reads it -- and whether any single filing equals the detection.
-- FLOAT64 before the LN for action_split's reason; ROUND to silver's scale so
-- 2 x 5 is 10 however the log round-trip lands.
derived_verdict AS (
  SELECT
    market, listing_id, d_type, d_ex_date, d_ratio,
    ROUND(EXP(SUM(LN(CAST(f_ratio AS FLOAT64)))), 6) AS feed_product,
    MAX(CASE WHEN f_ratio = d_ratio THEN 1 ELSE 0 END) AS has_twin
  FROM (
    SELECT DISTINCT market, listing_id, d_type, d_ex_date, d_ratio, f_type, f_ratio
    FROM derived_window
  ) events
  GROUP BY market, listing_id, d_type, d_ex_date, d_ratio
),
-- ONE EVENT DESCRIBED TWICE. Two reasons, one list, because both end the same
-- way: the losing row's factor must not be multiplied in beside the winner's.
--
-- SUPPRESSION IS KEYED ON THE ACTION'S OWN IDENTITY -- (market, listing_id,
-- action_type, ex_date), which is action_latest's unique key -- so one row
-- here names exactly ONE action. It used to be keyed on (listing, ex_date,
-- ratio, cash) with action_type deliberately omitted, and that over-collapsed:
-- a single duplicate could match BOTH halves of a genuine same-date
-- BONUS+SPLIT composition and suppress the pair, under-dividing history by the
-- whole of one event. MONEY-1516 review (#6).
--
-- PROXIMITY IS COUNTED IN SESSION ORDINALS, NOT IN A JOINED SPAN. The old form
-- LEFT JOINed the bar table and counted rows with a GROUP BY that named only
-- the LATER action, so a later row with two qualifying earlier partners
-- summed both spans into one count and the HAVING never fired -- three
-- producers of one event yielded 0.04 where 0.2 is correct. carrier_idx
-- makes it an integer comparison evaluated PER PAIR, with no GROUP BY to get
-- wrong and no 36.8M-row intermediate to materialise. MONEY-1516 review (#2).
suppressed AS (
  -- SELECT DISTINCT over UNION ALL, never UNION DISTINCT: the latter is
  -- BigQuery grammar and SQLite refuses it outright -- the parity harness
  -- caught it on the first run, which is what that harness is for. Both
  -- dialects accept this form. The de-duplication matters because an action
  -- suppressed for BOTH reasons would otherwise appear twice and fan its row
  -- out in the LEFT JOIN below.
  SELECT DISTINCT market, listing_id, action_type, ex_date FROM (
  -- (1) THE DERIVED TWIN, and it is the reason part (a) needed this at all.
  --
  -- derive-corporate-actions.ts runs a price-cliff detector over the bars and
  -- files what it sees as a CAPITAL_ADJUSTMENT with source DERIVED. The
  -- exchange separately files the SAME event as a BONUS or a SPLIT. Mongo's key
  -- carries type, so both rows exist and describe one corporate action.
  --
  -- The UTC ex_date bug used to hide this: DERIVED rows are stored at 00:00Z
  -- and feed rows at 18:30Z the previous day, so a UTC render put them on
  -- ADJACENT days where the near-duplicate rule below caught them. Rendering in
  -- IST -- which is correct -- lands both on the SAME day, where a rule
  -- requiring later.ex_date > earlier.ex_date never examines the pair at all.
  -- Measured on prod: 31 such groups, 27 of them with a carrier bar. INFY
  -- carries TWO (2014-12-02 and 2015-06-15), so every INFY bar before 2014
  -- came out divided by 16 where 4 is correct; CIPLA 6.25 where 2.5 is right.
  -- The raw cliffs settle it -- they match ratio in 27 of 27 and ratio
  -- squared in 0 of 27.
  --
  -- price-adjust.ts has always resolved this by SOURCE_RANK (NSE 90 over
  -- DERIVED 10) inside dedupeActions. This is that rule, in SQL.
  --
  -- NOT "same ex_date": same or ADJACENT carrier, so a detector that picks a
  -- neighbouring bar is still recognised as the same event.
  SELECT d.market, d.listing_id, d.action_type, d.ex_date
  FROM action_latest d
  JOIN action_carrier cd
    ON cd.market = d.market AND cd.listing_id = d.listing_id AND cd.ex_date = d.ex_date
  JOIN action_latest f
    ON f.market = d.market
   AND f.listing_id = d.listing_id
   AND f.source <> 'DERIVED'
   AND COALESCE(f.ratio, -1) = COALESCE(d.ratio, -1)
   AND COALESCE(f.cash, -1) = COALESCE(d.cash, -1)
  JOIN action_carrier cf
    ON cf.market = f.market AND cf.listing_id = f.listing_id AND cf.ex_date = f.ex_date
  WHERE d.source = 'DERIVED'
    AND ABS(cd.carrier_idx - cf.carrier_idx) <= 1

  UNION ALL

  -- (2) THE LATER OF A SAME-TYPE NEAR-DUPLICATE. Two producers filing one
  -- event a session apart under the SAME type. The EARLIEST survives.
  --
  -- action_type MUST match. Cross-type pairs on one ex-date are GENUINE
  -- compositions -- a bonus and a split are two share-count changes, 167 such
  -- pairs on prod, and 13 of 15 same-source BONUS+SPLIT cliffs measure as
  -- ratio squared. The one cross-type duplicate that is real is the DERIVED
  -- twin, and branch (1) names it by source rather than by guessing from dates.
  --
  -- AT MOST ONE session between, not EXACTLY one: zero means both land on the
  -- SAME carrier bar, where not collapsing multiplies both factors into one
  -- bar. It also fires on a listing with a HOLE in its bar series -- the known
  -- cost, measured at five listings of 17,699.
  SELECT later.market, later.listing_id, later.action_type, later.ex_date
  FROM action_latest earlier
  JOIN action_carrier ce
    ON ce.market = earlier.market AND ce.listing_id = earlier.listing_id AND ce.ex_date = earlier.ex_date
  JOIN action_latest later
    ON later.market = earlier.market
   AND later.listing_id = earlier.listing_id
   AND later.action_type = earlier.action_type
   AND later.ex_date > earlier.ex_date
   AND COALESCE(later.ratio, -1) = COALESCE(earlier.ratio, -1)
   AND COALESCE(later.cash, -1) = COALESCE(earlier.cash, -1)
  JOIN action_carrier cl
    ON cl.market = later.market AND cl.listing_id = later.listing_id AND cl.ex_date = later.ex_date
  WHERE cl.carrier_idx - ce.carrier_idx <= 1

  UNION ALL

  -- (3) THE COMPOSED TWIN -- MONEY-1541. The feed's events in reach multiply to
  -- exactly the detected ratio, so the detector is describing all of them.
  SELECT market, listing_id, d_type, d_ex_date
  FROM derived_verdict
  WHERE has_twin = 0 AND feed_product = ROUND(d_ratio, 6)

  UNION ALL

  -- (4) THE PARTIAL FILING -- MONEY-1541. 1 < product < detected: the feed rows
  -- go and the detector's whole cliff stays. Not a guess at what the feed left
  -- out: the truth is the detection (the feed recorded part) or the product
  -- (the price also fell that day), and applying the detection alone is never
  -- further from either than applying both. price-adjust.ts states the proof;
  -- product > detected has no such bound and is left alone. On prod this is
  -- SUDARSCHEM:NSE, whose listing carries NSE's SPLIT 5 alone beside a
  -- detected 10.
  SELECT w.market, w.listing_id, w.f_type, w.f_ex_date
  FROM derived_window w
  JOIN derived_verdict v
    ON v.market = w.market
   AND v.listing_id = w.listing_id
   AND v.d_type = w.d_type
   AND v.d_ex_date = w.d_ex_date
  WHERE v.has_twin = 0
    AND v.feed_product > 1
    AND v.feed_product < ROUND(v.d_ratio, 6)
  )
),
-- Actions composed onto one carrier bar: ratios MULTIPLY (a bonus and a split
-- on one ex-date are two share-count changes — 167 such pairs on prod), cash
-- SUMS. BigQuery has no cumulative product, hence EXP(SUM(LN(...))) again.
action_at_bar AS (
  SELECT
    c.market,
    c.listing_id,
    c.carrier_date,
    -- CAST to FLOAT64 BEFORE the LN -- MONEY-1528 (A). In NUMERIC this very
    -- expression turns BONUS 10 + SPLIT 5 into 49.999999979.
    EXP(SUM(LN(CAST(
      CASE
        WHEN a.action_type IN (${basisTypes}) AND a.factor_ratio IS NOT NULL AND dup.listing_id IS NULL
          THEN a.factor_ratio
        ELSE 1
      END
    AS FLOAT64)))) AS action_split,
    SUM(
      CASE
        WHEN a.action_type IN (${cashTypes}) AND a.cash > 0 AND dup.listing_id IS NULL
          THEN a.cash
        ELSE 0
      END
    ) AS action_cash
  FROM action_latest a
  JOIN action_carrier c
    ON c.market = a.market AND c.listing_id = a.listing_id AND c.ex_date = a.ex_date
  LEFT JOIN suppressed dup
    ON dup.market = a.market
   AND dup.listing_id = a.listing_id
   AND dup.action_type = a.action_type
   AND dup.ex_date = a.ex_date
  GROUP BY c.market, c.listing_id, c.carrier_date
),
-- BOTH WITNESSES, ONE ROW PER BAR -- MONEY-1528 (D). What a bar STATES is
-- decided here, once, for the view's COALESCE and for discardedActionSql
-- alike (see the header). A non-positive split factor states no split and a
-- negative amount states no dividend, so neither blocks the action table; a
-- 1 and a 0 DO state "nothing happened", and a US bar carries them on every
-- ordinary session. bar_split is FLOAT64 for the reason prev_close is.
witnessed AS (
  SELECT
    b.market, b.listing_id, b.symbol, b.exchange, b.session_date,
    b.open, b.high, b.low, b.close, b.volume, b.div_cash, b.split_factor, b.source,
    b.prev_close,
    CAST(CASE WHEN b.split_factor > 0 THEN b.split_factor END AS FLOAT64) AS bar_split,
    CASE WHEN b.div_cash >= 0 THEN b.div_cash END AS bar_cash,
    a.action_split,
    a.action_cash
  FROM lagged b
  LEFT JOIN action_at_bar a
    ON a.market = b.market
   AND a.listing_id = b.listing_id
   AND a.carrier_date = b.session_date
)`;
}

/**
 * The full `SELECT` behind `lake_gold.adjusted_bar_d1`.
 *
 * @param {string} source        see `witnessCtesSql`.
 * @param {string} actionSource  see `witnessCtesSql`.
 * @returns {string} one SELECT statement, no trailing semicolon.
 */
function adjustedBarD1Sql(source, actionSource) {
  return `${witnessCtesSql(source, actionSource)},
factored AS (
  SELECT
    market, listing_id, symbol, exchange, session_date,
    open, high, low, close, volume, div_cash, split_factor, source,
    -- ONE split factor, from ONE witness. What the bar STATES wins; the action
    -- table can only fill where it states nothing. A US bar states 1 on an
    -- ordinary day, so an action row is unreachable there -- double
    -- application is not resolved by precedence, it is unrepresentable, and
    -- a witness it overrules is REPORTED by discardedActionSql, never applied.
    -- The > 0 notion of "usable" lives in bar_split itself now -- MONEY-1516
    -- review (#5), whose NULLIF closed it for the value 0 alone.
    CASE
      WHEN COALESCE(bar_split, action_split) > 0
        THEN COALESCE(bar_split, action_split)
      ELSE 1
    END AS split_eff,
    CASE
      WHEN prev_close > 0
       AND COALESCE(bar_cash, action_cash) > 0
       AND COALESCE(bar_cash, action_cash) < prev_close
        THEN 1 - COALESCE(bar_cash, action_cash) / prev_close
      ELSE 1
    END AS div_ratio
  FROM witnessed
),
cumulative AS (
  SELECT
    market, listing_id, symbol, exchange, session_date,
    open, high, low, close, volume, div_cash, split_factor, source,
    EXP(COALESCE(SUM(LN(div_ratio / split_eff)) OVER back_from_latest, 0)) AS price_factor,
    EXP(COALESCE(SUM(LN(1.0 / split_eff)) OVER back_from_latest, 0)) AS split_factor_cum
  FROM factored
  WINDOW back_from_latest AS (
    PARTITION BY market, listing_id
    ORDER BY session_date
    ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
  )
)
SELECT
  market,
  listing_id,
  symbol,
  exchange,
  session_date,
  open,
  high,
  low,
  close,
  volume,
  div_cash,
  split_factor,
  source,
  price_factor,
  split_factor_cum,
  CAST(open * price_factor AS NUMERIC) AS adj_open,
  CAST(high * price_factor AS NUMERIC) AS adj_high,
  CAST(low * price_factor AS NUMERIC) AS adj_low,
  CAST(close * price_factor AS NUMERIC) AS adj_close,
  CAST(ROUND(volume / split_factor_cum) AS INT64) AS adj_volume,
  '${ADJUSTMENT_POLICY_VERSION}' AS adjustment_policy_version
FROM cumulative`;
}

/**
 * Every bar where the view DISCARDED an action — MONEY-1528 (D).
 *
 * A row means: the action table resolved an event for this bar (a split factor
 * other than 1, or a positive dividend), the bar STATES something different,
 * and the bar won. Includes the 0 and 1 a US bar carries on an ordinary
 * session, which is the case the double-witness assertion's ±3-day half
 * excludes by value and therefore could never see.
 *
 * Compared at the columns' own scale, NUMERIC(18,6), so the last binary digit
 * of a composed ratio is not a disagreement.
 *
 * @param {string} source        see `witnessCtesSql`.
 * @param {string} actionSource  see `witnessCtesSql`.
 * @returns {string} one SELECT statement, no trailing semicolon.
 */
function discardedActionSql(source, actionSource) {
  return `${witnessCtesSql(source, actionSource)}
SELECT
  market,
  listing_id,
  session_date,
  split_factor AS bar_split_factor,
  div_cash AS bar_div_cash,
  source AS bar_source,
  action_split,
  action_cash
FROM witnessed
WHERE (
       ROUND(action_split, 6) <> 1
   AND bar_split IS NOT NULL
   AND ROUND(action_split, 6) <> ROUND(bar_split, 6)
     )
   OR (
       action_cash > 0
   AND bar_cash IS NOT NULL
   AND ROUND(action_cash, 6) <> ROUND(bar_cash, 6)
     )`;
}

module.exports = {
  typeListSql,
  ACTION_SOURCE_RANK,
  ACTION_SOURCE_RANK_DEFAULT,
  ADJUSTMENT_POLICY_VERSION,
  SOURCE_AUTHORITY,
  PRICE_BASIS_ACTION_TYPES,
  CASH_ACTION_TYPES,
  RATIO_FIRST_ACTION_TYPES,
  sourceAuthoritySql,
  adjustedBarD1Sql,
  discardedActionSql,
};
