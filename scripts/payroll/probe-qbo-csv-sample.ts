/** READ-ONLY: render the QBO import CSV for a real draft header to eyeball. Untracked scratch. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.local'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import { loadDraft, listSiblings } from '../../src/lib/payroll/store';
import { deriveJeIdentity } from '../../src/lib/payroll/je-identity';
import { buildQboImportRows, qboImportFilename, QBO_IMPORT_COLUMNS } from '../../src/lib/payroll/qbo-import-csv';

async function main(): Promise<void> {
  const headerId = Number(process.argv[2] ?? 994);
  const loaded = await loadDraft(headerId);
  if (!loaded) throw new Error('header not found');
  const siblings = await listSiblings(loaded.header.entity, loaded.header.pay_date, loaded.header.pay_group);
  const segIndex = Math.max(0, siblings.findIndex((s) => s.id === headerId));
  const id = deriveJeIdentity(loaded.header, segIndex, siblings.length);
  const rows = buildQboImportRows([{ docNumber: id.docNumber, txnDateIso: id.txnDateIso, privateNote: id.privateNote, lines: loaded.lines }]);
  console.log(`filename: ${qboImportFilename(loaded.header.entity, [{ docNumber: id.docNumber, txnDateIso: id.txnDateIso, privateNote: id.privateNote, lines: [] }])}.csv\n`);
  console.log(QBO_IMPORT_COLUMNS.map((c) => c.header).join(','));
  for (const r of rows) console.log(QBO_IMPORT_COLUMNS.map((c) => String(r[c.key] ?? '')).join(','));
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
