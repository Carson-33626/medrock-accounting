/**
 * Chart-of-accounts replication: MedRock FL (template) -> FOCAS.
 *
 * WHY: FOCAS was connected to QuickBooks on 2026-08-07 as a fourth postable payroll entity, but
 * its company is a near-default QBO file — 81 active accounts whose entire payroll section is the
 * four stock accounts (Payroll expenses / :Officers' salaries / :Taxes / :Wages). Every one of the
 * 26 account names the payroll seed emits is absent, and QBO rejects a journal-entry line whose
 * AccountRef does not exist in that company. So FOCAS payroll drafts cannot post until its COA
 * matches. Carson, 2026-08-07: "match the chart of accounts fully, so disable any accounts on
 * FOCAS that are disabled on the others."
 *
 * DEFAULT IS A DRY RUN. It prints the plan and writes nothing. Pass --apply to execute.
 *
 *   NODE_OPTIONS=--dns-result-order=ipv4first npx tsx scripts/payroll/focas-coa-sync.ts
 *   NODE_OPTIONS=--dns-result-order=ipv4first npx tsx scripts/payroll/focas-coa-sync.ts --apply
 *
 * Safety rails, in order of how much damage they prevent:
 *  - Accounts that exist ONLY on FOCAS are never touched. FOCAS has its own live bookkeeping and
 *    an account absent from MedRock FL is not thereby "disabled on the others" — it is simply
 *    FOCAS's own. Deactivating those could orphan real posted transactions. They are reported.
 *  - Deactivation is limited to FOCAS accounts whose SAME-NAMED template counterpart is inactive.
 *  - Creation is ordered parent-first, because QBO needs the ParentRef to resolve.
 *  - Account numbers are only sent when FOCAS has no other account already using that number.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

import type { Location } from '../../src/lib/quickbooks-multi';

/** The QBO Account fields this script reads or copies. */
interface QbAccount {
  Id: string;
  Name: string;
  FullyQualifiedName: string;
  AcctNum?: string;
  AccountType: string;
  AccountSubType?: string;
  Classification?: string;
  Description?: string;
  SubAccount?: boolean;
  ParentRef?: { value: string };
  Active: boolean;
  SyncToken: string;
}

const TEMPLATE: Location = 'MedRock FL';
const TARGET: Location = 'FOCAS';
const APPLY = process.argv.includes('--apply');

/**
 * Scope decision (Carson, 2026-08-07): copy MedRock FL's active COA "minus junk".
 * Each exclusion below is a category that would be actively wrong on FOCAS, not merely noise.
 */

/** FL tombstones. Copying a "(DO NOT USE)" account into a clean company just recreates the mess. */
const isDoNotUse = (fqn: string): boolean => /\(\s*DO NOT USE\s*\)/i.test(fqn);

/**
 * Real-world registers, not a shared chart: FL's Truist / Bank of America / Stamps.com and its
 * A/P + A/R belong to FL's actual banking. FOCAS already has its own bank account
 * ("FOCAS INSTITUTE LLC 6458") and its own Accounts payable / Accounts receivable, so copying
 * FL's would give FOCAS a second set pointing at money that isn't its own.
 */
const EXCLUDED_TYPES = new Set(['Bank', 'Credit Card', 'Accounts Payable', 'Accounts Receivable']);

/**
 * Inter-entity accounts are directional and must be MIRRORED, never copied. FL holds
 * "Due from FOCAS" — the receivable FL is owed. Creating that same account inside FOCAS would
 * have FOCAS recording a receivable from itself. FOCAS instead needs the payable side
 * ("Due to Medrock Pharmacy, LLC" etc.), which is created from MIRROR_ACCOUNTS below.
 */
const isCounterpartyFocas = (fqn: string): boolean => /due\s+(from|to)\s+focas/i.test(fqn);

/**
 * The FOCAS-side inter-entity accounts, mirroring what FL/TN/TX already carry for each other.
 * Numbers follow the existing convention seen across the three companies (2015/2016 payables).
 * Carson, 2026-08-07: "we need to ensure 'due to FL/TN/TX' ... are also included".
 */
const MIRROR_ACCOUNTS: ReadonlyArray<{ Name: string; AcctNum: string; AccountType: string; AccountSubType: string }> = [
  { Name: 'Due to Medrock Pharmacy, LLC', AcctNum: '2015', AccountType: 'Other Current Liability', AccountSubType: 'OtherCurrentLiabilities' },
  { Name: 'Due to Medrock Tennessee', AcctNum: '2016', AccountType: 'Other Current Liability', AccountSubType: 'OtherCurrentLiabilities' },
  { Name: 'Due to Medrock Texas', AcctNum: '2017', AccountType: 'Other Current Liability', AccountSubType: 'OtherCurrentLiabilities' },
];

/**
 * The allocation vocabulary, which lives on QuickBooks CLASSES (and one DEPARTMENT), not on
 * accounts — this is the answer to "are those tags or what". FOCAS has zero classes and zero
 * departments today, and qb-journal.ts throws `unresolved department/class` at post time for any
 * name the company lacks, so the vocabulary has to exist before a dimensioned FOCAS line can post.
 */
const CLASSES_TO_CREATE: readonly string[] = [
  'Allocate - %', 'Allocate - FL', 'Allocate - TN', 'Allocate - TX', 'Allocate - SplitX3',
];
/**
 * Only '% Allocation'. FL/TN/TX departments are otherwise marketing REGIONS (Tampa, Dallas…) and
 * FOCAS has no marketers — its payroll is entirely ADMIN + RD, and there is no ADMIN or RD
 * department in any company. FOCAS's employee map is empty, so its JE lines carry
 * departmentName = null and post fine undimensioned; '% Allocation' is created only so the
 * Allocate - % convention has somewhere to land if FOCAS is ever included in an allocation.
 */
const DEPARTMENTS_TO_CREATE: readonly string[] = ['% Allocation'];

/** Depth in the account tree — 'A:B:C' is depth 2. Parents must be created first. */
const depthOf = (fqn: string): number => fqn.split(':').length - 1;
/** Everything above the leaf: 'A:B:C' -> 'A:B'. Empty string for a top-level account. */
const parentFqnOf = (fqn: string): string => fqn.split(':').slice(0, -1).join(':');

async function main(): Promise<void> {
  const { qbQueryAll, qbPost } = await import('../../src/lib/quickbooks-multi');

  /**
   * A bare Account query returns ACTIVE rows only — QBO applies `Active = true` implicitly, so
   * omitting the WHERE clause silently hides every disabled account. That would have quietly
   * turned the "disable what's disabled on the others" half of this job into a no-op, so the
   * inactive set is fetched explicitly and merged.
   *
   * Sequential, not Promise.all: concurrent TLS handshakes to Intuit reliably blow undici's
   * 10s connect timeout from this machine.
   */
  const fetchAll = async (loc: Location): Promise<QbAccount[]> => {
    const active = await qbQueryAll<QbAccount>(loc, 'Account', 'WHERE Active = true');
    const inactive = await qbQueryAll<QbAccount>(loc, 'Account', 'WHERE Active = false');
    return [...active, ...inactive];
  };

  const template = await fetchAll(TEMPLATE);
  const target = await fetchAll(TARGET);

  /**
   * Names are compared CASE-INSENSITIVELY because QuickBooks itself is. FOCAS's stock file uses
   * sentence case ('Cost of goods sold', 'Undeposited funds') where MedRock FL uses title case
   * ('Cost of Goods Sold', 'Undeposited Funds'). A case-sensitive comparison treated those as
   * missing, and QBO then rejected the create with "Duplicate Name Exists" (code 6240) — which in
   * turn orphaned all 12 children of Cost of Goods Sold. Match the way the API matches.
   */
  const key = (fqn: string): string => fqn.toLowerCase();
  const tByName = new Map(template.map((a) => [key(a.FullyQualifiedName), a]));
  const gByName = new Map(target.map((a) => [key(a.FullyQualifiedName), a]));

  console.log(`\nTemplate ${TEMPLATE}: ${template.length} accounts (${template.filter((a) => a.Active).length} active)`);
  console.log(`Target   ${TARGET}: ${target.length} accounts (${target.filter((a) => a.Active).length} active)`);
  console.log(APPLY ? '\n*** APPLY MODE — THIS WILL WRITE TO FOCAS QUICKBOOKS ***\n' : '\n--- DRY RUN (no writes) ---\n');

  // ── Plan ────────────────────────────────────────────────────────────────────
  // Create only what the template has ACTIVE. Creating an account purely to deactivate it adds
  // clutter to FOCAS's books and buys nothing.
  const excluded: Array<{ a: QbAccount; why: string }> = [];
  const keep = (a: QbAccount): boolean => {
    if (!a.Active || gByName.has(key(a.FullyQualifiedName))) return false;
    if (isDoNotUse(a.FullyQualifiedName)) { excluded.push({ a, why: 'DO NOT USE' }); return false; }
    if (EXCLUDED_TYPES.has(a.AccountType)) { excluded.push({ a, why: `${a.AccountType} register` }); return false; }
    if (isCounterpartyFocas(a.FullyQualifiedName)) { excluded.push({ a, why: 'FOCAS cannot owe itself — mirrored instead' }); return false; }
    return true;
  };

  const toCreate = template
    .filter(keep)
    .sort((a, b) => depthOf(a.FullyQualifiedName) - depthOf(b.FullyQualifiedName)
      || a.FullyQualifiedName.localeCompare(b.FullyQualifiedName));

  // A child whose parent was excluded can never be created — QBO needs the ParentRef to resolve.
  // Detect that here rather than discovering it as a mid-run failure.
  const plannedNames = new Set([...toCreate.map((a) => key(a.FullyQualifiedName)), ...gByName.keys()]);
  const orphaned = toCreate.filter((a) => {
    const p = parentFqnOf(a.FullyQualifiedName);
    return p !== '' && !plannedNames.has(key(p));
  });

  const mirrorsNeeded = MIRROR_ACCOUNTS.filter((m) => !gByName.has(key(m.Name)));

  // "Disable any accounts on FOCAS that are disabled on the others": same name, inactive on the
  // template, still active on FOCAS.
  const toDeactivate = target.filter((a) => {
    const t = tByName.get(key(a.FullyQualifiedName));
    return a.Active && t !== undefined && !t.Active;
  });

  // Deliberately NOT actioned — reported so a human decides.
  const focasOnly = target.filter((a) => a.Active && !tByName.has(key(a.FullyQualifiedName)));
  const typeMismatch = target.filter((a) => {
    const t = tByName.get(key(a.FullyQualifiedName));
    return t !== undefined && t.AccountType !== a.AccountType;
  });

  console.log(`=== CREATE on FOCAS — ${toCreate.length} account(s) ===`);
  for (const a of toCreate) {
    console.log(`  + ${(a.AcctNum ?? '----').padEnd(8)} ${a.AccountType.padEnd(22)} ${a.FullyQualifiedName}`);
  }

  console.log(`\n=== EXCLUDED from the copy — ${excluded.length} account(s) ===`);
  for (const { a, why } of excluded.sort((x, y) => x.why.localeCompare(y.why))) {
    console.log(`  x [${why}] ${a.FullyQualifiedName}`);
  }

  console.log(`\n=== MIRROR inter-entity accounts to CREATE on FOCAS — ${mirrorsNeeded.length} ===`);
  for (const m of mirrorsNeeded) console.log(`  + ${m.AcctNum.padEnd(8)} ${m.AccountType.padEnd(22)} ${m.Name}`);

  if (orphaned.length > 0) {
    console.log(`\n=== UNCREATABLE (parent was excluded) — ${orphaned.length} ===`);
    for (const a of orphaned) console.log(`  ! ${a.FullyQualifiedName} (needs parent "${parentFqnOf(a.FullyQualifiedName)}")`);
  }

  console.log(`\n=== CLASSES to create — ${CLASSES_TO_CREATE.length} ===`);
  for (const c of CLASSES_TO_CREATE) console.log(`  + ${c}`);
  console.log(`=== DEPARTMENTS to create — ${DEPARTMENTS_TO_CREATE.length} ===`);
  for (const d of DEPARTMENTS_TO_CREATE) console.log(`  + ${d}`);

  console.log(`\n=== DEACTIVATE on FOCAS — ${toDeactivate.length} account(s) (inactive on ${TEMPLATE}) ===`);
  for (const a of toDeactivate) {
    console.log(`  - ${(a.AcctNum ?? '----').padEnd(8)} ${a.AccountType.padEnd(22)} ${a.FullyQualifiedName}`);
  }

  console.log(`\n=== FOCAS-ONLY, LEFT ALONE — ${focasOnly.length} active account(s) not on ${TEMPLATE} ===`);
  console.log('    (FOCAS has its own bookkeeping; these are not "disabled on the others", they are simply absent there.)');
  for (const a of focasOnly) {
    console.log(`  ? ${(a.AcctNum ?? '----').padEnd(8)} ${a.AccountType.padEnd(22)} ${a.FullyQualifiedName}`);
  }

  if (typeMismatch.length > 0) {
    console.log(`\n=== NAME MATCHES BUT AccountType DIFFERS — ${typeMismatch.length} (NOT touched; resolve by hand) ===`);
    for (const a of typeMismatch) {
      console.log(`  ! ${a.FullyQualifiedName}: FOCAS=${a.AccountType} vs ${TEMPLATE}=${tByName.get(key(a.FullyQualifiedName))?.AccountType}`);
    }
  }

  // Account numbers must stay unique within a company when QBO numbering is enabled.
  const targetNums = new Set(target.map((a) => a.AcctNum).filter((n): n is string => !!n));
  const numClash = toCreate.filter((a) => a.AcctNum && targetNums.has(a.AcctNum));
  if (numClash.length > 0) {
    console.log(`\n=== ACCOUNT-NUMBER CLASHES — ${numClash.length} (number will be OMITTED on create) ===`);
    for (const a of numClash) console.log(`  ~ ${a.AcctNum} ${a.FullyQualifiedName} — already used on FOCAS`);
  }

  if (!APPLY) {
    console.log(
      `\nDry run only. Re-run with --apply to create ${toCreate.length} account(s) + ` +
      `${mirrorsNeeded.length} mirror(s) + ${CLASSES_TO_CREATE.length} class(es) + ` +
      `${DEPARTMENTS_TO_CREATE.length} department(s), and deactivate ${toDeactivate.length}.`,
    );
    return;
  }

  // ── Apply ───────────────────────────────────────────────────────────────────
  // Track ids as we go so a child created in this same run can resolve its parent.
  const idByName = new Map(target.map((a) => [key(a.FullyQualifiedName), a.Id]));
  let created = 0;
  let failed = 0;

  for (const a of toCreate) {
    const parentFqn = parentFqnOf(a.FullyQualifiedName);
    const parentId = parentFqn === '' ? null : idByName.get(key(parentFqn)) ?? null;
    if (parentFqn !== '' && parentId === null) {
      console.log(`  SKIP (parent missing) ${a.FullyQualifiedName}`);
      failed += 1;
      continue;
    }

    const body: Record<string, string | boolean | { value: string }> = {
      Name: a.Name,
      AccountType: a.AccountType,
    };
    if (a.AccountSubType) body.AccountSubType = a.AccountSubType;
    if (a.Description) body.Description = a.Description;
    if (a.AcctNum && !targetNums.has(a.AcctNum)) body.AcctNum = a.AcctNum;
    if (parentId !== null) {
      body.SubAccount = true;
      body.ParentRef = { value: parentId };
    }

    try {
      const res = await qbPost<{ Account?: QbAccount }>(TARGET, 'account?minorversion=75', body);
      const made = res.Account;
      if (!made) throw new Error('no Account in response');
      idByName.set(key(made.FullyQualifiedName), made.Id);
      if (made.AcctNum) targetNums.add(made.AcctNum);
      created += 1;
      console.log(`  created  ${made.FullyQualifiedName}`);
    } catch (e) {
      failed += 1;
      console.log(`  FAILED   ${a.FullyQualifiedName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Mirror inter-entity payables — FOCAS's side of the balances FL/TN/TX already carry for it.
  for (const m of mirrorsNeeded) {
    try {
      const body: Record<string, string | boolean> = {
        Name: m.Name,
        AccountType: m.AccountType,
        AccountSubType: m.AccountSubType,
      };
      if (!targetNums.has(m.AcctNum)) body.AcctNum = m.AcctNum;
      await qbPost(TARGET, 'account?minorversion=75', body);
      created += 1;
      console.log(`  created mirror  ${m.Name}`);
    } catch (e) {
      failed += 1;
      console.log(`  FAILED mirror   ${m.Name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Classes + departments: the allocation vocabulary. qb-journal.ts throws
  // `unresolved department/class` for any name missing from the company, so these must exist
  // before a dimensioned FOCAS line can post.
  const existingClasses = new Set(
    (await qbQueryAll<{ Name: string }>(TARGET, 'Class', 'WHERE Active = true')).map((c) => c.Name),
  );
  for (const name of CLASSES_TO_CREATE) {
    if (existingClasses.has(name)) { console.log(`  class exists     ${name}`); continue; }
    try {
      await qbPost(TARGET, 'class?minorversion=75', { Name: name });
      created += 1;
      console.log(`  created class    ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`  FAILED class     ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const existingDepts = new Set(
    (await qbQueryAll<{ Name: string }>(TARGET, 'Department', 'WHERE Active = true')).map((d) => d.Name),
  );
  for (const name of DEPARTMENTS_TO_CREATE) {
    if (existingDepts.has(name)) { console.log(`  dept exists      ${name}`); continue; }
    try {
      await qbPost(TARGET, 'department?minorversion=75', { Name: name });
      created += 1;
      console.log(`  created dept     ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`  FAILED dept      ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let deactivated = 0;
  for (const a of toDeactivate) {
    try {
      // QBO deactivates via a sparse update carrying Active:false. Id + SyncToken are mandatory.
      await qbPost(TARGET, 'account?minorversion=75', {
        Id: a.Id,
        SyncToken: a.SyncToken,
        Name: a.Name,
        Active: false,
        sparse: true,
      });
      deactivated += 1;
      console.log(`  deactivated  ${a.FullyQualifiedName}`);
    } catch (e) {
      failed += 1;
      console.log(`  FAILED deactivate ${a.FullyQualifiedName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`\nDone. created=${created} deactivated=${deactivated} failed=${failed}`);
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
