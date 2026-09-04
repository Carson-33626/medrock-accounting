/** READ-ONLY scratch: why does a pay_date header produce no ADP detail sheet? */
import './load-env-vercel-first';
import { loadDraft, getAccountMap, getEmployeeMap } from '../../src/lib/payroll/store';
import { selectSource } from '../../src/lib/payroll/source-select';
import { buildJournal } from '../../src/lib/payroll/build-je';
import { adpDateToIso } from '../../src/lib/payroll/dates';
import { shortMonthName } from '../../src/lib/payroll/month';
import type { JournalLine } from '../../src/lib/payroll/types';

const key = (l: JournalLine, memo: string): string =>
  [l.accountName, l.departmentName ?? '', l.className ?? '', l.creditBucket ?? '', l.postingType, memo].join('¦');

async function main(): Promise<void> {
  console.log('PAYROLL_ENC_KEY set:', !!process.env.PAYROLL_ENC_KEY);
  for (const id of process.argv.slice(2).map(Number)) {
    const loaded = await loadDraft(id);
    if (!loaded) { console.log(`#${id} not found`); continue; }
    const { header, lines } = loaded;
    const dayIso = adpDateToIso(header.pay_date);
    const dayRows = await selectSource().fetchRange(dayIso, dayIso);
    const runRows = dayRows.filter((r) => r.pay_group === header.pay_group);
    console.log(`\n#${id} ${header.entity} ${header.pay_group} ${header.pay_date} seg='${header.period_segment}' storedLines=${lines.length}`);
    console.log(`  source rows for ${dayIso}: ${dayRows.length} total, ${runRows.length} in pay group`);
    if (runRows.length === 0) continue;

    const [am, em] = await Promise.all([getAccountMap(header.entity), getEmployeeMap(header.entity)]);
    const built = buildJournal(runRows, am, em);
    console.log(`  rebuilt drafts: ${built.drafts.map((d) => `${d.entity}(${d.lines.length})`).join(', ')}`);
    const i = built.drafts.findIndex((d) => d.entity === header.entity);
    if (i < 0) continue;

    const seg = header.period_segment;
    const suffix = /^\d{4}-\d{2}$/.test(seg) && seg !== dayIso.slice(0, 7)
      ? ` - ${shortMonthName({ year: Number(seg.slice(0, 4)), month: Number(seg.slice(5, 7)) })} portion` : '';
    console.log(`  memo suffix: '${suffix}'`);

    const rebuiltKeys = new Set(built.drafts[i].lines.map((l) => key(l, l.memo)));
    const missing: string[] = [];
    for (const l of lines) {
      if (l.origin !== 'generated') continue;
      const memo = suffix !== '' && l.memo.endsWith(suffix) ? l.memo.slice(0, -suffix.length) : l.memo;
      if (!rebuiltKeys.has(key(l, memo))) missing.push(`${l.accountName} | ${memo} | ${l.postingType} | ${l.departmentName ?? '-'} | ${l.className ?? '-'}`);
    }
    console.log(`  stored generated lines with no rebuilt match: ${missing.length}`);
    for (const m of missing.slice(0, 8)) console.log(`    ${m}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
