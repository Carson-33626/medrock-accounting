/**
 * W9 targets — single-markdown builder. Replaces the old multi-sheet workbook.
 *
 * Target = QBO 1099-flagged vendor with no tax ID keyed, MINUS anyone matching
 * a payroll employee name (source.payroll_history via probe-payroll-names.ts —
 * payroll names are "Last, First M"; a target matches if its {first,last}
 * tokens are a subset of a payroll name's tokens).
 *
 * Inputs:  scripts/out/qbo-vendors-w9.csv, scripts/out/ramp-vendors-w9.csv,
 *          scripts/out/payroll-names.txt, scripts/w9/drive-w9s.csv
 * Output:  docs/accounting-requests/w9-targets.md  (the ONE deliverable)
 *
 *   npx tsx scripts/w9/build-targets-md.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT_DIR = resolve(__dirname, '..', 'out');
const DOCS = resolve(__dirname, '..', '..', '..', 'docs', 'accounting-requests');

function parseCsv(path: string): string[][] {
  const text = readFileSync(path, 'utf-8');
  const rows: string[][] = [];
  let cur = '';
  let row: string[] = [];
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur.replace(/\r$/, '')); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

const norm = (s: string): string => s.toLowerCase()
  .replace(/\s+-\s+(autopay|auto ?ach|ach( ramp)?|ramp ach|auto pay|pay online|net \d+)+$/i, '')
  .replace(/\b(llc|inc|corp|co|company|ltd|lp|medical)\b\.?/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

const tokens = (s: string): string[] => s.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1);

function main(): void {
  const payrollNames = readFileSync(resolve(OUT_DIR, 'payroll-names.txt'), 'utf-8')
    .split(/\r?\n/).filter(Boolean).map((n) => new Set(tokens(n)));
  /** A vendor name is an employee if its tokens all appear in one payroll name. */
  const isEmployee = (vendor: string): boolean => {
    const vt = tokens(vendor.replace(/\s*-\s*1099 vendor\s*$/i, ''));
    if (vt.length < 2 || vt.length > 4) return false; // person-shaped names only
    return payrollNames.some((pn) => vt.every((t) => pn.has(t)));
  };

  const qbo = parseCsv(resolve(OUT_DIR, 'qbo-vendors-w9.csv'));
  const ramp = parseCsv(resolve(OUT_DIR, 'ramp-vendors-w9.csv'));
  const drive = parseCsv(resolve(__dirname, 'drive-w9s.csv'));

  const rampByKey = new Map<string, { taxClass: string; spend: string }>();
  for (const r of ramp.slice(1)) {
    const k = norm(r[0]);
    const prev = rampByKey.get(k);
    if (!prev || (!prev.taxClass && r[4])) rampByKey.set(k, { taxClass: r[4], spend: r[8] });
  }
  const driveEntries = drive.slice(1).filter((r) => !/^\(/.test(r[0])).map((r) => ({ key: norm(r[0]), title: r[1] }));
  const driveMatch = (name: string): string => {
    const k = norm(name);
    for (const d of driveEntries) {
      if (d.key === k || (d.key.length >= 5 && k.includes(d.key)) || (k.length >= 5 && d.key.includes(k))) return d.title;
    }
    return '';
  };

  const flaggedNeedW9 = qbo.slice(1).filter((r) => r[2] === 'YES' && r[3] !== 'YES');
  const employees = flaggedNeedW9.filter((r) => isEmployee(r[0]));
  const targets = flaggedNeedW9.filter((r) => !isEmployee(r[0]));

  interface T { name: string; entities: string; email: string; phone: string; drive: string; rampClass: string; spend: string }
  const rows: T[] = targets.map((r) => {
    const m = rampByKey.get(norm(r[0]));
    return { name: r[0], entities: r[1].replace(/MedRock /g, ''), email: r[4], phone: r[5], drive: driveMatch(r[0]), rampClass: m?.taxClass ?? '', spend: m?.spend ?? '' };
  });

  const onDrive = rows.filter((r) => r.drive);
  const inRamp = rows.filter((r) => !r.drive && r.rampClass);
  const emailReady = rows.filter((r) => !r.drive && !r.rampClass && r.email);
  const noContact = rows.filter((r) => !r.drive && !r.rampClass && !r.email);

  const esc = (s: string): string => s.replace(/\|/g, '\\|');
  const table = (list: T[], extra: (r: T) => string, extraHeader: string): string => [
    `| Vendor | Entities | ${extraHeader} |`,
    `|---|---|---|`,
    ...list.sort((a, b) => a.name.localeCompare(b.name)).map((r) => `| ${esc(r.name)} | ${r.entities} | ${esc(extra(r))} |`),
  ].join('\n');

  const md = `# W9 targets — ${new Date().toISOString().slice(0, 10)}

> QBO 1099-flagged vendors with **no tax ID on file**, across FL/TN/TX, employees excluded
> (${employees.length} payroll-name matches pruned — reimbursement records, W2 not W9; unflag them in QBO).
> Sources: QBO Vendor pull, Ramp Bill Pay, shared-Drive W-9 scan, Gmail history.
> Regenerate: \`web/scripts/w9/\` probes → \`build-targets-md.ts\`.

**${rows.length} targets** — ${onDrive.length} already on Drive, ${inRamp.length} in Ramp, ${emailReady.length} email-ready, ${noContact.length} need contact discovery.

## 1 · W-9 already on the shared Drive — key the tax ID into QBO, done (${onDrive.length})

${table(onDrive, (r) => r.drive, 'Drive file')}

## 2 · W-9 data already in Ramp — pull from the Ramp dashboard (${inRamp.length})

${table(inRamp, (r) => r.rampClass, 'Ramp tax classification')}

## 3 · Mass-email ready (${emailReady.length})

${table(emailReady, (r) => r.email, 'Email')}

## 4 · No contact on file — chase via phone / HR / accounting mailboxes (${noContact.length})

${table(noContact, (r) => r.phone || '—', 'Phone')}

## Pruned as employees (unflag these vendor records in QBO — ${employees.length})

${employees.map((r) => esc(r[0])).sort().join(' · ')}
`;

  writeFileSync(resolve(DOCS, 'w9-targets.md'), md, 'utf-8');
  console.log(`w9-targets.md: ${rows.length} targets (drive=${onDrive.length} ramp=${inRamp.length} email=${emailReady.length} none=${noContact.length}) | employees pruned=${employees.length}`);
}

main();
