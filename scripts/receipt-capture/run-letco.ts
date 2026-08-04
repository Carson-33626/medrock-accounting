// Letco/Fagron orchestrator. TWO MODES — see the addendum in
// docs/superpowers/specs/2026-08-04-letco-fagron-bill-capture-design.md:
//
//   --mode=enrich (DEFAULT)  GL-code the draft bills the bookkeeper has ALREADY entered in Ramp.
//                            She creates a draft for every Letco invoice and codes the GL by hand
//                            before sending it for approval; enrich takes that coding step off her.
//                            Never creates anything, so it cannot duplicate her work.
//   --mode=create            Create drafts for invoices nobody has entered yet (13 of 38 as of
//                            2026-08-04). Only safe now that dedupe reads /bills/drafts as well.
//
// The 2026-08-04 live pilot created a perfectly-formed DUPLICATE because `GET /bills` silently
// excludes DRAFT-status bills, so the dedupe could not see the bookkeeper's own drafts. Both modes
// now read `GET /bills/drafts`. We never finalise a bill in either mode — a human reviews and
// releases the draft in Ramp, and Ramp syncs it to QuickBooks from there.
//
// Unlike run-uline.ts/run-toprx.ts, this is NOT a card-transaction-matching pipeline: Letco has
// zero Ramp card transactions (paid by bank autopay), so there is no worklist/matcher stage at all.
// Every roster invoice is its own unit of work, coded directly from its own detail page.
//
// GL option ids are ENTITY-SPECIFIC (Task 10 correction) — using FL's option id on a TN/TX bill
// would post real money to the wrong GL account. Vendor id + both option ids are resolved by the
// invoice's entity from web/.env.local; a missing var for the entity being run is a hard stop
// naming the exact variable, never a fallback to another entity's id.
//
// Task 9 carry-in: LetcoSession.get/postForm/getBinary take arbitrary paths and the type system
// cannot stop a caller from hitting a cart/checkout endpoint. Only the three verified read
// endpoints (roster POST, detail GET, PDF GET) are ever passed here.
//
//   npx tsx scripts/receipt-capture/run-letco.ts --entity=FL [--mode=enrich|create] [--since 2026-05-01] [--live] [--limit 5]
import '../ramp-split-push/load-env';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { LetcoSession } from './letco-session';
import { normalizeRosterItem, shouldFetchNextPage } from './letco-roster';
import type { RawRosterItem, RosterItem } from './letco-roster';
import { parseLetcoDetail } from './letco-invoice';
import { codeLetcoInvoice, LETCO_PRODUCT_ACCOUNT, LETCO_SHIPPING_ACCOUNT } from './letco-gl';
import { dedupeVerdict } from './bill-dedupe';
import type { DedupeFacts, DedupeVerdict } from './bill-dedupe';
import { loadConsumedBillStore } from './bill-consumed';
import {
  buildDraftBillBody, createDraftBill, attachBillDocument,
  listDraftBills, buildPatchLinesBody, patchDraftBillLines, isGlCoded,
} from './bill-draft';
import type { DraftBillInput, RampDraftBill } from './bill-draft';
import { planDraftEnrichment } from './letco-enrich';
import type { DraftLine } from './letco-enrich';
import { appendAudit } from './audit';
import { resolveSince, parseNumericFlag } from './cli-args';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';

const OUT = 'scripts/receipt-capture/out';
const PDF_DIR = `${OUT}/pdf`;
const AUDIT_PATH = `${OUT}/receipt-capture-audit.csv`;
const CONSUMED_PATH = `${OUT}/letco-consumed.json`;
const VENDOR = 'letco' as const;
const SCOPES_READ = 'bills:read';
const SCOPES_WRITE = 'bills:read bills:write';
const MAX_ROSTER_PAGES = 100;
// Deliberately NOT tied to --since: --since only bounds which invoices we even LOOK at (and is
// itself floored at PERIOD_FLOOR), but a hand-keyed QB bill for one of those invoices could in
// principle carry an earlier TxnDate. 2026-01-01 matches _probe-bill-origin.ts's own default, so
// the Step-3 reconcile check (163 manual / 50 Ramp as of 2026-08-04) is apples-to-apples with what
// that probe reports.
const QB_DEDUPE_FLOOR = '2026-01-01';

// ---- args ----
export type RunMode = 'create' | 'enrich';
interface Args { entity: Entity; since: string; live: boolean; limit: number; mode: RunMode }

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
  };
  const entityArg = get('--entity');
  if (!entityArg || !ALL_ENTITIES.includes(entityArg as Entity)) {
    throw new Error('Usage: npx tsx scripts/receipt-capture/run-letco.ts --entity=FL|TN|TX [--mode=enrich|create] [--since 2026-05-01] [--live] [--limit 5]');
  }
  const modeArg = get('--mode') ?? 'enrich';
  if (modeArg !== 'create' && modeArg !== 'enrich') {
    throw new Error(`Unknown --mode "${modeArg}". Use --mode=enrich (GL-code the bookkeeper's existing drafts) or --mode=create (create drafts she does not have).`);
  }
  return {
    entity: entityArg as Entity,
    since: resolveSince(get('--since')),
    live: argv.includes('--live'),
    limit: parseNumericFlag('--limit', get('--limit'), 5, 'clamp'),
    mode: modeArg,
  };
}

// ---- entity-scoped config (Task 10 correction: NOTHING here may fall back across entities) ----
function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') {
    throw new Error(
      `LETCO_ENV_MISSING: required env var ${name} is not set in web/.env.local. Refusing to guess ` +
      `or fall back to another entity's id — that would post this bill to the wrong GL account/vendor.`,
    );
  }
  return v.trim();
}

function accountOptionIdsFor(entity: Entity): Record<string, string> {
  return {
    [LETCO_PRODUCT_ACCOUNT]: requireEnv(`RAMP_GL_OPTION_1220_10_${entity}`),
    [LETCO_SHIPPING_ACCOUNT]: requireEnv(`RAMP_GL_OPTION_5000_45_${entity}`),
  };
}

// ---- roster paging ----
// The Knockout grid POSTs to the page URL itself; StartDate is M/D/YYYY and filters server-side.
// Verified live 2026-08-04: OrderType is a numeric Sana Commerce enum on the wire (1 = Invoice),
// not the string the endpoint's own query-string param name (`?OrderType=Invoice`) might suggest.
// The credit-note value is unconfirmed (the portal has never returned one against this filter), so
// this stays permissive on anything else STRING-shaped that says "invoice" but treats any other
// defined, non-1, non-"invoice" value as suspect and worth reporting rather than silently billing.
interface RawRosterItemWithType extends RawRosterItem { OrderType?: string | number }

function isInvoiceOrderType(orderType: string | number | undefined): boolean {
  if (orderType === undefined || orderType === null) return true;
  if (orderType === 1) return true;
  return String(orderType).trim().toLowerCase() === 'invoice';
}
interface RosterPageResponse { Items?: RawRosterItemWithType[]; TotalCount?: number }

function toPortalDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}/${Number(y)}`;
}

async function fetchRosterPage(session: LetcoSession, page: number, startDate: string): Promise<RosterPageResponse> {
  const res = await session.postForm('/profile/orders/?OrderType=Invoice', {
    page: String(page),
    OrderType: 'Invoice',
    StartDate: startDate,
    EndDate: '',
    OrderId: '',
    DocumentId: '',
  });
  if (res.status !== 200 || !/json/i.test(res.contentType)) {
    throw new Error(`Letco roster page ${page} failed: HTTP ${res.status} (content-type ${res.contentType || 'unknown'})`);
  }
  return JSON.parse(res.text) as RosterPageResponse;
}

interface RosterResult { roster: RosterItem[]; totalCount: number; skippedInvalid: number; creditNotes: RawRosterItemWithType[] }

async function fetchFullRoster(session: LetcoSession, since: string, maxPages: number): Promise<RosterResult> {
  const startDate = toPortalDate(since);
  const roster: RosterItem[] = [];
  const creditNotes: RawRosterItemWithType[] = [];
  let skippedInvalid = 0;
  let totalCount = 0;
  let lastPageSize = 0;
  let rawCollected = 0;
  let pagesFetched = 0;

  for (;;) {
    const page = await fetchRosterPage(session, pagesFetched, startDate);
    const rawItems = page.Items ?? [];
    totalCount = page.TotalCount ?? totalCount;
    lastPageSize = rawItems.length;
    rawCollected += lastPageSize;
    pagesFetched++;

    for (const raw of rawItems) {
      // We only ever request OrderType=Invoice, but a non-invoice row appearing anyway (e.g. a
      // credit note) must be reported and dropped, never silently normalised into a billable row —
      // credit notes are explicitly out of scope for v1 (design spec).
      if (!isInvoiceOrderType(raw.OrderType)) { creditNotes.push(raw); continue; }
      const item = normalizeRosterItem(raw);
      if (item === null) { skippedInvalid++; continue; }
      roster.push(item);
    }

    if (!shouldFetchNextPage(rawCollected, totalCount, lastPageSize, pagesFetched, maxPages)) break;
  }
  return { roster, totalCount, skippedInvalid, creditNotes };
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---- QuickBooks + Ramp dedupe facts ----
interface QbBillRow { DocNumber?: string; VendorRef?: { name?: string } }

async function fetchQbLetcoDocNumbers(entity: Entity, floor: string): Promise<Set<string>> {
  const location = ENTITY_TO_QB_LOCATION[entity];
  const bills = await qbQueryAll<QbBillRow>(location, 'Bill', `WHERE TxnDate >= '${floor}'`);
  const set = new Set<string>();
  for (const b of bills) {
    if (!/letco|fagron/i.test(b.VendorRef?.name ?? '')) continue;
    const doc = (b.DocNumber ?? '').trim();
    if (doc !== '') set.add(doc);
  }
  return set;
}

interface RampBillRaw { id: string; invoice_number?: string | null }
interface RampBillsPage { data?: RampBillRaw[]; page?: { next?: string | null } }

async function fetchRampBills(entity: Entity, token: string, maxPages = 30): Promise<RampBillRaw[]> {
  const out: RampBillRaw[] = [];
  let url: string | null = '/bills?page_size=100';
  for (let i = 0; i < maxPages && url !== null; i++) {
    const res: { status: number; body: RampBillsPage } = await rampGet<RampBillsPage>(entity, url, token);
    if (res.status !== 200) throw new Error(`Ramp /bills failed (${entity}): HTTP ${res.status}`);
    const rows = res.body.data ?? [];
    out.push(...rows);
    if (rows.length === 0) break;
    url = res.body.page?.next ?? null;
  }
  return out;
}

function extractDraftId(body: unknown): string | null {
  if (typeof body === 'object' && body !== null && 'id' in body) {
    const id = (body as { id?: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

// ---- plan CSV ----
type PlanVerdict = DedupeVerdict | 'residual';

interface PlanRow {
  invoiceNumber: string;
  orderId: string;
  entity: Entity;
  documentDate: string;
  dueDate: string | null;
  totalCents: number;
  lineCount: number | null;
  shippingCents: number | null;
  verdict: PlanVerdict;
  plannedAction: string;
  notes: string;
}

function csv(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function planRowLine(r: PlanRow): string {
  return [
    r.invoiceNumber, r.orderId, r.entity, r.documentDate, r.dueDate ?? '',
    (r.totalCents / 100).toFixed(2),
    r.lineCount === null ? '' : String(r.lineCount),
    r.shippingCents === null ? '' : (r.shippingCents / 100).toFixed(2),
    r.verdict, r.plannedAction, r.notes,
  ].map(csv).join(',');
}

function skipRow(item: RosterItem, entity: Entity, verdict: DedupeVerdict): PlanRow {
  return {
    invoiceNumber: item.documentId, orderId: item.orderId, entity,
    documentDate: item.documentDate, dueDate: item.dueDate, totalCents: item.totalCents,
    lineCount: null, shippingCents: null, verdict, plannedAction: 'skip', notes: verdict,
  };
}

function residualRow(item: RosterItem, entity: Entity, notes: string): PlanRow {
  return {
    invoiceNumber: item.documentId, orderId: item.orderId, entity,
    documentDate: item.documentDate, dueDate: item.dueDate, totalCents: item.totalCents,
    lineCount: null, shippingCents: null, verdict: 'residual', plannedAction: 'skip', notes,
  };
}

// ---- enrich mode ----
// Only the bookkeeper's Letco drafts are touched. Identified by vendor id first (authoritative) and
// by the C335- invoice prefix second, because a draft she typed by hand may predate the vendor link.
function isLetcoDraft(d: RampDraftBill, vendorId: string): boolean {
  if ((d.vendor?.id ?? '') === vendorId) return true;
  if (/letco|fagron/i.test(d.vendor?.name ?? '')) return true;
  return /^C335-/i.test((d.invoice_number ?? '').trim());
}

function toDraftLines(d: RampDraftBill): DraftLine[] {
  return (d.line_items ?? []).map((l) => ({
    amountCents: l.amount?.amount ?? 0,
    memo: l.memo ?? '',
    // isGlCoded, not "has any selection": a Billable=false flag is a selection but not GL coding,
    // and counting it as coded would make enrich skip a draft that still needs an account.
    coded: isGlCoded(l.accounting_field_selections),
  }));
}

interface EnrichRow {
  invoiceNumber: string;
  draftId: string;
  entity: Entity;
  owner: string;
  totalCents: number;
  lineCount: number;
  verdict: string;
  notes: string;
}

function enrichRowLine(r: EnrichRow): string {
  return [
    r.invoiceNumber, r.draftId, r.entity, r.owner,
    (r.totalCents / 100).toFixed(2), String(r.lineCount), r.verdict, r.notes,
  ].map(csv).join(',');
}

async function runEnrich(
  entity: Entity,
  args: Args,
  runId: string,
  session: LetcoSession,
  roster: RosterItem[],
  token: string,
  vendorId: string,
  glFieldExternalId: string,
  accountOptionIds: Record<string, string>,
): Promise<void> {
  const byInvoice = new Map(roster.map((r) => [r.documentId.trim().toUpperCase(), r]));
  const drafts = (await listDraftBills(entity, token, rampGet)).filter((d) => isLetcoDraft(d, vendorId));
  console.log(`[${entity}] Ramp drafts: ${drafts.length} Letco draft(s) found`);

  const rows: EnrichRow[] = [];
  const counts = { patch: 0, skip_already_coded: 0, residual: 0 };
  let liveWrites = 0;

  for (const draft of drafts) {
    const invoiceNumber = (draft.invoice_number ?? '').trim();
    const owner = `${draft.bill_owner?.first_name ?? ''} ${draft.bill_owner?.last_name ?? ''}`.trim();
    const draftLines = toDraftLines(draft);
    const base = {
      invoiceNumber: invoiceNumber === '' ? '(none)' : invoiceNumber,
      draftId: draft.id, entity, owner,
      totalCents: draft.amount?.amount ?? 0,
      lineCount: draftLines.length,
    };
    const residual = (notes: string): void => {
      counts.residual++;
      rows.push({ ...base, verdict: 'residual', notes });
    };

    // Cheapest refusal first: an already-coded draft needs no portal round-trip at all. This is also
    // what makes enrich idempotent — after we patch, every line is coded, so a re-run lands here.
    if (draftLines.length > 0 && draftLines.some((l) => l.coded)) {
      counts.skip_already_coded++;
      rows.push({ ...base, verdict: 'skip_already_coded', notes: 'already_coded' });
      continue;
    }

    const item = invoiceNumber === '' ? undefined : byInvoice.get(invoiceNumber.toUpperCase());
    if (item === undefined) {
      // Without the portal invoice there is nothing to reconcile against, and memo text alone is not
      // enough to post money on. Widening --since is the fix when this is just an out-of-window date.
      residual(`no_roster_match:not_in_window_since_${args.since}`);
      continue;
    }

    const detailRes = await session.get(item.detailUrl);
    if (detailRes.status !== 200) { residual(`detail_fetch_failed:HTTP_${detailRes.status}`); continue; }
    const parsed = parseLetcoDetail(detailRes.text, item.totalCents);
    if (parsed === null) { residual('reconcile_failed'); continue; }

    const plan = planDraftEnrichment(draftLines, parsed);
    if (!plan.ok) { residual(plan.reason); continue; }

    counts.patch++;
    const executeLive = args.live && liveWrites < args.limit;
    if (!executeLive) {
      const coding = plan.lines.map((l) => `${(l.amountCents / 100).toFixed(2)}->${l.account}`).join(' ');
      rows.push({ ...base, verdict: 'patch', notes: `${args.live ? 'over_limit' : 'dry_run'} ${coding}` });
      continue;
    }

    const body = buildPatchLinesBody(plan.lines, glFieldExternalId, accountOptionIds);
    const res = await patchDraftBillLines(entity, draft.id, body, token);
    const ok = res.status >= 200 && res.status < 300;
    liveWrites++;
    appendAudit(AUDIT_PATH, {
      runId, mode: 'live', vendor: VENDOR, entity, txnId: draft.id,
      action: ok ? 'patch_draft_gl' : 'error', invoiceKey: invoiceNumber,
      amountCents: base.totalCents, status: res.status,
      detail: JSON.stringify(res.body).slice(0, 500), priorMemo: draft.memo ?? null, priorLineItems: '',
    });
    rows.push({ ...base, verdict: 'patch', notes: ok ? `live_patched ${plan.lines.length} line(s)` : `patch_failed:HTTP_${res.status}` });
  }

  const planPath = `${OUT}/letco-enrich-plan-${entity}.csv`;
  const header = 'invoice_number,draft_id,entity,owner,total,line_count,verdict,notes';
  writeFileSync(planPath, [header, ...rows.map(enrichRowLine)].join('\n') + '\n');

  console.log(
    `[${entity}] drafts=${drafts.length} | patch=${counts.patch} skip_already_coded=${counts.skip_already_coded} ` +
    `residual=${counts.residual} | ${args.live ? `live writes=${liveWrites} (limit ${args.limit})` : 'dry-run (no writes)'}`,
  );
  console.log(`[${entity}] wrote ${planPath} (${rows.length} rows)`);
}

async function runLetco(entity: Entity, args: Args, runId: string): Promise<void> {
  // Fail loudly BEFORE touching the portal or Ramp if this entity's coding config is incomplete —
  // cheaper than discovering it mid-run on invoice #40.
  const vendorId = requireEnv(`LETCO_RAMP_VENDOR_${entity}`);
  // Confirmed empirically (2026-08-04), not inferred: every bill Ramp already holds carries a
  // non-null entity_id, one distinct value per entity (verified against a real Letco TX bill,
  // invoice C335-162940). Sending null here would be guessing against that evidence — resolved
  // strictly per entity, same requireEnv treatment as the vendor/GL option ids, because a wrong
  // value here puts the bill in the wrong company's books.
  const entityId = requireEnv(`RAMP_ENTITY_ID_${entity}`);
  const glFieldExternalId = requireEnv('RAMP_GL_FIELD_EXTERNAL_ID');
  const accountOptionIds = accountOptionIdsFor(entity);

  // Enrich mode never creates anything, so the consumed registry (whose only job is to stop a
  // crashed run from re-creating a draft) is neither read nor able to block it.
  const consumed = loadConsumedBillStore(CONSUMED_PATH);
  if (consumed.corrupt && args.mode === 'create') {
    if (args.live) {
      throw new Error(
        `LETCO_CONSUMED_REGISTRY_CORRUPT: ${CONSUMED_PATH} failed to parse — hard stop before any ` +
        `live write to avoid re-creating a draft bill a prior run already created. Inspect/restore ` +
        `(or delete to start a fresh, no-longer-protective, registry) before retrying --live.`,
      );
    }
    console.warn(
      `[WARN] ${CONSUMED_PATH} failed to parse — consumed-bill registry is running EMPTY this ` +
      `dry-run. Any 'skip_registry' verdicts in the plan CSV are not trustworthy. Repair/restore ` +
      `the registry before going --live.`,
    );
  }

  const session = await LetcoSession.login(entity);
  console.log(`[${entity}] Letco session authenticated`);

  const { roster, totalCount, skippedInvalid, creditNotes } = await fetchFullRoster(session, args.since, MAX_ROSTER_PAGES);
  console.log(`[${entity}] roster: ${roster.length} invoice(s) since ${args.since} (server TotalCount=${totalCount}), skippedInvalid=${skippedInvalid}, creditNotes=${creditNotes.length}`);
  if (creditNotes.length > 0) {
    console.log(`[${entity}] [warn] ${creditNotes.length} non-invoice row(s) reported, NOT processed: ${creditNotes.slice(0, 5).map((r) => r.DocumentId ?? '?').join(', ')}`);
  }

  const rampScope = args.live ? SCOPES_WRITE : SCOPES_READ;
  const token = await rampToken(entity, rampScope);

  if (args.mode === 'enrich') {
    await runEnrich(entity, args, runId, session, roster, token, vendorId, glFieldExternalId, accountOptionIds);
    return;
  }

  const qbDocNumbers = await fetchQbLetcoDocNumbers(entity, QB_DEDUPE_FLOOR);
  const rampBills = await fetchRampBills(entity, token);
  const rampInvoiceNumbers = new Set(rampBills.map((b) => (b.invoice_number ?? '').trim()).filter((s) => s !== ''));
  // The layer whose absence produced a duplicate on 2026-08-04: GET /bills excludes DRAFT-status
  // bills, so without this the bookkeeper's own drafts are invisible to create mode.
  const rampDrafts = await listDraftBills(entity, token, rampGet);
  const rampDraftInvoiceNumbers = new Set(
    rampDrafts.filter((d) => isLetcoDraft(d, vendorId)).map((d) => (d.invoice_number ?? '').trim()).filter((s) => s !== ''),
  );
  console.log(`[${entity}] dedupe facts: QB docNumbers=${qbDocNumbers.size} (since ${QB_DEDUPE_FLOOR}), Ramp bills w/ invoice#=${rampInvoiceNumbers.size}, Ramp DRAFTS w/ invoice#=${rampDraftInvoiceNumbers.size}, registry entries=${Object.keys(consumed.all()).length}`);

  const rows: PlanRow[] = [];
  const counts: Record<PlanVerdict, number> = { create: 0, skip_registry: 0, skip_quickbooks: 0, skip_ramp: 0, skip_draft: 0, residual: 0 };
  let liveWrites = 0;

  for (const item of roster) {
    const invoiceNumber = item.documentId;
    const facts: DedupeFacts = { inRegistry: consumed.has(invoiceNumber), qbDocNumbers, rampInvoiceNumbers, rampDraftInvoiceNumbers };
    const verdict = dedupeVerdict(invoiceNumber, facts);

    if (verdict !== 'create') {
      counts[verdict]++;
      rows.push(skipRow(item, entity, verdict));
      if (args.live) {
        appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: '', action: 'skip', invoiceKey: invoiceNumber, amountCents: item.totalCents, status: null, detail: verdict, priorMemo: null, priorLineItems: '' });
      }
      continue;
    }

    // dedupe cleared -> fetch detail -> parse -> reconcile -> code.
    const detailRes = await session.get(item.detailUrl);
    if (detailRes.status !== 200) {
      counts.residual++;
      const notes = `detail_fetch_failed:HTTP_${detailRes.status}`;
      rows.push(residualRow(item, entity, notes));
      if (args.live) appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: '', action: 'error', invoiceKey: invoiceNumber, amountCents: item.totalCents, status: detailRes.status, detail: notes, priorMemo: null, priorLineItems: '' });
      continue;
    }

    const parsed = parseLetcoDetail(detailRes.text, item.totalCents);
    if (parsed === null) {
      // Reconcile failure -> residual row, never a coded bill (parseLetcoDetail already refuses a
      // negative shipping residual internally; null also covers "no item table found").
      counts.residual++;
      rows.push(residualRow(item, entity, 'reconcile_failed'));
      if (args.live) appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: '', action: 'skip', invoiceKey: invoiceNumber, amountCents: item.totalCents, status: null, detail: 'reconcile_failed', priorMemo: null, priorLineItems: '' });
      continue;
    }

    const coded = codeLetcoInvoice(parsed);
    let dueAt = item.dueDate;
    if (dueAt === null) {
      dueAt = addDays(item.documentDate, 30);
      console.warn(`[${entity}] [warn] invoice ${invoiceNumber} has no due date on the roster; defaulting to documentDate+30 (${dueAt})`);
    }
    const memo = `Letco invoice ${item.documentId} (order ${item.orderId})`;
    counts.create++;

    const executeLive = args.live && liveWrites < args.limit;
    if (!executeLive) {
      rows.push({
        invoiceNumber, orderId: item.orderId, entity, documentDate: item.documentDate, dueDate: item.dueDate,
        totalCents: item.totalCents, lineCount: parsed.lines.length, shippingCents: parsed.shippingCents,
        verdict: 'create', plannedAction: 'create_draft_bill;attach_pdf',
        notes: args.live ? 'over_limit' : 'dry_run',
      });
      continue;
    }

    // --live, within limit: fetch the real PDF, create the draft, attach it, record the registry.
    const pdfPath = `/orders/files/report.pdf?OrderId=Invoice_${item.documentId}&OriginalOrderId=${item.orderId}`;
    const pdfRes = await session.getBinary(pdfPath);
    const isPdf = pdfRes.buffer.subarray(0, 4).toString('latin1') === '%PDF';
    if (pdfRes.status !== 200 || !isPdf) {
      liveWrites++; // still consumed this run's write attempt, mirrors run-uline.ts's failed-attach accounting
      rows.push({
        invoiceNumber, orderId: item.orderId, entity, documentDate: item.documentDate, dueDate: item.dueDate,
        totalCents: item.totalCents, lineCount: parsed.lines.length, shippingCents: parsed.shippingCents,
        verdict: 'create', plannedAction: 'create_draft_bill;attach_pdf',
        notes: `pdf_fetch_failed:HTTP_${pdfRes.status}`,
      });
      appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: '', action: 'error', invoiceKey: invoiceNumber, amountCents: item.totalCents, status: pdfRes.status, detail: 'pdf_fetch_failed', priorMemo: null, priorLineItems: '' });
      continue;
    }
    if (!existsSync(PDF_DIR)) mkdirSync(PDF_DIR, { recursive: true });
    writeFileSync(`${PDF_DIR}/letco-${entity}-${invoiceNumber}.pdf`, pdfRes.buffer);

    const input: DraftBillInput = {
      vendorId, entityId, invoiceNumber: item.documentId, issuedAt: item.documentDate, dueAt, memo,
      lines: coded, glFieldExternalId, accountOptionIds,
    };
    const body = buildDraftBillBody(input);
    const created = await createDraftBill(entity, body, token);
    const createOk = created.status >= 200 && created.status < 300;
    const draftId = createOk ? extractDraftId(created.body) : null;
    appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: draftId ?? '', action: createOk ? 'create_draft' : 'error', invoiceKey: invoiceNumber, amountCents: item.totalCents, status: created.status, detail: JSON.stringify(created.body).slice(0, 500), priorMemo: null, priorLineItems: '' });
    liveWrites++;

    if (!createOk || draftId === null) {
      rows.push({
        invoiceNumber, orderId: item.orderId, entity, documentDate: item.documentDate, dueDate: item.dueDate,
        totalCents: item.totalCents, lineCount: parsed.lines.length, shippingCents: parsed.shippingCents,
        verdict: 'create', plannedAction: 'create_draft_bill;attach_pdf',
        notes: `create_draft_failed:HTTP_${created.status}`,
      });
      continue;
    }

    // Recorded immediately after a successful create — before the attachment call — so a crash
    // between create and attach still leaves the registry reflecting that THIS invoice already has
    // a draft in Ramp (an un-attached draft is a far smaller cleanup than a duplicate draft, and
    // Ramp's draft-create has no idempotency key to protect against the latter on retry).
    consumed.record(invoiceNumber, draftId, entity);

    const attach = await attachBillDocument(entity, draftId, pdfRes.buffer, `${invoiceNumber}.pdf`, token);
    const attachOk = attach.status >= 200 && attach.status < 300;
    appendAudit(AUDIT_PATH, { runId, mode: 'live', vendor: VENDOR, entity, txnId: draftId, action: attachOk ? 'attach_pdf' : 'error', invoiceKey: invoiceNumber, amountCents: item.totalCents, status: attach.status, detail: JSON.stringify(attach.body).slice(0, 500), priorMemo: null, priorLineItems: '' });

    rows.push({
      invoiceNumber, orderId: item.orderId, entity, documentDate: item.documentDate, dueDate: item.dueDate,
      totalCents: item.totalCents, lineCount: parsed.lines.length, shippingCents: parsed.shippingCents,
      verdict: 'create', plannedAction: 'create_draft_bill;attach_pdf',
      notes: attachOk ? `live_created draft_id=${draftId}` : `draft_created_pdf_attach_failed draft_id=${draftId} HTTP_${attach.status}`,
    });
  }

  const planPath = `${OUT}/letco-plan-${entity}.csv`;
  const header = 'invoice_number,order_id,entity,document_date,due_date,total,line_count,shipping,verdict,planned_action,notes';
  writeFileSync(planPath, [header, ...rows.map(planRowLine)].join('\n') + '\n');

  console.log(
    `[${entity}] roster=${roster.length} | create=${counts.create} skip_registry=${counts.skip_registry} ` +
    `skip_quickbooks=${counts.skip_quickbooks} skip_ramp=${counts.skip_ramp} skip_draft=${counts.skip_draft} residual=${counts.residual} | ` +
    `${args.live ? `live writes=${liveWrites} (limit ${args.limit})` : 'dry-run (no writes)'}`,
  );
  console.log(`[${entity}] wrote ${planPath} (${rows.length} rows)`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const runId = `letco-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(`run ${runId} | entity=${args.entity} | mode=${args.mode} | since=${args.since} | ${args.live ? `LIVE (limit ${args.limit})` : 'DRY-RUN'}`);
  try {
    await runLetco(args.entity, args, runId);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (msg.startsWith('LETCO_ENV_MISSING')) { console.error(`\n[${args.entity}] ${msg}\n`); process.exit(3); }
    if (msg.startsWith('LETCO_CONSUMED_REGISTRY_CORRUPT')) { console.error(`\n[${args.entity}] ${msg}\n`); process.exit(4); }
    if (msg.includes('login failed') || msg.startsWith('Missing LETCO_')) { console.error(`\n[${args.entity}] Letco sign-in failed:\n${msg}\n`); process.exit(2); }
    throw e;
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
