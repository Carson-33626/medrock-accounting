// web/scripts/qbo-passthrough-probe.ts
// READ-ONLY C1 probe: for SYNCED Ramp txns that HAVE memos, find their QBO Purchase
// (amount + date ±3d, scoped to Ramp-named accounts — the verified type-A join) and record
// exactly where the Ramp memo shows up on the QBO side (PrivateNote / line Description /
// nowhere) and whether the Ramp receipt arrived as a QBO attachment. Zero writes.
// Run from web/:  npx tsx scripts/qbo-passthrough-probe.ts
import './ramp-split-push/load-env';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { rampToken, rampGet } from './ramp-split-push/ramp-client';
import type { Entity } from './ramp-split-push/types';
import { ENTITY_TO_QB_LOCATION, ALL_ENTITIES } from './ramp-split-push/types';
import { qbQueryAll } from '../src/lib/quickbooks-multi';

const OUT = 'scripts/out';
const DATE_WINDOW_DAYS = 3;
const SAMPLE_PER_ENTITY = 60;

interface RawRampTxn {
  id: string;
  amount: number;
  state: string | null;
  sync_status: string | null;
  synced_at: string | null;
  user_transaction_time: string | null;
  memo: string | null;
  merchant_name: string | null;
  card_holder: { first_name?: string; last_name?: string } | null;
  receipts: string[] | null;
  line_items: { memo?: string | null }[] | null;
}
interface RampPage { data: RawRampTxn[]; page?: { next?: string } }

interface Sample {
  id: string;
  absCents: number;
  date: string;
  merchant: string | null;
  holder: string | null;
  memo: string;
  lineMemos: string[];
  hasReceipt: boolean;
  syncedAt: string | null;
  isAmazon: boolean;
}

function isAmazonName(name: string | null): boolean {
  return /amazon|amzn/i.test(name ?? '');
}

async function pullSyncedMemoed(entity: Entity): Promise<Sample[]> {
  const token = await rampToken(entity, 'transactions:read');
  const out: Sample[] = [];
  let next: string | null = '/transactions?page_size=100&order_by_date_desc=true';
  for (let i = 0; i < 200 && next !== null && out.length < SAMPLE_PER_ENTITY * 3; i++) {
    let res: { status: number; body: RampPage } = await rampGet<RampPage>(entity, next, token);
    for (let attempt = 0; res.status !== 200 && attempt < 4; attempt++) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      res = await rampGet<RampPage>(entity, next, token);
    }
    if (res.status !== 200) throw new Error(`Ramp ${entity} page ${i} HTTP ${res.status}`);
    const rows: RawRampTxn[] = res.body.data ?? [];
    for (const r of rows) {
      if (r.state !== 'CLEARED' || r.sync_status !== 'SYNCED') continue;
      const memo = (r.memo ?? '').trim();
      if (memo === '') continue;
      const h = r.card_holder;
      out.push({
        id: r.id,
        absCents: Math.abs(Math.round(r.amount * 100)),
        date: (r.user_transaction_time ?? '').slice(0, 10),
        merchant: r.merchant_name,
        holder: h ? `${h.first_name ?? ''} ${h.last_name ?? ''}`.trim() || null : null,
        memo,
        lineMemos: (r.line_items ?? []).map((l) => (l.memo ?? '').trim()).filter((m) => m !== ''),
        hasReceipt: (r.receipts ?? []).length > 0,
        syncedAt: r.synced_at,
        isAmazon: isAmazonName(r.merchant_name),
      });
    }
    if (rows.length === 0) break;
    next = res.body.page?.next ?? null;
  }
  // Prefer txns synced AFTER the 2026-07-23 memo backfill (memo most likely existed pre-sync),
  // then Amazon rows, then everything else — cap the sample.
  const score = (s: Sample): number =>
    ((s.syncedAt ?? '') >= '2026-07-23' ? 2 : 0) + (s.isAmazon ? 1 : 0);
  return out.sort((a, b) => score(b) - score(a)).slice(0, SAMPLE_PER_ENTITY);
}

interface QBRef { value: string; name?: string }
interface QBAccountRaw { Id: string; Name?: string; FullyQualifiedName?: string }
interface QBLineRaw { Description?: string; Amount?: number; DetailType?: string }
interface QBPurchaseRaw {
  Id: string;
  TxnDate?: string;
  TotalAmt?: number;
  DocNumber?: string;
  AccountRef?: QBRef;
  EntityRef?: QBRef;
  PrivateNote?: string;
  Line?: QBLineRaw[];
}
interface QBAttachableRef { EntityRef?: { value?: string; type?: string } }
interface QBAttachableRaw { Id: string; FileName?: string; AttachableRef?: QBAttachableRef[] }

interface QBRow {
  qbId: string;
  absCents: number;
  epochDay: number;
  privateNote: string;
  lineDescs: string[];
  docNumber: string;
  payee: string;
  account: string;
  consumed: boolean;
}

function epochDay(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
}

async function pullQbPurchases(entity: Entity): Promise<{ rows: QBRow[]; attachedQbIds: Set<string> }> {
  const location = ENTITY_TO_QB_LOCATION[entity];
  const rampAccounts = await qbQueryAll<QBAccountRaw>(location, 'Account', "WHERE Name LIKE '%Ramp%'");
  const rampIds = new Set(rampAccounts.map((a) => a.Id));
  const raw = await qbQueryAll<QBPurchaseRaw>(location, 'Purchase', '');
  const rows: QBRow[] = raw
    .filter((p) => (p.TxnDate ?? '') !== '' && (rampIds.size === 0 || rampIds.has(p.AccountRef?.value ?? '')))
    .map((p) => ({
      qbId: p.Id,
      absCents: Math.abs(Math.round((p.TotalAmt ?? 0) * 100)),
      epochDay: epochDay((p.TxnDate ?? '').slice(0, 10)),
      privateNote: p.PrivateNote ?? '',
      lineDescs: (p.Line ?? []).map((l) => l.Description ?? '').filter((d) => d !== ''),
      docNumber: p.DocNumber ?? '',
      payee: p.EntityRef?.name ?? '',
      account: p.AccountRef?.name ?? '',
      consumed: false,
    }));
  const attachables = await qbQueryAll<QBAttachableRaw>(location, 'attachable', '');
  const attachedQbIds = new Set<string>();
  for (const a of attachables) {
    for (const ref of a.AttachableRef ?? []) {
      if (ref.EntityRef?.type === 'Purchase' && ref.EntityRef.value) attachedQbIds.add(ref.EntityRef.value);
    }
  }
  return { rows, attachedQbIds };
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
function csv(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  for (const entity of ALL_ENTITIES) {
    const samples = await pullSyncedMemoed(entity);
    const { rows: qb, attachedQbIds } = await pullQbPurchases(entity);
    const byCents = new Map<number, QBRow[]>();
    for (const q of qb) {
      const list = byCents.get(q.absCents) ?? [];
      list.push(q);
      byCents.set(q.absCents, list);
    }
    const lines: string[] = [
      'entity,is_amazon,txn_id,date,amount,merchant,holder,ramp_memo,qb_found,memo_in_private_note,memo_in_line_desc,qb_private_note,qb_line_descs,qb_doc_number,qb_payee,qb_account,ramp_has_receipt,qb_has_attachment',
    ];
    let found = 0, inNote = 0, inLine = 0, withAtt = 0, amazonFound = 0, amazonInNote = 0;
    for (const s of samples) {
      const rDay = epochDay(s.date);
      let best: QBRow | null = null;
      let bestDiff = DATE_WINDOW_DAYS + 1;
      for (const c of byCents.get(s.absCents) ?? []) {
        if (c.consumed) continue;
        const diff = Math.abs(c.epochDay - rDay);
        if (diff <= DATE_WINDOW_DAYS && diff < bestDiff) { best = c; bestDiff = diff; }
      }
      if (best) best.consumed = true;
      const memoInNote = best !== null && norm(best.privateNote).includes(norm(s.memo));
      const memoInDesc = best !== null && best.lineDescs.some((d) => norm(d).includes(norm(s.memo)));
      const hasAtt = best !== null && attachedQbIds.has(best.qbId);
      if (best) {
        found++;
        if (memoInNote) inNote++;
        if (memoInDesc) inLine++;
        if (hasAtt) withAtt++;
        if (s.isAmazon) { amazonFound++; if (memoInNote) amazonInNote++; }
      }
      lines.push([
        entity, s.isAmazon ? 'Y' : 'N', s.id, s.date, (s.absCents / 100).toFixed(2), s.merchant, s.holder, s.memo,
        best ? 'Y' : 'N', memoInNote ? 'Y' : 'N', memoInDesc ? 'Y' : 'N',
        best?.privateNote ?? '', (best?.lineDescs ?? []).join(' | '), best?.docNumber ?? '',
        best?.payee ?? '', best?.account ?? '', s.hasReceipt ? 'Y' : 'N', hasAtt ? 'Y' : 'N',
      ].map(csv).join(','));
    }
    writeFileSync(`${OUT}/qbo-passthrough-${entity}.csv`, lines.join('\n') + '\n');
    console.log(
      `[${entity}] sampled=${samples.length} qbFound=${found} memoInPrivateNote=${inNote} memoInLineDesc=${inLine} ` +
      `qbAttachments=${withAtt}/${found} | amazon: found=${amazonFound} memoInPrivateNote=${amazonInNote} | wrote ${OUT}/qbo-passthrough-${entity}.csv`,
    );
  }
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
