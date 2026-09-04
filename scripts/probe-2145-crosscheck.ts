/** READ-ONLY: BillPayment 47903 detail (FL) + check TN/TX for an equivalent "Due to Medisca" account/pattern. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');

  console.log('=== FL: BillPayment 47903 (linked from VendorCredit 04045193) ===');
  const flPayments = await qbQueryAll<Record<string, unknown>>('MedRock FL' as never, 'BillPayment', "WHERE TxnDate >= '2025-12-01' AND TxnDate <= '2026-01-05'");
  const bp = flPayments.find((p) => p.Id === '47903');
  console.log(JSON.stringify(bp, null, 2));

  for (const loc of ['MedRock TN', 'MedRock TX'] as const) {
    console.log(`\n=== ${loc}: accounts matching "Medisca" ===`);
    try {
      const accounts = await qbQueryAll<{ Id?: string; Name?: string; AccountType?: string; CurrentBalance?: number }>(
        loc as never, 'Account', "WHERE Name LIKE '%Medisca%'",
      );
      for (const a of accounts) {
        console.log(`  Id=${a.Id}  Name="${a.Name}"  Type=${a.AccountType}  Balance=${a.CurrentBalance}`);
      }
      if (accounts.length === 0) console.log('  (none found)');

      console.log(`=== ${loc}: vendors matching "Medisca" ===`);
      const vendors = await qbQueryAll<{ Id?: string; DisplayName?: string; Balance?: number }>(
        loc as never, 'Vendor', "WHERE DisplayName LIKE '%Medisca%'",
      );
      for (const v of vendors) console.log(`  Id=${v.Id}  DisplayName="${v.DisplayName}"  Balance=${v.Balance}`);

      // If an account exists, check for Purchase-entity autopay pattern
      const acct = accounts.find((a) => a.Name?.includes('Due to Medisca'));
      if (acct) {
        const purchases = await qbQueryAll<Record<string, unknown>>(loc as never, 'Purchase', "WHERE TxnDate >= '2024-01-01'");
        const hits = purchases.filter((p) => {
          const lines = (p.Line as Array<Record<string, unknown>> | undefined) ?? [];
          return lines.some((l) => {
            const detail = l.AccountBasedExpenseLineDetail as { AccountRef?: { value?: string } } | undefined;
            return detail?.AccountRef?.value === acct.Id;
          });
        });
        console.log(`  Purchase-entity hits against ${acct.Name}: ${hits.length}`);
        for (const h of hits.slice(0, 15)) {
          console.log(`    ${h.TxnDate}  Id=${h.Id}  Total=${h.TotalAmt}  note=${(h.PrivateNote as string ?? '').slice(0, 60)}`);
        }
      }
    } catch (e) {
      console.log(`  ERROR for ${loc}:`, e instanceof Error ? e.message : e);
    }
  }
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
