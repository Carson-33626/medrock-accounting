/**
 * Prunes the non-payroll accounts that today's COA replication added to FOCAS.
 *
 * WHY: replicating MedRock FL's chart into FOCAS (focas-coa-sync.ts) took 81 accounts to 254 so
 * that FOCAS payroll could post. Barb & Ash want the surplus removed — but the payroll accounts
 * are now wired into live journal-entry drafts, so this cannot be a blanket undo.
 *
 * WHAT IS KEPT, and why each rule matters:
 *  1. Every account named by a FOCAS payroll account-map rule. These ARE the JE. Removing one
 *     makes QBO reject the line at post time.
 *  2. Every ANCESTOR of a kept account. QBO cannot hold a sub-account whose parent is inactive,
 *     so keeping 'Payroll Expense -:Shipping Wages' means keeping 'Payroll Expense -'.
 *  3. The three inter-entity mirrors (Due to Medrock Pharmacy / Tennessee / Texas), explicitly
 *     requested 2026-08-07.
 *  4. Anything NOT created today. FOCAS's own 81 stock accounts and its real bookkeeping are
 *     off limits — identified by QBO's MetaData.CreateTime, not by name, so a name collision
 *     can never put a pre-existing account at risk.
 *  5. Anything carrying a balance. A non-zero CurrentBalance means real activity; deactivating
 *     it would strand money, so it is reported for a human instead.
 *
 * QBO deactivates rather than deletes, so every step here is reversible.
 *
 * DEFAULT IS A DRY RUN. Pass --apply.
 *   NODE_OPTIONS=--dns-result-order=ipv4first npx tsx scripts/payroll/focas-prune-nonpayroll.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import { withRetry } from './qb-retry';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface QbAccount {
  Id: string;
  Name: string;
  FullyQualifiedName: string;
  AcctNum?: string;
  AccountType: string;
  CurrentBalance?: number;
  Active: boolean;
  SyncToken: string;
  MetaData?: { CreateTime?: string };
}

const APPLY = process.argv.includes('--apply');
/** Accounts created on or after this instant are today's replication. */
const CREATED_SINCE = '2026-08-07T00:00:00';
const MIRRORS = ['Due to Medrock Pharmacy, LLC', 'Due to Medrock Tennessee', 'Due to Medrock Texas'];

const key = (s: string): string => s.toLowerCase();
/** 'A:B:C' -> ['A', 'A:B'] — every ancestor that must stay active. */
function ancestorsOf(fqn: string): string[] {
  const parts = fqn.split(':');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join(':'));
  return out;
}

async function main(): Promise<void> {
  const { qbQueryAll, qbPost } = await import('../../src/lib/quickbooks-multi');

  // 1. What the payroll JE actually needs, straight from the live rules.
  const pool = new Pool({
    connectionString: process.env.RDS_DATABASE_URL, max: 1,
    ssl: RDS_SSL, connectionTimeoutMillis: 30_000,
  });
  let referenced: string[];
  try {
    const { rows } = await pool.query<{ account_name: string }>(
      `SELECT DISTINCT account_name FROM accounting.payroll_account_map WHERE entity = 'FOCAS'`,
    );
    referenced = rows.map((r) => r.account_name);
  } finally {
    await pool.end();
  }

  const accounts = await withRetry('FOCAS accounts', () =>
    qbQueryAll<QbAccount>('FOCAS', 'Account', 'WHERE Active = true'));

  // 2. Build the keep-set: referenced names + their ancestors + the mirrors.
  const keep = new Set<string>();
  for (const name of [...referenced, ...MIRRORS]) {
    keep.add(key(name));
    for (const a of ancestorsOf(name)) keep.add(key(a));
  }

  const createdToday = (a: QbAccount): boolean => (a.MetaData?.CreateTime ?? '') >= CREATED_SINCE;

  const candidates = accounts.filter((a) => createdToday(a) && !keep.has(key(a.FullyQualifiedName)));
  const withBalance = candidates.filter((a) => Math.abs(a.CurrentBalance ?? 0) > 0.005);
  const toDeactivate = candidates.filter((a) => Math.abs(a.CurrentBalance ?? 0) <= 0.005);

  const keptCreatedToday = accounts.filter((a) => createdToday(a) && keep.has(key(a.FullyQualifiedName)));
  const preExisting = accounts.filter((a) => !createdToday(a));

  console.log(`\nFOCAS active accounts: ${accounts.length}`);
  console.log(`  pre-existing (untouchable):        ${preExisting.length}`);
  console.log(`  created today, KEPT (payroll/JE):  ${keptCreatedToday.length}`);
  console.log(`  created today, to DEACTIVATE:      ${toDeactivate.length}`);
  console.log(`  created today, HAS A BALANCE:      ${withBalance.length}  (left alone, reported below)`);
  console.log(`\n  payroll rules reference ${referenced.length} distinct account names`);
  console.log(APPLY ? '\n*** APPLY — deactivating in FOCAS QuickBooks ***' : '\n--- DRY RUN ---');

  console.log(`\n=== KEEPING (created today, wired into the payroll JE) — ${keptCreatedToday.length} ===`);
  for (const a of [...keptCreatedToday].sort((x, y) => x.FullyQualifiedName.localeCompare(y.FullyQualifiedName))) {
    console.log(`  keep  ${(a.AcctNum ?? '----').padEnd(8)} ${a.FullyQualifiedName}`);
  }

  if (withBalance.length > 0) {
    console.log(`\n=== HAS A BALANCE — NOT TOUCHED — ${withBalance.length} ===`);
    for (const a of withBalance) {
      console.log(`  !  ${(a.AcctNum ?? '----').padEnd(8)} ${a.FullyQualifiedName}  balance=${a.CurrentBalance}`);
    }
  }

  console.log(`\n=== DEACTIVATE — ${toDeactivate.length} ===`);
  for (const a of [...toDeactivate].sort((x, y) => x.FullyQualifiedName.localeCompare(y.FullyQualifiedName))) {
    console.log(`  -  ${(a.AcctNum ?? '----').padEnd(8)} ${a.AccountType.padEnd(22)} ${a.FullyQualifiedName}`);
  }

  if (!APPLY) {
    console.log(`\nDry run only. Re-run with --apply to deactivate ${toDeactivate.length}.`);
    return;
  }

  // Deepest first: QBO refuses to deactivate a parent that still has active children.
  const ordered = [...toDeactivate].sort(
    (a, b) => b.FullyQualifiedName.split(':').length - a.FullyQualifiedName.split(':').length,
  );
  let done = 0;
  let failed = 0;
  for (const a of ordered) {
    try {
      await qbPost('FOCAS', 'account?minorversion=75', {
        Id: a.Id, SyncToken: a.SyncToken, Name: a.Name, Active: false, sparse: true,
      });
      done += 1;
      if (done % 20 === 0) console.log(`  ${done}/${ordered.length}`);
    } catch (e) {
      failed += 1;
      console.log(`  FAILED ${a.FullyQualifiedName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\nDone. deactivated=${done} failed=${failed}`);
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
