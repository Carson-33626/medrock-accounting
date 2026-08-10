/**
 * READ-ONLY: pull Ramp's Bill Pay vendor directory (GET /vendors) for FL/TN/TX
 * for the W9 collection push. Grounded schema (2026-08-05 field dump): records
 * carry NO emails at this scope (contacts:[] everywhere) but DO carry
 * `federal_tax_classification` (Ramp-side W9 data), `name_legal`, category and
 * spend totals. Also probes GET /vendors/{id}/contacts on a sample to check
 * whether contact emails live behind a subresource. Emits a deduped CSV.
 *   npx tsx scripts/probe-ramp-vendors-w9.ts
 */
import '../lib/load-env';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rampGet, rampToken } from '../lib/ramp';
import { ALL_ENTITIES } from '../lib/entities';
import type { Entity } from '../lib/entities';

interface Money { amount?: number }
interface RampVendor {
  id?: string;
  name?: string;
  name_legal?: string | null;
  is_active?: boolean;
  status?: string | null;
  sk_category_name?: string | null;
  federal_tax_classification?: string | null;
  tax_address?: unknown;
  contacts?: unknown[];
  total_spend_all_time?: Money;
  total_spend_last_365_days?: Money;
}
interface VendorPage { data?: RampVendor[]; page?: { next?: string | null } }

interface Row {
  name: string;
  nameLegal: string;
  entities: Set<string>;
  category: string;
  taxClassification: string;
  hasTaxAddress: boolean;
  contactsCount: number;
  active: boolean;
  spendAllTimeCents: number;
  spend365Cents: number;
  ids: Set<string>;
}

const csvEscape = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

async function tokenFor(entity: Entity): Promise<string | null> {
  for (const scope of ['vendors:read', 'bills:read vendors:read', 'bills:read']) {
    try {
      return await rampToken(entity, scope);
    } catch {
      continue;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const merged = new Map<string, Row>();
  const sampleIds: Array<{ entity: Entity; id: string; token: string }> = [];

  for (const entity of ALL_ENTITIES) {
    const token = await tokenFor(entity);
    if (token === null) {
      console.log(`[${entity}] no token — skipped`);
      continue;
    }
    let url: string | null = '/vendors?page_size=100';
    let total = 0;
    for (let i = 0; i < 50 && url !== null; i++) {
      const res: { status: number; body: VendorPage } = await rampGet<VendorPage>(entity, url, token);
      if (res.status !== 200) {
        console.log(`[${entity}] GET ${url} -> HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
        break;
      }
      const rows = res.body.data ?? [];
      for (const v of rows) {
        total += 1;
        const name = (v.name ?? '').trim();
        if (!name) continue;
        if (v.id && sampleIds.length < 3 && (v.contacts?.length ?? 0) === 0) sampleIds.push({ entity, id: v.id, token });
        const key = name.toLowerCase().replace(/\s+-\s+(autopay|auto ?ach|ach( ramp)?|ramp ach|auto pay)$/i, '').replace(/[^a-z0-9]+/g, ' ').trim();
        let row = merged.get(key);
        if (!row) {
          row = {
            name, nameLegal: '', entities: new Set(), category: '', taxClassification: '',
            hasTaxAddress: false, contactsCount: 0, active: false, spendAllTimeCents: 0, spend365Cents: 0, ids: new Set(),
          };
          merged.set(key, row);
        }
        row.entities.add(entity);
        row.active = row.active || v.is_active !== false;
        if (v.id) row.ids.add(v.id);
        if (!row.nameLegal && v.name_legal) row.nameLegal = v.name_legal;
        if (!row.category && v.sk_category_name) row.category = v.sk_category_name;
        if (!row.taxClassification && v.federal_tax_classification) row.taxClassification = v.federal_tax_classification;
        row.hasTaxAddress = row.hasTaxAddress || (v.tax_address !== null && v.tax_address !== undefined);
        row.contactsCount += v.contacts?.length ?? 0;
        row.spendAllTimeCents += v.total_spend_all_time?.amount ?? 0;
        row.spend365Cents += v.total_spend_last_365_days?.amount ?? 0;
      }
      if (rows.length === 0) break;
      url = res.body.page?.next ?? null;
    }
    console.log(`[${entity}] vendors=${total}`);
  }

  // Does a contacts subresource exist?
  console.log(`\n=== GET /vendors/{id}/contacts sample probe ===`);
  for (const s of sampleIds) {
    const res = await rampGet<unknown>(s.entity, `/vendors/${s.id}/contacts`, s.token);
    console.log(`  [${s.entity}] ${s.id} -> HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  }

  const rows = [...merged.values()].sort((a, b) => b.spendAllTimeCents - a.spendAllTimeCents);
  const lines = ['vendor,legal_name,entities,category,federal_tax_classification,tax_address_on_file,contacts,active,spend_all_time,spend_365d,ramp_vendor_uuids'];
  for (const r of rows) {
    lines.push([
      csvEscape(r.name), csvEscape(r.nameLegal), [...r.entities].join('|'), csvEscape(r.category),
      csvEscape(r.taxClassification), r.hasTaxAddress ? 'YES' : '', String(r.contactsCount),
      r.active ? 'yes' : 'inactive', (r.spendAllTimeCents / 100).toFixed(2), (r.spend365Cents / 100).toFixed(2),
      [...r.ids].join('|'),
    ].join(','));
  }
  const out = resolve(__dirname, '..', 'out', 'ramp-vendors-w9.csv');
  writeFileSync(out, lines.join('\n'), 'utf-8');

  console.log(`\n================ MERGED ================`);
  console.log(`  distinct Ramp bill-pay vendors: ${rows.length}`);
  console.log(`  with federal_tax_classification (Ramp-side W9 data): ${rows.filter((r) => r.taxClassification).length}`);
  console.log(`  with tax_address: ${rows.filter((r) => r.hasTaxAddress).length}`);
  console.log(`  with any contact record: ${rows.filter((r) => r.contactsCount > 0).length}`);
  console.log(`  spend >= $600 all-time: ${rows.filter((r) => r.spendAllTimeCents >= 60000).length}`);
  console.log(`\n  top 20 by all-time spend:`);
  for (const r of rows.slice(0, 20)) {
    console.log(`    ${r.name.padEnd(45)} $${(r.spendAllTimeCents / 100).toFixed(2).padStart(12)}  taxClass=${r.taxClassification || '-'}  [${[...r.entities].join('|')}]`);
  }
  console.log(`\nCSV written: ${out}`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
