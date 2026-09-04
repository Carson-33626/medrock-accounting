/**
 * READ-ONLY: clean quantification of the medical crossover, matching ONLY on line-level
 * Description (not JE-level PrivateNote, which contaminated an earlier pass by flagging
 * every line in a JE whose PrivateNote happened to mention a category).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const ACCT_2110 = '15';
const ACCT_2115 = '1150040014';
interface QbLine {
  Amount?: number; Description?: string;
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: { value?: string } };
}
interface JE { Id?: string; DocNumber?: string; TxnDate?: string; Line?: QbLine[] }

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const entries = await qbQueryAll<JE>('MedRock FL' as never, 'JournalEntry', `WHERE TxnDate >= '2026-01-01' ORDER BY TxnDate ASC`);

  let healthCreditsInto2110 = 0, healthCreditCount2110 = 0;
  let eeErMedicalCombinedInto2110 = 0, eeErCount = 0;
  let erMedicalDebitsFrom2115 = 0, erMedicalCount2115 = 0;
  let carAllowanceDebitsFrom2115 = 0;

  for (const je of entries) {
    for (const l of je.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      const acct = d?.AccountRef?.value;
      const type = d?.PostingType;
      const amt = l.Amount ?? 0;
      const desc = (l.Description ?? '').trim();
      if (acct === ACCT_2110 && type === 'Credit' && /^Health\s*-/i.test(desc)) {
        healthCreditsInto2110 += amt; healthCreditCount2110++;
      }
      if (acct === ACCT_2110 && type === 'Credit' && /medical/i.test(desc) && !/^Health\s*-/i.test(desc)) {
        eeErMedicalCombinedInto2110 += amt; eeErCount++;
      }
      if (acct === ACCT_2115 && type === 'Debit' && /^ER Medical\s*-/i.test(desc)) {
        erMedicalDebitsFrom2115 += amt; erMedicalCount2115++;
      }
      if (acct === ACCT_2115 && type === 'Debit' && /^Car Allowance/i.test(desc)) {
        carAllowanceDebitsFrom2115 += amt;
      }
    }
  }

  console.log('===== 2026 YTD clean medical crossover quantification (MedRock FL) =====');
  console.log(`2110 CREDITS  "Health - X" (EE premium withholding, per-pay-period, post-Mar pattern): count=${healthCreditCount2110}  total=${healthCreditsInto2110.toFixed(2)}`);
  console.log(`2110 CREDITS  "EE/ER Medical" (combined, pre-Mar pattern, single line/pay period):     count=${eeErCount}  total=${eeErMedicalCombinedInto2110.toFixed(2)}`);
  console.log(`  --> TOTAL medical-related credits landed in 2110, 2026 YTD: ${(healthCreditsInto2110 + eeErMedicalCombinedInto2110).toFixed(2)}`);
  console.log(`2115 DEBITS   "ER Medical - X" (per-pay-period employer cost, relieving 2115, post-Mar pattern): count=${erMedicalCount2115}  total=${erMedicalDebitsFrom2115.toFixed(2)}`);
  console.log(`2115 DEBITS   "Car Allowance - X" (unrelated to medical but same misclassification pattern, FYI): total=${carAllowanceDebitsFrom2115.toFixed(2)}`);

  // Also: does ANY debit to 2110 ever have a medical/aetna/health memo? (checks for a clearing path)
  console.log('\n===== Does ANYTHING ever DEBIT 2110 with a medical/health/aetna description? (2026 YTD) =====');
  let found = false;
  for (const je of entries) {
    for (const l of je.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      if (d?.AccountRef?.value === ACCT_2110 && d.PostingType === 'Debit' && /(medical|health|aetna)/i.test(l.Description ?? '')) {
        found = true;
        console.log(`  ${je.TxnDate}  #${je.DocNumber}  ${(l.Amount ?? 0).toFixed(2)}  desc=${JSON.stringify(l.Description)}`);
      }
    }
  }
  if (!found) console.log('  NONE FOUND — confirms no JE-based clearing path for medical credits stranded in 2110.');
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
