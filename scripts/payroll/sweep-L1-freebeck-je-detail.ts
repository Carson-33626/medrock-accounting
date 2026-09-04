/**
 * READ-ONLY — Books Sweep lane L1. Pulls the FULL JournalEntry detail (every line, both sides)
 * for the TN JEs tied to Audrey Freebeck's duplicate SIC payout (K07 / L1-03), plus her ADP
 * payroll_history rows for the same pay period, so the proposed correction can state both legs
 * against an independent source rather than a single account-line memo.
 *
 *   npx tsx scripts/payroll/sweep-L1-freebeck-je-detail.ts
 */
import './load-env-vercel-first';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import { getRdsPool } from '../../src/lib/rds';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import type { SensitiveRow } from '../../src/lib/payroll/types';

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface QbLineDetail { PostingType?: 'Debit' | 'Credit'; AccountRef?: { name?: string } }
interface QbLine { Amount?: number; Description?: string; JournalEntryLineDetail?: QbLineDetail }
interface QbJE { Id: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; Line?: QbLine[] }

interface RawRow { position_id: string; name: string; pay_group: string; pay_date: string; sensitive_encrypted: string }

async function main(): Promise<void> {
  const all = await qbQueryAll<QbJE>('MedRock TN', 'JournalEntry', `WHERE TxnDate >= '2025-11-01' AND TxnDate <= '2025-11-30'`);
  console.log(`=== TN JournalEntry, Nov 2025 (${all.length} total) — full line detail for any touching Employee Advances ===`);
  for (const je of all.sort((a, b) => (a.TxnDate ?? '').localeCompare(b.TxnDate ?? ''))) {
    const touches1215 = (je.Line ?? []).some((l) => /employee advances/i.test(l.JournalEntryLineDetail?.AccountRef?.name ?? ''));
    if (!touches1215) continue;
    console.log(`\n  JE Id=${je.Id} DocNumber=${je.DocNumber ?? '(none)'} ${je.TxnDate}${je.PrivateNote ? ` note="${je.PrivateNote}"` : ''}`);
    for (const l of je.Line ?? []) {
      const side = l.JournalEntryLineDetail?.PostingType === 'Debit' ? 'Dr' : 'Cr';
      console.log(`    ${side} ${money(l.Amount ?? 0).padStart(11)}  [${l.JournalEntryLineDetail?.AccountRef?.name ?? '?'}]  ${l.Description ?? ''}`);
    }
  }

  console.log(`\n=== ADP payroll_history: Freebeck, Nov 2025 pay dates (independent source) ===`);
  const pool = getRdsPool();
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY not set');
  const { rows } = await pool.query<RawRow>(
    `SELECT position_id, name, pay_group, pay_date, sensitive_encrypted FROM source.payroll_history
     WHERE name ILIKE '%Freebeck%' AND pay_date >= '11/01/2025' AND pay_date <= '11/30/2025'`,
  );
  for (const r of rows) {
    const s: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
    console.log(`\n  ${r.name} (${r.position_id})  pay_date=${r.pay_date}  pay_group=${r.pay_group}`);
    for (const [col, val] of Object.entries(s)) {
      if (typeof val !== 'number' || val === 0) continue;
      if (/sic|comm|wage|gross|net/i.test(col)) console.log(`    ${money(val).padStart(11)}  ${col}`);
    }
  }
  await pool.end();
}

void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
