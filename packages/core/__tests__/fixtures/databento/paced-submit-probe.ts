/**
 * Child process for "a paced submit keeps the process alive" — MONEY-1539.
 *
 * Two submits 4.8 s apart on a fake clock, so the second one waits ~200 ms in
 * the pacer on the client's OWN default sleep (no `sleep` is injected). The
 * fetch is fake, so nothing else holds the event loop: if that sleep's timer is
 * unref'd, Node exits 0 mid-await and the line below is never printed — the
 * exact way the nightly append died. Shaped like the job's `main()`, so the
 * exit code is the job's too.
 */
import { submitBatchJob } from "../../../src/market-data/databento/databento-client";

process.env["DATABENTO_API_KEY"] = "probe-key";

const fetchImpl = async () =>
  ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => "",
    json: async () => ({
      id: "EQUS-PROBE",
      dataset: "EQUS.MINI",
      schema: "ohlcv-1m",
      symbols: "AAPL",
      start: "2024-01-02 00:00:00+00:00",
      end: "2024-01-03 00:00:00+00:00",
      state: "queued",
      ts_received: "2026-09-06T00:00:00Z",
      cost_usd: null,
    }),
    body: null,
  }) as never;

const req = {
  dataset: "EQUS.MINI",
  symbols: ["AAPL"],
  schema: "ohlcv-1m" as const,
  start: new Date("2024-01-02T00:00:00Z"),
  end: new Date("2024-01-03T00:00:00Z"),
  splitSymbols: false,
  splitDuration: "none" as const,
};

async function main(): Promise<void> {
  let clock = 1e12;
  await submitBatchJob(req, { fetchImpl, now: () => clock });
  clock += 4_800;
  await submitBatchJob(req, { fetchImpl, now: () => clock });
  console.log("SECOND-SUBMIT-RETURNED");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
