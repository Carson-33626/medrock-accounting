/** READ-ONLY: list QBO accounts whose name matches a regex. npx tsx scripts/_probe-accounts-grep.ts "<regex>" [FL|TN|TX] */
import './payroll/load-env-vercel-first';
import { qbQueryAll } from '../src/lib/quickbooks-multi';
import type { Location } from '../src/lib/quickbooks-multi';

interface Account { Id: string; AcctNum?: string; FullyQualifiedName?: string; AccountType?: string; Active?: boolean }
const LOCS: Record<string, Location> = { FL: 'MedRock FL', TN: 'MedRock TN', TX: 'MedRock TX' };
const [pat, key = 'FL'] = process.argv.slice(2);
async function main(): Promise<void> {
  const re = new RegExp(pat, 'i');
  const accts = await qbQueryAll<Account>(LOCS[key], 'Account', '');
  for (const a of accts) if (re.test(a.FullyQualifiedName ?? '')) console.log(`${a.AcctNum ?? ''}\t${a.FullyQualifiedName}\t${a.AccountType}\t${a.Active === false ? 'INACTIVE' : ''}`);
}
main().catch((e: Error) => { console.error(e.message); process.exit(1); });
