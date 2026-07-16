/**
 * READ-ONLY: find how the inter-entity accounts are ACTUALLY used in each QB company —
 * which of the two competing families Amy reached for (the entity-NAMED "Due from/to MedRock X"
 * accounts vs the GENERIC symmetric "IE - Due From"/"IE - Due To" pair), and what she put in
 * the memo to identify the counterparty.
 *
 * Scope 7 (admin wage allocation) has to pick one family; the named set turned out to be
 * asymmetric/incomplete across the 3 companies, so this decides it from her real history
 * rather than our guess.
 *
 * Also flags any payroll ("PR") JE that already touches an IE account — i.e. whether admin
 * wages were ALREADY being allocated, which would give us her real percentages.
 *
 * Prints account names, memos, posting types and amounts — no PII beyond what a JE memo carries.
 *   npx tsx scripts/payroll/probe-ie-usage.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface QbLine {
  Amount?: number;
  Description?: string;
  JournalEntryLineDetail?: {
    PostingType?: 'Debit' | 'Credit';
    AccountRef?: { value?: string; name?: string };
    ClassRef?: { name?: string };
    DepartmentRef?: { name?: string };
  };
}
interface QbJournalEntry { Id?: string; DocNumber?: string; TxnDate?: string; PrivateNote?: string; Line?: QbLine[] }

const IE_PATTERN = /due\s*(from|to)\s*medrock|due\s*to\s*medrock|^ie\s*-\s*due|inter[-\s]?company/i;
const isIeAccount = (name: string): boolean => IE_PATTERN.test(name);

async function main(): Promise<void> {
  const { qbQueryAll, getConnectionStatus } = await import('../../src/lib/quickbooks-multi');
  const status = await getConnectionStatus();
  const locations = (Object.keys(status) as Array<keyof typeof status>).filter((l) => status[l]);

  for (const location of locations) {
    console.log(`\n================ ${location} ================`);

    // 2026 JEs only — enough to characterise current practice without pulling the whole history.
    const entries = await qbQueryAll<QbJournalEntry>(
      location, 'JournalEntry', `WHERE TxnDate >= '2026-01-01' ORDER BY TxnDate`,
    );

    const usage = new Map<string, { count: number; memos: Set<string>; docs: Set<string>; total: number }>();
    const prTouchingIe: string[] = [];

    for (const je of entries) {
      let jeTouchesIe = false;
      for (const l of je.Line ?? []) {
        const d = l.JournalEntryLineDetail;
        const acct = d?.AccountRef?.name ?? '';
        if (!isIeAccount(acct)) continue;
        jeTouchesIe = true;

        const key = `${acct}  [${d?.PostingType ?? '?'}]`;
        let u = usage.get(key);
        if (!u) { u = { count: 0, memos: new Set(), docs: new Set(), total: 0 }; usage.set(key, u); }
        u.count++;
        u.total += l.Amount ?? 0;
        if (l.Description) u.memos.add(l.Description);
        if (je.DocNumber) u.docs.add(je.DocNumber);
      }
      if (jeTouchesIe && /^PR\b/i.test(je.DocNumber ?? '')) {
        prTouchingIe.push(`${je.DocNumber} (${je.TxnDate})`);
      }
    }

    console.log(`\n  IE ACCOUNT USAGE across ${entries.length} JEs since 2026-01-01:`);
    if (usage.size === 0) console.log('    (no JE touches any inter-entity account)');
    for (const [key, u] of [...usage.entries()].sort()) {
      console.log(`\n    ${key}  — ${u.count} lines, total ${u.total.toFixed(2)}`);
      console.log(`      docs:  ${[...u.docs].slice(0, 8).join(', ')}${u.docs.size > 8 ? ` … (+${u.docs.size - 8})` : ''}`);
      if (u.memos.size > 0) console.log(`      memos: ${[...u.memos].slice(0, 5).map((m) => `"${m}"`).join(', ')}${u.memos.size > 5 ? ' …' : ''}`);
    }

    console.log(`\n  >>> PAYROLL JEs touching an IE account: ${prTouchingIe.length === 0 ? 'NONE (admin wages were NOT being allocated)' : prTouchingIe.join(', ')}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
