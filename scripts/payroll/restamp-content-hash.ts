/**
 * ONE-TIME MIGRATION (2026-08-20): re-stamp `source_snapshot_hash` on every open payroll draft
 * with the new CONTENT-based hash.
 *
 * Background. The drift gate used to hash `row_key=updated_at`. `source.payroll_history` is
 * written WINDOWED_REPLACE, so every ADP ingest re-inserts the whole pay-date window with
 * `updated_at = now()` even when nothing changed — which re-fingerprinted every row and made
 * every draft built before that ingest report "source changed since draft was built". The hash
 * now covers row CONTENT (see store.ts sourceSnapshotHash), so every hash stamped under the old
 * scheme is stale and must be re-stamped once.
 *
 * SAFETY — this never restamps blindly. For each run it rebuilds the draft from the CURRENT
 * source rows and compares it line-for-line against what is stored:
 *   - identical  -> the stored draft already reflects today's source, so the new hash is simply
 *                   the correct fingerprint of the data it was built from. Restamped in place,
 *                   preserving `status` (an approved run stays approved — no re-review needed).
 *   - different  -> the source really did change since the draft was built. LEFT ALONE and
 *                   reported: it needs a genuine rebuild + re-review, which is what the drift
 *                   gate exists to force.
 * Posted headers are never touched.
 *
 * Dry run by default; pass --apply to write.
 *   npx tsx scripts/payroll/restamp-content-hash.ts            # report only
 *   npx tsx scripts/payroll/restamp-content-hash.ts --apply
 */
import './load-env-vercel-first';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import { selectSource } from '../../src/lib/payroll/source-select';
import { buildJournal } from '../../src/lib/payroll/build-je';
import { splitStraddle } from '../../src/lib/payroll/split';
import { adpDateToIso } from '../../src/lib/payroll/dates';
import { getAccountMap, getEmployeeMap, loadDraft, runSnapshotHash } from '../../src/lib/payroll/store';
import type { Entity, JournalLine, PayrollRow } from '../../src/lib/payroll/types';

interface HeaderRow {
  id: string; entity: Entity; pay_date: string; pay_group: string; period_segment: string;
  status: string; source_snapshot_hash: string | null;
}

/** Order-independent fingerprint of a draft's lines — what a rebuild would have to reproduce. */
function lineKey(l: JournalLine): string {
  return [
    l.postingType, l.amount.toFixed(2), l.accountName, l.departmentName ?? '', l.className ?? '',
    l.memo, l.creditBucket ?? '', l.origin,
  ].join('|');
}

function sameLines(a: JournalLine[], b: JournalLine[]): boolean {
  if (a.length !== b.length) return false;
  const x = a.map(lineKey).sort();
  const y = b.map(lineKey).sort();
  return x.every((v, i) => v === y[i]);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    const { rows: headers } = await pool.query<HeaderRow>(
      `SELECT id::text, entity, pay_date, pay_group, period_segment, status, source_snapshot_hash
         FROM accounting.payroll_journal_headers
        WHERE status <> 'posted' AND kind = 'pay_date'
        ORDER BY to_date(pay_date,'MM/DD/YYYY'), entity, period_segment, id`,
    );
    console.log(`${headers.length} open pay_date header(s); mode = ${apply ? 'APPLY' : 'DRY RUN'}\n`);

    const dayCache = new Map<string, PayrollRow[]>();
    const mapCache = new Map<Entity, [Awaited<ReturnType<typeof getAccountMap>>, Awaited<ReturnType<typeof getEmployeeMap>>]>();
    let restamped = 0;
    let alreadyCurrent = 0;
    const needRebuild: string[] = [];
    const missing: string[] = [];

    for (const h of headers) {
      const dayIso = adpDateToIso(h.pay_date);
      let dayRows = dayCache.get(dayIso);
      if (!dayRows) { dayRows = await selectSource().fetchRange(dayIso, dayIso); dayCache.set(dayIso, dayRows); }

      let maps = mapCache.get(h.entity);
      if (!maps) { maps = [await getAccountMap(h.entity), await getEmployeeMap(h.entity)]; mapCache.set(h.entity, maps); }

      const { drafts } = buildJournal(dayRows, maps[0], maps[1]);
      const draft = drafts.find((d) => d.entity === h.entity && d.payDate === h.pay_date && d.payGroup === h.pay_group);
      const label = `#${h.id} ${h.entity} ${h.pay_date} ${h.pay_group}${h.period_segment ? ` [${h.period_segment}]` : ''} ${h.status}`;
      if (!draft) { missing.push(`${label} — run absent from source for its pay date`); continue; }

      const piece = splitStraddle(draft).find((p) => (p.periodSegment ?? '') === h.period_segment);
      if (!piece) { needRebuild.push(`${label} — month-split shape changed (no piece for this segment)`); continue; }

      const stored = await loadDraft(Number(h.id));
      if (!stored) { missing.push(`${label} — header vanished mid-run`); continue; }

      if (!sameLines(stored.lines, piece.lines)) {
        needRebuild.push(`${label} — stored ${stored.lines.length} line(s) D=${stored.header.total_debits} differ from rebuild ${piece.lines.length} line(s) D=${piece.totalDebits}`);
        continue;
      }

      const fresh = runSnapshotHash(dayRows, draft.payDate, draft.payGroup);
      if (fresh === h.source_snapshot_hash) { alreadyCurrent += 1; continue; }

      if (apply) {
        await pool.query(
          `UPDATE accounting.payroll_journal_headers SET source_snapshot_hash = $2
            WHERE id = $1 AND status <> 'posted'`,
          [Number(h.id), fresh],
        );
      }
      restamped += 1;
      console.log(`${apply ? 'restamped' : 'would restamp'} ${label}  ${(h.source_snapshot_hash ?? '(none)').slice(0, 12)} -> ${fresh.slice(0, 12)}`);
    }

    console.log(`\n${apply ? 'RESTAMPED' : 'WOULD RESTAMP'}: ${restamped} | already current: ${alreadyCurrent} | needs a real rebuild: ${needRebuild.length} | unresolvable: ${missing.length}`);
    if (needRebuild.length > 0) {
      console.log('\nLEFT ALONE — the source genuinely changed since these were built; rebuild + re-review:');
      for (const s of needRebuild) console.log(`  ${s}`);
    }
    if (missing.length > 0) {
      console.log('\nUNRESOLVABLE — send to engineering:');
      for (const s of missing) console.log(`  ${s}`);
    }
    if (!apply) console.log('\nDRY RUN — nothing was written. Re-run with --apply to commit.');
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
