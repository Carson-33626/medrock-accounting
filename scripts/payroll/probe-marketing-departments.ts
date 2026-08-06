/**
 * READ-ONLY: what marketing REGIONS (QB Departments) did Amy actually use, and on which
 * accounts, in PR 2026.03.27? Answers "what regions exist + is it just marketer→territory
 * routing." Pulls her real JE per company and lists every line whose account or memo mentions
 * marketing, grouped by DepartmentRef. Prints ONLY account/department/memo + dollars (no PII).
 *   npx tsx scripts/payroll/probe-marketing-departments.ts
 * QB creds from .env.vercel (the .env.local QB client id is wrong).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface QbLine {
  Amount?: number;
  Description?: string;
  JournalEntryLineDetail?: {
    PostingType?: 'Debit' | 'Credit';
    AccountRef?: { name?: string };
    ClassRef?: { name?: string };
    DepartmentRef?: { name?: string };
  };
}
interface QbJournalEntry { Id?: string; DocNumber?: string; TxnDate?: string; Line?: QbLine[] }

async function main(): Promise<void> {
  const { qbQueryAll, getConnectionStatus } = await import('../../src/lib/quickbooks-multi');
  const status = await getConnectionStatus();
  const locations = (Object.keys(status) as Array<keyof typeof status>).filter((l) => status[l]);

  for (const location of locations) {
    console.log(`\n================ ${location} ================`);
    let entries: QbJournalEntry[] = [];
    try {
      entries = await qbQueryAll<QbJournalEntry>(location, 'JournalEntry', `WHERE DocNumber = 'PR 2026.03.27'`);
    } catch (e) {
      console.log('  query failed:', (e as Error).message);
      continue;
    }
    if (entries.length === 0) { console.log('  no PR 2026.03.27 JE found'); continue; }

    for (const je of entries) {
      const mkt = (je.Line ?? []).filter((l) => {
        const a = `${l.JournalEntryLineDetail?.AccountRef?.name ?? ''} ${l.Description ?? ''}`.toLowerCase();
        return /market/.test(a);
      });
      console.log(`  JE #${je.DocNumber} (${je.TxnDate}) — ${mkt.length} marketing lines`);
      const byDept = new Map<string, { acct: Set<string>; cls: Set<string>; amt: number; n: number }>();
      for (const l of mkt) {
        const d = l.JournalEntryLineDetail;
        const dept = d?.DepartmentRef?.name ?? '(no dept)';
        const e = byDept.get(dept) ?? { acct: new Set(), cls: new Set(), amt: 0, n: 0 };
        if (d?.AccountRef?.name) e.acct.add(d.AccountRef.name);
        if (d?.ClassRef?.name) e.cls.add(d.ClassRef.name);
        e.amt += l.Amount ?? 0; e.n += 1;
        byDept.set(dept, e);
      }
      for (const [dept, e] of [...byDept.entries()].sort((a, b) => b[1].amt - a[1].amt)) {
        console.log(`    [dept: ${dept}]  $${e.amt.toFixed(2)}  (${e.n} lines)  accts={${[...e.acct].join(' | ')}}  classes={${[...e.cls].join(', ')}}`);
      }
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
