# workers/src/connect — Zerodha Connect (paid app) live-data code · DORMANT

MONEY-837. This is the relocated code for the **paid Kite Connect** app's three
exclusive capabilities — **historical candles, live quotes, live ticks** — that
the free Personal tier cannot serve. It lives here (workers = long-running Cloud
Run, can hold a WebSocket) so it's in its eventual runtime home.

**It is dormant.** Nothing imports it from `workers/src/index.ts`; no route,
processor, or Pub/Sub topic invokes it. It is **not** bundled into the running
worker (tsup only bundles the `src/index.ts` entry graph). It is kept here,
build-clean, for **future activation if/when we want live data**.

| File                                 | Capability                                                                                       | Kite                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `zerodha-client.ts`                  | live quotes (`getZerodhaQuote`/`getZerodhaQuotes`) + historical candles (`getZerodhaHistorical`) | `/quote`, `/instruments/historical` |
| `ws/zerodha-ws.ts` + `ws/base-ws.ts` | live tick WebSocket (Node `ws` package)                                                          | `wss://ws.kite.trade`               |
| `intraday-hub.ts`                    | shared WS pool + tick→bar aggregation + SSE fan-out                                              | —                                   |
| `tick-aggregator.ts`                 | OHLC bar aggregation                                                                             | —                                   |
| `types.ts`                           | local `QuoteData` / `HistoricalBar` shapes                                                       | —                                   |

## Auth (when activated)

The founder authenticates the Connect app via the web flow
`/api/brokers/zerodha-connect/...` (founder-gated, `deepshaswat@gmail.com`),
which stores the encrypted access token in a `BrokerConnection` row with
`broker = ZERODHA_CONNECT`. A future worker job would read that token (via
`@usemoney/security` decrypt) and use this code to serve candles/quotes/ticks.
Env: `ZERODHA_CONNECT_API_KEY` / `ZERODHA_CONNECT_API_SECRET`.

## Not here

The Personal app handles ALL sync (holdings/positions/tradebook/MF/profile +
the `/instruments` master via `ZERODHA_SYSTEM_API_KEY`); the MF NAV universe is
AMFI. None of that touches this folder. Web runtime market data is Yahoo.
