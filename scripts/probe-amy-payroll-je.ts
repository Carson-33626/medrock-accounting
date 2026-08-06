/**
 * READ-ONLY: pull recent JournalEntry txns from each connected QB company and
 * surface the ones that look like Amy's manual payroll JEs, printing the full
 * debit/credit line breakdown so we can model the target accounting.
 *   npx tsx scripts/probe-amy-payroll-je.ts
 *
 * Loads QB creds from .env.vercel (the .env.local QB client id is wrong).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env.vercel FIRST (before importing the QB lib, which reads env at module init).
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface QbLine {
  Amount?: number;
  Description?: string;
  DetailType?: string;
  JournalEntryLineDetail?: {
    PostingType?: 'Debit' | 'Credit';
    AccountRef?: { value?: string; name?: string };
    ClassRef?: { name?: string };
    DepartmentRef?: { name?: string };
    Entity?: { EntityRef?: { name?: string; type?: string } };
  };
}
interface QbJournalEntry {
  Id?: string;
  DocNumber?: string;
  TxnDate?: string;
  PrivateNote?: string;
  Line?: QbLine[];
  TotalAmt?: number;
}

async function main(): Promise<void> {
  const { qbQueryAll, getConnectionStatus } = await import('../src/lib/quickbooks-multi');

  const status = await getConnectionStatus();
  console.log('Connection status:', status);

  const locations = (Object.keys(status) as Array<keyof typeof status>).filter((l) => status[l]);

  for (const location of locations) {
    console.log(`\n================ ${location} ================`);
    let entries: QbJournalEntry[] = [];
    try {
      entries = await qbQueryAll<QbJournalEntry>(
        location,
        'JournalEntry',
        `WHERE TxnDate >= '2026-01-01' ORDER BY TxnDate DESC`,
      );
    } catch (e) {
      console.log('  query failed:', (e as Error).message);
      continue;
    }
    console.log(`  ${entries.length} JEs since 2026-01-01`);

    // Strong payroll signal: multiple tax/withholding accounts in ONE entry.
    const payrollScore = (je: QbJournalEntry): number => {
      const accts = (je.Line ?? []).map((l) =>
        `${l.Description ?? ''} ${l.JournalEntryLineDetail?.AccountRef?.name ?? ''}`.toLowerCase(),
      );
      const hits = new Set<string>();
      for (const a of accts) {
        if (/941|federal.*(withhold|tax)/.test(a)) hits.add('941');
        if (/social security|fica/.test(a)) hits.add('ss');
        if (/medicare/.test(a)) hits.add('medicare');
        if (/state.*(withhold|income tax|unemployment)|suta|futa|940/.test(a)) hits.add('state');
        if (/401|retirement/.test(a)) hits.add('401k');
        if (/garnish|child support|withholding order/.test(a)) hits.add('garnish');
        if (/wage|salary|gross pay/.test(a)) hits.add('wages');
        if (/net pay|payroll clearing|payroll cash|direct deposit/.test(a)) hits.add('netpay');
        if (/dental|vision|medical.*(ee|pre-tax|withhold)/.test(a)) hits.add('benefits');
      }
      return hits.size;
    };

    // Candidates: strong multi-signal entries with several lines.
    const candidates = entries
      .map((je) => ({ je, score: payrollScore(je), lines: (je.Line ?? []).length }))
      .filter((c) => c.score >= 3 && c.lines >= 5)
      .sort((a, b) => (a.je.TxnDate ?? '').localeCompare(b.je.TxnDate ?? ''));

    console.log(`  ${candidates.length} strong payroll-JE candidates (score>=3, lines>=5):`);
    for (const c of candidates) {
      console.log(
        `   ${c.je.TxnDate}  #${c.je.DocNumber ?? c.je.Id}  lines:${c.lines} score:${c.score}  ${(c.je.PrivateNote ?? '').slice(0, 50)}`,
      );
    }

    // Dump the LAST such entry in full (accounting said last one was ~April).
    const latest = candidates[candidates.length - 1]?.je;
    if (latest) {
      console.log(`\n  ----- FULL BREAKDOWN: ${location} JE #${latest.DocNumber ?? latest.Id} (${latest.TxnDate}) -----`);
      console.log(`  Note: ${latest.PrivateNote ?? ''}`);
      let dr = 0, cr = 0;
      for (const l of latest.Line ?? []) {
        const d = l.JournalEntryLineDetail;
        const type = d?.PostingType ?? '?';
        const amt = l.Amount ?? 0;
        if (type === 'Debit') dr += amt; else cr += amt;
        const acct = d?.AccountRef?.name ?? d?.AccountRef?.value ?? '?';
        const cls = d?.ClassRef?.name ? ` [class:${d.ClassRef.name}]` : '';
        const dept = d?.DepartmentRef?.name ? ` [dept:${d.DepartmentRef.name}]` : '';
        console.log(
          `   ${type.padEnd(6)} ${amt.toFixed(2).padStart(12)}  ${acct}${cls}${dept}  ${l.Description ? '— ' + l.Description : ''}`,
        );
      }
      console.log(`   TOTALS  Dr ${dr.toFixed(2)}  Cr ${cr.toFixed(2)}`);
    }
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
