/**
 * Regenerate month-end allocation runs for the given months — the exact same pipeline as
 * POST /api/payroll/eom/generate (safety gate, revenue presence, pool fetch incl. local
 * unposted payroll drafts, buildMonthEndAllocation, saveDraft, replace-semantics, run
 * snapshot). Writes LOCAL drafts only; never touches QuickBooks.
 *
 *   npx tsx scripts/payroll/regen-eom-months.ts 2026-06 2026-07 --apply
 */
// MUST be the first import: quickbooks-multi captures its OAuth creds into module-level
// constants, and tsx hoists imports above inline statements.
import './load-env-vercel-first';
import { createHash } from 'node:crypto';
import { EOM_ENTITIES, fetchRevenuePresence, sharesFromRevenue, type EomEntity, type RevenueTest } from '../../src/lib/payroll/revenue-rule';
import { fetchAllocationPool, type PoolLine } from '../../src/lib/payroll/qb-pool';
import { buildMonthEndAllocation } from '../../src/lib/payroll/month-end';
import { saveEomRun, listEomHeaders, deleteUnpostedEomHeaders, listPostedCsAlloHeaders } from '../../src/lib/payroll/eom-store';
import { excludeCsLines } from '../../src/lib/payroll/cs-catchup';
import { saveDraft, type JsonValue } from '../../src/lib/payroll/store';
import type { Month } from '../../src/lib/payroll/month';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const apply = process.argv.includes('--apply');
const months = process.argv.slice(2).filter((a) => MONTH_RE.test(a));
if (months.length === 0) throw new Error('usage: regen-eom-months.ts <YYYY-MM> [YYYY-MM ...] [--apply]');

const toJson = <T,>(value: T): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

async function runMonth(month: string): Promise<void> {
  const [y, mo] = month.split('-');
  const m: Month = { year: Number(y), month: Number(mo) };
  console.log(`\n=== ${month} ===`);

  const posted = (await listEomHeaders(m)).filter((h) => h.status === 'posted');
  if (posted.length > 0) {
    console.log(`  SKIP: month has posted allocation JEs (${posted.map((h) => h.qb_doc_number ?? `#${h.id}`).join(', ')})`);
    return;
  }

  const revenueTest: RevenueTest = await fetchRevenuePresence(m);
  const poolResult = await fetchAllocationPool(m);
  let pool = poolResult.pool;
  const attention = poolResult.attention;
  // HARD RULE: months whose CS is already allocated by posted CS Allo entries exclude the
  // Customer-Service pool slice — see cs-catchup.excludeCsLines.
  const csHeaders = await listPostedCsAlloHeaders(m);
  const csAlloDocs = csHeaders.map((h) => h.qb_doc_number ?? `#${h.id}`);
  if (csHeaders.length > 0) {
    const { kept, cs } = excludeCsLines(pool);
    pool = kept;
    console.log(`  CS allocated separately (${csAlloDocs.join(', ')}) — ${cs.length} CS lines excluded, ${money(cs.reduce((s, l) => s + l.amount, 0))}`);
  }
  const draftLines = pool.filter((l) => l.txnType === 'DraftJE');
  console.log(`  pool: ${pool.length} lines (${draftLines.length} from local payroll drafts, ${money(draftLines.reduce((s, l) => s + l.amount, 0))}); attention: ${attention.length}`);
  // Revenue true-up visibility: the class-split deposit lines this regen scoops (2026-08-19).
  const depositLines = pool.filter((l) => l.rule === 'passthrough' && l.txnType === 'Deposit');
  if (depositLines.length > 0) {
    console.log(`  deposit passthrough: ${depositLines.length} lines, net ${money(depositLines.reduce((s, l) => s + l.amount, 0))}`);
  }

  let shares = sharesFromRevenue(revenueTest);
  if (shares === null) {
    if (pool.some((l) => l.rule === 'revenue')) { console.log(`  SKIP: no location has revenue for ${month}`); return; }
    shares = Object.fromEntries(EOM_ENTITIES.map((e) => [e, 0])) as Record<EomEntity, number>;
  }
  console.log(`  shares: ${EOM_ENTITIES.map((e) => `${e.slice(-2)} ${shares[e].toFixed(2)}%`).join(' / ')}`);

  const drafts = buildMonthEndAllocation(pool, shares, m, { csAlloDocs });
  for (const d of drafts) {
    console.log(`  draft ${d.docNumber}: ${d.lines.length} lines, Dr=${money(d.totalDebits)} Cr=${money(d.totalCredits)} var=${d.variance}`);
  }

  if (!apply) { console.log('  (preview — nothing saved)'); return; }

  const hash = createHash('sha256').update(JSON.stringify(pool)).digest('hex');
  for (const draft of drafts) {
    const id = await saveDraft(draft, hash);
    console.log(`  saved header #${id} ${draft.entity}`);
  }
  await deleteUnpostedEomHeaders(m, drafts.map((d) => d.entity));
  await saveEomRun({
    month,
    pool: toJson<PoolLine[]>(pool),
    revenue: toJson({ test: revenueTest, shares, csAlloDocs }),
    attention: toJson<PoolLine[]>(attention),
  });
  console.log(`  run snapshot saved`);
}

async function main(): Promise<void> {
  console.log(`mode=${apply ? 'APPLY' : 'PREVIEW'} — months: ${months.join(', ')}`);
  for (const month of months) await runMonth(month);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
