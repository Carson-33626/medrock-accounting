/** READ-ONLY: full raw JSON for the 10 txns found touching "Due to Medisca" (Id=248), MedRock FL. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const LOC = 'MedRock FL' as never;

  const purchaseDocs = ['47115', '48257', '49215', '50244', '50449', '51229', '51343', '52035'];
  const purchases = await qbQueryAll<{ DocNumber?: string; [k: string]: unknown }>(LOC, 'Purchase', "WHERE TxnDate >= '2025-12-01'");
  console.log('=== PURCHASE full detail ===');
  for (const doc of purchaseDocs) {
    const p = purchases.find((x) => x.DocNumber === doc);
    console.log(`\n--- Purchase #${doc} ---`);
    console.log(JSON.stringify(p, null, 2));
  }

  const credits = await qbQueryAll<{ DocNumber?: string; [k: string]: unknown }>(LOC, 'VendorCredit', "WHERE TxnDate >= '2025-12-01'");
  console.log('\n=== VENDORCREDIT full detail ===');
  const vc = credits.find((x) => x.DocNumber === '04045193');
  console.log(JSON.stringify(vc, null, 2));

  // Also pull vendor detail for both Medisca vendor records
  const vendors = await qbQueryAll<{ Id?: string; DisplayName?: string; [k: string]: unknown }>(LOC, 'Vendor', "WHERE DisplayName LIKE '%Medisca%'");
  console.log('\n=== VENDOR records ===');
  for (const v of vendors) console.log(JSON.stringify(v, null, 2));

  // Open AP balance for Medisca-family vendors (trade AP account) via Bill query
  console.log('\n=== Open Bills for any Medisca-named vendor (trade AP check) ===');
  const bills = await qbQueryAll<{ DocNumber?: string; VendorRef?: { name?: string }; Balance?: number; TotalAmt?: number; TxnDate?: string }>(
    LOC, 'Bill', "WHERE TxnDate >= '2024-01-01'",
  );
  const medBills = bills.filter((b) => (b.VendorRef?.name ?? '').toLowerCase().includes('medisca'));
  console.log(`Total Medisca-vendor bills since 2024-01-01: ${medBills.length}`);
  const openBills = medBills.filter((b) => (b.Balance ?? 0) > 0);
  console.log(`Open (unpaid) Medisca bills: ${openBills.length}`);
  let openTotal = 0;
  for (const b of openBills) {
    openTotal += b.Balance ?? 0;
    console.log(`  ${b.TxnDate}  #${b.DocNumber}  vendor="${b.VendorRef?.name}"  Total=${b.TotalAmt}  Balance=${b.Balance}`);
  }
  console.log(`Open AP total (Medisca vendors): ${openTotal.toFixed(2)}`);
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
