/** READ-ONLY: verify the Allocate - % regen. Untracked scratch.
 *  [1] dollar-neutrality: per-header totals vs the before-snapshot (scratchpad headers-before.json)
 *  [2] class coverage: Allocate - % lines by month/entity, debit vs credit
 *  [3] no ''-segment header coexists with segmented pieces for the same run
 *  [4] status of the two previously-approved April headers */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import { getRdsPool } from '../../src/lib/rds';

const SNAP = 'C:\\Users\\Carson.D\\AppData\\Local\\Temp\\claude\\C--Users-Carson-D-Documents-GitHub-Active-Development-Accounting-Analytics\\b2c26048-68a8-4ca7-b107-f471120d9bf8\\scratchpad\\headers-before.json';

interface Snap { entity: string; pay_date: string; pay_group: string; period_segment: string; status: string; total_debits: string; total_credits: string }

async function main(): Promise<void> {
  const pool = getRdsPool();
  const before = JSON.parse(readFileSync(SNAP, 'utf-8').replace(/^﻿/, '')) as Snap[];

  const after = await pool.query<Snap & { kind: string }>(
    `SELECT entity, pay_date, pay_group, period_segment, status, kind, total_debits::text, total_credits::text
       FROM accounting.payroll_journal_headers WHERE kind = 'pay_date'
      ORDER BY entity, pay_date, pay_group, period_segment`,
  );

  const key = (r: { entity: string; pay_date: string; pay_group: string }): string => `${r.entity}|${r.pay_date}|${r.pay_group}`;
  const sumBy = (rows: Snap[]): Map<string, { d: number; c: number; segs: string[] }> => {
    const m = new Map<string, { d: number; c: number; segs: string[] }>();
    for (const r of rows) {
      const k = key(r);
      const cur = m.get(k) ?? { d: 0, c: 0, segs: [] };
      cur.d += Number(r.total_debits); cur.c += Number(r.total_credits); cur.segs.push(r.period_segment);
      m.set(k, cur);
    }
    return m;
  };
  const b = sumBy(before);
  const a = sumBy(after.rows);
  let mismatches = 0;
  for (const [k, bv] of b) {
    const av = a.get(k);
    if (!av) { console.log(`  MISSING after regen: ${k} (before D=${bv.d.toFixed(2)})`); mismatches++; continue; }
    if (Math.abs(av.d - bv.d) > 0.005 || Math.abs(av.c - bv.c) > 0.005) {
      console.log(`  TOTALS MOVED: ${k}  D ${bv.d.toFixed(2)} -> ${av.d.toFixed(2)}  C ${bv.c.toFixed(2)} -> ${av.c.toFixed(2)}`);
      mismatches++;
    }
  }
  const newRuns = [...a.keys()].filter((k) => !b.has(k));
  console.log(`[1] dollar-neutrality: ${b.size} before-runs checked, ${mismatches} mismatches; ${newRuns.length} NEW runs (expected: August): ${newRuns.join('; ')}`);

  const mixed = new Map<string, Set<string>>();
  for (const r of after.rows) {
    const k = key(r);
    const s = mixed.get(k) ?? new Set<string>();
    s.add(r.period_segment); mixed.set(k, s);
  }
  const bad = [...mixed.entries()].filter(([, s]) => s.has('') && s.size > 1);
  console.log(`[3] runs mixing ''-segment with pieces: ${bad.length}${bad.length ? ' — ' + bad.map(([k]) => k).join('; ') : ''}`);

  const cls = await pool.query<{ mon: string; entity: string; posting_type: string; n: string; total: string }>(
    `SELECT substring(h.pay_date from 1 for 2) || '/' || substring(h.pay_date from 7 for 4) AS mon,
            h.entity, l.posting_type, COUNT(*)::text AS n, SUM(l.amount)::text AS total
       FROM accounting.payroll_journal_lines l
       JOIN accounting.payroll_journal_headers h ON h.id = l.header_id
      WHERE l.class_name = 'Allocate - %'
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
  );
  console.log(`[2] 'Allocate - %' lines by month/entity/side:`);
  for (const r of cls.rows) console.log(`    ${r.mon} ${r.entity} ${r.posting_type}: ${r.n} lines $${Number(r.total).toFixed(2)}`);
  const credits = cls.rows.filter((r) => r.posting_type === 'Credit');
  console.log(`    credit-side Allocate lines: ${credits.length === 0 ? 'NONE (correct)' : 'PRESENT (BUG)'}`);

  const april = await pool.query<{ id: number; status: string }>(
    `SELECT id, status FROM accounting.payroll_journal_headers WHERE id IN (1134, 1135)`,
  );
  console.log(`[4] previously-approved April headers: ${april.rows.map((r) => `#${r.id}=${r.status}`).join(', ') || 'gone (replaced by pieces)'}`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
