-- events_for_listing(listing_id, since) — MONEY-1597 (C5b).
--
-- Every event on one listing observed on or after @since, newest first, with
-- the returns that followed it (gold.event_return_outcome) and what the event
-- said (the latest silver instrument_event row: title, tags, evidence_uri).
--
-- The listing is named EITHER by its full lake id in @listing_id, OR — for a
-- US ticker — by @us_symbol, resolved to its ACTIVE listing in silver.listing.
-- The unused one is bound to '' and matches nothing. A US ticker is not a
-- security (DOW is two companies), so the resolution is to the listing that
-- holds the ticker TODAY, and every row names the listing_id it came from.
--
-- NO EVENTS IS AN ANSWER ONLY IF THE LAKE KNOWS THE LISTING. Every row carries
-- listing_sessions: the listing's sessions in gold.rolling_stats since @since.
-- When there are no events the query still returns ONE row, with a NULL
-- event_id, so the tool can tell "no events" (sessions > 0) from "an id the
-- lake holds no bars for" (sessions = 0) — a misspelt or not-yet-loaded id
-- would otherwise come back as an empty success and be cached as a fact.
-- The count reads one listing over the window's month partitions.
--
-- @row_limit is the tool's cap + 1: the extra row is how it knows it cut.
-- Named parameters only. {{gold}} and {{silver}} are dataset names from the
-- tool's own configuration, never from a caller.
WITH target AS (
  SELECT @listing_id AS listing_id
  UNION DISTINCT
  SELECT listing_id
  FROM {{silver}}.listing
  WHERE market = 'US' AND status = 'ACTIVE' AND symbol = @us_symbol
),
coverage AS (
  SELECT COUNT(*) AS listing_sessions
  FROM {{gold}}.rolling_stats
  WHERE session_date >= PARSE_DATE('%Y-%m-%d', @since)
    AND listing_id IN (SELECT listing_id FROM target)
),
events AS (
  SELECT
    o.event_id,
    o.market,
    o.listing_id,
    o.event_type,
    e.title,
    e.tags,
    e.evidence_uri,
    e.source,
    o.observed_at,
    o.observed_date,
    o.window_status,
    o.base_session_date,
    o.session_date_1d,
    o.session_date_20d,
    o.ret_1d,
    o.ret_5d,
    o.ret_20d,
    o.abn_ret_1d,
    o.abn_ret_5d,
    o.abn_ret_20d,
    o.vol_20d_before,
    o.vol_20d_after,
    o.gap_open_pct,
    o.benchmark_id
  FROM {{gold}}.event_return_outcome AS o
  LEFT JOIN (
    SELECT event_id, title, tags, evidence_uri, source
    FROM {{silver}}.instrument_event
    -- One day of slack: a venue date of D is a UTC instant as early as D-1
    -- 18:30 (IST), and this prunes silver's DATE(observed_at) partitions.
    WHERE observed_at >= TIMESTAMP(DATE_SUB(PARSE_DATE('%Y-%m-%d', @since), INTERVAL 1 DAY))
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY event_id ORDER BY observed_at DESC, ingested_at DESC
    ) = 1
  ) AS e
    ON e.event_id = o.event_id
  WHERE o.observed_date >= PARSE_DATE('%Y-%m-%d', @since)
    AND o.listing_id IN (SELECT listing_id FROM target)
  ORDER BY o.observed_at DESC
  LIMIT @row_limit
)
SELECT c.listing_sessions, ev.*
FROM coverage AS c
LEFT JOIN events AS ev ON TRUE
ORDER BY ev.observed_at DESC
