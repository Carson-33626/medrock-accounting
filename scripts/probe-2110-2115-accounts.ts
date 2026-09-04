/** READ-ONLY: find Account records for 2110/2115 (and Aetna/medical clearing candidates) in MedRock FL, with CurrentBalance. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface QbAccount {
  Id?: string;
  Name?: string;
  AcctNum?: string;
  AccountType?: string;
  AccountSubType?: string;
  CurrentBalance?: number;
  Classification?: string;
  Active?: boolean;
}

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const accounts = await qbQueryAll<QbAccount>('MedRock FL' as never, 'Account', 'WHERE Classification = \'Liability\'');
  console.log(`\n===== MedRock FL — ALL Liability accounts (${accounts.length}) =====`);
  for (const a of accounts.sort((x, y) => (x.AcctNum ?? x.Name ?? '').localeCompare(y.AcctNum ?? y.Name ?? ''))) {
    console.log(
      `  Id=${a.Id?.padStart(4)}  ${(a.AcctNum ?? '').padEnd(8)} ${(a.Name ?? '').padEnd(45)} type=${a.AccountType}/${a.AccountSubType}  bal=${(a.CurrentBalance ?? 0).toFixed(2)}  active=${a.Active}`,
    );
  }

  // Also grab all accounts (any classification) with names hinting at Aetna/medical/insurance clearing.
  const all = await qbQueryAll<QbAccount>('MedRock FL' as never, 'Account', '');
  console.log(`\n===== MedRock FL — accounts matching Aetna/Medical/Insurance/Health/Clearing (${all.length} total accounts scanned) =====`);
  for (const a of all) {
    const n = (a.Name ?? '').toLowerCase();
    if (/(aetna|medical|insurance|health|clearing)/.test(n)) {
      console.log(
        `  Id=${a.Id?.padStart(4)}  ${(a.AcctNum ?? '').padEnd(8)} ${(a.Name ?? '').padEnd(45)} type=${a.AccountType}/${a.AccountSubType}  bal=${(a.CurrentBalance ?? 0).toFixed(2)}  active=${a.Active}`,
      );
    }
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
