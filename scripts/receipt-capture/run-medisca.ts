// Medisca orchestrator — ENRICH ONLY. See
// docs/superpowers/specs/2026-08-04-medisca-draft-enrichment-design.md
//
// Kristina enters every Medisca invoice as a Ramp draft (77 of them right now, ALL uncoded) and
// codes the GL by hand before sending for approval. This takes that coding step off her by
// replaying her OWN QuickBooks history onto the drafts she has not coded yet.
//
// There is deliberately NO create mode. Letco has one because 13 of its invoices had no draft at
// all; every Medisca invoice already has one. Creating would only duplicate her work — the exact
// failure the Letco pilot produced on 2026-08-04.
//
// Unlike Letco this needs NO portal session at all: Ramp's drafts already carry the invoice PDF,
// per-line amounts and shipping as its own line, and the risk here is product CATEGORY, which the
// portal's free text would not resolve any better than the memo already does.
//
//   npx tsx scripts/receipt-capture/run-medisca.ts --entity=FL [--history-since 2023-01-01] [--live] [--limit 5]
import '../ramp-split-push/load-env';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  listDraftBills, buildPatchLinesBody, patchDraftBillLines, isGlCoded,
} from './bill-draft';
import type { RampDraftBill } from './bill-draft';
import { planMediscaEnrichment, recordHistory } from './medisca-gl';
import type { MediscaHistory, MediscaDraftLine } from './medisca-gl';
import { appendAudit } from './audit';
import { parseNumericFlag } from './cli-args';
import { rampToken, rampGet } from '../ramp-split-push/ramp-client';
import { buildGlIndex } from '../amazon-enrich/gl-resolve';
import { ALL_ENTITIES, ENTITY_TO_QB_LOCATION } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';
import { qbQueryAll } from '../../src/lib/quickbooks-multi';

const OUT = 'scripts/receipt-capture/out';
const AUDIT_PATH = `${OUT}/receipt-capture-audit.csv`;
const VENDOR = 'medisca' as const;
const SCOPES_READ = 'bills:read accounting:read';
const SCOPES_WRITE = 'bills:read bills:write accounting:read';
const VENDOR_RE = /medisca/i;
// Widening this changes nothing measurable (2025 -> 2023 added 88 items and 256 lines but produced
// the identical 67 patchable / 10 refused split), so it is a knob, not a lever. The blockers are
// genuinely new items and genuine inconsistencies, not a thin corpus.
const DEFAULT_HISTORY_SINCE = '2023-01-01';

interface Args { entity: Entity; historySince: string; live: boolean; limit: number }

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
    throw new Error('Usage: npx tsx scripts/receipt-capture/run-medisca.ts --entity=FL|TN|TX [--history-since 2023-01-01] [--live] [--limit 5]');
  }
  return {
    entity: entityArg as Entity,
    historySince: get('--history-since') ?? DEFAULT_HISTORY_SINCE,
    live: argv.includes('--live'),
    limit: parseNumericFlag('--limit', get('--limit'), 5, 'clamp'),
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

async function main(): Promise<void> {
  const args = parseArgs();
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const runId = `medisca-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(`run ${runId} | entity=${args.entity} | history since ${args.historySince} | ${args.live ? `LIVE (limit ${args.limit})` : 'DRY-RUN'}`);

  const vendorId = requireEnv(`MEDISCA_RAMP_VENDOR_${args.entity}`);
  const glFieldExternalId = requireEnv('RAMP_GL_FIELD_EXTERNAL_ID');
  const token = await rampToken(args.entity, args.live ? SCOPES_WRITE : SCOPES_READ);

  const { history, bills, lines } = await buildHistory(args.historySince);
  console.log(`[${args.entity}] history (all entities): ${bills} QB Medisca bill(s), ${lines} coded line(s), ${history.size} distinct item(s)`);

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
  const counts = { patch: 0, skip_already_coded: 0, unclassifiable: 0, other: 0 };
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

    const plan = planMediscaEnrichment(draftLines, history);
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
    const accounts = plan.lines.map((l) => `${(l.amountCents / 100).toFixed(2)}->${l.account}`).join(' ');
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
    `[${args.entity}] drafts=${drafts.length} | patch=${counts.patch} skip_already_coded=${counts.skip_already_coded} ` +
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
