// READ-ONLY recon: engineering / R&D software + cloud spend across Ramp and QuickBooks.
// Answers "which vendors, how much per month". Zero writes to Ramp or QB (dry-run mandate).
//
// Run from web/:  npx tsx scripts/recon-tech-subscriptions.ts
//
// Ramp side  : every CLEARED card txn since FROM_DATE for FL/TN/TX, rolled up per merchant with
//               monthly cadence, GL coding seen, and which cardholders spend on it.
// QBO side   : every Bill + Purchase since FROM_DATE for every connected company, rolled up per
//               vendor with the expense accounts each one hits.
// Outputs    : three CSVs + a console shortlist. Classification of "is this engineering spend" is
//               deliberately a WIDE keyword net plus the two GL anchors (5000.50 R&D,
//               6200.97 Software Support Fees) — the full CSVs are there to eyeball the long tail.
import './lib/load-env';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { rampToken, rampGet } from './lib/ramp';
import type { Entity } from './lib/entities';
import { ALL_ENTITIES } from './lib/entities';
import { qbQueryAll, getConnectedLocations } from '../src/lib/quickbooks-multi';
import type { Location } from '../src/lib/quickbooks-multi';

const FROM_DATE = process.env.RECON_FROM ?? '2025-07-01';
const TO_DATE = process.env.RECON_TO ?? new Date().toISOString().slice(0, 10);
const OUT_DIR = join(process.cwd(), '..', 'docs', 'tech-spend-recon');

// ── Classification ─────────────────────────────────────────────────────────────
// Wide net on purpose. Anything matching gets flagged for the shortlist; the full roll-up is
// still written out so nothing is silently dropped.
const TECH_RE =
  /(aws|amazon web services|supabase|vercel|github|gitlab|anthropic|openai|claude|cursor|netlify|cloudflare|digitalocean|linode|heroku|render\.com|railway|fly\.io|planetscale|neon\b|mongodb|atlas|redis|datadog|sentry|new relic|twilio|sendgrid|postmark|mailgun|resend|stripe|plaid|auth0|okta|clerk\.com|firebase|google cloud|gcp|azure|microsoft 365|google workspace|jetbrains|visual studio|autodesk|figma|notion|linear\b|jira|atlassian|slack|zoom|asana|monday\.com|airtable|zapier|make\.com|n8n|docker|npmjs|jsr\b|hugging ?face|replicate|pinecone|weaviate|langchain|langsmith|browserstack|playwright|circleci|travis|namecheap|godaddy|cloudflare|route ?53|godaddy|porkbun|1password|lastpass|bitwarden|tailscale|ngrok|postman|insomnia(?!\s*cookies)|retool|snowflake|databricks|fivetran|dbt\b|segment|posthog|mixpanel|amplitude|launchdarkly|statsig|expo\b|apple developer|google play|elastic|grafana|pagerduty|opsgenie|hetzner|ovh|vultr|backblaze|wasabi|cloudinary|imgix|algolia|typesense|meilisearch|deepgram|assemblyai|elevenlabs|midjourney|perplexity|groq|together ?ai|fireworks ?ai|modal\b|runpod|lambda ?labs|paperspace|colab)/i;

// Amazon needs its own bucket — "Amazon warehouse stuff" (supplies) and AWS are different animals
// and Ramp names them differently (AMAZON WEB SERVICES vs Amazon.com / Amazon Business).
const AWS_RE = /(amazon web services|aws\b|amzn.*aws)/i;
const AMAZON_RETAIL_RE = /(amazon\.com|amazon mktp|amzn mktp|amazon business|amazon prime|amazon retail|amazon\.co)/i;

// GL anchors from docs/ramp-recon/RAMP-RULES-SETUP-GUIDE.md
const RD_ACCT_RE = /(5000\.50|research\s*&?\s*development)/i;
const SOFTWARE_ACCT_RE = /(6200\.97|software support|software subscription|dues.*subscription|computer.*software)/i;

type Bucket = 'AWS' | 'Amazon-retail' | 'Tech/SaaS' | 'GL:R&D' | 'GL:Software' | '';

function bucketOf(name: string, glText: string): Bucket {
  if (AWS_RE.test(name)) return 'AWS';
  if (AMAZON_RETAIL_RE.test(name)) return 'Amazon-retail';
  if (TECH_RE.test(name)) return 'Tech/SaaS';
  if (RD_ACCT_RE.test(glText)) return 'GL:R&D';
  if (SOFTWARE_ACCT_RE.test(glText)) return 'GL:Software';
  return '';
}

// ── Ramp ───────────────────────────────────────────────────────────────────────
interface RampFieldSelection {
  category_info?: { name?: string | null } | null;
  external_code?: string | null;
  name?: string | null;
  value?: string | null;
  type?: string | null;
}
interface RawRampTxn {
  id: string;
  amount: number;
  state: string | null;
  sync_status: string | null;
  user_transaction_time: string | null;
  merchant_name: string | null;
  merchant_descriptor: string | null;
  memo: string | null;
  sk_category_name: string | null;
  card_holder: { first_name?: string; last_name?: string; department_name?: string | null } | null;
  accounting_field_selections: RampFieldSelection[] | null;
}
interface RampPage {
  data: RawRampTxn[];
  page?: { next?: string };
}

interface RampTxnRow {
  entity: Entity;
  date: string;
  merchant: string;
  cents: number;
  holder: string;
  department: string;
  category: string;
  gl: string;
  syncStatus: string;
  memo: string;
}
const RAMP_TXNS: RampTxnRow[] = [];

interface MerchantRoll {
  key: string;
  display: string;
  entities: Set<Entity>;
  months: Map<string, number>; // 'YYYY-MM' -> cents
  totalCents: number;
  count: number;
  holders: Map<string, number>;
  glCodes: Set<string>;
  categories: Set<string>;
  firstDate: string;
  lastDate: string;
  memoSample: string;
}

function normalizeMerchant(name: string | null, descriptor: string | null): string {
  const raw = (name ?? descriptor ?? '(unknown)').trim();
  return raw.replace(/\s+/g, ' ');
}

function glTextOf(sels: RampFieldSelection[] | null): string {
  if (!sels) return '';
  return sels
    .map((s) => [s.name, s.value, s.external_code, s.category_info?.name].filter(Boolean).join(' '))
    .join(' | ');
}

async function pullRamp(): Promise<Map<string, MerchantRoll>> {
  const rolls = new Map<string, MerchantRoll>();
  for (const entity of ALL_ENTITIES) {
    process.stdout.write(`  Ramp ${entity} …`);
    const token = await rampToken(entity, 'transactions:read');
    let next: string | null =
      `/transactions?page_size=100&order_by_date_desc=true&from_date=${FROM_DATE}T00:00:00Z`;
    let seen = 0;
    for (let i = 0; i < 400 && next !== null; i++) {
      const res: { status: number; body: RampPage } = await rampGet<RampPage>(entity, next, token);
      if (res.status !== 200) throw new Error(`Ramp ${entity} page ${i} HTTP ${res.status}`);
      for (const r of res.body.data ?? []) {
        if (r.state !== 'CLEARED') continue;
        const date = (r.user_transaction_time ?? '').slice(0, 10);
        if (!date || date < FROM_DATE || date > TO_DATE) continue;
        seen++;
        const display = normalizeMerchant(r.merchant_name, r.merchant_descriptor);
        const key = display.toLowerCase();
        const cents = Math.round(r.amount * 100);
        const month = date.slice(0, 7);
        let m = rolls.get(key);
        if (!m) {
          m = {
            key,
            display,
            entities: new Set<Entity>(),
            months: new Map<string, number>(),
            totalCents: 0,
            count: 0,
            holders: new Map<string, number>(),
            glCodes: new Set<string>(),
            categories: new Set<string>(),
            firstDate: date,
            lastDate: date,
            memoSample: '',
          };
          rolls.set(key, m);
        }
        m.entities.add(entity);
        m.months.set(month, (m.months.get(month) ?? 0) + cents);
        m.totalCents += cents;
        m.count++;
        const holder = r.card_holder
          ? `${r.card_holder.first_name ?? ''} ${r.card_holder.last_name ?? ''}`.trim()
          : '(none)';
        m.holders.set(holder, (m.holders.get(holder) ?? 0) + 1);
        const gl = glTextOf(r.accounting_field_selections);
        if (gl) m.glCodes.add(gl.slice(0, 120));
        if (r.sk_category_name) m.categories.add(r.sk_category_name);
        if (date < m.firstDate) m.firstDate = date;
        if (date > m.lastDate) m.lastDate = date;
        if (!m.memoSample && r.memo) m.memoSample = r.memo.slice(0, 80);
        RAMP_TXNS.push({
          entity,
          date,
          merchant: display,
          cents,
          holder,
          department: r.card_holder?.department_name ?? '',
          category: r.sk_category_name ?? '',
          gl,
          syncStatus: r.sync_status ?? '',
          memo: (r.memo ?? '').slice(0, 120),
        });
      }
      next = res.body.page?.next ?? null;
    }
    console.log(` ${seen} cleared txns`);
  }
  return rolls;
}

// ── QuickBooks ─────────────────────────────────────────────────────────────────
interface QbRef {
  value?: string;
  name?: string;
}
interface QbLine {
  Amount?: number;
  Description?: string;
  DetailType?: string;
  AccountBasedExpenseLineDetail?: { AccountRef?: QbRef; ClassRef?: QbRef };
  ItemBasedExpenseLineDetail?: { ItemRef?: QbRef; ClassRef?: QbRef };
}
interface QbTxn {
  Id?: string;
  TxnDate?: string;
  TotalAmt?: number;
  DocNumber?: string;
  PrivateNote?: string;
  Credit?: boolean;
  PaymentType?: string;       // Purchase only: Cash | Check | CreditCard
  AccountRef?: QbRef;         // Purchase only: the funding account (which card/bank paid)
  APAccountRef?: QbRef;       // Bill only
  VendorRef?: QbRef;
  EntityRef?: QbRef;
  Line?: QbLine[];
}

// Line-level dump rows so the roll-up can be re-pivoted without re-pulling the APIs.
interface QbLineRow {
  location: Location;
  source: string;
  date: string;
  vendor: string;
  account: string;
  cents: number;
  fundingAccount: string;
  paymentType: string;
  docNumber: string;
  description: string;
}
const QB_LINES: QbLineRow[] = [];

interface VendorRoll {
  key: string;
  display: string;
  locations: Set<Location>;
  months: Map<string, number>;
  totalCents: number;
  count: number;
  accounts: Map<string, number>; // account name -> cents
  sourceTypes: Set<string>;
  firstDate: string;
  lastDate: string;
}

function addQbTxn(
  rolls: Map<string, VendorRoll>,
  location: Location,
  source: string,
  t: QbTxn,
): void {
  const date = t.TxnDate ?? '';
  if (!date || date < FROM_DATE || date > TO_DATE) return;
  const vendorRef = t.VendorRef ?? t.EntityRef;
  const display = (vendorRef?.name ?? '(no vendor)').trim();
  const key = display.toLowerCase();
  // Credit-card credits / refunds come back with Credit=true — sign them so a refund nets out.
  const sign = t.Credit === true ? -1 : 1;
  const cents = Math.round((t.TotalAmt ?? 0) * 100) * sign;
  let v = rolls.get(key);
  if (!v) {
    v = {
      key,
      display,
      locations: new Set<Location>(),
      months: new Map<string, number>(),
      totalCents: 0,
      count: 0,
      accounts: new Map<string, number>(),
      sourceTypes: new Set<string>(),
      firstDate: date,
      lastDate: date,
    };
    rolls.set(key, v);
  }
  v.locations.add(location);
  v.sourceTypes.add(source);
  v.months.set(date.slice(0, 7), (v.months.get(date.slice(0, 7)) ?? 0) + cents);
  v.totalCents += cents;
  v.count++;
  for (const l of t.Line ?? []) {
    const acct =
      l.AccountBasedExpenseLineDetail?.AccountRef?.name ??
      l.ItemBasedExpenseLineDetail?.ItemRef?.name ??
      null;
    if (!acct) continue;
    const lc = Math.round((l.Amount ?? 0) * 100) * sign;
    v.accounts.set(acct, (v.accounts.get(acct) ?? 0) + lc);
    QB_LINES.push({
      location,
      source,
      date,
      vendor: display,
      account: acct,
      cents: lc,
      fundingAccount: t.AccountRef?.name ?? t.APAccountRef?.name ?? '',
      paymentType: t.PaymentType ?? '',
      docNumber: t.DocNumber ?? '',
      description: (l.Description ?? '').slice(0, 120),
    });
  }
  if (date < v.firstDate) v.firstDate = date;
  if (date > v.lastDate) v.lastDate = date;
}

async function pullQb(): Promise<{ rolls: Map<string, VendorRoll>; locations: Location[]; errors: string[] }> {
  const rolls = new Map<string, VendorRoll>();
  const errors: string[] = [];
  const locations = await getConnectedLocations();
  const where = `WHERE TxnDate >= '${FROM_DATE}' AND TxnDate <= '${TO_DATE}' ORDERBY TxnDate`;
  for (const location of locations) {
    for (const source of ['Bill', 'Purchase'] as const) {
      try {
        const rows = await qbQueryAll<QbTxn>(location, source, where);
        for (const t of rows) addQbTxn(rolls, location, source, t);
        console.log(`  QB ${location} ${source}: ${rows.length}`);
      } catch (e) {
        const msg = `QB ${location} ${source}: ${e instanceof Error ? e.message : String(e)}`;
        errors.push(msg);
        console.error(`  ! ${msg}`);
      }
    }
  }
  return { rolls, locations, errors };
}

// ── Output ─────────────────────────────────────────────────────────────────────
function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}
// Average per ACTIVE month (months with any charge) — a vendor billed 4 of 13 months shouldn't be
// reported as a monthly subscription rate averaged over months it wasn't running.
function perActiveMonth(months: Map<string, number>): number {
  if (months.size === 0) return 0;
  let sum = 0;
  for (const v of months.values()) sum += v;
  return Math.round(sum / months.size);
}
// Recent run-rate: mean of the last 3 calendar months that had activity.
function recentRunRate(months: Map<string, number>): number {
  const keys = [...months.keys()].sort().slice(-3);
  if (keys.length === 0) return 0;
  let sum = 0;
  for (const k of keys) sum += months.get(k) ?? 0;
  return Math.round(sum / keys.length);
}
function allMonthsBetween(): string[] {
  const out: string[] = [];
  const [fy, fm] = FROM_DATE.split('-').map(Number);
  const [ty, tm] = TO_DATE.split('-').map(Number);
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

async function main(): Promise<void> {
  console.log(`Tech-spend recon  ${FROM_DATE} .. ${TO_DATE}`);
  mkdirSync(OUT_DIR, { recursive: true });
  const months = allMonthsBetween();

  console.log('\nRamp:');
  const ramp = await pullRamp();
  console.log(`  ${ramp.size} distinct merchants`);

  console.log('\nQuickBooks:');
  const { rolls: qb, locations, errors } = await pullQb();
  console.log(`  ${qb.size} distinct vendors across ${locations.join(', ') || '(none connected)'}`);

  // ---- Ramp CSV ----
  const rampRows = [...ramp.values()].sort((a, b) => b.totalCents - a.totalCents);
  const rampCsv: string[] = [
    ['bucket', 'merchant', 'entities', 'txns', 'total', 'active_months', 'avg_per_active_month',
      'last3mo_run_rate', 'first', 'last', 'cardholders', 'ramp_category', 'gl_coding', 'memo_sample',
      ...months].map(csvCell).join(','),
  ];
  for (const r of rampRows) {
    const glText = [...r.glCodes].join(' ; ');
    rampCsv.push([
      bucketOf(r.display, glText),
      r.display,
      [...r.entities].join('+'),
      String(r.count),
      dollars(r.totalCents),
      String(r.months.size),
      dollars(perActiveMonth(r.months)),
      dollars(recentRunRate(r.months)),
      r.firstDate,
      r.lastDate,
      [...r.holders.entries()].sort((a, b) => b[1] - a[1]).map(([h, n]) => `${h}(${n})`).join('; '),
      [...r.categories].join('; '),
      glText,
      r.memoSample,
      ...months.map((m) => dollars(r.months.get(m) ?? 0)),
    ].map(csvCell).join(','));
  }
  writeFileSync(join(OUT_DIR, 'ramp-merchants.csv'), rampCsv.join('\n'), 'utf8');

  // ---- QB CSV ----
  const qbRows = [...qb.values()].sort((a, b) => b.totalCents - a.totalCents);
  const qbCsv: string[] = [
    ['bucket', 'vendor', 'companies', 'sources', 'txns', 'total', 'active_months',
      'avg_per_active_month', 'last3mo_run_rate', 'first', 'last', 'accounts',
      ...months].map(csvCell).join(','),
  ];
  for (const v of qbRows) {
    const acctText = [...v.accounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([a, c]) => `${a} $${dollars(c)}`)
      .join(' ; ');
    qbCsv.push([
      bucketOf(v.display, acctText),
      v.display,
      [...v.locations].join('+'),
      [...v.sourceTypes].join('+'),
      String(v.count),
      dollars(v.totalCents),
      String(v.months.size),
      dollars(perActiveMonth(v.months)),
      dollars(recentRunRate(v.months)),
      v.firstDate,
      v.lastDate,
      acctText,
      ...months.map((m) => dollars(v.months.get(m) ?? 0)),
    ].map(csvCell).join(','));
  }
  writeFileSync(join(OUT_DIR, 'qb-vendors.csv'), qbCsv.join('\n'), 'utf8');

  // ---- Console shortlist ----
  console.log('\n' + '='.repeat(110));
  console.log('RAMP — flagged tech / R&D merchants');
  console.log('='.repeat(110));
  console.log(
    'bucket'.padEnd(14) + 'merchant'.padEnd(34) + 'ent'.padEnd(9) + 'n'.padStart(4) +
    'total'.padStart(13) + '/act.mo'.padStart(12) + 'last3mo'.padStart(12) + '  mo  window',
  );
  let rampFlaggedTotal = 0;
  let rampFlaggedRun = 0;
  for (const r of rampRows) {
    const glText = [...r.glCodes].join(' ; ');
    const b = bucketOf(r.display, glText);
    if (!b) continue;
    rampFlaggedTotal += r.totalCents;
    rampFlaggedRun += recentRunRate(r.months);
    console.log(
      b.padEnd(14) + r.display.slice(0, 32).padEnd(34) + [...r.entities].join('+').padEnd(9) +
      String(r.count).padStart(4) + dollars(r.totalCents).padStart(13) +
      dollars(perActiveMonth(r.months)).padStart(12) + dollars(recentRunRate(r.months)).padStart(12) +
      `  ${String(r.months.size).padStart(2)}  ${r.firstDate}..${r.lastDate}`,
    );
  }
  console.log('-'.repeat(110));
  console.log(`RAMP flagged total ${dollars(rampFlaggedTotal)}   combined last-3-mo run rate ${dollars(rampFlaggedRun)}/mo`);

  console.log('\n' + '='.repeat(110));
  console.log('QUICKBOOKS — flagged tech / R&D vendors (Bills + Purchases)');
  console.log('='.repeat(110));
  let qbFlaggedTotal = 0;
  let qbFlaggedRun = 0;
  for (const v of qbRows) {
    const acctText = [...v.accounts.keys()].join(' ; ');
    const b = bucketOf(v.display, acctText);
    if (!b) continue;
    qbFlaggedTotal += v.totalCents;
    qbFlaggedRun += recentRunRate(v.months);
    console.log(
      b.padEnd(14) + v.display.slice(0, 32).padEnd(34) + [...v.locations].join('+').padEnd(24) +
      String(v.count).padStart(4) + dollars(v.totalCents).padStart(13) +
      dollars(perActiveMonth(v.months)).padStart(12) + dollars(recentRunRate(v.months)).padStart(12),
    );
    const acctPairs = [...v.accounts.entries()].sort((x, y) => y[1] - x[1]);
    console.log('    accts: ' + acctPairs.map(([a, c]) => `${a} $${dollars(c)}`).join(' | ').slice(0, 200));
  }
  console.log('-'.repeat(110));
  console.log(`QB flagged total ${dollars(qbFlaggedTotal)}   combined last-3-mo run rate ${dollars(qbFlaggedRun)}/mo`);

  // ---- Accounts roll-up: everything booked to the R&D / Software GLs, whoever the vendor is ----
  console.log('\n' + '='.repeat(110));
  console.log('QUICKBOOKS — every vendor touching an R&D (5000.50) or Software (6200.97) account');
  console.log('='.repeat(110));
  const acctLines: string[] = [['account', 'vendor', 'companies', 'total', 'last3mo_run_rate'].join(',')];
  for (const v of qbRows) {
    for (const [acct, cents] of v.accounts) {
      if (!RD_ACCT_RE.test(acct) && !SOFTWARE_ACCT_RE.test(acct)) continue;
      console.log(`${acct.slice(0, 44).padEnd(46)}${v.display.slice(0, 32).padEnd(34)}${[...v.locations].join('+').padEnd(20)}${dollars(cents).padStart(13)}`);
      acctLines.push([acct, v.display, [...v.locations].join('+'), dollars(cents), dollars(recentRunRate(v.months))].map(csvCell).join(','));
    }
  }
  writeFileSync(join(OUT_DIR, 'qb-rd-software-accounts.csv'), acctLines.join('\n'), 'utf8');

  // ---- Line-level dumps (re-pivotable without re-hitting the APIs) ----
  const rampDump: string[] = [['entity', 'date', 'merchant', 'amount', 'cardholder', 'department', 'ramp_category', 'gl_coding', 'sync_status', 'memo'].join(',')];
  for (const t of RAMP_TXNS) {
    rampDump.push([t.entity, t.date, t.merchant, dollars(t.cents), t.holder, t.department, t.category, t.gl, t.syncStatus, t.memo].map(csvCell).join(','));
  }
  writeFileSync(join(OUT_DIR, 'ramp-txns.csv'), rampDump.join('\n'), 'utf8');

  const qbDump: string[] = [['company', 'source', 'date', 'vendor', 'account', 'amount', 'funding_account', 'payment_type', 'doc_number', 'description'].join(',')];
  for (const l of QB_LINES) {
    qbDump.push([l.location, l.source, l.date, l.vendor, l.account, dollars(l.cents), l.fundingAccount, l.paymentType, l.docNumber, l.description].map(csvCell).join(','));
  }
  writeFileSync(join(OUT_DIR, 'qb-lines.csv'), qbDump.join('\n'), 'utf8');
  console.log(`
Dumped ${RAMP_TXNS.length} Ramp txns, ${QB_LINES.length} QB expense lines.`);

  if (errors.length > 0) {
    console.log('\nERRORS (coverage gaps — treat these as UNSCANNED, not zero):');
    for (const e of errors) console.log(`  ! ${e}`);
  }
  console.log(`\nWrote:\n  ${join(OUT_DIR, 'ramp-merchants.csv')}\n  ${join(OUT_DIR, 'qb-vendors.csv')}\n  ${join(OUT_DIR, 'qb-rd-software-accounts.csv')}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
