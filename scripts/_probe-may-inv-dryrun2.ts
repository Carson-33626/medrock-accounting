/**
 * READ-ONLY dry run (nothing saved, nothing posted): the May 2026 correction `{E} Inv Adj 2026.05-2`
 * exactly as `generateInvCloseCorrection` would assemble it AFTER the 2026-10-27 code fixes
 * (bounded lab, closed-period guard, 1220.20 relief, TX device standard cost). Mirrors that function
 * minus saveDraft / insertAudit / DELETE. QuickBooks: GET/report reads only. RDS: SELECT only.
 */
import './lib/load-env';
import { computeClose, closePoolContributions, monthEndDate } from '../src/lib/inventory/close-server';
import { correctionOrderLock, fetchBookCloseDate } from '../src/lib/inventory/close-drift-server';
import { fetchDeviceRelievedThrough } from '../src/lib/inventory/device-cost-server';
import { assemblePool } from '../src/lib/inventory/je-pool';
import { invCloseCorrectionDocNumber } from '../src/lib/inventory/monthly-close';
import { QB_LOCATIONS, QB_TO_RDS_LOCATION } from '../src/lib/qb-links';
import { getRdsPool } from '../src/lib/rds';
import type { Entity } from '../src/lib/payroll/types';

const usd = (n: number): string => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main(): Promise<void> {
  const month = '2026-05';
  const monthEnd = monthEndDate(month);
  if (!monthEnd) throw new Error('month');
  const close = await computeClose(month, 'floor', monthEnd);
  console.log('categoryUnavailable:', close.categoryUnavailable);
  for (const entity of QB_LOCATIONS as Entity[]) {
    const je = close.categoryJournalEntries.find((j) => j.location === QB_TO_RDS_LOCATION[entity as keyof typeof QB_TO_RDS_LOCATION]);
    if (!je) { console.log(`\n##### ${entity}: no category JE`); continue; }
    console.log(`\n##### ${entity} (${je.location}) bookAvailable=${je.bookAvailable} BookCloseDate=${await fetchBookCloseDate(entity)}`);
    console.log('order lock:', await correctionOrderLock(entity, month));
    console.log('device relieved through (posted):', await fetchDeviceRelievedThrough(entity));
    console.log('category gaps (FIFO − book at 5/31):');
    for (const l of je.lines) console.log(`   ${l.qbCategory.padEnd(34)} fifo=${usd(l.fifoTarget).padStart(12)} book=${usd(l.qbBookBalance ?? 0).padStart(12)} adj=${usd(l.adjustment ?? 0).padStart(12)} lots=${l.lotCount}`);
    if (!je.bookAvailable) continue;

    const { lab, ship, device, contributions } = await closePoolContributions(entity, je, month, monthEnd);
    const pool = assemblePool(contributions);
    console.log(`would-be doc ${invCloseCorrectionDocNumber(je.location, month, 1)}  TxnDate ${monthEnd}  postable=${pool.postable} variance=${pool.variance} Dr=${usd(pool.totalDebits)} Cr=${usd(pool.totalCredits)} unavailable=[${pool.unavailable.join(',')}]`);
    console.log(`lab: target=${usd(lab.contribution.target)} postedThroughMay=${lab.snapshot ? usd(lab.snapshot.postedToDate) : 'n/a'} delta=${usd(lab.contribution.delta)} | device contributor: ${device === null ? 'n/a (FIFO emits 1220.15)' : 'joined'}`);
    for (const s of pool.subtotals) console.log(`  subtotal ${s.label}: lines=${s.lineCount} Dr=${usd(s.debits)} Cr=${usd(s.credits)}`);
    for (const l of pool.lines) console.log(`  ${l.postingType.padEnd(6)} ${usd(l.amount).padStart(12)}  ${l.accountName}  | ${l.memo.slice(0, 110)}`);
    for (const w of pool.warnings) console.log('  ! ' + w.slice(0, 260));
  }
  await getRdsPool().end().catch(() => undefined);
}
main().then(() => process.exit(0)).catch((e: Error) => { console.error(e); process.exit(1); });
