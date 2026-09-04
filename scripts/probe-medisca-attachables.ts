/** READ-ONLY: pull every attachment on the Medisca vendor profile (and on Medisca-referencing
 *  bills / vendor credits / bill payments) in FL, TN and TX. Kristina (2026-08-27) says the
 *  Medisca statements and 2145 backup are uploaded there.
 *
 *  Downloads go to the session scratchpad. GETs only. Untracked scratch.
 *    npx tsx scripts/probe-medisca-attachables.ts
 */
import './payroll/load-env-vercel-first';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getValidTokens, qbQueryAll } from '../src/lib/quickbooks-multi';
import type { Location } from '../src/lib/quickbooks-multi';

const OUT_ROOT =
  'C:/Users/Carson.D/AppData/Local/Temp/claude/C--Users-Carson-D-Documents-GitHub-Active-Development-Accounting-Analytics/86372a4b-bf3b-4d0b-a45d-84dc04c3885a/scratchpad/medisca/qbo';

const QB_API_BASE = process.env.QB_ENVIRONMENT === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com/v3'
  : 'https://quickbooks.api.intuit.com/v3';

interface QbRef { value?: string; name?: string; type?: string }
interface QbVendor { Id: string; DisplayName: string; Balance?: number }
interface QbAttachable {
  Id: string;
  FileName?: string;
  ContentType?: string;
  Size?: number;
  Note?: string;
  Tag?: string;
  FileAccessUri?: string;
  TempDownloadUri?: string;
  AttachableRef?: Array<{ EntityRef?: QbRef }>;
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
}
interface QbVendorTxn { Id: string; TxnDate?: string; DocNumber?: string; TotalAmt?: number; VendorRef?: QbRef; PrivateNote?: string }

interface Downloaded {
  readonly location: Location;
  readonly attachableId: string;
  readonly fileName: string;
  readonly size: number;
  readonly created: string;
  readonly linkedTo: readonly string[];
  readonly note: string;
  readonly savedPath: string | null;
  readonly error: string | null;
}

const LOCATIONS: readonly Location[] = ['MedRock TX', 'MedRock TN', 'MedRock FL'];

async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (err) { last = err; console.log(`  retry ${i + 1}/${tries} ${label}: ${err instanceof Error ? err.message : String(err)}`); await new Promise((r) => setTimeout(r, 3000 * (i + 1))); }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function download(url: string, bearer: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}`, Accept: '*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main(): Promise<void> {
  const all: Downloaded[] = [];
  for (const location of LOCATIONS) {
    console.log(`\n=== ${location} ===`);
    const tokens = await getValidTokens(location);
    if (!tokens) { console.log('  no tokens — skipped'); continue; }
    const realm = tokens.realm_id;
    const bearer = tokens.access_token;

    const vendors = await withRetry('Vendor', () => qbQueryAll<QbVendor>(location, 'Vendor', `WHERE DisplayName LIKE 'Medisca%'`));
    console.log(`  vendors: ${vendors.map((v) => `#${v.Id} ${v.DisplayName} (bal ${v.Balance ?? '?'})`).join(' | ') || '(none)'}`);
    const vendorIds = new Set(vendors.map((v) => v.Id));
    if (vendorIds.size === 0) continue;

    // Medisca-owned transaction ids, so attachments hanging off a Bill/VendorCredit/BillPayment count too.
    const txnIds = new Map<string, string>();
    for (const entityType of ['Bill', 'VendorCredit', 'BillPayment', 'Purchase'] as const) {
      let rows: QbVendorTxn[] = [];
      try { rows = await withRetry(entityType, () => qbQueryAll<QbVendorTxn>(location, entityType, '')); }
      catch (err) { console.log(`  ${entityType}: query failed ${err instanceof Error ? err.message : String(err)}`); continue; }
      let n = 0;
      for (const r of rows) {
        if (r.VendorRef?.value && vendorIds.has(r.VendorRef.value)) { txnIds.set(`${entityType}:${r.Id}`, `${entityType} ${r.DocNumber ?? r.Id} ${r.TxnDate ?? ''} $${r.TotalAmt ?? '?'}`); n++; }
      }
      console.log(`  ${entityType}: ${rows.length} total, ${n} Medisca`);
    }

    const atts = await withRetry('Attachable', () => qbQueryAll<QbAttachable>(location, 'Attachable', ''));
    console.log(`  Attachable records in company: ${atts.length}`);
    const outDir = join(OUT_ROOT, location.replace(/\s+/g, '_'));
    mkdirSync(outDir, { recursive: true });

    for (const a of atts) {
      const linked: string[] = [];
      for (const ref of a.AttachableRef ?? []) {
        const t = ref.EntityRef?.type ?? '';
        const v = ref.EntityRef?.value ?? '';
        if (t === 'Vendor' && vendorIds.has(v)) linked.push(`Vendor ${v}`);
        const key = `${t}:${v}`;
        if (txnIds.has(key)) linked.push(txnIds.get(key) as string);
      }
      const nameHit = /medisca/i.test(`${a.FileName ?? ''} ${a.Note ?? ''} ${a.Tag ?? ''}`);
      if (linked.length === 0 && !nameHit) continue;

      const fileName = a.FileName ?? `attachable-${a.Id}`;
      let savedPath: string | null = null;
      let error: string | null = null;
      if (a.FileName && a.Size) {
        try {
          const bytes = await download(`${QB_API_BASE}/company/${realm}/download/${a.Id}?minorversion=75`, bearer);
          // The download endpoint may answer with a pre-signed URL rather than bytes.
          const asText = bytes.subarray(0, 8).toString('latin1');
          const payload = asText.startsWith('http') ? await download(bytes.toString('utf8').trim(), bearer) : bytes;
          savedPath = join(outDir, `${a.Id}-${fileName.replace(/[^\w.\-]+/g, '_')}`);
          writeFileSync(savedPath, payload);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      } else {
        error = `LINK only (no stored file): ${a.Note ?? a.Tag ?? ''}`;
      }
      const rec: Downloaded = {
        location, attachableId: a.Id, fileName, size: a.Size ?? 0,
        created: a.MetaData?.CreateTime ?? '', linkedTo: linked, note: a.Note ?? '', savedPath, error,
      };
      all.push(rec);
      console.log(`  #${a.Id} ${fileName} ${a.Size ?? 0}B created ${rec.created.slice(0, 10)} -> ${linked.join('; ') || '(name match only)'} ${savedPath ? 'SAVED' : `!! ${error}`}`);
    }
  }
  mkdirSync(OUT_ROOT, { recursive: true });
  writeFileSync(join(OUT_ROOT, '_index.json'), JSON.stringify(all, null, 2));
  console.log(`\n${all.length} Medisca attachment record(s) -> ${join(OUT_ROOT, '_index.json')}`);
  process.exit(0);
}

void main().catch((err) => { console.error(err); process.exit(1); });
