/**
 * ONE-OFF (Carson approved 2026-08-25): clear Veronica Denha's phantom Employee-Advances
 * balance in MedRock FL.
 *
 * The story (probe-oanh-1215-2110.ts + probe-oanh-columns.ts veronica):
 *   - 2025-10-24 `PR 2025.10.24` booked Dr $3,169.23 to 1215 Employee Advances
 *     ("Duplicate Payment") — the advance she owed back.
 *   - ADP withheld COMPANY LOAN - EE - PRINCIPAL POST-TAX 01/16/2026..07/01/2026
 *     (12 x $250 + $169.23 = $3,169.23) — fully repaid.
 *   - Our posted Apr-Jul FL payroll JEs credited 1215 $1,669.23 (correct mapping).
 *   - The first $1,500 (Jan-Mar 2026, 6 x $250) ran through Barbara's MANUAL PR JEs,
 *     which credited the withholdings pool (2110) instead of 1215.
 *
 * Fix: Dr 2110 Payroll Withholdings $1,500 / Cr 1215 Employee Advances $1,500.
 *
 * Pre-flight (hard-fails on mismatch):
 *   - 'Payroll Withholdings' resolves with AcctNum 2110, 'Employee Advances' with 1215;
 *   - her 1215 activity re-derived live from QB: the $3,169.23 Dr exists, her repayment
 *     credits (the 'Other - Marketing' lines on PR 2026.* docs) sum to $1,669.23,
 *     residual exactly $1,500.00;
 *   - no JE already carries the doc number (re-run safe).
 *
 *   npx tsx scripts/payroll/veronica-1215-clear.ts          (dry-run: pre-flight + payload)
 *   npx tsx scripts/payroll/veronica-1215-clear.ts --live   (post to MedRock FL)
 */
import './load-env-vercel-first';
import { qbPost, qbQueryAll } from '../../src/lib/quickbooks-multi';
import { fetchDimensions, type QbJournalEntryPayload } from '../../src/lib/payroll/qb-journal';
import type { JsonValue } from '../../src/lib/payroll/store';

const ENTITY = 'MedRock FL' as const;
const DOC = 'EE Adv Clr 2026.08';
const TXN_DATE = '2026-08-25';
const AMOUNT = 1500.0;
const live = process.argv.includes('--live');
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface QbJeLine {
  Amount?: number;
  Description?: string;
  JournalEntryLineDetail?: { PostingType?: 'Debit' | 'Credit'; AccountRef?: { name?: string } };
}
interface QbJe { Id: string; DocNumber?: string; TxnDate?: string; Line?: QbJeLine[] }

async function preflight(): Promise<{ withholdingsId: string; advancesId: string }> {
  const refs = await fetchDimensions(ENTITY);
  const withholdingsId = refs.accounts['Payroll Withholdings'];
  const advancesId = refs.accounts['Employee Advances'];
  if (!withholdingsId || !advancesId) throw new Error('account name(s) failed to resolve in MedRock FL');
  const wNum = refs.accountNums?.['Payroll Withholdings'];
  const aNum = refs.accountNums?.['Employee Advances'];
  console.log(`  accounts: Payroll Withholdings (Id ${withholdingsId}, #${wNum ?? '?'}) · Employee Advances (Id ${advancesId}, #${aNum ?? '?'})`);
  if (wNum !== undefined && wNum !== '2110') throw new Error(`'Payroll Withholdings' carries AcctNum ${wNum}, expected 2110 — stop and review`);
  if (aNum !== undefined && aNum !== '1215') throw new Error(`'Employee Advances' carries AcctNum ${aNum}, expected 1215 — stop and review`);

  // Re-derive her 1215 activity from live QB.
  const jes = await qbQueryAll<QbJe>(ENTITY, 'JournalEntry', `WHERE TxnDate >= '2025-10-01' AND TxnDate <= '2026-08-25'`);
  let duplicateDr = 0;
  let repaymentCr = 0;
  for (const j of jes) {
    const doc = (j.DocNumber ?? '').trim();
    if (doc === DOC) throw new Error(`a JE with DocNumber '${DOC}' already exists (QB Id ${j.Id}) — already posted?`);
    for (const l of j.Line ?? []) {
      const d = l.JournalEntryLineDetail;
      if (!/^employee advances$/i.test(d?.AccountRef?.name ?? '')) continue;
      if (doc === 'PR 2025.10.24' && d?.PostingType === 'Debit' && /duplicate/i.test(l.Description ?? '')) {
        duplicateDr += l.Amount ?? 0;
      }
      if (/^PR 2026\./.test(doc) && d?.PostingType === 'Credit' && /marketing/i.test(l.Description ?? '')) {
        repaymentCr += l.Amount ?? 0;
      }
    }
  }
  console.log(`  1215 activity, hers: duplicate-payment Dr ${money(duplicateDr)} · posted repayment Cr ${money(repaymentCr)} · residual ${money(duplicateDr - repaymentCr)}`);
  if (Math.abs(duplicateDr - 3169.23) >= 0.005) throw new Error('duplicate-payment Dr is not $3,169.23 — stop and review');
  if (Math.abs(duplicateDr - repaymentCr - AMOUNT) >= 0.005) throw new Error(`residual is not ${money(AMOUNT)} — stop and review`);
  return { withholdingsId, advancesId };
}

async function main(): Promise<void> {
  console.log(`mode=${live ? 'LIVE' : 'DRY-RUN'} — Veronica Denha 1215 clearing JE (${ENTITY})`);
  const { withholdingsId, advancesId } = await preflight();

  const payload: QbJournalEntryPayload = {
    DocNumber: DOC,
    TxnDate: TXN_DATE,
    PrivateNote:
      'Clears V. Denha employee advance (duplicate payment PR 2025.10.24, $3,169.23). ADP ' +
      'withheld COMPANY LOAN repayments Jan-Jul 2026 totaling $3,169.23; the Apr-Jul payroll ' +
      'JEs credited 1215 correctly ($1,669.23), but the Jan-Mar manual PR JEs put the first ' +
      '$1,500 (6 x $250) into 2110 Payroll Withholdings instead. This entry relieves the 2110 ' +
      'excess and clears the remaining 1215 balance. Advance fully repaid per ADP.',
    Line: [
      {
        Amount: AMOUNT,
        DetailType: 'JournalEntryLineDetail',
        Description: 'V. Denha loan repayments Jan-Mar 2026 (6 x $250) withheld to 2110 in manual PR JEs',
        JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: withholdingsId } },
      },
      {
        Amount: AMOUNT,
        DetailType: 'JournalEntryLineDetail',
        Description: 'Clears V. Denha advance balance (PR 2025.10.24 duplicate payment, fully repaid via ADP)',
        JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: advancesId } },
      },
    ],
  };

  console.log(`\n  ${DOC}  ${TXN_DATE}`);
  console.log(`    Dr ${money(AMOUNT)}  Payroll Withholdings (2110)`);
  console.log(`    Cr ${money(AMOUNT)}  Employee Advances (1215)`);

  if (!live) {
    console.log('\nDRY-RUN — nothing posted. Re-run with --live to post.');
    return;
  }
  const response = await qbPost<{ JournalEntry?: { Id?: string; DocNumber?: string } }>(
    ENTITY, 'journalentry?minorversion=75', payload as unknown as JsonValue,
  );
  console.log(`\n  ✅ POSTED ${ENTITY}: ${response.JournalEntry?.DocNumber ?? DOC} — QB JE Id ${response.JournalEntry?.Id ?? '?'}`);
}

void main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
