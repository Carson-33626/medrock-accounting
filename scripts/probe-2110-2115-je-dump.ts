/** READ-ONLY: dump full raw line detail (all accounts, both sides) for named FL JEs by DocNumber. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
interface QbLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: {
    PostingType?: string;
    AccountRef?: { value?: string; name?: string };
    ClassRef?: { name?: string };
    DepartmentRef?: { name?: string };
  };
}
interface JE { Id?: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; Line?: QbLine[] }

const WANT = ['PR SIC 2026.01.31', 'SIC Payout', 'SIC Payout IE', 'PR Q4-2025 SIC Adj', 'PR Q1-2026.01 SIC Est', 'PR 2026.04.10A', 'YE Adj 2025.12.31'];

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const entries = await qbQueryAll<JE>('MedRock FL' as never, 'JournalEntry', `WHERE TxnDate >= '2025-11-01'`);
  for (const doc of WANT) {
    const je = entries.find((e) => e.DocNumber === doc);
    console.log(`\n===== MedRock FL  #${doc} =====`);
    if (!je) { console.log('  NOT FOUND'); continue; }
    console.log(`  Date: ${je.TxnDate}   Id: ${je.Id}`);
    console.log(`  PrivateNote: ${JSON.stringify(je.PrivateNote ?? '')}`);
    let dr = 0, cr = 0;
    for (const l of je.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      const type = d?.PostingType ?? '?';
      const amt = l.Amount ?? 0;
      if (type === 'Debit') dr += amt; else cr += amt;
      const acct = d?.AccountRef?.name ?? d?.AccountRef?.value ?? '?';
      const cls = d?.ClassRef?.name ? ` [class:${d.ClassRef.name}]` : '';
      const dept = d?.DepartmentRef?.name ? ` [dept:${d.DepartmentRef.name}]` : '';
      console.log(`   ${type.padEnd(6)} ${amt.toFixed(2).padStart(12)}  ${acct}${cls}${dept}  desc=${JSON.stringify(l.Description ?? '')}`);
    }
    console.log(`   TOTALS  Dr ${dr.toFixed(2)}  Cr ${cr.toFixed(2)}`);
  }

  // Search for anything with "SIC" in DocNumber or PrivateNote across the whole window
  console.log(`\n===== ALL FL JEs Dec 2025 - Apr 2026 with "SIC" in DocNumber or PrivateNote =====`);
  for (const je of entries) {
    if (!je.TxnDate || je.TxnDate < '2025-12-01' || je.TxnDate > '2026-04-30') continue;
    const hay = `${je.DocNumber ?? ''} ${je.PrivateNote ?? ''}`;
    if (/sic/i.test(hay)) {
      console.log(`  ${je.TxnDate}  #${je.DocNumber}  Id=${je.Id}  note=${JSON.stringify((je.PrivateNote ?? '').slice(0, 200))}`);
    }
  }

  // Search for reversal candidates: JEs whose lines sum to the flagged SIC amounts
  console.log(`\n===== Search for reversal-shaped JEs matching 22332.21 / 17830.11 / 10424.21 (Dec 2025 - Apr 2026) =====`);
  const targets = [22332.21, 17830.11, 10424.21, 802.24, 174.04];
  for (const je of entries) {
    if (!je.TxnDate || je.TxnDate < '2025-12-01' || je.TxnDate > '2026-04-30') continue;
    if (['PR SIC 2026.01.31', 'SIC Payout', 'SIC Payout IE'].includes(je.DocNumber ?? '')) continue;
    for (const l of je.Line ?? []) {
      const amt = l.Amount ?? 0;
      if (targets.some((t) => Math.abs(amt - t) < 0.02)) {
        const d = l.JournalEntryLineDetail;
        console.log(
          `  ${je.TxnDate}  #${je.DocNumber}  Id=${je.Id}  ${d?.PostingType} ${amt.toFixed(2)}  acct=${d?.AccountRef?.name}  desc=${JSON.stringify(l.Description ?? '')}  note=${JSON.stringify((je.PrivateNote ?? '').slice(0, 150))}`,
        );
      }
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
