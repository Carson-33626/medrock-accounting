// ============================================================================================
// PREP ONLY — DOES NOT EXECUTE ANY APPROVAL OR SYNC. (Carson: "prep a script for a mass approval,
// don't execute ... as well as the ability to push to QBO too.")
//
// CAPABILITY FINDINGS (Ramp Developer API, verified against the live OpenAPI spec 2026-07-23):
//   * There is NO card-transaction approval endpoint. PATCH /transactions/{id} accepts line_items
//     ONLY (no state/approval field). The only approval endpoints are blank-canvas-approvals
//     (custom workflow steps) and bill/reimbursement flows — none apply to card txns.
//     => A pure-REST "mass approve card transactions" is NOT possible. Real options:
//        (A) Ramp UI bulk-approve (manual), (B) browser automation vs the Ramp UI (Playwright —
//        we already use it for LifeFile/Walmart), (C) Ramp MCP server (can act on the account),
//        (D) adjust Ramp's approval POLICY so documented txns auto-approve.
//   * QBO PUSH: POST /accounting/ready-to-sync + POST /accounting/syncs EXIST but need
//     accounting:write AND an API-BASED accounting connection where WE are the sync engine. Our
//     entities use the DIRECT native-QB connection, under which Ramp auto-syncs to QBO once a txn
//     is APPROVED + fully documented — i.e. we don't push; approval is the trigger. Pushing via API
//     would require migrating DIRECT -> API-based (major, replaces the working native sync; drops
//     historical codings) — an accounting+eng decision, not a script.
//
// So this file: (1) builds the read-only APPROVAL WORKLIST accounting will want (what's approvable,
// $, cardholder, deep-links), and (2) scaffolds the approve + QBO-push execution paths behind hard
// guards that REFUSE to run until a mechanism is chosen and wired. Run to produce the worklist:
//   cd web && npx tsx scripts/ramp-mass-approval.ts            # writes worklist CSV, no side effects
// ============================================================================================
import './lib/load-env';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rampToken, rampGet } from './lib/ramp';
import type { Entity } from './lib/entities';

const ENTITIES: Entity[] = ['FL', 'TN', 'TX'];
const OUT = 'scripts/ramp-mass-approval/out';

// Ramp UI deep-link for a card transaction (for the human/accounting worklist).
const txnLink = (id: string): string => `https://app.ramp.com/transactions/${id}`;

interface RawTxn {
  id: string;
  amount: number;
  state: string | null;
  all_requirements_met_and_approved: boolean;
  user_transaction_time: string | null;
  memo: string | null;
  merchant_name: string | null;
  receipts: string[] | null;
  card_holder: { first_name?: string; last_name?: string } | null;
  sk_category_name: string | null;
}
interface Page { data: RawTxn[]; page?: { next?: string } }

export interface Approvable {
  entity: Entity; id: string; date: string; amountCents: number; cardholder: string;
  merchant: string; category: string; link: string;
}

// A txn is APPROVABLE by a click when it's cleared, still open, and fully documented (memo+receipt) —
// i.e. the ONLY thing missing is the approval. (Undocumented ones need memo/receipt first, not this.)
export async function buildApprovalWorklist(months?: string[]): Promise<Approvable[]> {
  const out: Approvable[] = [];
  for (const entity of ENTITIES) {
    const token = await rampToken(entity, 'transactions:read');
    let next: string | null = '/transactions?page_size=100&order_by_date_desc=true';
    for (let i = 0; i < 100 && next !== null; i++) {
      const res: { status: number; body: Page } = await rampGet<Page>(entity, next, token);
      if (res.status !== 200) break;
      const rows = res.body.data ?? [];
      if (rows.length === 0) break;
      for (const t of rows) {
        if (t.state !== 'CLEARED' || t.all_requirements_met_and_approved !== false) continue;
        const hasMemo = !!t.memo && t.memo.trim() !== '';
        const hasRcpt = (t.receipts?.length ?? 0) > 0;
        if (!hasMemo || !hasRcpt) continue; // not approvable yet — needs docs, not a click
        const ym = (t.user_transaction_time ?? '').slice(0, 7);
        if (months && !months.includes(ym)) continue;
        out.push({
          entity, id: t.id, date: (t.user_transaction_time ?? '').slice(0, 10),
          amountCents: Math.round(t.amount * 100),
          cardholder: t.card_holder ? `${t.card_holder.first_name ?? ''} ${t.card_holder.last_name ?? ''}`.trim() : '',
          merchant: t.merchant_name ?? '', category: t.sk_category_name ?? '', link: txnLink(t.id),
        });
      }
      next = res.body.page?.next ?? null;
    }
  }
  return out;
}

// ---- EXECUTION STUBS (guarded — throw until a mechanism is chosen + wired; never auto-run) --------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function approveTransactions(_ids: string[]): Promise<never> {
  throw new Error(
    'No Ramp REST endpoint approves card transactions. Choose a mechanism before wiring: ' +
    '(A) Ramp UI bulk-approve, (B) Playwright browser automation vs app.ramp.com, ' +
    '(C) Ramp MCP server, or (D) a Ramp approval-policy change. See header.',
  );
}

// QBO push under DIRECT connection is automatic on approval. This scaffold is for the API-based-
// connection path ONLY and refuses under DIRECT.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function pushToQbo(_entity: Entity, _txnIds: string[]): Promise<never> {
  throw new Error(
    'QBO push not available under the DIRECT (native-QB) connection — Ramp auto-syncs on approval. ' +
    'POST /accounting/ready-to-sync + /accounting/syncs require an API-based accounting connection ' +
    '(accounting:write) which we do NOT have; enabling it is a connection migration decision.',
  );
}

async function csv(rows: Approvable[]): Promise<string> {
  const esc = (v: unknown): string => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = 'entity,date,amount,cardholder,merchant,category,txn_id,ramp_link';
  return [head, ...rows.map((r) => [r.entity, r.date, (r.amountCents / 100).toFixed(2), r.cardholder, r.merchant, r.category, r.id, r.link].map(esc).join(','))].join('\n');
}

async function main(): Promise<void> {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const monthArg = process.argv.find((a) => /^\d{4}-\d{2}(,\d{4}-\d{2})*$/.test(a));
  const months = monthArg ? monthArg.split(',') : undefined;
  const work = await buildApprovalWorklist(months);
  work.sort((a, b) => b.amountCents - a.amountCents);
  writeFileSync(`${OUT}/approval_worklist.csv`, await csv(work));

  const byHolder = new Map<string, { n: number; cents: number }>();
  for (const w of work) { const k = `${w.entity} / ${w.cardholder}`; const e = byHolder.get(k) ?? { n: 0, cents: 0 }; e.n++; e.cents += w.amountCents; byHolder.set(k, e); }
  const total = work.reduce((s, w) => s + w.amountCents, 0);
  console.log(`APPROVAL WORKLIST${months ? ` (${months.join(',')})` : ' (all months)'}: ${work.length} fully-documented txns awaiting an approval click / $${(total / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  console.log('\nby cardholder (top 15):');
  for (const [k, v] of [...byHolder.entries()].sort((a, b) => b[1].cents - a[1].cents).slice(0, 15)) {
    console.log(`  $${(v.cents / 100).toFixed(2).padStart(11)}  ${String(v.n).padStart(3)}x  ${k}`);
  }
  console.log(`\nWrote ${OUT}/approval_worklist.csv`);
  console.log('NOTE: execution is stubbed — no card-approval REST API exists; QBO push needs an API-based connection. See file header.');
}
main().catch((e) => { console.error(e); process.exit(1); });
