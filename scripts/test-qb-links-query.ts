/**
 * Read-only repro of the /api/inventory/qb-links route queries against RDS —
 * checks whether the new page's SQL errors at runtime.
 *   npx tsx scripts/test-qb-links-query.ts
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

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.RDS_DATABASE_URL,
    max: 1,
    ssl: { rejectUnauthorized: false },
  });

  const baseJoin = `
    FROM inventory.purchase_lots p
    LEFT JOIN inventory.qb_purchase_links l ON l.receipt_id = p.receipt_id
    LEFT JOIN inventory.qb_documents d ON d.qb_doc_key = l.qb_doc_key`;

  try {
    const rows = await pool.query(
      `SELECT p.receipt_id, p.location, p.date_received::text AS date_received,
              p.vendor, p.product_name, p.total_cost::float8 AS total_cost,
              COALESCE(l.status, 'unsynced') AS status,
              l.match_method, l.confidence::float8 AS confidence,
              l.qb_doc_key, d.doc_type, d.doc_id,
              d.vendor AS qb_vendor, d.txn_date::text AS qb_txn_date,
              d.paid_date::text AS qb_paid_date, d.total_amount::float8 AS qb_total,
              l.decided_by, l.notes,
              count(*) OVER ()::text AS total_rows
       ${baseJoin}
       WHERE p.receipt_id NOT LIKE 'OB|%'
       ORDER BY CASE COALESCE(l.status, 'unsynced')
                  WHEN 'review' THEN 0 WHEN 'unmatched' THEN 1 WHEN 'unsynced' THEN 2
                  WHEN 'auto' THEN 3 WHEN 'manual' THEN 4 ELSE 5 END,
                p.total_cost DESC NULLS LAST, p.date_received DESC
       LIMIT 5 OFFSET 0`,
    );
    console.log('list query OK, sample:');
    for (const r of rows.rows) {
      console.log(` ${r.status} ${r.location} ${r.date_received} $${r.total_cost} ${String(r.product_name).slice(0, 30)}`);
    }
    console.log('total_rows:', rows.rows[0]?.total_rows);

    const totals = await pool.query(
      `SELECT COALESCE(l.status, 'unsynced') AS status,
              count(*)::text AS receipts, COALESCE(sum(p.total_cost), 0)::text AS value
       FROM inventory.purchase_lots p
       LEFT JOIN inventory.qb_purchase_links l ON l.receipt_id = p.receipt_id
       WHERE p.receipt_id NOT LIKE 'OB|%'
       GROUP BY 1`,
    );
    console.log('totals query OK:');
    for (const r of totals.rows) console.log(` ${r.status}: ${r.receipts} receipts $${Math.round(Number(r.value)).toLocaleString()}`);

    const sync = await pool.query(
      `SELECT location, max(synced_at)::text AS synced_at FROM inventory.qb_documents GROUP BY location`,
    );
    console.log('lastSync query OK:', JSON.stringify(sync.rows));
  } finally {
    await pool.end();
  }
}

void main();
