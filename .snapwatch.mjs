import { MongoClient } from "mongodb";
const c = new MongoClient(process.env.MONGO_URL);
await c.connect();
const db = c.db();
const R = "stock_ratios_vendor_snapshot", F = "stock_financials_vendor_snapshot";
const names = (await db.listCollections().toArray()).map(x => x.name);
console.log("collections present:", [R, F].map(n => `${n}=${names.includes(n)}`).join("  "));
for (let i = 0; i < 25; i++) {
  const r = names.includes(R) ? await db.collection(R).countDocuments() : 0;
  const f = names.includes(F) ? await db.collection(F).countDocuments() : 0;
  const day = names.includes(R)
    ? (await db.collection(R).distinct("snapshotDay")).map(d => new Date(d).toISOString().slice(0,10)).join(",")
    : "-";
  console.log(`${new Date().toISOString().slice(11,19)}  ratios=${String(r).padStart(5)}/2135  financials=${String(f).padStart(6)}/32359  day=${day}`);
  if (r >= 2135 && f >= 32359) { console.log("  == both complete =="); break; }
  await new Promise(x => setTimeout(x, 20000));
}
await c.close();
