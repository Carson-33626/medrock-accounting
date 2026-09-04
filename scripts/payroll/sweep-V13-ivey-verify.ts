/**
 * READ-ONLY — V13 verifier probe for L1-08 (Ivey residual duplicate cost). Checks three things
 * the finding claims but did not independently re-derive in this pass:
 *   1. Full detail of the underlying duplicate-payroll JEs TN Id 17938 and 17939 (dates, amounts).
 *   2. Whether any JE after 2026-04-30 touches Ivey's name or the $1,741.43 / $487.83 / $42.08 /
 *      $1,211.52 figures on Marketing Wages - Base, Employer Taxes, or WC accounts (i.e. did
 *      anyone already clear the residual).
 *   3. ADP mirror: any Ivey-named payroll_history row dated Q1/Q2 2026 that looks like a
 *      correction run (names + amounts only, not full decrypted dump).
 *
 *   npx tsx scripts/payroll/sweep-V13-ivey-verify.ts
 */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import { getRdsPool } from '../../src/lib/rds';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import type { SensitiveRow } from '../../src/lib/payroll/types';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface QbLineDetail { PostingType?: 'Debit' | 'Credit'; AccountRef?: { name?: string } }
interface QbLine { Amount?: number; Description?: string; JournalEntryLineDetail?: QbLineDetail }
interface QbJE { Id: string; DocNumber?: string; TxnDate?: string; Line?: QbLine[] }

function printJe(entity: string, je: QbJE): void {
  console.log(`\n  ${entity} JE Id=${je.Id} DocNumber="${je.DocNumber ?? ''}" ${je.TxnDate ?? ''}`);
  let dr = 0, cr = 0;
  for (const l of je.Line ?? []) {
    const side = l.JournalEntryLineDetail?.PostingType === 'Debit' ? 'Dr' : 'Cr';
    if (side === 'Dr') dr += l.Amount ?? 0; else cr += l.Amount ?? 0;
    console.log(`    ${side} ${money(l.Amount ?? 0).padStart(11)}  [${l.JournalEntryLineDetail?.AccountRef?.name ?? '?'}]  ${l.Description ?? ''}`);
  }
  console.log(`    -- totals: Dr ${money(dr)}  Cr ${money(cr)}  ${Math.abs(dr - cr) < 0.005 ? '(balances)' : '*** DOES NOT BALANCE ***'}`);
}

async function main(): Promise<void> {
  console.log('=== 1. TN JE Id 17938 and 17939 (the intercompany entries JE 20699 cites as the duplicate-wage source) ===');
  // These predate the closure JE — widen the window generously around the memo's implied dates.
  const wideWindow = await qbQueryAll<QbJE>('MedRock TN', 'JournalEntry', `WHERE TxnDate >= '2025-01-01' AND TxnDate <= '2026-04-30'`);
  console.log(`  (pulled ${wideWindow.length} TN JEs 2025-01-01..2026-04-30)`);
  for (const id of ['17938', '17939']) {
    const je = wideWindow.find((j) => j.Id === id);
    if (je) printJe('MedRock TN', je);
    else console.log(`\n  MedRock TN JE Id=${id}: NOT FOUND in 2025-01-01..2026-04-30 window`);
  }

  console.log('\n=== 2. Any TN JE after 2026-04-30 mentioning Ivey, or touching the residual figures, on the relevant expense accounts ===');
  const after = await qbQueryAll<QbJE>('MedRock TN', 'JournalEntry', `WHERE TxnDate >= '2026-05-01' AND TxnDate <= '2026-09-02'`);
  console.log(`  (pulled ${after.length} TN JEs 2026-05-01..2026-09-02)`);
  const residualAmounts = new Set(['487.83', '42.08', '1211.52', '1741.43', '529.91', '415.38', '207.69', '796.14', '945.29']);
  const hits = after.filter((j) => (j.Line ?? []).some((l) => {
    const desc = (l.Description ?? '').toLowerCase();
    const amt = (l.Amount ?? 0).toFixed(2);
    return desc.includes('ivey') || desc.includes('car allowance') || residualAmounts.has(amt);
  }));
  if (hits.length === 0) {
    console.log('  no JE line in this window mentions "Ivey" or matches the residual figures ($487.83 / $42.08 / $1,211.52 / $1,741.43 / $529.91) — the residual has NOT been cleared by any later JE.');
  } else {
    for (const j of hits) printJe('MedRock TN', j);
  }

  console.log('\n=== 3. ADP mirror: Ivey rows, Q1/Q2 2026, names + amounts only (no decryption of unrelated fields) ===');
  const pool = getRdsPool();
  const { rows } = await pool.query<{ position_id: string; name: string; pay_group: string; pay_date: string; row_key: string; sensitive_encrypted: string }>(
    `SELECT position_id, name, pay_group, pay_date, row_key, sensitive_encrypted FROM source.payroll_history WHERE name ILIKE '%ivey%' ORDER BY pay_date`,
  );
  console.log(`  ${rows.length} payroll_history rows for name ILIKE '%ivey%'`);
  const toDate = (d: string): string => { const parts = d.split('/'); return parts.length === 3 ? `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}` : d; };
  for (const r of rows) {
    console.log(`  ${r.pay_date} (${toDate(r.pay_date)})  ${r.name}  position=${r.position_id}  pay_group=${r.pay_group}  row_key=${r.row_key}`);
  }
  const q1q2 = rows.filter((r) => { const d = toDate(r.pay_date); return d >= '2026-01-01' && d <= '2026-06-30'; });
  console.log(`  ${q1q2.length} of those rows fall in Q1/Q2 2026 (2026-01-01..2026-06-30)`);

  console.log('\n  -- Q1/Q2 2026 rows: Net Pay / Gross Pay, and any column whose name suggests a correction, names + amounts only --');
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY missing');
  for (const r of q1q2) {
    const s: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
    const entries = Object.entries(s as Record<string, unknown>);
    const netGross = entries.filter(([k]) => /net pay|gross pay/i.test(k));
    const correctionLike = entries.filter(([k, v]) => /correct|adjust|amend|void|reissue/i.test(k) && (typeof v === 'number' ? v !== 0 : Boolean(v) && v !== '0' && v !== '0.00'));
    console.log(`  ${r.pay_date} (${entityFromPayGroup(r.pay_group)})  ` +
      netGross.map(([k, v]) => `${k}=${String(v)}`).join('  '));
    if (correctionLike.length > 0) {
      console.log(`      *** correction-like nonzero fields: ${correctionLike.map(([k, v]) => `${k}=${String(v)}`).join('  ')}`);
    }
  }
  await pool.end();
}

function entityFromPayGroup(pg: string): string {
  if (pg === 'MRFL') return 'FL';
  if (pg === 'MRTN') return 'TN';
  if (pg === 'MRTX') return 'TX';
  return pg;
}

void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
