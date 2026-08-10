/** READ-ONLY: FL's active QB Departments — the exact names FOCAS must match. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
interface QbDept { Id: string; Name: string; FullyQualifiedName?: string; Active?: boolean }
async function main(): Promise<void> {
  const { qbQueryAll } = await import('../../src/lib/quickbooks-multi');
  for (const loc of ['MedRock FL', 'FOCAS'] as const) {
    const d = await qbQueryAll<QbDept>(loc, 'Department', 'WHERE Active = true');
    console.log(`\n${loc} departments (${d.length}):`);
    for (const x of d) console.log(`   id=${x.Id.padEnd(4)} ${x.FullyQualifiedName ?? x.Name}`);
  }
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
