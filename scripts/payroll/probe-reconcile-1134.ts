/** READ-ONLY: reproduce the reconcile + post-gate decision for the April 10 FL split run
 *  (headers 1134/1135) exactly as /api/payroll/post computes it. Untracked scratch. */
import './load-env-vercel-first';
import { loadDraft, listSiblings, getAccountMap, getEmployeeMap, sourceSnapshotHash } from '../../src/lib/payroll/store';
import { selectSource } from '../../src/lib/payroll/source-select';
import { buildJournal } from '../../src/lib/payroll/build-je';
import { reconcile } from '../../src/lib/payroll/reconcile';
import { decidePost } from '../../src/lib/payroll/post-guard';
import { adpDateToIso } from '../../src/lib/payroll/dates';
import type { JournalDraft, JournalLine } from '../../src/lib/payroll/types';

const round2 = (n: number): number => Math.round(n * 100) / 100;

async function main(): Promise<void> {
  const headerId = Number(process.argv[2] ?? 1134);
  const loaded = await loadDraft(headerId);
  if (!loaded) throw new Error('not found');
  const { header, lines } = loaded;
  const siblings = await listSiblings(header.entity, header.pay_date, header.pay_group);
  console.log(`header #${headerId} ${header.entity} ${header.pay_date} status=${header.status} siblings=${siblings.length} (${siblings.map((s) => `#${s.id}:${s.status}`).join(', ')})`);

  const dayIso = adpDateToIso(header.pay_date);
  const dayRows = (await selectSource().fetchRange(dayIso, dayIso)).filter((r) => r.pay_group === header.pay_group);
  console.log(`source rows for ${dayIso} / ${header.pay_group}: ${dayRows.length}`);

  const [accountMap, employeeMap] = await Promise.all([getAccountMap(header.entity), getEmployeeMap(header.entity)]);
  const built = buildJournal(dayRows, accountMap, employeeMap);
  console.log(`unmappedColumns: ${JSON.stringify(built.unmappedColumns)}; unmappedPositions: ${JSON.stringify(built.unmappedPositions)}`);

  let reconcileLines: JournalLine[] = lines;
  let totals = { totalDebits: header.total_debits, totalCredits: header.total_credits, variance: header.variance };
  if (siblings.length > 1) {
    const loads = await Promise.all(siblings.map((s) => (s.id === headerId ? Promise.resolve(loaded) : loadDraft(s.id))));
    reconcileLines = loads.flatMap((l) => l?.lines ?? []);
    const d = round2(reconcileLines.filter((l) => l.postingType === 'Debit').reduce((s, l) => s + l.amount, 0));
    const c = round2(reconcileLines.filter((l) => l.postingType === 'Credit').reduce((s, l) => s + l.amount, 0));
    totals = { totalDebits: d, totalCredits: c, variance: round2(d - c) };
  }
  const reconcileDraft: JournalDraft = {
    entity: header.entity, payDate: header.pay_date, payGroup: header.pay_group,
    periodStart: header.period_start ?? '', periodEnd: header.period_end ?? '',
    lines: reconcileLines, ...totals,
    rowKeys: [...new Set(reconcileLines.flatMap((l) => l.sourceRowKeys))],
  };
  const rec = reconcile(reconcileDraft, dayRows, { unmappedColumns: built.unmappedColumns, unmappedPositions: built.unmappedPositions });
  console.log(`\nreconcile: postable=${rec.postable}`);
  console.log(JSON.stringify(rec, null, 2).slice(0, 3000));

  const currentHash = sourceSnapshotHash(dayRows);
  const hasDrift = !!header.source_snapshot_hash && currentHash !== header.source_snapshot_hash;
  console.log(`\ndrift: stored=${header.source_snapshot_hash?.slice(0, 12)} current=${currentHash.slice(0, 12)} hasDrift=${hasDrift}`);

  const decision = decidePost({ mode: 'live', reconcile: rec, headerStatus: header.status, hasKey: !!process.env.PAYROLL_ENC_KEY, hasDrift });
  console.log(`\ndecidePost(live): allowed=${decision.allowed}${decision.allowed ? '' : ` status=${decision.status} error=${decision.error}`}`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
