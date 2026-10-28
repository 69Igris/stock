/**
 * Seed All
 *
 * Orchestrates all seed scripts in the correct order:
 *   1. Instruments (master data)
 *   2. Mutual Funds (AMFI feed + metadata)
 *   3. Sectors (Yahoo Finance enrichment)
 *   4. Prices (latest quotes)
 *
 * Usage: npx tsx scripts/seed/seed-all.ts
 */

import { execSync } from "child_process";

const scripts = [
  { name: "Instruments", file: "scripts/seed/seed-instruments.ts" },
  { name: "Mutual Funds", file: "scripts/seed/seed-mf.ts" },
  { name: "Sectors", file: "scripts/seed/seed-sectors.ts" },
  { name: "Prices", file: "scripts/seed/seed-prices.ts" },
];

async function main() {
  console.log("=== UseMoney Full Seed ===\n");

  for (const script of scripts) {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`Running: ${script.name}`);
    console.log(`${"=".repeat(50)}\n`);

    try {
      execSync(`npx tsx ${script.file}`, {
        stdio: "inherit",
        cwd: process.cwd(),
      });
      console.log(`\n${script.name} completed successfully.`);
    } catch (error) {
      console.error(`\n${script.name} FAILED.`);
      console.error("Continuing with next script...\n");
    }
  }

  console.log("\n=== Full Seed Complete ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed-all failed:", err);
    process.exit(1);
  });
