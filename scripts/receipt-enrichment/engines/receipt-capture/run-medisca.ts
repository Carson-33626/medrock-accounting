// Medisca orchestrator. Specs:
//   docs/superpowers/specs/2026-08-04-medisca-draft-enrichment-design.md   (enrich)
//   docs/superpowers/specs/2026-08-05-medisca-create-mode-design.md        (refresh + create)
//
// THREE MODES, and the cache is the seam between them:
//
//   refresh   portal -> local cache + PDFs.  READ-ONLY: no Ramp, no QuickBooks, no writes anywhere.
//   enrich    GL-codes the drafts Kristina has ALREADY keyed, by replaying her QB history.
//   create    builds the drafts she has not keyed yet, reading the CACHE ONLY — never the portal.
//
// Splitting capture from writing is what makes planning offline, repeatable and reviewable: the same
// cache replays an identical plan, writes work from a snapshot a human has looked at, and a vendor
// outage cannot block a create run.
//
// Create exists because enrich only halves her work — it codes what she has already typed. The point
// is to remove the typing. It targets ONLY invoices no system has yet: everything already in
// QuickBooks, in a Ramp bill, or in a Ramp draft is deduped out, because creating those would
// double-book, which is exactly what the Letco pilot did on 2026-08-04.
//
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/run-medisca.ts --entity=FL --mode=refresh [--force]
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/run-medisca.ts --entity=FL --mode=create
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/run-medisca.ts --entity=FL [--mode=enrich] [--live] [--limit 5]
import '../ramp-split-push/load-env';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import {
  listDraftBills, buildPatchLinesBody, patchDraftBillLines, isGlCoded,
  buildDraftBillBody, createDraftBill, attachBillDocument,
} from './bill-draft';
import type { RampDraftBill, DraftBillBody } from './bill-draft';
import { loadConsumedBillStore } from './bill-consumed';
import { planMediscaEnrichment, recordHistory } from './medisca-gl';
import type { MediscaHistory, MediscaDraftLine } from './medisca-gl';
import { buildRulings, RULED_BY } from './medisca-rulings';
import { MediscaSession } from './medisca-session';
import { refreshEntity } from './medisca-refresh';
import { loadBillCache, normalizeInvoiceNumber } from './bill-cache';
import { planMediscaCreate } from './medisca-create';
import { joinInvoiceLines, buildSkuHistory, toSkuMapFile } from './medisca-sku';
import type { SkuObservation, QbCodedLine } from './medisca-sku';
import { dedupeVerdict } from './bill-dedupe';
import type { DedupeFacts } from './bill-dedupe';
import { appendAudit } from './audit';
import { parseNumericFlag } from './cli-args';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import { buildGlIndex } from '../amazon-enrich/gl-resolve';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';
import { qbQueryAll } from '../../platform/quickbooks';
import { RC } from '../../paths';

const OUT = RC.out;
const AUDIT_PATH = `${OUT}/receipt-capture-audit.csv`;
const VENDOR = 'medisca' as const;
const SCOPES_READ = 'bills:read accounting:read';
const SCOPES_WRITE = 'bills:read bills:write accounting:read';
const VENDOR_RE = /medisca/i;
// Widening this changes nothing measurable (2025 -> 2023 added 88 items and 256 lines but produced
// the identical 67 patchable / 10 refused split), so it is a knob, not a lever. The blockers are
// genuinely new items and genuine inconsistencies, not a thin corpus.
const DEFAULT_HISTORY_SINCE = '2023-01-01';

type Mode = 'refresh' | 'enrich' | 'create';
const MODES: Mode[] = ['refresh', 'enrich', 'create'];

// Never capture or create into a period accounting has closed. Advance this as months close.
const PERIOD_FLOOR = '2026-05-01';

interface Args { mode: Mode; entity: Entity; historySince: string; since: string; invoice: string | null; live: boolean; limit: number; force: boolean }

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
  };
  const usage =
    'Usage: npx tsx engines/receipt-capture/run-medisca.ts --entity=FL|TN|TX ' +
    '[--mode=refresh|enrich|create] [--since 2023-01-01 (refresh capture window)] ' +
    '[--history-since 2023-01-01] [--force] [--live] [--limit 5]';

  const entityArg = get('--entity');
  if (!entityArg || !ALL_ENTITIES.includes(entityArg as Entity)) throw new Error(usage);

  const modeArg = (get('--mode') ?? 'enrich') as Mode;
  if (!MODES.includes(modeArg)) throw new Error(usage);

  return {
    mode: modeArg,
    entity: entityArg as Entity,
    historySince: get('--history-since') ?? DEFAULT_HISTORY_SINCE,
    // Refresh-only: how far back to CAPTURE. Capture is read-only, so unlike PERIOD_FLOOR (which
    // gates what create may WRITE) there is no safety reason to limit it — and a deep cache is what
    // feeds the SKU map, since the teaching set is precisely the old, already-coded invoices.
    since: get('--since') ?? PERIOD_FLOOR,
    // Create-only: restrict the run to one invoice number. Exists so a live PILOT can pick a
    // deliberate target instead of whatever sorts first by date.
    invoice: get('--invoice'),
    live: argv.includes('--live'),
    limit: parseNumericFlag('--limit', get('--limit'), 5, 'clamp'),
    force: argv.includes('--force'),
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') {
    throw new Error(
      `MEDISCA_ENV_MISSING: required env var ${name} is not set in web/.env.local. Refusing to guess ` +
      `or fall back to another entity's id — that would code this bill against the wrong vendor.`,
    );
  }
  return v.trim();
}

// ---- history ----
interface QbLine { Description?: string; AccountBasedExpenseLineDetail?: { AccountRef?: { name?: string } } }
interface QbBill { VendorRef?: { name?: string }; Line?: QbLine[] }

// History is pooled across ALL THREE entities, then applied to one entity's drafts.
//
// Account CODES are standardized company-wide (only the Ramp option id is entity-specific, and that
// is resolved per entity below), so how she coded an item in FL is real evidence for the same item
// in TX. It matters: TX has only 331 coded lines of its own, and per-entity history left it at 9 of
// 14 drafts vs 27 of 37 for FL. Pooling is also STRICTER where it counts — an item she codes
// differently in different entities becomes ambiguous and gets refused, instead of being confidently
// replayed from one entity's thin sample.
async function buildHistory(since: string): Promise<{ history: MediscaHistory; bills: number; lines: number }> {
  const history: MediscaHistory = new Map();
  let bills = 0;
  let lines = 0;
  for (const entity of ALL_ENTITIES) {
    const rows = await qbQueryAll<QbBill>(ENTITY_TO_QB_LOCATION[entity], 'Bill', `WHERE TxnDate >= '${since}'`);
    const mine = rows.filter((b) => VENDOR_RE.test(b.VendorRef?.name ?? ''));
    bills += mine.length;
    for (const b of mine) {
      for (const l of b.Line ?? []) {
        const acct = l.AccountBasedExpenseLineDetail?.AccountRef?.name;
        const desc = (l.Description ?? '').trim();
        if (!acct || desc === '') continue;
        lines++;
        // QB account names are "1220.10 Inventory Asset:Compound Ingredient Inventory" — the leading
        // token is the code the classifier and the Ramp option lookup both key on.
        recordHistory(history, desc, acct.split(' ')[0]);
      }
    }
  }
  return { history, bills, lines };
}

/**
 * QuickBooks Medisca bill lines, keyed by normalised invoice number. This is the teaching set for
 * the SKU map: where an invoice exists on both sides, its portal lines and its QB lines describe the
 * same goods, so joining them by amount reveals which account she gave each SKU.
 */
async function buildQbLineIndex(since: string): Promise<Map<string, QbCodedLine[]>> {
  const out = new Map<string, QbCodedLine[]>();
  for (const entity of ALL_ENTITIES) {
    const rows = await qbQueryAll<QbBill & { DocNumber?: string }>(
      ENTITY_TO_QB_LOCATION[entity], 'Bill', `WHERE TxnDate >= '${since}'`,
    );
    for (const b of rows.filter((r) => VENDOR_RE.test(r.VendorRef?.name ?? ''))) {
      const key = normalizeInvoiceNumber(b.DocNumber ?? '');
      if (key === '') continue;
      out.set(key, (b.Line ?? [])
        .map((l) => ({
          account: (l.AccountBasedExpenseLineDetail?.AccountRef?.name ?? '').split(' ')[0],
          amountCents: Math.round(((l as { Amount?: number }).Amount ?? 0) * 100),
        }))
        .filter((l) => l.account !== ''));
    }
  }
  return out;
}

/**
 * The four dedupe layers, minus the registry (checked per invoice). Both systems are consulted
 * because Medisca bills reach the books by two routes, and `GET /bills` silently excludes DRAFTs —
 * the omission that produced a duplicate of the bookkeeper's own draft on 2026-08-04.
 */
async function buildDedupeFacts(entity: Entity): Promise<Omit<DedupeFacts, 'inRegistry'>> {
  const qbDocNumbers = new Set<string>();
  for (const e of ALL_ENTITIES) {
    const rows = await qbQueryAll<QbBill & { DocNumber?: string }>(
      ENTITY_TO_QB_LOCATION[e], 'Bill', `WHERE TxnDate >= '2025-01-01'`,
    );
    for (const b of rows.filter((r) => VENDOR_RE.test(r.VendorRef?.name ?? ''))) {
      const d = (b.DocNumber ?? '').trim();
      if (d !== '') qbDocNumbers.add(d);
    }
  }

  const token = await rampToken(entity, SCOPES_READ);
  const rampDraftInvoiceNumbers = new Set<string>();
  for (const d of await listDraftBills(entity, token, rampGet)) {
    if (VENDOR_RE.test(d.vendor?.name ?? '') && (d.invoice_number ?? '') !== '') {
      rampDraftInvoiceNumbers.add((d.invoice_number ?? '').trim());
    }
  }

  const rampInvoiceNumbers = new Set<string>();
  interface BillPage { data?: { invoice_number?: string | null; vendor?: { name?: string | null } | null }[]; page?: { next?: string | null } }
  let url: string | null = '/bills?page_size=100';
  for (let i = 0; i < 50 && url !== null; i++) {
    const res: { status: number; body: BillPage } = await rampGet<BillPage>(entity, url, token);
    for (const b of res.body.data ?? []) {
      if (VENDOR_RE.test(b.vendor?.name ?? '') && (b.invoice_number ?? '') !== '') {
        rampInvoiceNumbers.add((b.invoice_number ?? '').trim());
      }
    }
    url = res.body.page?.next ?? null;
  }

  return { qbDocNumbers, rampInvoiceNumbers, rampDraftInvoiceNumbers };
}

function isMediscaDraft(d: RampDraftBill, vendorId: string): boolean {
  if ((d.vendor?.id ?? '') === vendorId) return true;
  return VENDOR_RE.test(d.vendor?.name ?? '');
}

function toDraftLines(d: RampDraftBill): MediscaDraftLine[] {
  return (d.line_items ?? []).map((l) => ({
    amountCents: l.amount?.amount ?? 0,
    memo: l.memo ?? '',
    coded: isGlCoded(l.accounting_field_selections),
  }));
}

// ---- plan CSV ----
interface PlanRow {
  invoiceNumber: string; draftId: string; entity: Entity; owner: string;
  totalCents: number; lineCount: number; verdict: string; accounts: string; notes: string;
}

function csv(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function planLine(r: PlanRow): string {
  return [
    r.invoiceNumber, r.draftId, r.entity, r.owner, (r.totalCents / 100).toFixed(2),
    String(r.lineCount), r.verdict, r.accounts, r.notes,
  ].map(csv).join(',');
}

// ---- refresh ----
// Portal -> local cache. Read-only: no Ramp, no QuickBooks, no writes to any system of record.
async function runRefresh(args: Args): Promise<void> {
  const session = await MediscaSession.login(args.entity);
  console.log(`[${args.entity}] logged in: customer=${session.customerCode} company=${session.company}`);

  const res = await refreshEntity(
    session,
    {
      entity: args.entity,
      periodFloor: args.since,
      force: args.force,
      outDir: OUT,
      pdfDir: `${OUT}/pdf/medisca`,
      now: () => new Date().toISOString(),
    },
    (msg: string) => console.log(msg),
  );

  console.log(
    `[${args.entity}] refresh: listed=${res.listed} fetched=${res.fetched} ` +
    `reused=${res.reused} failed=${res.failed}`,
  );
  console.log(`[${args.entity}] cache ${res.cachePath}`);
  console.log(`[${args.entity}] export ${res.csvPath}`);
}

// ---- create ----
// Reads the LOCAL CACHE only — no portal access, so a vendor outage cannot block a create run and
// the plan is reproducible from a reviewed snapshot.
interface CreateRow {
  invoiceNumber: string; entity: Entity; invoiceDate: string; dueDate: string;
  totalCents: number; lineCount: number; verdict: string; accounts: string; notes: string;
}

function extractDraftId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' && id !== '' ? id : null;
}

const CONSUMED_PATH = `${OUT}/medisca-consumed.json`;

async function runCreate(args: Args, runId: string): Promise<void> {
  const cachePath = `${OUT}/medisca-cache-${args.entity}.json`;
  if (!existsSync(cachePath)) {
    throw new Error(`No cache at ${cachePath}. Run --mode=refresh first — create never touches the portal.`);
  }
  const cache = loadBillCache(cachePath);
  // The floor is enforced HERE, not only at capture: the cache may deliberately hold years of
  // history (it feeds the SKU map), but create must never propose a draft into a closed period.
  const all = cache.all().filter((r) => r.entity === args.entity);
  const cached = all.filter((r) => r.invoiceDate >= PERIOD_FLOOR)
    .filter((r) => args.invoice === null || normalizeInvoiceNumber(r.invoiceNumber) === normalizeInvoiceNumber(args.invoice));
  console.log(`[${args.entity}] cache: ${all.length} invoice(s), ${cached.length} on/after ${PERIOD_FLOOR}${args.invoice ? ` (filtered to ${args.invoice})` : ''}`);

  // The registry is the only idempotency Ramp's draft-create has. Same discipline as Letco: a
  // corrupt registry hard-stops a live run (an empty-looking registry would re-create every bill)
  // but only warns a dry-run.
  const consumed = loadConsumedBillStore(CONSUMED_PATH);
  if (consumed.corrupt && args.live) {
    throw new Error(
      `MEDISCA_CONSUMED_REGISTRY_CORRUPT: ${CONSUMED_PATH} failed to parse — hard stop before any ` +
      `live write. Inspect/restore before retrying --live.`,
    );
  }

  // Live-only config, resolved BEFORE any work so a missing var fails on invoice #0, not #40.
  const vendorId = args.live ? requireEnv(`MEDISCA_RAMP_VENDOR_${args.entity}`) : '';
  const entityId = args.live ? requireEnv(`RAMP_ENTITY_ID_${args.entity}`) : '';
  const glFieldExternalId = requireEnv('RAMP_GL_FIELD_EXTERNAL_ID');
  const token = await rampToken(args.entity, args.live ? SCOPES_WRITE : SCOPES_READ);
  const gl = await buildGlIndex(args.entity, token);
  const accountOptionIds: Record<string, string> = {};
  for (const [code, id] of gl.byCode) accountOptionIds[code] = id;

  const { history } = await buildHistory(args.historySince);
  const rulings = buildRulings();

  // The SKU map is learned from the overlap between what the portal captured and what she has
  // already coded in QuickBooks — the same replay-her-decisions principle as the description
  // classifier, keyed on product identity instead of prose.
  // Learn from the ORDER lines, not the billed lines. Every invoice before 2026-08-03 is an
  // image-only PDF with no extractable lines, and those are exactly the invoices already coded in
  // QuickBooks — the only ones that can teach anything. Reading the billed lines instead produced a
  // SKU map with zero observations, because the invoices carrying SKUs were the new ones QB has
  // never seen.
  //
  // Pooled across ALL entities for the same reason the description history is: account codes are
  // company-wide, and TX alone is too thin to learn from.
  const qbByInvoice = await buildQbLineIndex(args.historySince);
  const observations: SkuObservation[] = [];
  for (const e of ALL_ENTITIES) {
    const path = `${OUT}/medisca-cache-${e}.json`;
    if (!existsSync(path)) continue;
    for (const inv of loadBillCache(path).all()) {
      const qbLines = qbByInvoice.get(normalizeInvoiceNumber(inv.invoiceNumber));
      if (qbLines === undefined) continue;
      observations.push(...joinInvoiceLines(
        inv.orderLines
          .filter((l) => l.sku !== '')
          .map((l) => ({ sku: l.sku, amountCents: l.amountCents })),
        qbLines,
      ));
    }
  }
  const skuHistory = buildSkuHistory(observations);
  const skuFile = toSkuMapFile(skuHistory, new Date().toISOString());
  writeFileSync(`${OUT}/medisca-sku-map.json`, JSON.stringify(skuFile, null, 2));
  console.log(
    `[${args.entity}] SKU map: ${observations.length} observation(s) -> ` +
    `${Object.keys(skuFile.resolved).length} resolved, ${Object.keys(skuFile.ambiguous).length} contested`,
  );

  const facts = await buildDedupeFacts(args.entity);
  console.log(
    `[${args.entity}] dedupe: ${facts.qbDocNumbers.size} QB, ${facts.rampInvoiceNumbers.size} Ramp bills, ` +
    `${facts.rampDraftInvoiceNumbers.size} Ramp drafts`,
  );

  const rows: CreateRow[] = [];
  const counts: Record<string, number> = {};
  const bump = (k: string): void => { counts[k] = (counts[k] ?? 0) + 1; };
  let liveWrites = 0;

  for (const inv of cached.sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate))) {
    const base = {
      invoiceNumber: inv.invoiceNumberRaw, entity: args.entity,
      invoiceDate: inv.invoiceDate, dueDate: inv.dueDate,
      totalCents: inv.listTotalCents, lineCount: inv.lines.length,
    };

    const verdict = dedupeVerdict(inv.invoiceNumber, { ...facts, inRegistry: consumed.has(inv.invoiceNumberRaw) });
    if (verdict !== 'create') {
      bump(verdict);
      rows.push({ ...base, verdict, accounts: '', notes: 'already recorded' });
      continue;
    }

    const plan = planMediscaCreate({
      invoiceNumberRaw: inv.invoiceNumberRaw,
      listTotalCents: inv.listTotalCents,
      pdfLines: inv.lines.map((l) => ({ amountCents: l.amountCents, unitPriceCents: 0, text: l.desc })),
      pdfTotals: inv.parseError !== null || inv.lines.length === 0
        ? null
        : { subtotalCents: inv.pdfSubtotalCents, totalCents: inv.pdfTotalCents },
      orderLines: inv.orderLines.map((l) => ({
        sku: l.sku, name: l.name, qty: 0, backOrdered: l.backOrdered,
        unitPriceCents: 0, amountCents: l.amountCents, lot: l.lot,
      })),
    }, { skuHistory, descriptionHistory: history, rulings });

    if (!plan.ok) {
      bump(plan.reason);
      rows.push({ ...base, verdict: plan.reason, accounts: '', notes: plan.detail });
      continue;
    }

    const label = plan.coded ? 'create_coded' : 'create_uncoded';
    const accounts = plan.lines.map((l) => `${(l.amountCents / 100).toFixed(2)}->${l.account ?? '??'}[${l.reason}]`).join(' ');
    const adjNote = plan.adjustmentCents === 0 ? '' : `adjustment ${(plan.adjustmentCents / 100).toFixed(2)}`;

    const executeLive = args.live && liveWrites < args.limit;
    if (!executeLive) {
      bump(label);
      rows.push({ ...base, verdict: label, accounts, notes: [adjNote, args.live ? 'over_limit' : 'dry_run'].filter((s) => s !== '').join(' ') });
      continue;
    }

    // ---- live: create the draft, record the registry, attach the cached PDF ----
    // A CODED plan uses the standard body builder; an UNCODED one gets the same lines with NO
    // accounting selections at all — all-or-nothing, a half-coded draft looks reviewed.
    let body: DraftBillBody;
    const memo = `Medisca invoice ${inv.invoiceNumberRaw} (order ${inv.orderNumber})`;
    if (plan.coded) {
      body = buildDraftBillBody({
        vendorId, entityId, invoiceNumber: inv.invoiceNumberRaw,
        issuedAt: inv.invoiceDate, dueAt: inv.dueDate, memo,
        lines: plan.lines.map((l) => ({ amountCents: l.amountCents, memo: l.memo, account: l.account as string })),
        glFieldExternalId, accountOptionIds,
      });
    } else {
      body = {
        vendor_id: vendorId, invoice_number: inv.invoiceNumberRaw,
        issued_at: inv.invoiceDate, due_at: inv.dueDate, memo,
        line_items: plan.lines.map((l) => ({ amount: l.amountCents / 100, memo: l.memo, accounting_field_selections: [] })),
        entity_id: entityId,
      };
    }

    const created = await createDraftBill(args.entity, body, token);
    const createOk = created.status >= 200 && created.status < 300;
    const draftId = createOk ? extractDraftId(created.body) : null;
    appendAudit(AUDIT_PATH, {
      runId, mode: 'live', vendor: VENDOR, entity: args.entity, txnId: draftId ?? '',
      action: createOk ? 'create_draft' : 'error', invoiceKey: inv.invoiceNumberRaw,
      amountCents: inv.listTotalCents, status: created.status,
      detail: JSON.stringify(created.body).slice(0, 500), priorMemo: null, priorLineItems: '',
    });
    liveWrites++;

    if (!createOk || draftId === null) {
      bump('create_failed');
      rows.push({ ...base, verdict: label, accounts, notes: `create_draft_failed:HTTP_${created.status}` });
      continue;
    }

    // Recorded BEFORE the attach: a crash between create and attach must leave the registry knowing
    // this invoice already has a draft — an un-attached draft is a small cleanup, a duplicate is not.
    consumed.record(inv.invoiceNumberRaw, draftId, args.entity);

    let attachNote = 'no_pdf_cached';
    if (inv.pdfPath !== '' && existsSync(inv.pdfPath)) {
      const attach = await attachBillDocument(
        args.entity, draftId, readFileSync(inv.pdfPath), `${inv.invoiceNumberRaw}.pdf`, token,
      );
      const attachOk = attach.status >= 200 && attach.status < 300;
      attachNote = attachOk ? 'pdf_attached' : `pdf_attach_failed:HTTP_${attach.status}`;
      appendAudit(AUDIT_PATH, {
        runId, mode: 'live', vendor: VENDOR, entity: args.entity, txnId: draftId,
        action: attachOk ? 'attach_pdf' : 'error', invoiceKey: inv.invoiceNumberRaw,
        amountCents: inv.listTotalCents, status: attach.status,
        detail: JSON.stringify(attach.body).slice(0, 300), priorMemo: null, priorLineItems: '',
      });
    }

    bump(`${label}_live`);
    rows.push({ ...base, verdict: label, accounts, notes: [`live_created draft_id=${draftId}`, attachNote, adjNote].filter((s) => s !== '').join(' ') });
  }

  const planPath = `${OUT}/medisca-create-plan-${args.entity}.csv`;
  writeFileSync(planPath, [
    'invoice_number,entity,invoice_date,due_date,total,line_count,verdict,accounts,notes',
    ...rows.map((r) => [
      r.invoiceNumber, r.entity, r.invoiceDate, r.dueDate, (r.totalCents / 100).toFixed(2),
      String(r.lineCount), r.verdict, r.accounts, r.notes,
    ].map(csv).join(',')),
  ].join('\n') + '\n');

  console.log(`[${args.entity}] ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(' ')}`);
  console.log(
    `[${args.entity}] wrote ${planPath} (${rows.length} rows) | ` +
    `${args.live ? `live writes=${liveWrites} (limit ${args.limit})` : 'dry-run (no writes)'} | run ${runId}`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const runId = `medisca-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(`run ${runId} | mode=${args.mode} | entity=${args.entity} | ${args.live ? `LIVE (limit ${args.limit})` : 'DRY-RUN'}`);

  if (args.mode === 'refresh') {
    await runRefresh(args);
    return;
  }
  if (args.mode === 'create') {
    await runCreate(args, runId);
    return;
  }
  console.log(`  history since ${args.historySince}`);

  const vendorId = requireEnv(`MEDISCA_RAMP_VENDOR_${args.entity}`);
  const glFieldExternalId = requireEnv('RAMP_GL_FIELD_EXTERNAL_ID');
  const token = await rampToken(args.entity, args.live ? SCOPES_WRITE : SCOPES_READ);

  const { history, bills, lines } = await buildHistory(args.historySince);
  console.log(`[${args.entity}] history (all entities): ${bills} QB Medisca bill(s), ${lines} coded line(s), ${history.size} distinct item(s)`);

  const rulings = buildRulings();
  console.log(`[${args.entity}] rulings: ${rulings.byItem.size} item + ${rulings.byLine.size} line, ruled by ${RULED_BY}`);

  // Option ids are resolved from THIS entity's live chart of accounts rather than env vars: Medisca
  // spans at least six accounts (vs Letco's two), and the Ramp option id differs per entity, so
  // hardcoding them would mean 18 env vars and a silent mis-post the day one changes.
  const gl = await buildGlIndex(args.entity, token);
  const accountOptionIds: Record<string, string> = {};
  for (const [code, id] of gl.byCode) accountOptionIds[code] = id;
  console.log(`[${args.entity}] chart: ${gl.byCode.size} account code(s) resolved to Ramp option ids`);

  const drafts = (await listDraftBills(args.entity, token, rampGet)).filter((d) => isMediscaDraft(d, vendorId));
  console.log(`[${args.entity}] Ramp drafts: ${drafts.length} Medisca draft(s)`);

  const rows: PlanRow[] = [];
  const counts = { patch: 0, skip_already_coded: 0, unclassifiable: 0, other: 0, byRuling: 0 };
  let liveWrites = 0;

  for (const draft of drafts) {
    const draftLines = toDraftLines(draft);
    const base = {
      invoiceNumber: (draft.invoice_number ?? '(none)').trim(),
      draftId: draft.id,
      entity: args.entity,
      owner: `${draft.bill_owner?.first_name ?? ''} ${draft.bill_owner?.last_name ?? ''}`.trim(),
      totalCents: draft.amount?.amount ?? 0,
      lineCount: draftLines.length,
    };

    const plan = planMediscaEnrichment(draftLines, history, { rulings, draftId: draft.id });
    if (!plan.ok) {
      if (plan.reason === 'already_coded') counts.skip_already_coded++;
      else if (plan.reason === 'unclassifiable') counts.unclassifiable++;
      else counts.other++;
      rows.push({ ...base, verdict: plan.reason, accounts: '', notes: plan.detail });
      continue;
    }

    // A missing option id would throw inside buildPatchLinesBody mid-run; catching it here turns it
    // into one skipped draft with a named account instead of a dead run.
    const missing = plan.lines.map((l) => l.account).filter((a) => accountOptionIds[a] === undefined);
    if (missing.length > 0) {
      counts.other++;
      rows.push({ ...base, verdict: 'no_option_id', accounts: [...new Set(plan.lines.map((l) => l.account))].join(' '), notes: `no Ramp option id for ${[...new Set(missing)].join(' ')}` });
      continue;
    }

    counts.patch++;
    // The reason travels with each line: a human ruling is not the same evidence as her own history,
    // and anyone auditing this CSV must be able to tell the two apart at a glance.
    const accounts = plan.lines.map((l) => `${(l.amountCents / 100).toFixed(2)}->${l.account}[${l.reason}]`).join(' ');
    if (plan.lines.some((l) => l.reason.endsWith('_ruling'))) counts.byRuling++;
    const executeLive = args.live && liveWrites < args.limit;
    if (!executeLive) {
      rows.push({ ...base, verdict: 'patch', accounts, notes: args.live ? 'over_limit' : 'dry_run' });
      continue;
    }

    const body = buildPatchLinesBody(plan.lines, glFieldExternalId, accountOptionIds);
    const res = await patchDraftBillLines(args.entity, draft.id, body, token);
    const ok = res.status >= 200 && res.status < 300;
    liveWrites++;
    appendAudit(AUDIT_PATH, {
      runId, mode: 'live', vendor: VENDOR, entity: args.entity, txnId: draft.id,
      action: ok ? 'patch_draft_gl' : 'error', invoiceKey: base.invoiceNumber,
      amountCents: base.totalCents, status: res.status,
      detail: JSON.stringify(res.body).slice(0, 500), priorMemo: draft.memo ?? null, priorLineItems: '',
    });
    rows.push({ ...base, verdict: 'patch', accounts, notes: ok ? `live_patched ${plan.lines.length} line(s)` : `patch_failed:HTTP_${res.status}` });
  }

  const planPath = `${OUT}/medisca-enrich-plan-${args.entity}.csv`;
  writeFileSync(planPath, [
    'invoice_number,draft_id,entity,owner,total,line_count,verdict,accounts,notes',
    ...rows.map(planLine),
  ].join('\n') + '\n');

  console.log(
    `[${args.entity}] drafts=${drafts.length} | patch=${counts.patch} (${counts.byRuling} via ruling) ` +
    `skip_already_coded=${counts.skip_already_coded} ` +
    `unclassifiable=${counts.unclassifiable} other=${counts.other} | ` +
    `${args.live ? `live writes=${liveWrites} (limit ${args.limit})` : 'dry-run (no writes)'}`,
  );
  console.log(`[${args.entity}] wrote ${planPath} (${rows.length} rows)`);

  // The refusals are the part a human has to act on, so surface them rather than burying them in
  // the CSV — they are also the signal for what to add to her history next.
  const refused = rows.filter((r) => r.verdict === 'unclassifiable');
  if (refused.length > 0) {
    console.log(`\n[${args.entity}] left for her (${refused.length}):`);
    for (const r of refused.slice(0, 12)) console.log(`  ${r.invoiceNumber}: ${r.notes.slice(0, 120)}`);
  }
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
