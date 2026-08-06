/**
 * READ-ONLY conformance probe against the LIVE source.payroll_history.
 * Proves our crypto.ts + RdsPayrollSource decrypt the REAL production blobs with
 * the REAL PAYROLL_ENC_KEY (envelope conformance). Prints ONLY structure/counts —
 * never decrypted names or dollar amounts (payroll PII stays out of logs).
 *   npx tsx scripts/payroll/probe-live-conformance.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

async function main(): Promise<void> {
  const key = process.env.PAYROLL_ENC_KEY;
  if (!key) { console.log('❌ PAYROLL_ENC_KEY not in .env.local'); return; }
  const pool = new Pool({ connectionString: process.env.RDS_DATABASE_URL, max: 1, ssl: { rejectUnauthorized: false } });
  try {
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='source' AND table_name='payroll_history' ORDER BY ordinal_position`);
    if (cols.rowCount === 0) { console.log('❌ source.payroll_history NOT FOUND'); return; }
    const names = cols.rows.map((r) => r.column_name);
    const expected = ['position_id','name','pay_date','pay_group','sensitive_encrypted','row_key','updated_at'];
    const missing = expected.filter((e) => !names.includes(e));
    console.log(`✅ table found — ${names.length} cols. Missing expected: ${missing.length ? missing.join(',') : 'none'}`);

    const meta = await pool.query<{ n: string; a: string; b: string }>(
      `SELECT count(*)::text n, min(to_date(pay_date,'MM/DD/YYYY'))::text a, max(to_date(pay_date,'MM/DD/YYYY'))::text b
       FROM source.payroll_history`);
    console.log(`rows: ${meta.rows[0].n}  pay_date range: ${meta.rows[0].a} .. ${meta.rows[0].b}`);
    const grp = await pool.query<{ pay_group: string; n: string }>(
      `SELECT pay_group, count(*)::text n FROM source.payroll_history GROUP BY pay_group ORDER BY 2 DESC`);
    console.log('pay_groups:', grp.rows.map((r) => `${r.pay_group}:${r.n}`).join('  '));

    // Decrypt the most recent pay_date's rows via the real source path — structure only.
    const maxIso = meta.rows[0].b;
    const { RdsPayrollSource } = await import('../../src/lib/payroll/source');
    const src = new RdsPayrollSource(key);
    let rows;
    try { rows = await src.fetchRange(maxIso, maxIso); }
    catch (e) { console.log(`❌ DECRYPT FAILED (envelope mismatch?): ${(e as Error).message}`); return; }

    let grossNum = 0, netNum = 0; const keyCounts = new Set<string>();
    for (const r of rows) {
      if (typeof r.sensitive['GROSS PAY'] === 'number') grossNum++;
      if (typeof r.sensitive['NET PAY'] === 'number') netNum++;
      Object.keys(r.sensitive).forEach((k) => keyCounts.add(k));
    }
    console.log(`✅ DECRYPT OK for ${maxIso}: ${rows.length} rows decrypted`);
    console.log(`   GROSS PAY numeric: ${grossNum}/${rows.length}   NET PAY numeric: ${netNum}/${rows.length}`);
    console.log(`   distinct sensitive JSON keys across rows: ${keyCounts.size} (no values printed)`);
  } finally { await pool.end(); }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
