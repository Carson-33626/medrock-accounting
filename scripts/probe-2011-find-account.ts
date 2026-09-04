/** READ-ONLY: find the QB Account Id for 2011 Accrued Expenses (and 2115) in MedRock FL. */
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
  Active?: boolean;
}

async function main(): Promise<void> {
  const { qbQueryAll } = await import('../src/lib/quickbooks-multi');
  const accounts = await qbQueryAll<QbAccount>('MedRock FL' as never, 'Account', '');
  console.log(`Total accounts: ${accounts.length}`);
  const matches = accounts.filter(
    (a) =>
      (a.AcctNum && (a.AcctNum.includes('2011') || a.AcctNum.includes('2115'))) ||
      (a.Name && /accrued/i.test(a.Name)),
  );
  for (const a of matches) {
    console.log(
      `Id=${a.Id}  AcctNum=${a.AcctNum ?? '-'}  Name="${a.Name}"  Type=${a.AccountType}/${a.AccountSubType}  Balance=${a.CurrentBalance}  Active=${a.Active}`,
    );
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
