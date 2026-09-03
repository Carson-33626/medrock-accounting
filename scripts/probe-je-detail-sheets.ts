/**
 * Read-only: assemble the new JE evidence sheets against a REAL stored draft and
 * check they foot.
 *
 * Acceptance #2 of docs/fifo-monthly-close/ds-je-source-attachments.md — the
 * detail must add up to the entry it accompanies. A detail file that does not
 * foot is worse than no attachment, because it looks authoritative.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../src/lib/rds-ssl';
import { fetchJeLotDetail } from '../src/lib/inventory/ledger-values';
import { buildInventoryJeDetailSheets } from '../src/lib/inventory/je-detail';
import type { JournalLine, PostingType, LineOrigin, CreditBucket } from '../src/lib/payroll/types';

const envText = readFileSync(resolve(__dirname, '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) {
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const HEADER_IDS = [2723, 2724, 2725];

interface LineRow {
  posting_type: PostingType;
  amount: string;
  account_name: string;
  memo: string | null;
  origin: LineOrigin;
  source_row_keys: string[];
}

const money = (n: number): string => n.toFixed(2).padStart(14);

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });

  for (const id of HEADER_IDS) {
    const { rows: hdr } = await pool.query<{ entity: string; period_end: string | null }>(
      `SELECT entity, period_end::text AS period_end
       FROM accounting.payroll_journal_headers WHERE id = $1`,
      [id],
    );
    if (hdr.length === 0) {
      console.log(`#${id}: not found\n`);
      continue;
    }
    const monthEnd = hdr[0].period_end ?? '';

    const { rows: lineRows } = await pool.query<LineRow>(
      `SELECT posting_type, amount, account_name, memo, origin, source_row_keys
       FROM accounting.payroll_journal_lines WHERE header_id = $1 ORDER BY sort_order`,
      [id],
    );
    const lines: JournalLine[] = lineRows.map((r) => ({
      postingType: r.posting_type,
      amount: Number(r.amount),
      accountName: r.account_name,
      departmentName: null,
      className: null,
      memo: r.memo ?? '',
      creditBucket: null as CreditBucket | null,
      origin: r.origin,
      sourceRowKeys: r.source_row_keys,
    }));

    const receiptIds = [...new Set(lines.flatMap((l) => l.sourceRowKeys))];
    const lots = await fetchJeLotDetail(pool, receiptIds, monthEnd.slice(0, 7));
    const [bridge, detail] = buildInventoryJeDetailSheets(lines, lots, monthEnd);

    console.log(`=== #${id} ${hdr[0].entity} ${monthEnd} — ${lines.length} lines, ${receiptIds.length} receipts, ${lots.length} lots found`);
    for (const r of bridge.rows) {
      console.log(
        [
          String(r.account ?? '').padEnd(42),
          money(Number(r.debit ?? 0)),
          money(Number(r.credit ?? 0)),
          `fifo ${r.fifo_value === null ? '—'.padStart(14) : money(Number(r.fifo_value))}`,
          `book ${r.implied_book === null ? '—'.padStart(14) : money(Number(r.implied_book))}`,
          String(r.category ?? '').slice(0, 34),
        ].join('  '),
      );
    }

    const bridgeFifo = Number(bridge.rows.at(-1)?.fifo_value ?? 0);
    const lotTotal = Number(detail.rows.at(-1)?.remaining_value ?? 0);
    const missing = receiptIds.length - lots.length;
    console.log(
      `    lot sheet: ${detail.rows.length - 1} lots, Σ remaining ${lotTotal.toFixed(2)} ` +
        `| bridge Σ FIFO ${bridgeFifo.toFixed(2)} | ${Math.abs(lotTotal - bridgeFifo) < 0.005 ? 'FOOTS ✓' : 'MISMATCH ✗'}` +
        `${missing > 0 ? ` | ${missing} receipt ids had no lot row` : ''}`,
    );
    console.log('');
  }

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
