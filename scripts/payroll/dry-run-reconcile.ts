/**
 * READ-ONLY dry-run reconcile for the payroll -> QuickBooks JE feature.
 * For payDate = 03/27/2026 (Amy's last full manual JE), for each of MedRock
 * FL/TN/TX: build our draft JE from the seed account map (empty employee map,
 * so department/class always resolve null — isolates account-total accuracy
 * from the region-split question), reconcile it, then compare our totals
 * against Amy's actual QuickBooks JournalEntry for that pay date.
 *
 * NO DB writes. NO QuickBooks posting. Never prints employee names or any
 * decrypted per-row PII — only account names, ADP column names, and aggregate
 * dollar totals.
 *
 *   npx tsx scripts/payroll/dry-run-reconcile.ts
 *
 * Env: .env.local for RDS (RDS_DATABASE_URL, PAYROLL_ENC_KEY), then
 * .env.vercel OVERRIDES the QUICKBOOKS_* keys only (the .env.local QB client
 * id is wrong — see scripts/probe-amy-payroll-je.ts).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const localEnvText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of localEnvText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const QB_ENV_KEYS = new Set(['QUICKBOOKS_CLIENT_ID', 'QUICKBOOKS_CLIENT_SECRET', 'QUICKBOOKS_ENVIRONMENT', 'QUICKBOOKS_REDIRECT_URI']);
const vercelEnvText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of vercelEnvText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && QB_ENV_KEYS.has(m[1])) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

import type { AccountMapRule, Entity, EmployeeMapRule, JournalDraft, PayrollRow } from '../../src/lib/payroll/types';
import { entityForPayGroup, POSTABLE_ENTITIES } from '../../src/lib/payroll/entity';
import { buildJournal } from '../../src/lib/payroll/build-je';
import { reconcile } from '../../src/lib/payroll/reconcile';
import { buildSeedAccountMap } from './account-map-seed-data';
import { buildMarketerEmployeeMap } from './employee-map-seed-data';

const PAY_DATE_ISO = '2026-03-27';
const PAY_DATE_DISPLAY = '03/27/2026';
const DOC_NUMBER = 'PR 2026.03.27';

interface QbLine {
  Amount?: number;
  Description?: string;
  DetailType?: string;
  JournalEntryLineDetail?: {
    PostingType?: 'Debit' | 'Credit';
    AccountRef?: { value?: string; name?: string };
    ClassRef?: { name?: string };
    DepartmentRef?: { name?: string };
  };
}
interface QbJournalEntry {
  Id?: string;
  DocNumber?: string;
  TxnDate?: string;
  PrivateNote?: string;
  Line?: QbLine[];
}

/** Same multi-signal scoring heuristic as scripts/probe-amy-payroll-je.ts. */
function payrollScore(je: QbJournalEntry): number {
  const accts = (je.Line ?? []).map(
    (l) => `${l.Description ?? ''} ${l.JournalEntryLineDetail?.AccountRef?.name ?? ''}`.toLowerCase(),
  );
  const hits = new Set<string>();
  for (const a of accts) {
    if (/941|federal.*(withhold|tax)/.test(a)) hits.add('941');
    if (/social security|fica/.test(a)) hits.add('ss');
    if (/medicare/.test(a)) hits.add('medicare');
    if (/state.*(withhold|income tax|unemployment)|suta|futa|940/.test(a)) hits.add('state');
    if (/401|retirement/.test(a)) hits.add('401k');
    if (/garnish|child support|withholding order/.test(a)) hits.add('garnish');
    if (/wage|salary|gross pay/.test(a)) hits.add('wages');
    if (/net pay|payroll clearing|payroll cash|direct deposit/.test(a)) hits.add('netpay');
    if (/dental|vision|medical.*(ee|pre-tax|withhold)/.test(a)) hits.add('benefits');
  }
  return hits.size;
}

interface AmyTotals {
  found: boolean;
  matchedBy: 'DocNumber' | 'TxnDate' | 'none' | 'blocked';
  blockedReason?: string;
  debits: number;
  credits: number;
  byAccount: Map<string, { debit: number; credit: number }>;
  marketingDepartments: Set<string>;
  /** Net (debit - credit) $ per QB Department, for lines whose account/memo mentions "marketing" only. */
  marketingByDept: Map<string, number>;
}

async function fetchAmyTotals(
  entity: Entity,
  qbQueryAll: <T>(location: Entity, ent: string, where: string) => Promise<T[]>,
): Promise<AmyTotals> {
  const empty: AmyTotals = {
    found: false,
    matchedBy: 'none',
    debits: 0,
    credits: 0,
    byAccount: new Map(),
    marketingDepartments: new Set(),
    marketingByDept: new Map(),
  };

  let candidates: QbJournalEntry[] = [];
  try {
    candidates = await qbQueryAll<QbJournalEntry>(entity, 'JournalEntry', `WHERE DocNumber = '${DOC_NUMBER}'`);
  } catch (e) {
    return { ...empty, matchedBy: 'blocked', blockedReason: (e as Error).message };
  }
  let matchedBy: AmyTotals['matchedBy'] = 'DocNumber';
  let je = candidates[0];

  if (!je) {
    let byDate: QbJournalEntry[] = [];
    try {
      byDate = await qbQueryAll<QbJournalEntry>(entity, 'JournalEntry', `WHERE TxnDate = '${PAY_DATE_ISO}'`);
    } catch (e) {
      return { ...empty, matchedBy: 'blocked', blockedReason: (e as Error).message };
    }
    const scored = byDate
      .map((c) => ({ je: c, score: payrollScore(c), lines: (c.Line ?? []).length }))
      .filter((c) => c.score >= 3 && c.lines >= 5)
      .sort((a, b) => b.score - a.score);
    je = scored[0]?.je;
    matchedBy = 'TxnDate';
  }

  if (!je) return empty;

  const byAccount = new Map<string, { debit: number; credit: number }>();
  const marketingDepartments = new Set<string>();
  const marketingByDept = new Map<string, number>();
  let debits = 0;
  let credits = 0;
  for (const line of je.Line ?? []) {
    const d = line.JournalEntryLineDetail;
    if (!d?.PostingType) continue;
    const acct = d.AccountRef?.name ?? d.AccountRef?.value ?? '(unknown account)';
    const amt = line.Amount ?? 0;
    const entry = byAccount.get(acct) ?? { debit: 0, credit: 0 };
    if (d.PostingType === 'Debit') { entry.debit += amt; debits += amt; }
    else { entry.credit += amt; credits += amt; }
    byAccount.set(acct, entry);

    if (/marketing/i.test(acct)) {
      const dept = d.DepartmentRef?.name ?? '(no dept)';
      marketingByDept.set(dept, (marketingByDept.get(dept) ?? 0) + (d.PostingType === 'Debit' ? amt : -amt));
      if (d.DepartmentRef?.name) marketingDepartments.add(d.DepartmentRef.name);
    }
  }

  return { found: true, matchedBy, debits, credits, byAccount, marketingDepartments, marketingByDept };
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function main(): Promise<void> {
  const { qbQueryAll, getConnectionStatus } = await import('../../src/lib/quickbooks-multi');
  const { RdsPayrollSource } = await import('../../src/lib/payroll/source');

  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) {
    console.error('PAYROLL_ENC_KEY not set (.env.local) — cannot decrypt payroll rows. Aborting.');
    process.exit(1);
    return;
  }

  const status = await getConnectionStatus();
  console.log('QuickBooks connection status:', status);

  const source = new RdsPayrollSource(key);
  const allRows: PayrollRow[] = await source.fetchRange(PAY_DATE_ISO, PAY_DATE_ISO);
  console.log(`\nFetched ${allRows.length} total payroll_history rows for ${PAY_DATE_DISPLAY} (all entities/pay-groups).`);

  // Marketer -> region (Department/Class) overlay, derived from the territory-mapping snapshot.
  // Covers all 3 entities; filtered per-entity below before being passed into buildJournal (same
  // shape as the entity-scoped accountMap).
  const fullEmployeeMap: EmployeeMapRule[] = await buildMarketerEmployeeMap();
  console.log(`\nMarketer employee-map: ${fullEmployeeMap.length} rule(s) derived across FL/TN/TX.`);

  for (const entity of POSTABLE_ENTITIES) {
    console.log(`\n\n================ ${entity} — ${PAY_DATE_DISPLAY} ================`);

    const rows = allRows.filter((r) => entityForPayGroup(r.pay_group) === entity);
    if (rows.length === 0) {
      console.log('  No rows for this entity on this pay date.');
      continue;
    }

    const accountMap: AccountMapRule[] = buildSeedAccountMap(entity);
    const employeeMap: EmployeeMapRule[] = fullEmployeeMap.filter((e) => e.entity === entity);

    const built = buildJournal(rows, accountMap, employeeMap);
    const draft: JournalDraft | undefined = built.drafts.find((d) => d.entity === entity);
    if (!draft) {
      console.log('  buildJournal produced no draft for this entity (rows excluded as FOCS/1099/unknown pay group?).');
      continue;
    }

    const result = reconcile(draft, rows, {
      unmappedColumns: built.unmappedColumns,
      unmappedPositions: built.unmappedPositions,
    });

    console.log(`  Rows: ${rows.length}   Lines: ${draft.lines.length}`);
    console.log(`  OUR   Debits ${fmt(draft.totalDebits)}   Credits ${fmt(draft.totalCredits)}   Variance ${fmt(draft.variance)}`);
    console.log(`  Reconcile: balanced=${result.balanced} netOk=${result.netOk} postable=${result.postable}`);
    if (result.errors.length) console.log(`  Errors: ${result.errors.join(' | ')}`);
    console.log(`  Unmapped columns (${built.unmappedColumns.length}): ${built.unmappedColumns.length ? built.unmappedColumns.sort().join(', ') : '(none)'}`);

    // Per-unmapped-column summed |$| across this entity's rows for this pay date — distinguishes
    // real GL-carrying columns from $0/rollup columns. Sorted desc so the biggest gaps surface first.
    if (built.unmappedColumns.length) {
      const unmappedDollars = built.unmappedColumns
        .map((col) => {
          const total = rows.reduce((s, r) => {
            const v = r.sensitive[col];
            return s + (typeof v === 'number' ? Math.abs(v) : 0);
          }, 0);
          return { col, total: round2(total) };
        })
        .sort((a, b) => b.total - a.total);
      console.log(`  Unmapped columns by summed |$| (desc):`);
      for (const { col, total } of unmappedDollars) {
        console.log(`    ${fmt(total).padStart(14)}  ${col}`);
      }
    }
    if (built.excluded.length) {
      console.log(`  Excluded groups: ${built.excluded.map((e) => `${e.payGroup} (${e.reason}) x${e.count}`).join('; ')}`);
    }

    // Marketing wage note (ours): total booked, un-split, to the single Marketing Wages account.
    const ourMarketingTotal = draft.lines
      .filter((l) => l.accountName === 'Payroll Expense -:Marketing Wages - Base')
      .reduce((s, l) => s + l.amount, 0);

    let amy: AmyTotals;
    try {
      amy = await fetchAmyTotals(entity, qbQueryAll);
    } catch (e) {
      amy = {
        found: false,
        matchedBy: 'blocked',
        blockedReason: (e as Error).message,
        debits: 0,
        credits: 0,
        byAccount: new Map(),
        marketingDepartments: new Set(),
        marketingByDept: new Map(),
      };
    }

    if (amy.matchedBy === 'blocked') {
      console.log(`\n  AMY (QuickBooks): BLOCKED — ${amy.blockedReason}`);
      console.log(`  Marketing wages (ours, un-split): ${fmt(ourMarketingTotal)} — Amy comparison blocked on QB auth.`);
      continue;
    }
    if (!amy.found) {
      console.log(`\n  AMY (QuickBooks): NOT FOUND (no DocNumber='${DOC_NUMBER}' or scored TxnDate='${PAY_DATE_ISO}' match).`);
      console.log(`  Marketing wages (ours, un-split): ${fmt(ourMarketingTotal)} — no Amy JE to compare against.`);
      continue;
    }

    console.log(`\n  AMY (QuickBooks, matched by ${amy.matchedBy})   Debits ${fmt(amy.debits)}   Credits ${fmt(amy.credits)}`);
    console.log(`  DELTA (ours - Amy)   Debits ${fmt(draft.totalDebits - amy.debits)}   Credits ${fmt(draft.totalCredits - amy.credits)}`);

    // Per-account comparison.
    const ourByAccount = new Map<string, { debit: number; credit: number }>();
    for (const line of draft.lines) {
      const entry = ourByAccount.get(line.accountName) ?? { debit: 0, credit: 0 };
      if (line.postingType === 'Debit') entry.debit += line.amount; else entry.credit += line.amount;
      ourByAccount.set(line.accountName, entry);
    }
    const allAccounts = new Set<string>([...ourByAccount.keys(), ...amy.byAccount.keys()]);
    const rowsCmp = [...allAccounts].map((acct) => {
      const ours = ourByAccount.get(acct) ?? { debit: 0, credit: 0 };
      const theirs = amy.byAccount.get(acct) ?? { debit: 0, credit: 0 };
      const ourNet = ours.debit - ours.credit;
      const amyNet = theirs.debit - theirs.credit;
      const delta = ourNet - amyNet;
      return { acct, ourNet, amyNet, delta };
    }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    console.log('\n  PER-ACCOUNT COMPARISON (top 25 by |delta|, net = debit - credit):');
    console.log(`  ${'account'.padEnd(55)} ${'ours'.padStart(14)} ${'amy'.padStart(14)} ${'delta'.padStart(14)}  match`);
    for (const r of rowsCmp.slice(0, 25)) {
      const match = Math.abs(r.delta) < 1 ? 'OK' : 'MISMATCH';
      console.log(`  ${r.acct.slice(0, 55).padEnd(55)} ${fmt(r.ourNet).padStart(14)} ${fmt(r.amyNet).padStart(14)} ${fmt(r.delta).padStart(14)}  ${match}`);
    }

    // ---- Marketing-by-region comparison: our region-split (via the marketer employee-map) vs
    // Amy's actual per-Department marketing-wage lines from PR 2026.03.27 (probe-marketing-
    // departments.ts pattern — match on DepartmentRef name). ----
    const MARKETING_ACCOUNT = 'Payroll Expense -:Marketing Wages - Base';
    const ourMarketingByDept = new Map<string, number>();
    for (const line of draft.lines) {
      if (line.accountName !== MARKETING_ACCOUNT) continue;
      const dept = line.departmentName ?? '(unassigned)';
      const signed = line.postingType === 'Debit' ? line.amount : -line.amount;
      ourMarketingByDept.set(dept, round2((ourMarketingByDept.get(dept) ?? 0) + signed));
    }
    const allMarketingDepts = new Set<string>([...ourMarketingByDept.keys(), ...amy.marketingByDept.keys()]);
    const marketingCmp = [...allMarketingDepts]
      .map((dept) => {
        const ours = ourMarketingByDept.get(dept) ?? 0;
        const theirs = round2(amy.marketingByDept.get(dept) ?? 0);
        return { dept, ours, theirs, delta: round2(ours - theirs) };
      })
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    const ourMarketingAcct = ourByAccount.get(MARKETING_ACCOUNT) ?? { debit: 0, credit: 0 };
    const amyMarketingAcct = amy.byAccount.get(MARKETING_ACCOUNT) ?? { debit: 0, credit: 0 };
    const ourMarketingAggTotal = round2(ourMarketingAcct.debit - ourMarketingAcct.credit);
    const amyMarketingAggTotal = round2(amyMarketingAcct.debit - amyMarketingAcct.credit);
    const marketingDeltaBeforeSplit = round2(ourMarketingAggTotal - amyMarketingAggTotal);
    const marketingDeltaAfterSplit = round2(marketingCmp.reduce((s, r) => s + Math.abs(r.delta), 0));

    console.log(`\n  MARKETING-BY-REGION (ours region-split via employee-map vs Amy's per-Department marketing lines):`);
    console.log(`  ${'region'.padEnd(28)} ${'ours'.padStart(14)} ${'amy'.padStart(14)} ${'delta'.padStart(14)}  match`);
    for (const r of marketingCmp) {
      const match = Math.abs(r.delta) < 1 ? 'OK' : 'MISMATCH';
      console.log(`  ${r.dept.slice(0, 28).padEnd(28)} ${fmt(r.ours).padStart(14)} ${fmt(r.theirs).padStart(14)} ${fmt(r.delta).padStart(14)}  ${match}`);
    }
    console.log(
      `\n  MARKETING TOTAL DELTA — before region-split (aggregate-account level, ours ${fmt(ourMarketingAggTotal)} vs Amy ${fmt(amyMarketingAggTotal)}): ${fmt(marketingDeltaBeforeSplit)}`,
    );
    console.log(
      `  MARKETING TOTAL DELTA — after region-split (sum of |per-region delta| across ${marketingCmp.length} region row(s)): ${fmt(marketingDeltaAfterSplit)}`,
    );
    console.log(
      `  (booked ${fmt(ourMarketingTotal)} to '${MARKETING_ACCOUNT}' now split across ${ourMarketingByDept.size} region(s) ` +
      `vs Amy's ${amy.marketingDepartments.size} distinct Department line(s) for marketing wages)`,
    );
  }

  const { getRdsPool } = await import('../../src/lib/rds');
  await getRdsPool().end();
}

void main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
