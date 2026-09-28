// READ-ONLY: find month-end allocation adjustments keyed straight into QuickBooks (outside the app).
// Barbara, 2026-09-28: she fixed April with a manual adjustment JE, but the difference check only
// nets entries the app posted. Lists every QB JE for April 2026 plus anything created since 09-25,
// flags which ones the app knows about, and prints the accounts on the ones it doesn't.
import './load-env-vercel-first';
import { getRdsPool } from '../../src/lib/rds';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';
import { EOM_ENTITIES } from '../../src/lib/payroll/revenue-rule';
import type { Entity } from '../../src/lib/payroll/types';

interface QbLine { Amount?: number; Description?: string; JournalEntryLineDetail?: { PostingType?: 'Debit' | 'Credit'; AccountRef?: { name?: string } } }
interface QbJe { Id: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; MetaData?: { CreateTime?: string }; Line?: QbLine[] }

async function main(): Promise<void> {
  const month = process.argv[2] ?? '2026-04';
  const since = process.argv[3] ?? '2026-09-25';
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

  const { rows } = await getRdsPool().query<{ qb_entry_id: string }>(
    `SELECT qb_entry_id FROM accounting.payroll_journal_headers WHERE qb_entry_id IS NOT NULL`,
  );
  const known = new Set(rows.map((r) => r.qb_entry_id));

  for (const entity of EOM_ENTITIES as readonly Entity[]) {
    const inMonth = await qbQueryAll<QbJe>(entity, 'JournalEntry', `WHERE TxnDate >= '${month}-01' AND TxnDate <= '${last}'`);
    const recent = await qbQueryAll<QbJe>(entity, 'JournalEntry', `WHERE MetaData.CreateTime >= '${since}T00:00:00'`);
    const byId = new Map<string, QbJe>();
    for (const je of [...inMonth, ...recent]) byId.set(je.Id, je);
    console.log(`\n=== ${entity}: ${byId.size} JE(s) dated ${month} or created since ${since}`);
    for (const je of [...byId.values()].sort((a, b) => (a.TxnDate ?? '').localeCompare(b.TxnDate ?? ''))) {
      const app = known.has(je.Id) ? 'APP' : 'MANUAL';
      const debits = (je.Line ?? []).filter((l) => l.JournalEntryLineDetail?.PostingType === 'Debit').reduce((s, l) => s + (l.Amount ?? 0), 0);
      const looksAllo = /allo|alloc|adj/i.test(`${je.DocNumber ?? ''} ${je.PrivateNote ?? ''}`);
      console.log(`${app.padEnd(6)} id ${je.Id.padEnd(6)} ${je.TxnDate} doc "${je.DocNumber ?? ''}" created ${je.MetaData?.CreateTime ?? '?'} Dr $${debits.toFixed(2)}${looksAllo ? '  <-- allocation-like' : ''}${je.PrivateNote ? `  note: ${je.PrivateNote.slice(0, 80)}` : ''}`);
      if (app === 'MANUAL' && looksAllo) {
        for (const l of je.Line ?? []) {
          const d = l.JournalEntryLineDetail;
          console.log(`         ${(d?.PostingType ?? '').padEnd(6)} ${(l.Amount ?? 0).toFixed(2).padStart(11)}  ${d?.AccountRef?.name ?? ''}`);
        }
      }
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
