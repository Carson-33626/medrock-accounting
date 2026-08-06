/**
 * READ-ONLY: pull the full QBO Vendor list for FL/TN/TX and classify for the
 * W9 collection push (Barbara 7/20 item h). Captures the QBO 1099-tracking flag
 * (Vendor1099), whether a Tax ID is on file (TaxIdentifier is masked by QBO but
 * presence/absence still tells us if a W9 was ever keyed in), email, phone,
 * balance and activity. Emits a per-entity dump + a deduped cross-entity CSV.
 *   npx tsx scripts/probe-vendors-w9.ts
 * QB creds from .env.vercel (the .env.local QB client id is wrong).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envText = readFileSync(resolve(__dirname, '..', '..', '.env.vercel'), 'utf-8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

interface QbVendor {
  Id?: string;
  DisplayName?: string;
  CompanyName?: string;
  GivenName?: string;
  FamilyName?: string;
  Active?: boolean;
  Vendor1099?: boolean;
  TaxIdentifier?: string;
  Balance?: number;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  WebAddr?: { URI?: string };
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
}

interface Row {
  name: string;
  entities: Set<string>;
  flagged1099: boolean;
  taxIdOnFile: boolean;
  email: string;
  phone: string;
  active: boolean;
  balance: number;
  lastUpdated: string;
}

const csvEscape = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

async function main(): Promise<void> {
  const { qbQueryAll, getConnectionStatus } = await import('../../src/lib/quickbooks-multi');
  const status = await getConnectionStatus();
  const locations = (Object.keys(status) as Array<keyof typeof status>).filter((l) => status[l]);
  console.log(`Connected companies: ${locations.join(', ')}`);

  const merged = new Map<string, Row>();

  for (const location of locations) {
    const vendors = await qbQueryAll<QbVendor>(location, 'Vendor', '');
    const active = vendors.filter((v) => v.Active !== false);
    const flagged = active.filter((v) => v.Vendor1099 === true);
    const withTaxId = active.filter((v) => (v.TaxIdentifier ?? '') !== '');
    const withEmail = active.filter((v) => (v.PrimaryEmailAddr?.Address ?? '') !== '');
    console.log(`\n================ ${location} ================`);
    console.log(`  vendors: ${vendors.length} total, ${active.length} active`);
    console.log(`  1099-flagged: ${flagged.length}   tax-ID on file: ${withTaxId.length}   with email: ${withEmail.length}`);
    if (flagged.length) {
      console.log(`  1099-flagged vendors:`);
      for (const v of flagged) {
        console.log(`    ${v.DisplayName}  email=${v.PrimaryEmailAddr?.Address ?? '-'}  taxId=${v.TaxIdentifier ? 'ON FILE' : 'MISSING'}`);
      }
    }

    for (const v of vendors) {
      const name = (v.DisplayName ?? v.CompanyName ?? '').trim();
      if (!name) continue;
      const key = name.toLowerCase().replace(/\s+-\s+autopay$/i, '').replace(/[^a-z0-9]+/g, ' ').trim();
      let row = merged.get(key);
      if (!row) {
        row = {
          name, entities: new Set(), flagged1099: false, taxIdOnFile: false,
          email: '', phone: '', active: false, balance: 0, lastUpdated: '',
        };
        merged.set(key, row);
      }
      row.entities.add(location);
      row.flagged1099 = row.flagged1099 || v.Vendor1099 === true;
      row.taxIdOnFile = row.taxIdOnFile || (v.TaxIdentifier ?? '') !== '';
      if (!row.email && v.PrimaryEmailAddr?.Address) row.email = v.PrimaryEmailAddr.Address;
      if (!row.phone && v.PrimaryPhone?.FreeFormNumber) row.phone = v.PrimaryPhone.FreeFormNumber;
      row.active = row.active || v.Active !== false;
      row.balance += v.Balance ?? 0;
      const upd = v.MetaData?.LastUpdatedTime?.slice(0, 10) ?? '';
      if (upd > row.lastUpdated) row.lastUpdated = upd;
    }
  }

  const rows = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  const lines = ['vendor,entities,flagged_1099,tax_id_on_file,email,phone,active,open_balance,last_updated'];
  for (const r of rows) {
    lines.push([
      csvEscape(r.name), [...r.entities].join('|'), r.flagged1099 ? 'YES' : '', r.taxIdOnFile ? 'YES' : '',
      csvEscape(r.email), csvEscape(r.phone), r.active ? 'yes' : 'inactive', r.balance.toFixed(2), r.lastUpdated,
    ].join(','));
  }
  const out = resolve(__dirname, '..', 'out', 'qbo-vendors-w9.csv');
  writeFileSync(out, lines.join('\n'), 'utf-8');

  const activeRows = rows.filter((r) => r.active);
  console.log(`\n================ MERGED ================`);
  console.log(`  distinct vendors (all entities): ${rows.length}  (active: ${activeRows.length})`);
  console.log(`  1099-flagged: ${activeRows.filter((r) => r.flagged1099).length}`);
  console.log(`  tax ID on file: ${activeRows.filter((r) => r.taxIdOnFile).length}`);
  console.log(`  with email: ${activeRows.filter((r) => r.email).length}`);
  console.log(`  W9 gap (active, NO tax id on file): ${activeRows.filter((r) => !r.taxIdOnFile).length}`);
  console.log(`\nCSV written: ${out}`);
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
