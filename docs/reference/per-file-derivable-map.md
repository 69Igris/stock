# Per-file derivable map — NSE/BSE report families

**Provenance:** extracted 9-Aug-2026 from `nse-bse-data-engine-audit-jul2026.md` §5
(UseMoney - Research folder — outside the repo, which is why MONEY-1100's "§5"
reference dangled). Committed here so tickets P4/P11 reference it in-repo.

**Conflict rule (settles the discrepancy class up front):** column lists below
are the _semantic_ layer — what fields mean and what they derive. Where a list
disagrees with the bytes in `feeds/…`, **the archived file wins**; update this
doc in the same commit as the parser. Rows marked ✔ were live-measured during
the Jul/Aug audits; unmarked lists are the standard published layouts — verify
the header row against one archived file before coding each parser.

---

## Archive-verified corrections (10-Aug-2026, post MONEY-1169 repair)

First verification pass run against the REPAIRED archive (the corruption fix
made the archived bytes readable for the first time). Confirmed exact: `sec_bhavdata_full`
(incl. space padding), `ind_close_all` (all 13 columns), UDiFF (already parsed
in prod). Corrections, per the conflict rule — the archived file wins:

1. **Legacy CM bhavcopy is SHORT-width far later than "mid-1998".** Both
   `cm02JAN1995bhav.csv` _and_ `cm14NOV2006bhav.csv` end at `TIMESTAMP,`
   (trailing comma = one empty column; no `TOTALTRADES`, no `ISIN`). The
   existing `parseOldNseCmBhavcopy` (P3) already tolerates both widths and
   counts `withoutIsin` — keep resolving pre-ISIN rows by symbol@exchange.
   Check a ~2015+ file before relying on the wide form anywhere.
2. **MTO data rows carry NO `SERIES` column** (2026 format). Verified layout:
   header meta rows (`10,MTO,…`), a column-header line, then
   `20,<srNo>,<security name>,<traded>,<deliverable>,<pct>` — six fields.
   Parse record-type `20` keyed on the in-file header line, not a guessed
   positional layout; older eras may differ.
3. **`SCBSEALL` fields now pinned** (map said "verify"):
   `DATE|SCRIP CODE|DELIVERY QTY|DELIVERY VAL|DAY'S VOLUME|DAY'S TURNOVER|DELV. PER.`
   — seven pipe-delimited fields, zero-padded fixed-width numerics, **no scrip
   name column**. Join by `SCRIP CODE` → InstrumentMapping via the BSE scrip
   master, exactly as §7 prescribes.
4. **`CM_52_wk_High_low` opens with a DISCLAIMER line**, not the header — the
   real header appears further down. Parser must skip preamble rows until the
   header matches. **`eq_band_changes` actual header:**
   `Sr. No,Symbol,Series,Security Name,From,To` — no explicit effective-date
   column; the date is the file's date.

### Wave-2 additions (11-Aug-2026, P4.2/P4.5/P4.6 agents — every item fixture-verified)

5. **`ind_close_all` provenance + quirks (§2):** the file the engine parses
   daily comes from **nsearchives** (`feeds/NSE/indices/`); niftyindices
   `Daily_Snapshot` (`feeds/NSE/index-snapshot/`) is the backfill-only second
   source — two prefixes, one layout. NSE writes sub-1 decimals with a leading
   dot (`.97`, `-.22`) and `Index Date` is **`DD-MM-YYYY`** (not `DD-MMM-YYYY`).
   Rows are PARTIALLY null: `Nifty50 Dividend Points` prints `-` for
   O/H/L/Vol/Turnover/P-E/P-B/DivYield with a real close.
6. **`fo_secban` has NO header (§3):** line 1 is a banner —
   `Securities in Ban For Trade Date DD-MMM-YYYY:` — whose date is
   authoritative; data rows are `serial,SYMBOL`.
7. **`sec_list` carries ASM/GSM stage in a `Remarks` column (§4):** real header
   `Symbol,Series,Security Name,Band,Remarks` with e.g. `"GSM STAGE - I"`.
   Since both dedicated surveillance families 404 at their registered paths,
   this column is currently the ONLY archived surveillance-stage source.
8. **`shortselling` names its symbol column `Symbol Name`** and carries a
   per-row `Trade Date`; `series_change` has `Security` + `Remarks` columns and
   rows dated years before the fetch (confirmed rolling).
9. **`block.csv` has NO `Remarks` column** — 7 columns, stopping at
   `Trade Price / Wght. Avg. Price`; bulk's 8-column header matches the map
   verbatim (✔). Bulk's `Remarks` prints `-` (null), not blank.
10. **Deals snapshots are FETCH-DAY keyed (§5):** bulk was all Friday and block
    all Monday in the same capture pass — a row's own `Date` wins and
    `expectedDate` must never filter (rolling; registry agrees).
11. **SLB stays unverified:** `nse-slb-openpos` probed 404; its parser + model
    are map-derived and must be re-verified against the first real file.

---

## 1. CM cash prices

**UDiFF bhavcopy (NSE CM + BSE CM — same SEBI UDiFF schema, ✔ both in prod daily since MONEY-851):**
`TradDt, BizDt, Sgmt, Src, FinInstrmTp, FinInstrmId, ISIN, TckrSymb, SctySrs, XpryDt, FininstrmActlXpryDt, StrkPric, OptnTp, FinInstrmNm, OpnPric, HghPric, LwPric, ClsPric, LastPric, PrvsClsgPric, UndrlygPric, SttlmPric, OpnIntrst, ChngInOpnIntrst, TtlTradgVol, TtlTrfVal, TtlNbOfTxsExctd, SsnId, NewBrdLotQty, Rmks, Rsvd1..4`.
Derivables: EOD OHLCV universe-wide; VWAP ≈ TtlTrfVal÷TtlTradgVol; avg-trade-size = TtlTradgVol÷TtlNbOfTxsExctd (liquidity screen); series/group → equity-vs-debt classification (MONEY-1093); ISIN joins; with corp actions → adjusted series (MONEY-1109). BSE group letters ride `SctySrs`; `FinInstrmTp` is uniformly STK on BSE cash — useless for equity-vs-debt, use group + ISIN prefix.

**`sec_bhavdata_full_{DDMMYYYY}.csv` ✔ (the P4.1 target):**
`SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER`.
Gotchas to verify on an archived file: values are space-padded after commas (trim everything); `DATE1` is `DD-MMM-YYYY`; `DELIV_QTY`/`DELIV_PER` carry `-` placeholders on some rows — treat `-` as null, NOT zero (for trade-for-trade series like BE/BZ delivery is 100% by construction; decide explicitly whether to store null or 100 and document it); `TURNOVER_LACS` is in lakhs (₹). Derivables: delivery-% history (accumulation/distribution), delivery spikes vs 20-day mean, true daily VWAP (`AVG_PRICE`), trade-count. One file replaces bhavcopy+MTO for dates it covers (~Oct-2019→).

**MTO `MTO_{DDMMYYYY}.DAT` ✔ (delivery before sec_bhavdata_full; ≈Apr-2003→):** positional/comma DAT with record-type prefixes — header rows then data rows shaped `20, <srNo>, <security name>, <tradedQty>, <deliverableQty>, <delivPct>` (no SERIES — see corrections above). Parse only record-type 20 rows; key on the in-file header line.

**Legacy CM bhavcopy `cm{DD}{MMM}{YYYY}bhav.csv` (1994→Jul-2024, SPARSE):**
`SYMBOL, SERIES, OPEN, HIGH, LOW, CLOSE, LAST, PREVCLOSE, TOTTRDQTY, TOTTRDVAL, TIMESTAMP[, TOTALTRADES, ISIN]` — the wide form appears only in later eras (short-width verified through at least 2006; see corrections). Parser must tolerate both widths; pre-ISIN rows resolve by symbol@exchange only.

**SME bhavcopy `sme{DDMMYYYY}.csv`:** legacy-style columns for the Emerge board; check overlap vs CM UDiFF (series SM/ST/SO) before double-ingesting (P11 item 5).

## 2. Indices

**`ind_close_all_{DDMMYYYY}.csv` ✔ (niftyindices canonical, Apr-2013→):**
`Index Name, Index Date, Open Index Value, High Index Value, Low Index Value, Closing Index Value, Points Change, Change(%), Volume, Turnover (Rs. Cr.), P/E, P/B, Div Yield`.
The engine currently stores OHLC only — **P/E, P/B, Div Yield, Volume, Turnover are fetched and discarded daily** (P4.2 adds them to IndexClose). `-` = null. Index name is cosmetically unstable → keep the existing `toIndexSlug` keying.

**niftyindices POST endpoints (deep history):** `getHistoricaldatatabletoString` (OHLC), `getpepbHistoricaldataDBtoString` (P/E-P/B-DivYield, ~1999→), `getTotalReturnIndexString` (TRI) — body `{"cinfo":"{'name':'<INDEX>','startDate':'DD-MMM-YYYY','endDate':'DD-MMM-YYYY','indexName':'<INDEX>'}"}`, JSON-in-string; chunk ≤1y.

**BSE `ProduceCSVForDate/w`:** `Date, Open, High, Low, Close` per index; pre-modern years close-only (✔ 1986: O/H/L blank on all 199 rows) → null OHL.

## 3. F&O

**FO UDiFF bhavcopy:** same UDiFF columns as §1 with `XpryDt, StrkPric, OptnTp, SttlmPric, OpnIntrst, ChngInOpnIntrst, UndrlygPric` live. Derivables (P4.4 `DerivativeSummary`): futures basis = fut ClsPric − underlying close; term structure across expiries; **rollover %** = near-expiry OI migration in expiry week; **PCR** by OI and by volume from options rows; max-pain (strike minimizing ITM payout over OI); OI-buildup quadrant from ΔOI × Δprice (LONG|SHORT|LONG_UNWIND|SHORT_COVER); IV needs a pricer (MONEY-1116, Black-76 on SttlmPric).

**`FOSett_prce_{DDMMYYYY}.csv`:** contract-wise daily settlement prices — authoritative settle when UDiFF `SttlmPric` is blank on illiquid strikes.
**`fo_secban_{DDMMYYYY}.csv` ✔ pattern:** one symbol per row under a header — the day's F&O ban list → StockFlag.
**`fao_participant_oi/vol_{DDMMYYYY}.csv`:** 4 data rows (Client, DII, FII, Pro) × columns for Future Index Long/Short, Future Stock L/S, Option Index Call/Put L/S, Option Stock C/P L/S, Total L/S — small fixed matrix; P11 `MarketPositioning`.
**`mwpl_cli_{DDMMYYYY}.xls`, `combineoi_deleq_{DDMMYYYY}.csv`, `ncloi_{DDMMYYYY}.zip`:** MWPL + combined OI per security → utilisation % (P11).
**`fii_stats_{DD-Mon-YYYY}.xls`:** FII derivatives buy/sell/OI by instrument class (P11).

## 4. Per-stock flag files (P4.5 → StockFlag)

**52wk `CM_52_wk_High_low_{DDMMYYYY}.csv`:** disclaimer preamble line(s), then `SYMBOL, SERIES, Adjusted_52_Week_High, 52_Week_High_Date, Adjusted_52_Week_Low, 52_Week_Low_DT` (header wording drifts — match case-insensitively, skip preamble until the header row).
**PE `peDetail/PE_{DDMMYY}.csv` ✔ measured:** `SYMBOL, SYMBOL P/E, ADJUSTED P/E`.
**Band changes `eq_band_changes_{DDMMYYYY}.csv` ✔:** `Sr. No, Symbol, Series, Security Name, From, To` — next-trade-date band moves; effective date = file date.
**Complete band list `sec_list_{DDMMYYYY}.csv`:** symbol → applicable price band (No Band for F&O names).
**Surveillance `REG_IND{DDMMYY}.csv` / `REG1_IND{DDMMYY}.csv`:** symbol → surveillance indicator (ASM/GSM stage codes) — the differentiating retail warning; store code verbatim + decode table in code.
**`series_change.csv` (rolling):** symbol, old series, new series, effective date — BE↔EQ migrations.
**`shortselling_{DDMMYYYY}.csv`:** day's short-selling disclosures.

## 5. Deals (P4.6)

**`bulk.csv` / `block.csv` (rolling snapshots) + `/api/historicalOR/bulk-block-short-deals` (history, ≤365d/call):**
`Date, Symbol, Security Name, Client Name, Buy/Sell, Quantity Traded, Trade Price / Wght. Avg. Price, Remarks`.
Unique key = all fields (same client can print twice legitimately — dedupe only exact duplicates). Derivables: named-entity institutional prints, repeat-buyer detection, feeds MONEY-1117.

**SLB (`SLBM_BC{DDMMYYYY}.DAT`, `slb_openpos_{DDMMYYYY}.csv`, `SLB_ELG_SEC_{DDMMYYYY}.csv`):** lending volumes/fees + open positions per security → borrow-demand ≈ short-interest proxy.

## 6. Debt (P11 item 3)

**`wdmlist_{DDMMYYYY}.csv` ✔:** `SECTYPE, SECURITY, …, ISIN, STATUS` (+ coupon/maturity embedded in security naming) → BondMaster.
**`cbm_trd{YYYYMMDD}.csv`** and **`corpbond{DDMMYYYY}.csv` ✔** (`MARKET, SERIES, SYMBOL, SECURITY, …, HI_52_WK, LO_52_WK` + price/yield/volume cols): traded corp-bond prices/yields → BondEOD (ISIN join gives the ~12k DEBT instruments prices).
**`TRM_BC{DDMMYYYY}.csv` ✔ pattern:** tri-party repo bhavcopy (optional).

## 7. BSE specifics

**`SCBSEALL{DDMM}.zip` ✔ ≥2007 (P4.1 BSE leg):** pipe-delimited gross delivery per scrip —
`DATE|SCRIP CODE|DELIVERY QTY|DELIVERY VAL|DAY'S VOLUME|DAY'S TURNOVER|DELV. PER.`
(live-verified 10-Aug-2026; zero-padded numerics, no scrip-name column). Join scrip code → InstrumentMapping via the BSE scrip master (`scrip_id`), NOT by name.
**Scrip master `ListofScripData/w?segment=Debt` ✔ (in prod):** `scrip_id, Scrip_Name, ISIN, GROUP, Mktcap, FaceValue, Industry, status…` — group letter F/G = debt (MONEY-1093 classifier input); Mktcap field feeds the market-cap derivable.

## 8. Masters (context for every join)

`EQUITY_L.csv` ✔: `SYMBOL, NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE` (SME master same shape) — listing age, face value (split detection cross-check), delisting detection by disappearance (tolerate multi-day absence before flagging).

---

_Everything above feeds: P4 (MONEY-1100) items 1–6, P7 (MONEY-1101), P11 (parse-the-tail), MONEY-1108/1109/1116/1117. When a parser lands, move its family's row here from "expected" to ✔ with the archived file it was verified against._
