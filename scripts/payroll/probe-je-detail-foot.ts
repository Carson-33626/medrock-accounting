/**
 * READ-ONLY: does each JE kind's source-detail sheet foot to the entry it accompanies?
 *
 * DS §7 acceptance 2. Picks one real stored header per kind, assembles the workbook the
 * download and the QuickBooks attachment both ship, and checks the detail sheet's Debit/Credit
 * totals against the header's. No writes, no QuickBooks post, no upload.
 *
 *   npx tsx scripts/payroll/probe-je-detail-foot.ts [headerId ...]
 */
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { loadDraft } from '../../src/lib/payroll/store';
import { buildJeSourceWorkbook } from '../../src/lib/payroll/je-workbook';
import type { CellValue } from '../../src/lib/inventory-export';

const round2 = (n: number): number => Math.round(n * 100) / 100;

function colTotal(rows: Record<string, CellValue>[], keys: string[]): number {
  const key = keys.find((k) => rows.some((r) => typeof r[k] === 'number'));
  if (!key) return 0;
  let cents = 0;
  for (const r of rows) {
    // The TOTAL row restates the column; counting it would double every figure.
    const first = Object.values(r)[0];
    if (typeof first === 'string' && first.toUpperCase() === 'TOTAL') continue;
    const v = r[key];
    if (typeof v === 'number') cents += Math.round(v * 100);
  }
  return cents / 100;
}

async function pickHeaders(): Promise<number[]> {
  const { rows } = await getRdsPool().query<{ id: string; kind: string }>(
    `SELECT DISTINCT ON (kind) id::text, kind
       FROM accounting.payroll_journal_headers
      WHERE kind IN ('pay_date','allocation','inventory')
      ORDER BY kind, (status = 'posted') DESC, updated_at DESC`,
  );
  return rows.map((r) => Number(r.id));
}

async function main(): Promise<void> {
  const argIds = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));
  const ids = argIds.length > 0 ? argIds : await pickHeaders();

  for (const id of ids) {
    const loaded = await loadDraft(id);
    if (!loaded) {
      console.log(`\n#${id}: header not found`);
      continue;
    }
    const { header, lines } = loaded;
    console.log(
      `\n#${id} ${header.entity} kind=${header.kind} status=${header.status} pay_date=${header.pay_date} ` +
      `seg='${header.period_segment}' lines=${lines.length} Dr ${header.total_debits} / Cr ${header.total_credits}`,
    );

    const wb = await buildJeSourceWorkbook(header, lines, { skipAccountNums: true });
    console.log(`  sheets: ${wb.sheets.map((s) => `${s.name} (${s.rows.length} rows)`).join(', ')}`);

    for (const sheet of wb.sheets.slice(1)) {
      const dr = colTotal(sheet.rows, ['debit']);
      const cr = colTotal(sheet.rows, ['credit']);
      if (dr === 0 && cr === 0) {
        // Sheets like `Lot detail` carry evidence rather than Dr/Cr — report their own total.
        const rv = colTotal(sheet.rows, ['remaining_value', 'fifo_value']);
        console.log(`  ${sheet.name}: value column total ${rv.toFixed(2)}`);
        continue;
      }
      const okDr = round2(dr) === round2(header.total_debits);
      const okCr = round2(cr) === round2(header.total_credits);
      console.log(
        `  ${sheet.name}: Dr ${dr.toFixed(2)} vs ${header.total_debits.toFixed(2)} ${okDr ? 'FOOTS' : 'MISMATCH'} | ` +
        `Cr ${cr.toFixed(2)} vs ${header.total_credits.toFixed(2)} ${okCr ? 'FOOTS' : 'MISMATCH'}`,
      );
    }
    if (wb.sheets.length === 1) console.log('  (no detail sheets — see the je-detail-fetch warning above for why)');
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
