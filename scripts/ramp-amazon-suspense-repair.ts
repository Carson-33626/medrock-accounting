/**
 * Recode every NOT-YET-SYNCED retail-Amazon transaction on Ramp to GL 8220 "Suspense".
 *
 * Carson, 2026-08-07: "anything non-synced amazon needs to be recoded to Suspense, book keeper
 * will push manually from there." A human gates the QBO push, which is what makes coding
 * older-dated transactions safe — nothing posts as a side effect of this script.
 *
 * DEFAULT IS A DRY RUN. Pass --apply to write.
 *   NODE_OPTIONS=--dns-result-order=ipv4first npx tsx scripts/ramp-amazon-suspense-repair.ts
 *   NODE_OPTIONS=--dns-result-order=ipv4first npx tsx scripts/ramp-amazon-suspense-repair.ts --apply
 *
 * The rules this encodes, each earned the hard way:
 *
 *  - EXACT merchant match, never a regex. `merchant_name === 'Amazon'` is the only safe test:
 *    /amazon/i also matches "Amazon Web Services" (8 TN txns / $3,849.84 of infrastructure spend
 *    that has a real GL home) and Whole Foods. Neither may be swept into Suspense.
 *  - NOT_SYNC_READY only. A SYNCED transaction is already in QuickBooks and Ramp rejects the
 *    write (403); those need a QBO reclass journal instead, not a Ramp PATCH.
 *  - Re-GET immediately before each PATCH. `sync_status` can flip between the scan and the write —
 *    that race produced 12 HTTP 403s on 2026-07-30.
 *  - PATCH /transactions replaces `line_items` WHOLESALE. Every selection that is not re-sent is
 *    destroyed, so each line's selections are rebuilt verbatim and ONLY the GL_ACCOUNT one is
 *    swapped. That preserves QuickbooksBillable (on all 230) and the QuickbooksClass
 *    "Allocate - TX" intercompany markers (on 3 FL txns).
 *  - Memos are never touched. The transaction memo carries "Amazon order# …" used for QBO
 *    pairing; `PATCH /transactions` cannot write it anyway (it accepts only `line_items` and
 *    silently ignores a `memo` key — a trap that cost 63 phantom memo writes once).
 *  - No re-splitting. Each existing line keeps its own amount, so a split transaction stays split.
 *
 * Writes a rollback ledger CSV holding each transaction's PRIOR GL, so any write can be undone
 * while the transaction is still NOT_SYNC_READY.
 */
import './receipt-enrichment/engines/ramp-split-push/load-env';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rampToken, rampGet, rampFetch, getRampAccounts } from './receipt-enrichment/engines/ramp-split-push/ramp-client';
import type { Entity } from './receipt-enrichment/engines/ramp-split-push/types';

const ENTITIES: Entity[] = ['FL', 'TN', 'TX'];
const SCOPE_READ = 'transactions:read accounting:read';
const SCOPE_WRITE = 'transactions:read transactions:write accounting:read';
const SUSPENSE_CODE = '8220';
const GL_FIELD = 'QuickbooksCategory';
const OUT = 'scripts/out';
const APPLY = process.argv.includes('--apply');
const BASE = 'https://api.ramp.com/developer/v1';

interface RawSel {
  type?: string | null;
  external_id?: string | null;
  external_code?: string | null;
  name?: string | null;
  category_info?: { external_id?: string | null; type?: string | null } | null;
}
interface RawLine {
  amount?: { amount?: number | null } | null;
  memo?: string | null;
  accounting_field_selections?: RawSel[] | null;
}
interface RawTxn {
  id: string;
  amount?: number | null;
  sync_status?: string | null;
  state?: string | null;
  merchant_name?: string | null;
  user_transaction_time?: string | null;
  memo?: string | null;
  line_items?: RawLine[] | null;
}
interface Page { data: RawTxn[]; page?: { next?: string } }

interface PatchSelection { field_external_id: string; field_option_external_id: string }
interface PatchLine { amount: number; memo: string | null; accounting_field_selections: PatchSelection[] }

const money = (c: number): string => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const csvCell = (v: string): string => `"${v.replace(/"/g, '""')}"`;

/** The GL selection currently on a line, if any. */
function glSelOf(line: RawLine): RawSel | undefined {
  return (line.accounting_field_selections ?? []).find(
    (s) => s.type === 'GL_ACCOUNT' || s.category_info?.external_id === GL_FIELD,
  );
}

/** True when EVERY line already sits at Suspense — nothing to do. */
function alreadySuspense(t: RawTxn): boolean {
  const lines = t.line_items ?? [];
  if (lines.length === 0) return false;
  return lines.every((l) => glSelOf(l)?.external_code === SUSPENSE_CODE);
}

/**
 * Rebuild the full line_items array with the GL swapped to Suspense and everything else intact.
 * A line with no GL selection at all (every TX target) gets one added.
 */
function buildPayload(t: RawTxn, suspenseOptionId: string): { line_items: PatchLine[] } {
  const lines = t.line_items ?? [];
  const built: PatchLine[] = lines.map((line) => {
    const selections: PatchSelection[] = [];
    let sawGl = false;
    for (const s of line.accounting_field_selections ?? []) {
      const field = s.category_info?.external_id;
      if (!field) continue; // no field id -> cannot be re-sent; nothing we can do but drop it
      const isGl = s.type === 'GL_ACCOUNT' || field === GL_FIELD;
      if (isGl) {
        sawGl = true;
        selections.push({ field_external_id: GL_FIELD, field_option_external_id: suspenseOptionId });
        continue;
      }
      if (!s.external_id) continue; // an option with no external id cannot be round-tripped
      selections.push({ field_external_id: field, field_option_external_id: s.external_id });
    }
    if (!sawGl) selections.push({ field_external_id: GL_FIELD, field_option_external_id: suspenseOptionId });
    return { amount: line.amount?.amount ?? 0, memo: line.memo ?? null, accounting_field_selections: selections };
  });

  // Defensive: a target with no line_items at all still needs one line carrying the full amount.
  if (built.length === 0) {
    built.push({
      amount: Math.round((t.amount ?? 0) * 100),
      memo: null,
      accounting_field_selections: [{ field_external_id: GL_FIELD, field_option_external_id: suspenseOptionId }],
    });
  }
  return { line_items: built };
}

async function main(): Promise<void> {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  const ledger: string[] = ['entity,ramp_txn_id,date,amount,prior_gl_code,prior_gl_name,prior_gl_option_id,result'];
  let scanned = 0;
  let targeted = 0;
  let written = 0;
  let skippedRace = 0;
  let failed = 0;

  for (const entity of ENTITIES) {
    const token = await rampToken(entity, APPLY ? SCOPE_WRITE : SCOPE_READ);

    const accounts = await getRampAccounts(entity, token);
    const suspense = accounts.find((a) => (a as { code?: string }).code === SUSPENSE_CODE) as
      | { id?: string; name?: string }
      | undefined;
    if (!suspense?.id) {
      console.log(`  ${entity}: NO Suspense (${SUSPENSE_CODE}) account found — skipping entity`);
      continue;
    }
    console.log(`\n================ ${entity} — Suspense option id ${suspense.id} ================`);

    // Scan the whole book for retail-Amazon targets.
    const targets: RawTxn[] = [];
    let url = '/transactions?page_size=100';
    for (;;) {
      const res = await rampGet<Page>(entity, url, token);
      const page = res.body.data ?? [];
      scanned += page.length;
      for (const t of page) {
        if (t.merchant_name !== 'Amazon') continue;
        if (t.sync_status !== 'NOT_SYNC_READY') continue;
        if (alreadySuspense(t)) continue;
        targets.push(t);
      }
      const next = res.body.page?.next;
      if (!next || page.length === 0) break;
      url = next;
    }
    targeted += targets.length;
    const sum = targets.reduce((s, t) => s + Math.round((t.amount ?? 0) * 100), 0);
    console.log(`  targets: ${targets.length} / ${money(sum)}`);
    let previewed = 0;

    for (const t of targets) {
      const prior = glSelOf((t.line_items ?? [])[0] ?? {});
      const priorCode = prior?.external_code ?? '';
      const priorName = prior?.name ?? '(uncoded)';
      const priorOpt = prior?.external_id ?? '';
      const date = (t.user_transaction_time ?? '').slice(0, 10);
      const amt = money(Math.round((t.amount ?? 0) * 100));

      if (!APPLY) {
        console.log(`    would recode ${t.id} ${date} ${amt.padStart(11)}  ${priorName} -> Suspense`);
        // Show the actual payload for the first couple per entity, and for anything carrying a
        // Class — those are the intercompany "Allocate - TX" markers a careless PATCH would erase.
        const hasClass = (t.line_items ?? []).some((l) =>
          (l.accounting_field_selections ?? []).some((s) => s.category_info?.external_id === 'QuickbooksClass'),
        );
        if (previewed < 2 || hasClass) {
          previewed += 1;
          console.log(`      PAYLOAD${hasClass ? ' (carries a Class — collateral check)' : ''}: ${JSON.stringify(buildPayload(t, suspense.id))}`);
        }
        ledger.push([entity, t.id, date, amt, priorCode, csvCell(priorName), priorOpt, 'dry_run'].join(','));
        continue;
      }

      // TOCTOU guard: re-read immediately before writing and bail if it moved.
      let fresh: RawTxn;
      try {
        const re = await rampGet<RawTxn>(entity, `/transactions/${t.id}`, token);
        fresh = re.body;
      } catch (e) {
        failed += 1;
        console.log(`    FAILED re-read ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
        ledger.push([entity, t.id, date, amt, priorCode, csvCell(priorName), priorOpt, 'reread_failed'].join(','));
        continue;
      }
      if (fresh.sync_status !== 'NOT_SYNC_READY') {
        skippedRace += 1;
        console.log(`    skip (now ${fresh.sync_status}) ${t.id}`);
        ledger.push([entity, t.id, date, amt, priorCode, csvCell(priorName), priorOpt, `skipped_${fresh.sync_status}`].join(','));
        continue;
      }
      if (alreadySuspense(fresh)) {
        skippedRace += 1;
        ledger.push([entity, t.id, date, amt, priorCode, csvCell(priorName), priorOpt, 'skipped_already_suspense'].join(','));
        continue;
      }

      const payload = buildPayload(fresh, suspense.id);
      try {
        const res = await rampFetch(`${BASE}/transactions/${t.id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`${res.status} ${body.slice(0, 300)}`);
        }
        written += 1;
        ledger.push([entity, t.id, date, amt, priorCode, csvCell(priorName), priorOpt, 'recoded'].join(','));
        if (written % 25 === 0) console.log(`    ${written} written…`);
      } catch (e) {
        failed += 1;
        console.log(`    FAILED ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
        ledger.push([entity, t.id, date, amt, priorCode, csvCell(priorName), priorOpt, 'failed'].join(','));
      }
    }
  }

  const ledgerPath = `${OUT}/amazon-suspense-${APPLY ? 'applied' : 'dryrun'}.csv`;
  writeFileSync(ledgerPath, ledger.join('\n'), 'utf8');

  console.log(`\n==================== SUMMARY ====================`);
  console.log(`  transactions scanned : ${scanned}`);
  console.log(`  targets              : ${targeted}`);
  if (APPLY) {
    console.log(`  recoded to Suspense  : ${written}`);
    console.log(`  skipped (raced)      : ${skippedRace}`);
    console.log(`  failed               : ${failed}`);
  } else {
    console.log(`  (dry run — nothing written)`);
  }
  console.log(`  rollback ledger      : ${ledgerPath}`);
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
