/**
 * READ-ONLY probe: quantify duplicate Amazon transactions in QBO (Ramp sync +
 * Amazon Business feed both writing). Uses the inventory.qb_documents snapshot
 * (all Bills + Purchases since 2025-06, all 3 companies, synced today).
 * Candidate dupe = two distinct docs, same amount, vendor contains 'amazon',
 * txn dates within 5 days, same location.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) {
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

interface DocRow {
  qb_doc_key: string;
  location: string;
  doc_type: string;
  vendor: string | null;
  txn_date: string;
  total_amount: number;
}

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.RDS_DATABASE_URL,
    max: 1,
    ssl: { rejectUnauthorized: false },
  });

  const vendors = await pool.query<{ location: string; vendor: string; n: number; total: number }>(
    `SELECT location, vendor, count(*)::int AS n, round(sum(total_amount))::float8 AS total
     FROM inventory.qb_documents
     WHERE vendor ILIKE '%amazon%'
     GROUP BY location, vendor ORDER BY location, total DESC`,
  );
  console.log('Amazon-ish vendors in QBO docs:');
  console.table(vendors.rows);

  const docs = await pool.query<DocRow>(
    `SELECT qb_doc_key, location, doc_type, vendor, txn_date::text AS txn_date,
            total_amount::float8 AS total_amount
     FROM inventory.qb_documents
     WHERE vendor ILIKE '%amazon%' AND total_amount > 0
     ORDER BY location, total_amount, txn_date`,
  );

  // pair docs: same location + amount (cents), dates within 5 days, distinct docs
  const byKey = new Map<string, DocRow[]>();
  for (const d of docs.rows) {
    const k = `${d.location}|${Math.round(d.total_amount * 100)}`;
    const arr = byKey.get(k);
    if (arr) arr.push(d);
    else byKey.set(k, [d]);
  }

  let pairCount = 0;
  let pairValue = 0;
  const samples: string[] = [];
  const paired = new Set<string>();
  for (const group of byKey.values()) {
    for (let i = 0; i < group.length; i++) {
      if (paired.has(group[i].qb_doc_key)) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (paired.has(group[j].qb_doc_key)) continue;
        const days = Math.abs(
          (Date.parse(group[i].txn_date) - Date.parse(group[j].txn_date)) / 86_400_000,
        );
        if (days <= 5) {
          paired.add(group[i].qb_doc_key);
          paired.add(group[j].qb_doc_key);
          pairCount += 1;
          pairValue += group[i].total_amount;
          if (samples.length < 15) {
            samples.push(
              `${group[i].location.padEnd(11)} $${group[i].total_amount.toFixed(2).padStart(9)}  ` +
                `${group[i].txn_date} ${group[i].doc_type}(${(group[i].vendor ?? '').slice(0, 18)})` +
                ` <-> ${group[j].txn_date} ${group[j].doc_type}(${(group[j].vendor ?? '').slice(0, 18)})`,
            );
          }
          break;
        }
      }
    }
  }

  console.log(`\nAmazon docs total: ${docs.rows.length}`);
  console.log(`Candidate duplicate pairs (same loc+amount, <=5d apart): ${pairCount}  ($${Math.round(pairValue).toLocaleString()} double-counted)`);
  console.log('\nSample pairs:');
  for (const s of samples) console.log(' ', s);

  // monthly distribution of candidate dupes — is May (their current month) affected?
  const monthly = new Map<string, { n: number; v: number }>();
  for (const group of byKey.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const days = Math.abs(
          (Date.parse(group[i].txn_date) - Date.parse(group[j].txn_date)) / 86_400_000,
        );
        if (days <= 5) {
          const m = group[i].txn_date.slice(0, 7);
          const e = monthly.get(m) ?? { n: 0, v: 0 };
          e.n += 1;
          e.v += group[i].total_amount;
          monthly.set(m, e);
          break;
        }
      }
    }
  }
  console.log('\nBy month:');
  for (const [m, e] of [...monthly.entries()].sort()) {
    console.log(`  ${m}: ${e.n} pairs  $${Math.round(e.v).toLocaleString()}`);
  }

  await pool.end();
}

void main();
