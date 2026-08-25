/**
 * ONE-OFF (Carson, 2026-08-25): the March 2026 month-end allocation that reached QB is the
 * `% Allo 2026.03-2` supplement trio (FL 53229 / TN 20557 / TX 1891) — generated under the
 * OLD pooling rules: it moved Marketing and Shipping wages and used a revenue split. The
 * corrected rules (Ash, via Carson): pre-April months split EVERYTHING pooled 1/3, marketing
 * never pools, shipping never pools.
 *
 * Sequence:
 *   1. npx tsx scripts/payroll/march-allo-kill-regen-repost.ts            (dry-run: show kill list)
 *   2. npx tsx scripts/payroll/march-allo-kill-regen-repost.ts --kill     (delete the -2 trio in QB)
 *   3. npx tsx scripts/payroll/regen-eom-months.ts 2026-03 --apply        (regen March under new rules)
 *   4. npx tsx scripts/payroll/march-allo-kill-regen-repost.ts --post     (post the regenerated trio)
 *
 * --post deliberately bypasses the eom/post route's March period lock and approve gate:
 * Carson's explicit instruction ("kill that, regenerate our march tool, then repost with the
 * corrected pooling rules") IS the approval. Status flips + audit rows mirror the route.
 */
import './load-env-vercel-first';
import { qbPost, qbQueryAll } from '../../src/lib/quickbooks-multi';
import { EOM_ENTITIES } from '../../src/lib/payroll/revenue-rule';
import { listEomHeaders } from '../../src/lib/payroll/eom-store';
import { loadDraft, insertAudit, setHeaderStatus, type JsonValue } from '../../src/lib/payroll/store';
import { postJournalEntry } from '../../src/lib/payroll/qb-journal';
import type { Entity, JournalDraft } from '../../src/lib/payroll/types';

const MARCH = { year: 2026, month: 3 };
const SHORT: Partial<Record<Entity, string>> = { 'MedRock FL': 'FL', 'MedRock TN': 'TN', 'MedRock TX': 'TX' };
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface QbJeWithSync {
  Id: string; SyncToken?: string; DocNumber?: string; TxnDate?: string;
  Line?: { Amount?: number; JournalEntryLineDetail?: { PostingType?: 'Debit' | 'Credit' } }[];
}

const kill = process.argv.includes('--kill');
const post = process.argv.includes('--post');

async function findKillList(): Promise<Map<Entity, QbJeWithSync>> {
  const out = new Map<Entity, QbJeWithSync>();
  for (const entity of EOM_ENTITIES) {
    const expectDoc = `${SHORT[entity]} % Allo 2026.03-2`;
    const mainDoc = `${SHORT[entity]} % Allo 2026.03`;
    const jes = await qbQueryAll<QbJeWithSync>(entity, 'JournalEntry', `WHERE TxnDate = '2026-03-31'`);
    const main = jes.find((j) => (j.DocNumber ?? '').trim() === mainDoc);
    if (main) {
      throw new Error(`${entity}: a posted '${mainDoc}' exists (QB Id ${main.Id}) — reposting would collide. Stop and review.`);
    }
    const hit = jes.find((j) => (j.DocNumber ?? '').trim() === expectDoc);
    if (!hit) {
      console.log(`  ${entity}: no '${expectDoc}' found — nothing to kill here`);
      continue;
    }
    const dr = (hit.Line ?? []).reduce((s, l) => s + (l.JournalEntryLineDetail?.PostingType === 'Debit' ? (l.Amount ?? 0) : 0), 0);
    console.log(`  ${entity}: QB Id ${hit.Id}  ${hit.DocNumber}  Dr ${money(dr)}  SyncToken=${hit.SyncToken ?? '?'}`);
    out.set(entity, hit);
  }
  return out;
}

async function killPhase(): Promise<void> {
  console.log(`\n=== ${kill ? 'KILL' : 'DRY-RUN'}: the % Allo 2026.03-2 trio ===`);
  const list = await findKillList();
  if (!kill) {
    console.log('\nDRY-RUN — nothing deleted. Re-run with --kill to delete the JEs above.');
    return;
  }
  for (const [entity, je] of list) {
    const res = await qbPost<{ JournalEntry?: { Id?: string; status?: string } }>(
      entity,
      'journalentry?operation=delete&minorversion=75',
      { Id: je.Id, SyncToken: je.SyncToken ?? '0' } as unknown as JsonValue,
    );
    console.log(`  🗑️  DELETED ${entity} ${je.DocNumber} (QB Id ${je.Id}) — status=${res.JournalEntry?.status ?? 'Deleted'}`);
  }
}

async function postPhase(): Promise<void> {
  console.log('\n=== POST: regenerated March allocation trio ===');
  const headers = await listEomHeaders(MARCH);
  if (headers.length !== 3) {
    throw new Error(`expected 3 March allocation headers, found ${headers.length} — run regen-eom-months.ts 2026-03 --apply first`);
  }
  for (const h of headers) {
    if (h.status === 'posted' || h.qb_entry_id) {
      console.log(`  SKIP #${h.id} ${h.entity}: already posted (${h.qb_doc_number ?? h.qb_entry_id})`);
      continue;
    }
    if (h.variance !== 0) throw new Error(`#${h.id} ${h.entity} unbalanced (var=${h.variance}) — refusing`);
    const loaded = await loadDraft(h.id);
    if (!loaded) throw new Error(`#${h.id} vanished mid-run`);
    const draft: JournalDraft = {
      entity: h.entity, kind: 'allocation', payDate: h.pay_date, payGroup: h.pay_group,
      periodStart: h.period_start ?? '', periodEnd: h.period_end ?? '', periodSegment: h.period_segment,
      docNumber: `${SHORT[h.entity]} % Allo 2026.03`, txnDate: h.txn_date ?? undefined,
      privateNote:
        'Month-end allocation — March 2026, REISSUE under the corrected pooling rules ' +
        '(Ash 2026-08-25): all pooled shared labor and costs split 1/3 each (the CS revenue ' +
        'split begins April 2026); marketing and shipping stay with the employing entity. ' +
        'Replaces the deleted % Allo 2026.03-2 supplement, whose coverage this entry includes.',
      lines: loaded.lines, totalDebits: h.total_debits, totalCredits: h.total_credits,
      variance: h.variance, rowKeys: [],
    };
    console.log(`  #${h.id} ${h.entity} ${draft.docNumber}: ${draft.lines.length} lines Dr ${money(h.total_debits)} Cr ${money(h.total_credits)}`);
    const result = await postJournalEntry(h.entity, draft, { mode: 'live' });
    await setHeaderStatus(h.id, 'posted', { entryId: result.qbEntryId, docNumber: result.qbDocNumber });
    await insertAudit({
      headerId: h.id, mode: 'live', entity: h.entity,
      qbDocNumber: result.qbDocNumber, qbEntryId: result.qbEntryId, outcome: 'posted',
      requestPayload: JSON.parse(JSON.stringify(result.payload)) as JsonValue,
      responseBody: result.response ?? null,
    });
    console.log(`  ✅ POSTED ${h.entity}: ${result.qbDocNumber} — QB JE Id ${result.qbEntryId}`);
  }
}

async function main(): Promise<void> {
  if (post) await postPhase();
  else await killPhase();
}
void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
