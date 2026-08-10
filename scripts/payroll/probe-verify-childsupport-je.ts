/**
 * READ-ONLY: pull the one FL QuickBooks JE that put a "Child Support Fee" line into the
 * month-end allocation pool (txn 50509, 2026-03-13) and print every line, so we can say exactly
 * what was coded and by whom-shaped entry. Also sweeps all of 2026 for any OTHER garnishment /
 * child-support account line carrying an Allocate flag, in all three companies.
 *   npx tsx scripts/payroll/probe-verify-childsupport-je.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Entity } from '../../src/lib/payroll/types';
// NOTE: qb-pool and quickbooks-multi are imported DYNAMICALLY inside main(), after the env
// loader below has run. quickbooks-multi resolves its API base URL (production vs sandbox) at
// module scope, so a static import here would bind the wrong host and 403 / time out.

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
/** Accounts that must never leave their originating company (Barbara, 2026-08-06). */
const PROTECTED_RE = /Garnishment|Processing Fees|Withholdings/i;

interface QbRef { value?: string; name?: string }
interface QbJeLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: QbRef; DepartmentRef?: QbRef; ClassRef?: QbRef };
}
interface QbJe { Id: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; Line?: QbJeLine[] }

async function main(): Promise<void> {
  const { qbQueryAll } = (await import('../../src/lib/quickbooks-multi')) as {
    qbQueryAll: <T>(location: string, entity: string, where: string) => Promise<T[]>;
  };
  const { classifyAllocateFlag } = await import('../../src/lib/payroll/qb-pool');

  const [je] = await qbQueryAll<QbJe>('MedRock FL', 'JournalEntry', `WHERE Id = '50509'`);
  console.log('=== MedRock FL JournalEntry 50509 (the JE that pooled a Child Support Fee) ===');
  if (!je) console.log('  NOT FOUND');
  else {
    console.log(`  date=${je.TxnDate} doc=${je.DocNumber ?? '(none)'} note=${JSON.stringify(je.PrivateNote ?? '')}`);
    for (const l of je.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      console.log(`    ${String(d?.PostingType).padEnd(6)} ${money(l.Amount ?? 0).padStart(12)}  ${(d?.AccountRef?.name ?? '?').padEnd(50)} class=${d?.ClassRef?.name ?? '(none)'} dept=${d?.DepartmentRef?.name ?? '(none)'}  memo=${JSON.stringify(l.Description ?? '')}`);
    }
  }

  console.log('\n=== 2026 sweep: any Allocate-flagged line on a protected payroll-liability account ===');
  const companies: Entity[] = ['MedRock FL', 'MedRock TN', 'MedRock TX'];
  const where = `WHERE TxnDate >= '2026-01-01' AND TxnDate <= '2026-12-31'`;
  let hits = 0;
  for (const c of companies) {
    const jes = await qbQueryAll<QbJe>(c, 'JournalEntry', where);
    for (const j of jes) {
      for (const l of j.Line ?? []) {
        const d = l.JournalEntryLineDetail;
        const acct = d?.AccountRef?.name ?? '';
        if (!PROTECTED_RE.test(acct)) continue;
        const cls = classifyAllocateFlag(d?.ClassRef?.name ?? null, d?.DepartmentRef?.name ?? null, c);
        if (!cls) continue;
        hits++;
        const sign = d?.PostingType === 'Credit' ? -1 : 1;
        console.log(`  ${c.padEnd(14)} JE ${j.Id} ${j.TxnDate} ${money(sign * (l.Amount ?? 0)).padStart(12)}  ${acct}`);
        console.log(`      class=${d?.ClassRef?.name ?? '(none)'} dept=${d?.DepartmentRef?.name ?? '(none)'} -> rule=${cls.rule} memo=${JSON.stringify(l.Description ?? '')}`);
      }
    }
  }
  console.log(`\n  total Allocate-flagged protected-account lines in 2026: ${hits}`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
