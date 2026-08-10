/**
 * READ-ONLY verification of three meeting claims (2026-08-06), against real 2026 data:
 *   1. FOCAS payroll never reaches the month-end location split.
 *   2. Child-support deductions + the employer processing fee stay with their originating
 *      location/cost center (never swept into the Allocate pool).
 *   3. The `Allocate` coding family produces correct JE output for all four entities.
 *
 * Prints columns, cost centers, entities, accounts and dollar totals only — never a person's
 * name. No writes of any kind.
 *   npx tsx scripts/payroll/probe-verify-focas-alloc.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { RDS_SSL } from '../../src/lib/rds-ssl';
import { decryptSensitive } from '../../src/lib/payroll/crypto';
import { costCenterFor } from '../../src/lib/payroll/cost-center';
import { classifyAllocateFlag } from '../../src/lib/payroll/qb-pool';
import { entityForPayGroup } from '../../src/lib/payroll/entity';
import type { SensitiveRow, Entity } from '../../src/lib/payroll/types';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const hdr = (s: string): void => console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);

interface CountRow { k: string; n: string; amt: string | null }
interface SrcRow {
  position_id: string;
  home_department: string | null;
  pay_group: string;
  pay_date: string;
  sensitive_encrypted: string;
}
interface EmpMapRow { entity: string; position_id: string; department_name: string | null; class_name: string | null; active: boolean }
interface LineRow {
  entity: string; kind: string; pay_group: string; pay_date: string; status: string;
  posting_type: string; amount: string; account_name: string;
  department_name: string | null; class_name: string | null; memo: string | null; origin: string;
}
interface EomRunRow { month: string; pool: unknown; revenue: unknown; attention: unknown; generated_at: string }

/** Shape of one saved pool line (mirrors PoolLine, re-declared because the run column is jsonb). */
interface SavedPoolLine {
  entity: string; txnType: string; txnId: string; accountName: string;
  className: string | null; departmentName: string | null; amount: number;
  rule: string; counterparty: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAIM 1 — does any FOCAS payroll dollar reach the EOM pool / the 3 splits?
// ─────────────────────────────────────────────────────────────────────────────
async function claim1(pool: Pool): Promise<void> {
  hdr('CLAIM 1 — FOCAS vs the month-end location split');

  const { rows: pg } = await pool.query<CountRow>(
    `SELECT pay_group AS k, count(*)::text AS n, NULL AS amt
     FROM source.payroll_history WHERE pay_date >= '01/01/2026' GROUP BY 1 ORDER BY 2 DESC`,
  );
  console.log('\n-- source.payroll_history 2026 rows by pay_group -> entity --');
  for (const r of pg) console.log(`  ${r.k.padEnd(10)} rows=${String(r.n).padStart(6)}  entity=${entityForPayGroup(r.k) ?? 'EXCLUDED'}`);

  const { rows: hdrs } = await pool.query<CountRow>(
    `SELECT entity || ' | ' || kind || ' | ' || pay_group || ' | ' || status AS k,
            count(*)::text AS n, sum(total_debits)::text AS amt
     FROM accounting.payroll_journal_headers
     WHERE pay_date LIKE '%2026' GROUP BY 1 ORDER BY 1`,
  );
  console.log('\n-- payroll_journal_headers 2026 (entity | kind | pay_group | status) --');
  for (const r of hdrs) console.log(`  ${r.k.padEnd(56)} n=${String(r.n).padStart(4)}  debits=${money(Number(r.amt ?? 0))}`);

  // The decisive test: any Allocate-flagged JE line under a FOCAS header?
  const { rows: focasAlloc } = await pool.query<LineRow>(
    `SELECT h.entity, h.kind, h.pay_group, h.pay_date, h.status,
            l.posting_type, l.amount::text AS amount, l.account_name,
            l.department_name, l.class_name, l.memo, l.origin
     FROM accounting.payroll_journal_lines l
     JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
     WHERE h.entity = 'FOCAS'
       AND (l.class_name LIKE 'Allocate%' OR l.department_name = '% Allocation')`,
  );
  console.log(`\n-- FOCAS JE lines carrying an Allocate class / '% Allocation' dept: ${focasAlloc.length} --`);
  for (const r of focasAlloc) {
    console.log(`  ${r.pay_date} ${r.posting_type} ${money(Number(r.amount))} ${r.account_name} dept=${r.department_name} class=${r.class_name}`);
  }

  const { rows: focasEmp } = await pool.query<EmpMapRow>(
    `SELECT entity, position_id, department_name, class_name, active
     FROM accounting.payroll_employee_map WHERE entity = 'FOCAS'`,
  );
  console.log(`\n-- FOCAS employee_map rules: ${focasEmp.length} --`);
  for (const r of focasEmp) console.log(`  pos ${r.position_id} dept=${JSON.stringify(r.department_name)} class=${JSON.stringify(r.class_name)} active=${r.active}`);

  const { rows: focasAcct } = await pool.query<CountRow>(
    `SELECT entity AS k, count(*)::text AS n, NULL AS amt
     FROM accounting.payroll_account_map GROUP BY 1 ORDER BY 1`,
  );
  console.log('\n-- account_map rule counts by entity --');
  for (const r of focasAcct) console.log(`  ${r.k.padEnd(14)} ${r.n} rules`);

  // Any FOCAS line in a saved EOM pool snapshot?
  const { rows: runs } = await pool.query<EomRunRow>(
    `SELECT month, pool, revenue, attention, generated_at::text FROM accounting.payroll_eom_runs ORDER BY month`,
  );
  console.log(`\n-- saved accounting.payroll_eom_runs: ${runs.length} --`);
  for (const run of runs) {
    const poolLines = (run.pool ?? []) as SavedPoolLine[];
    const attn = (run.attention ?? []) as SavedPoolLine[];
    const byEntity = new Map<string, { n: number; amt: number }>();
    for (const l of poolLines) {
      const g = byEntity.get(l.entity) ?? { n: 0, amt: 0 };
      g.n++; g.amt += l.amount; byEntity.set(l.entity, g);
    }
    const focasInPool = poolLines.filter((l) => l.entity === 'FOCAS');
    const focasInAttn = attn.filter((l) => l.entity === 'FOCAS');
    console.log(`\n  ${run.month} (generated ${run.generated_at}) pool=${poolLines.length} attention=${attn.length}`);
    console.log(`    revenue test: ${JSON.stringify(run.revenue)}`);
    for (const [e, g] of [...byEntity].sort()) console.log(`    pool holder ${e.padEnd(14)} lines=${String(g.n).padStart(4)} ${money(g.amt)}`);
    console.log(`    FOCAS lines in pool=${focasInPool.length}  in attention=${focasInAttn.length}`);
    const byRule = new Map<string, { n: number; amt: number }>();
    for (const l of [...poolLines, ...attn]) {
      const g = byRule.get(l.rule) ?? { n: 0, amt: 0 };
      g.n++; g.amt += l.amount; byRule.set(l.rule, g);
    }
    for (const [r, g] of [...byRule].sort()) console.log(`    rule ${r.padEnd(12)} lines=${String(g.n).padStart(4)} ${money(g.amt)}`);
    // Any class naming FOCAS at all?
    const focasClassed = [...poolLines, ...attn].filter((l) => /FOCAS|FOCS/i.test(`${l.className ?? ''} ${l.departmentName ?? ''}`));
    console.log(`    lines whose class/dept mentions FOCAS: ${focasClassed.length}`);
    for (const l of focasClassed) console.log(`      ${l.entity} ${l.txnType} ${l.accountName} class=${l.className} rule=${l.rule} ${money(l.amount)}`);
  }

  // Would a FOCAS-named Allocate class even classify? (pure-function probe, no I/O)
  console.log('\n-- classifyAllocateFlag() behaviour for FOCAS-shaped coding --');
  for (const cls of ['Allocate - FOCAS', 'Allocate - FOCS', 'Allocate - Split FOCAS50', 'Allocate - %', 'Allocate - SplitX3']) {
    for (const holder of ['MedRock FL', 'FOCAS'] as Entity[]) {
      console.log(`  class=${cls.padEnd(24)} holder=${holder.padEnd(12)} -> ${JSON.stringify(classifyAllocateFlag(cls, null, holder))}`);
    }
  }
  console.log(`  dept='% Allocation' holder=FOCAS -> ${JSON.stringify(classifyAllocateFlag(null, '% Allocation', 'FOCAS'))}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAIM 2 — child support deduction + ER processing fee keep their location
// ─────────────────────────────────────────────────────────────────────────────
const CHILD_COLUMNS = ['CHILD PAYMENTS', 'CHILD PAYMENTS - ER', 'GARNISH', 'BKWITHHOLD'];

async function claim2(pool: Pool): Promise<void> {
  hdr('CLAIM 2 — child support / processing fee stay with their location');

  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) throw new Error('PAYROLL_ENC_KEY not set');

  const { rows } = await pool.query<SrcRow>(
    `SELECT position_id, home_department, pay_group, pay_date, sensitive_encrypted
     FROM source.payroll_history WHERE pay_date LIKE '%2026'`,
  );

  // column -> entity -> cost center -> $ (+ distinct positions, counted not named)
  const agg = new Map<string, Map<string, Map<string, { amt: number; pos: Set<string> }>>>();
  const carriers = new Map<string, Set<string>>(); // column -> `${entity}|${positionId}`
  for (const r of rows) {
    const ent = entityForPayGroup(r.pay_group);
    if (ent === null) continue;
    const cc = costCenterFor(r.home_department ?? '');
    const s: SensitiveRow = decryptSensitive(r.sensitive_encrypted, key);
    for (const col of CHILD_COLUMNS) {
      const v = s[col];
      if (typeof v !== 'number' || v === 0) continue;
      const byEnt = agg.get(col) ?? new Map<string, Map<string, { amt: number; pos: Set<string> }>>();
      const byCc = byEnt.get(ent) ?? new Map<string, { amt: number; pos: Set<string> }>();
      const g = byCc.get(cc) ?? { amt: 0, pos: new Set<string>() };
      g.amt += v; g.pos.add(r.position_id);
      byCc.set(cc, g); byEnt.set(ent, byCc); agg.set(col, byEnt);
      const cs = carriers.get(col) ?? new Set<string>();
      cs.add(`${ent}|${r.position_id}`); carriers.set(col, cs);
    }
  }

  console.log('\n-- 2026 source dollars by column / entity / cost center --');
  for (const col of CHILD_COLUMNS) {
    const byEnt = agg.get(col);
    if (!byEnt) { console.log(`\n  ${col}: NO 2026 dollars`); continue; }
    console.log(`\n  ${col}:`);
    for (const [ent, byCc] of [...byEnt].sort()) {
      let entTotal = 0;
      for (const [cc, g] of [...byCc].sort()) {
        entTotal += g.amt;
        console.log(`    ${ent.padEnd(14)} cc=${cc.padEnd(7)} ${money(g.amt).padStart(14)}  (${g.pos.size} position(s))`);
      }
      console.log(`    ${ent.padEnd(14)} ${'TOTAL'.padEnd(10)} ${money(entTotal).padStart(14)}`);
    }
  }

  // THE risk: does any child-support carrier have an Allocate-* employee-map rule?
  // If so, resolveLine stamps the deduction line with that class (and '% Allocation'
  // dept for 'Allocate - %'), which is exactly what fetchAllocationPool sweeps.
  const { rows: emps } = await pool.query<EmpMapRow>(
    `SELECT entity, position_id, department_name, class_name, active FROM accounting.payroll_employee_map`,
  );
  const empKey = new Map<string, EmpMapRow>(emps.map((e) => [`${e.entity}|${e.position_id}`, e]));
  console.log('\n-- cross-check: do child-support carriers carry an Allocate employee-map rule? --');
  for (const col of CHILD_COLUMNS) {
    const cs = carriers.get(col);
    if (!cs) continue;
    let flagged = 0;
    for (const k of cs) {
      const e = empKey.get(k);
      const cls = e?.class_name ?? null;
      const dept = e?.department_name ?? null;
      if ((cls && cls.startsWith('Allocate')) || dept === '% Allocation') {
        flagged++;
        const [ent, pos] = k.split('|');
        console.log(`    !! ${col} carrier ${ent} pos ${pos} -> class=${JSON.stringify(cls)} dept=${JSON.stringify(dept)} active=${e?.active}`);
      }
    }
    console.log(`  ${col.padEnd(22)} carriers=${String(cs.size).padStart(3)}  Allocate-flagged carriers=${flagged}`);
  }

  // What the BUILT JE actually looks like for these accounts.
  const { rows: jeLines } = await pool.query<LineRow>(
    `SELECT h.entity, h.kind, h.pay_group, h.pay_date, h.status,
            l.posting_type, l.amount::text AS amount, l.account_name,
            l.department_name, l.class_name, l.memo, l.origin
     FROM accounting.payroll_journal_lines l
     JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
     WHERE h.pay_date LIKE '%2026'
       AND (l.account_name ILIKE '%Garnishment%'
            OR l.account_name ILIKE '%Payroll Processing Fees%'
            OR l.memo ILIKE '%Child Support%'
            OR l.memo ILIKE '%Garnish%')
     ORDER BY h.entity, h.pay_date`,
  );
  console.log(`\n-- built 2026 JE lines touching garnishment / child-support fee: ${jeLines.length} --`);
  const jeAgg = new Map<string, { n: number; amt: number; depts: Set<string>; classes: Set<string>; memos: Set<string> }>();
  for (const l of jeLines) {
    const k = `${l.entity} | ${l.account_name} | ${l.posting_type}`;
    const g = jeAgg.get(k) ?? { n: 0, amt: 0, depts: new Set<string>(), classes: new Set<string>(), memos: new Set<string>() };
    g.n++; g.amt += Number(l.amount);
    g.depts.add(String(l.department_name)); g.classes.add(String(l.class_name)); g.memos.add(String(l.memo));
    jeAgg.set(k, g);
  }
  for (const [k, g] of [...jeAgg].sort()) {
    console.log(`\n  ${k}`);
    console.log(`    lines=${g.n} total=${money(g.amt)}`);
    console.log(`    dept(s)  : ${[...g.depts].join(' | ')}`);
    console.log(`    class(es) : ${[...g.classes].join(' | ')}`);
    console.log(`    memo(s)  : ${[...g.memos].sort().join(' | ')}`);
  }

  // Is any of that dollar volume Allocate-flagged (i.e. would get split)?
  const swept = jeLines.filter((l) => (l.class_name ?? '').startsWith('Allocate') || l.department_name === '% Allocation');
  const sweptAmt = swept.reduce((s, l) => s + Number(l.amount), 0);
  console.log(`\n  >>> garnishment/child-support JE lines carrying an Allocate flag: ${swept.length} (${money(sweptAmt)})`);
  for (const l of swept) console.log(`      ${l.entity} ${l.pay_date} ${l.posting_type} ${money(Number(l.amount))} ${l.account_name} dept=${l.department_name} class=${l.class_name} memo=${l.memo}`);

  // Account-map rules actually in the DB for these columns (seed vs live can drift).
  const { rows: acctRules } = await pool.query<{ entity: string; adp_column: string; cost_center: string; account_name: string; posting_type: string; memo: string | null; active: boolean }>(
    `SELECT entity, adp_column, cost_center, account_name, posting_type, memo, active
     FROM accounting.payroll_account_map
     WHERE adp_column = ANY($1::text[]) ORDER BY adp_column, entity, posting_type`,
    [CHILD_COLUMNS],
  );
  console.log(`\n-- live account_map rules for those columns: ${acctRules.length} --`);
  for (const r of acctRules) {
    console.log(`  ${r.adp_column.padEnd(22)} ${r.entity.padEnd(14)} cc=${r.cost_center.padEnd(6)} ${r.posting_type.padEnd(6)} ${r.account_name.padEnd(38)} memo=${JSON.stringify(r.memo)} active=${r.active}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAIM 3 — Allocate coding across all four entities
// ─────────────────────────────────────────────────────────────────────────────
async function claim3(pool: Pool): Promise<void> {
  hdr('CLAIM 3 — Allocate coding -> JE output, per entity');

  const { rows: classes } = await pool.query<CountRow>(
    `SELECT h.entity || ' | class=' || coalesce(l.class_name,'(null)') || ' | dept=' || coalesce(l.department_name,'(null)') AS k,
            count(*)::text AS n, sum(l.amount)::text AS amt
     FROM accounting.payroll_journal_lines l
     JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
     WHERE h.pay_date LIKE '%2026'
       AND (l.class_name IS NOT NULL OR l.department_name IS NOT NULL)
     GROUP BY 1 ORDER BY 1`,
  );
  console.log('\n-- 2026 JE lines: distinct entity x class x dept (dimensioned lines only) --');
  for (const r of classes) console.log(`  ${r.k.padEnd(72)} n=${String(r.n).padStart(5)} ${money(Number(r.amt ?? 0)).padStart(16)}`);

  const { rows: emp } = await pool.query<CountRow>(
    `SELECT entity || ' | class=' || coalesce(class_name,'(null)') || ' | dept=' || coalesce(department_name,'(null)') || ' | active=' || active AS k,
            count(*)::text AS n, NULL AS amt
     FROM accounting.payroll_employee_map GROUP BY 1 ORDER BY 1`,
  );
  console.log('\n-- employee_map: distinct entity x class x dept --');
  for (const r of emp) console.log(`  ${r.k.padEnd(78)} positions=${r.n}`);

  const { rows: allocHdrs } = await pool.query<CountRow>(
    `SELECT entity || ' | ' || pay_date || ' | ' || status || ' | doc=' || coalesce(qb_doc_number,'(none)') AS k,
            count(*)::text AS n, sum(total_debits)::text AS amt
     FROM accounting.payroll_journal_headers WHERE kind = 'allocation' GROUP BY 1 ORDER BY 1`,
  );
  console.log(`\n-- kind='allocation' headers ever generated: ${allocHdrs.length} --`);
  for (const r of allocHdrs) console.log(`  ${r.k.padEnd(66)} debits=${money(Number(r.amt ?? 0))}`);

  const { rows: allocLines } = await pool.query<LineRow>(
    `SELECT h.entity, h.kind, h.pay_group, h.pay_date, h.status,
            l.posting_type, l.amount::text AS amount, l.account_name,
            l.department_name, l.class_name, l.memo, l.origin
     FROM accounting.payroll_journal_lines l
     JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
     WHERE h.kind = 'allocation' ORDER BY h.entity, l.sort_order`,
  );
  console.log(`\n-- allocation JE lines: ${allocLines.length} --`);
  const byEnt = new Map<string, { dr: number; cr: number; n: number }>();
  for (const l of allocLines) {
    const g = byEnt.get(l.entity) ?? { dr: 0, cr: 0, n: 0 };
    g.n++;
    if (l.posting_type === 'Debit') g.dr += Number(l.amount); else g.cr += Number(l.amount);
    byEnt.set(l.entity, g);
  }
  for (const [e, g] of [...byEnt].sort()) {
    console.log(`  ${e.padEnd(14)} lines=${String(g.n).padStart(4)} DR=${money(g.dr).padStart(16)} CR=${money(g.cr).padStart(16)} variance=${money(Math.round((g.dr - g.cr) * 100) / 100)}`);
  }
  for (const l of allocLines.slice(0, 40)) {
    console.log(`    ${l.entity.padEnd(12)} ${l.posting_type.padEnd(6)} ${money(Number(l.amount)).padStart(14)} ${l.account_name.padEnd(46)} dept=${l.department_name} class=${l.class_name} origin=${l.origin}`);
  }
  if (allocLines.length > 40) console.log(`    … ${allocLines.length - 40} more`);
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: RDS_SSL });
  try {
    await claim1(pool);
    await claim2(pool);
    await claim3(pool);
  } finally {
    await pool.end();
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
