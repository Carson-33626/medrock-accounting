/**
 * One-off runner: invoke the QB-links sync engine directly (no HTTP server).
 * Loads web/.env.local manually, then dynamically imports the lib so its
 * module-level env reads see the values.
 *
 *   npx tsx scripts/sync-qb-links.ts TN TX
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) {
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const SHORT_TO_LOCATION: Record<string, 'MedRock FL' | 'MedRock TN' | 'MedRock TX'> = {
  FL: 'MedRock FL',
  TN: 'MedRock TN',
  TX: 'MedRock TX',
};

async function main(): Promise<void> {
  const { syncQbLinks } = await import('../src/lib/qb-links');
  const args = process.argv.slice(2).map((a) => a.toUpperCase());
  const targets = args.length > 0 ? args : ['TN', 'TX'];

  for (const short of targets) {
    const location = SHORT_TO_LOCATION[short];
    if (!location) {
      console.error(`Unknown location: ${short}`);
      continue;
    }
    console.log(`\n=== Syncing ${location} ===`);
    try {
      const r = await syncQbLinks(location);
      console.log(
        `docs: ${r.bills} bills + ${r.purchases} purchases (${r.billPayments} bill payments)\n` +
          `receipts: ${r.receipts}\n` +
          `auto: ${r.counts.auto} ($${Math.round(r.values.auto).toLocaleString()})\n` +
          `review: ${r.counts.review} ($${Math.round(r.values.review).toLocaleString()})\n` +
          `unmatched: ${r.counts.unmatched} ($${Math.round(r.values.unmatched).toLocaleString()})\n` +
          `preserved manual decisions: ${r.preservedDecisions}`,
      );
    } catch (err) {
      console.error(`${location} FAILED:`, err instanceof Error ? err.message : err);
    }
  }
  process.exit(0);
}

void main();
