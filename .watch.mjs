import { MongoClient } from "mongodb";
const c = new MongoClient(process.env.MONGO_URL);
await c.connect();
const col = c.db().collection("mf_portfolio_holdings");
const aug = new Date("2026-08-01T00:00:00Z");
for (let i = 0; i < 40; i++) {
  const rows = await col.countDocuments({ period: aug });
  const coded = await col.countDocuments({ period: aug, amfiSchemeCode: { $ne: null } });
  const arr = await col.countDocuments({ period: aug, amfiSchemeCodes: { $exists: true, $ne: [] } });
  const schemes = (await col.distinct("schemeKey", { period: aug })).length;
  const amcs = (await col.distinct("amc", { period: aug })).length;
  console.log(`${new Date().toISOString().slice(11,19)}  rows=${String(rows).padStart(6)} schemes=${String(schemes).padStart(4)} amcs=${String(amcs).padStart(2)} coded=${String(coded).padStart(6)} codesArr=${String(arr).padStart(6)}`);
  await new Promise(r => setTimeout(r, 60000));
}
await c.close();
