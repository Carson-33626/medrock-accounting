/**
 * READ-ONLY: blast-radius scan for the duplicate-DocNumber fault.
 *
 * For every UNPOSTED local JE header (all kinds), derive the DocNumber it would post under
 * and check whether that DocNumber is already live in the entity's QuickBooks company.
 * Prints a one-line verdict per collision plus a coarse same/different signal.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface QbLine {
  Amount?: number;
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: { name?: string } };
}
interface JE {
  Id?: string;
  DocNumber?: string;
  TxnDate?: string;
  PrivateNote?: string;
  MetaData?: { CreateTime?: string };
  Line?: QbLine[];
}

interface HeaderRow {
  id: string;
  entity: string;
  kind: string;
  pay_date: string;
  pay_group: string;
  period_segment: string;
  period_start: string | null;
  period_end: string | null;
  txn_date: string | null;
  qb_doc_number: string | null;
  status: string;
  total_debits: string;
  seg_index: string;
  seg_count: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const ENTITIES = ['MedRock FL', 'MedRock TN', 'MedRock TX'] as const;

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const { getRdsPool } = await import('../src/lib/rds');
  const { deriveJeIdentity } = await import('../src/lib/payroll/je-identity');

  const { rows } = await getRdsPool().query<HeaderRow>(
    `WITH sibs AS (
       SELECT id, entity, kind, pay_date, pay_group, period_segment, period_start, period_end,
              to_char(txn_date,'YYYY-MM-DD') AS txn_date, qb_doc_number, status, total_debits,
              (COUNT(*) OVER (PARTITION BY entity, pay_date, pay_group))::int AS seg_count,
              (ROW_NUMBER() OVER (PARTITION BY entity, pay_date, pay_group ORDER BY period_segment) - 1)::int AS seg_index
         FROM accounting.payroll_journal_headers
     )
     SELECT id::text AS id, entity, kind, pay_date, pay_group, period_segment, period_start, period_end,
            txn_date, qb_doc_number, status, total_debits::text AS total_debits,
            seg_index::text AS seg_index, seg_count::text AS seg_count
       FROM sibs
      WHERE status <> 'posted'
      ORDER BY entity, txn_date`,
  );
  console.log(`local unposted headers: ${rows.length}`);

  for (const entity of ENTITIES) {
    const entries = await qbQueryAll<JE>(entity, 'JournalEntry', `WHERE TxnDate >= '2025-01-01'`);
    const byDoc = new Map<string, JE[]>();
    for (const e of entries) {
      if (!e.DocNumber) continue;
      const list = byDoc.get(e.DocNumber) ?? [];
      list.push(e);
      byDoc.set(e.DocNumber, list);
    }
    console.log(`\n===== ${entity} — ${entries.length} live JEs, ${byDoc.size} distinct DocNumbers =====`);

    let collisions = 0;
    for (const r of rows.filter((x) => x.entity === entity)) {
      const doc = deriveJeIdentity(
        {
          entity: r.entity,
          kind: r.kind,
          pay_date: r.pay_date,
          pay_group: r.pay_group,
          period_segment: r.period_segment,
          period_start: r.period_start,
          period_end: r.period_end,
          txn_date: r.txn_date,
          qb_doc_number: r.qb_doc_number,
        },
        Number(r.seg_index),
        Number(r.seg_count),
      ).docNumber;
      const hits = byDoc.get(doc);
      if (!hits) continue;
      collisions++;
      for (const je of hits) {
        let dr = 0;
        for (const l of je.Line ?? []) if (l.JournalEntryLineDetail?.PostingType === 'Debit') dr += l.Amount ?? 0;
        const localDr = round2(Number(r.total_debits));
        const same = round2(dr) === localDr ? 'SAME-TOTAL' : 'DIFFERENT';
        console.log(
          `  ${same}  draft id=${r.id} (${r.kind}, ${r.status}, txn ${r.txn_date}, $${localDr}) ` +
            `<-> QB Id=${je.Id} doc='${doc}' txn=${je.TxnDate} $${round2(dr)} lines=${(je.Line ?? []).length} ` +
            `created=${je.MetaData?.CreateTime ?? '?'}`,
        );
      }
    }
    if (collisions === 0) console.log('  no DocNumber collisions with unposted local drafts');

    // Any live JE using our reserved prefixes that we did NOT post (no local posted header claims it).
    const reserved = [...byDoc.keys()].filter((d) => /^(PR |EOM |INV )/.test(d));
    console.log(`  live JEs carrying a reserved prefix (PR/EOM/INV): ${reserved.length}`);
  }

  await getRdsPool().end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
