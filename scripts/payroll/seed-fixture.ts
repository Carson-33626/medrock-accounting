// web/scripts/payroll/seed-fixture.ts
// Reads the real sample xlsx, builds per-row sensitive JSON (parsing =ROUND()),
// encrypts each with a TEST key using the frozen envelope, writes a fixture file.
// Run: npx tsx scripts/payroll/seed-fixture.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createCipheriv } from 'node:crypto';
import ExcelJS from 'exceljs';

const SAMPLE = 'C:/Users/Carson.D/Documents/GitHub/Active Development/MedRock-Data-Loader/docs/PayrollHistory (1).xlsx';
const OUT_DIR = resolve(__dirname, '..', '..', 'src', 'lib', 'payroll', 'fixtures');
const TEST_KEY = randomBytes(32); // fixture-only key

// Map ADP header -> our plaintext column (only the plaintext keys; everything else is sensitive)
const PLAINTEXT: Record<string, string> = {
  'POSITION ID': 'position_id', 'NAME': 'name', 'STATUS': 'status',
  'WORKER CLASSIFICATION': 'worker_classification', 'HOME DEPARTMENT': 'home_department',
  'LOCATION': 'location', 'PAY DATE': 'pay_date', 'PAY #': 'pay_num', 'PAY FREQUENCY': 'pay_frequency',
  'PAY GROUP': 'pay_group', 'PAY TYPE': 'pay_type', 'PERIOD START DATE': 'period_start_date',
  'PERIOD END DATE': 'period_end_date', 'PROCESSED AS': 'processed_as', 'RATE TYPE': 'rate_type',
  'SUI/SDI TAX CODE': 'sui_sdi_tax_code',
};

function parseRound(v: unknown): number | string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v !== null && 'formula' in v) {
    const f = String((v as { formula: string }).formula);
    const m = /ROUND\(\s*(-?\d+(?:\.\d+)?)/.exec(f);
    if (m) return parseFloat(m[1]);
  }
  const s = String(v);
  const m = /^=?ROUND\(\s*(-?\d+(?:\.\d+)?)/.exec(s);
  return m ? parseFloat(m[1]) : s;
}

function encrypt(obj: Record<string, unknown>): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', TEST_KEY, nonce);
  const pt = Buffer.from(JSON.stringify(obj), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]).toString('base64');
}

async function main(): Promise<void> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SAMPLE);
  const ws = wb.getWorksheet('Payroll History');
  if (!ws) throw new Error('Payroll History sheet not found');
  const headers: string[] = [];
  ws.getRow(1).eachCell((c, col) => { headers[col] = String(c.value ?? '').trim(); });

  const rows: Array<Record<string, unknown>> = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const plain: Record<string, string> = {};
    const sensitive: Record<string, number | string | null> = {};
    let hasData = false;
    for (let c = 1; c < headers.length; c++) {
      const h = headers[c]; if (!h) continue;
      const raw = row.getCell(c).value;
      if (PLAINTEXT[h]) { plain[PLAINTEXT[h]] = raw == null ? '' : String(typeof raw === 'object' && 'text' in (raw as object) ? (raw as { text: string }).text : raw).trim(); }
      else { sensitive[h] = parseRound(raw); }
      if (raw != null) hasData = true;
    }
    if (!hasData || !plain.position_id) continue;
    plain.row_key = [plain.position_id, plain.pay_date, plain.period_start_date, plain.period_end_date, plain.processed_as].join('|');
    plain.updated_at = '2026-07-10T02:00:00Z';
    rows.push({ ...plain, sensitive_encrypted: encrypt(sensitive) });
    hasData = false;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'payroll_history.fixture.json'), JSON.stringify(rows, null, 2));
  writeFileSync(resolve(OUT_DIR, 'test-key.txt'), TEST_KEY.toString('base64'));
  console.log(`Wrote ${rows.length} fixture rows + test-key.txt`);
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
