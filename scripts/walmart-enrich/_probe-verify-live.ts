// Read-only post-run verification: re-read every txn this run wrote (from rollback.json) straight from
// Ramp and check the three things that can actually be wrong.
//   1. receipts — exactly 1 is healthy; 2+ is the permanent-duplicate failure (no delete API)
//   2. split balance — Σ line_items == txn amount, remembering line amounts come back in MINOR units
//      while the txn amount is dollars
//   3. GL spread — how many lines landed in Suspense, and where the rest went
//   npx tsx scripts/walmart-enrich/_probe-verify-live.ts [--retailer sams] [--since-index N]
import './../ramp-split-push/load-env';
import { readFileSync } from 'node:fs';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import { resolveProfile } from './retailer-profile';
import type { Entity } from '../ramp-split-push/types';

// read-only on purpose: this probe must never be able to write.
const SCOPES_READ = 'transactions:read receipts:read accounting:read';

interface RollbackRow { entity: Entity; txn_id: string; order_id: string }
interface LineSel { category_info?: { external_id?: string }; name?: string | null; external_code?: string | null }
// A line's amount is an OBJECT in minor units ({amount: 2216, minor_unit_conversion_rate: 100}), while
// the transaction's own `amount` is a plain dollar number. Reading the line as a bare number yields NaN.
interface LineAmount { amount: number; minor_unit_conversion_rate: number }
interface Line { amount: LineAmount; memo?: string | null; accounting_field_selections?: LineSel[] }
interface Txn { id: string; amount: number; merchant_name?: string; receipts?: string[]; line_items?: Line[]; state?: string; sync_status?: string }

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main(): Promise<void> {
  const profile = resolveProfile(arg('--retailer', 'sams'));
  const sinceIndex = Number(arg('--since-index', '0')) || 0;
  const rows = (JSON.parse(readFileSync(`${profile.outDir}/rollback.json`, 'utf8')) as RollbackRow[]).slice(sinceIndex);
  console.log(`verifying ${rows.length} ${profile.label} txn(s) from ${profile.outDir}/rollback.json\n`);

  const tokens: Partial<Record<Entity, string>> = {};
  const entities = [...new Set(rows.map((r) => r.entity))];
  for (const e of entities) tokens[e] = await rampToken(e, SCOPES_READ);

  let ok = 0;
  const noReceipt: string[] = [];
  const dupReceipt: string[] = [];
  const unbalanced: string[] = [];
  const glCount = new Map<string, number>();
  let lineTotal = 0;

  for (const r of rows) {
    const { body: t } = await rampGet<Txn>(r.entity, `/transactions/${r.txn_id}`, tokens[r.entity]!);
    const receipts = t.receipts?.length ?? 0;
    if (receipts === 0) noReceipt.push(`${r.entity} ${r.txn_id} (order ${r.order_id})`);
    if (receipts > 1) dupReceipt.push(`${r.entity} ${r.txn_id} — ${receipts} receipts`);

    const lines = t.line_items ?? [];
    const sumCents = lines.reduce((a, l) => a + Math.round(l.amount.amount), 0);
    const txnCents = Math.round(t.amount * 100);
    if (sumCents !== txnCents) unbalanced.push(`${r.entity} ${r.txn_id} — lines ${sumCents} vs txn ${txnCents}`);
    else ok++;

    for (const l of lines) {
      lineTotal++;
      const sel = l.accounting_field_selections?.find((s) => s.category_info?.external_id === 'QuickbooksCategory');
      const label = `${sel?.external_code ?? '(none)'}  ${sel?.name ?? ''}`;
      glCount.set(label, (glCount.get(label) ?? 0) + 1);
    }
  }

  console.log(`balanced splits: ${ok}/${rows.length}`);
  console.log(`receipts: exactly-1 ${rows.length - noReceipt.length - dupReceipt.length} | none ${noReceipt.length} | DUPLICATE ${dupReceipt.length}`);
  if (dupReceipt.length) { console.log('\n!! DUPLICATE RECEIPTS (permanent — no delete API):'); dupReceipt.forEach((s) => console.log('   ' + s)); }
  if (noReceipt.length) { console.log('\nno receipt (expected for txns that already had one before this run):'); noReceipt.slice(0, 50).forEach((s) => console.log('   ' + s)); }
  if (unbalanced.length) { console.log('\n!! UNBALANCED:'); unbalanced.forEach((s) => console.log('   ' + s)); }

  console.log(`\nGL spread across ${lineTotal} live line(s), by QuickBooks external_code:`);
  for (const [code, n] of [...glCount.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${code}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
