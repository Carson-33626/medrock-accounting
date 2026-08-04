// Why: the live FL pilot's draft-bill create returned HTTP 422
// {"vendor_id":["Not a valid UUID."]} — LETCO_RAMP_VENDOR_{FL,TN,TX} in web/.env.local hold 52/41/78,
// which came from /accounting/vendors (the ACCOUNTING-provider vendor ids, i.e. the QBO ids), not the
// Bill Pay vendor UUIDs the Bills API wants. This probe finds the right UUID two independent ways:
//   (1) GET /vendors  — Ramp's Bill Pay vendor directory
//   (2) the vendor_id already carried by real Letco bills Ramp holds (invoice numbers start "C335-")
// READ-ONLY.
//   npx tsx scripts/receipt-capture/_probe-billpay-vendor-id.ts
import '../ramp-split-push/load-env';
import { rampGet, rampToken } from '../ramp-split-push/ramp-client';
import { ALL_ENTITIES } from '../ramp-split-push/types';
import type { Entity } from '../ramp-split-push/types';

interface BillPayVendor { id?: string; business_name?: string; name?: string; is_active?: boolean }
interface VendorPage { data?: BillPayVendor[]; page?: { next?: string | null } }

interface BillVendorRef { id?: string; remote_id?: string; remote_name?: string; business_name?: string }
interface BillRaw { id: string; invoice_number?: string | null; vendor?: BillVendorRef; vendor_id?: string }
interface BillsPage { data?: BillRaw[]; page?: { next?: string | null } }

function nameOf(v: BillPayVendor): string {
  return v.business_name ?? v.name ?? '(unnamed)';
}

async function tokenFor(entity: Entity, scopes: string[]): Promise<{ token: string; scope: string } | null> {
  for (const scope of scopes) {
    try {
      const token = await rampToken(entity, scope);
      return { token, scope };
    } catch {
      continue;
    }
  }
  return null;
}

async function probeVendorDirectory(entity: Entity): Promise<void> {
  const auth = await tokenFor(entity, ['vendors:read', 'bills:read vendors:read', 'bills:read']);
  if (auth === null) {
    console.log(`[${entity}] no token minted for any vendor scope`);
    return;
  }
  let url: string | null = '/vendors?page_size=100';
  const hits: BillPayVendor[] = [];
  let total = 0;
  for (let i = 0; i < 30 && url !== null; i++) {
    const res: { status: number; body: VendorPage } = await rampGet<VendorPage>(entity, url, auth.token);
    if (res.status !== 200) {
      console.log(`[${entity}] GET ${url} -> HTTP ${res.status} (scope "${auth.scope}") ${JSON.stringify(res.body).slice(0, 200)}`);
      return;
    }
    const rows = res.body.data ?? [];
    total += rows.length;
    for (const v of rows) if (/letco|fagron/i.test(nameOf(v))) hits.push(v);
    if (rows.length === 0) break;
    url = res.body.page?.next ?? null;
  }
  console.log(`[${entity}] /vendors scanned=${total} (scope "${auth.scope}") letco/fagron matches=${hits.length}`);
  for (const v of hits) console.log(`   id=${v.id ?? '?'}  active=${v.is_active ?? '?'}  "${nameOf(v)}"`);
}

async function probeExistingBills(entity: Entity): Promise<void> {
  const auth = await tokenFor(entity, ['bills:read']);
  if (auth === null) {
    console.log(`[${entity}] no bills:read token`);
    return;
  }
  let url: string | null = '/bills?page_size=100';
  const seen = new Map<string, { count: number; name: string; sample: string }>();
  for (let i = 0; i < 30 && url !== null; i++) {
    const res: { status: number; body: BillsPage } = await rampGet<BillsPage>(entity, url, auth.token);
    if (res.status !== 200) break;
    const rows = res.body.data ?? [];
    for (const b of rows) {
      const inv = (b.invoice_number ?? '').trim();
      if (!/^C335-/i.test(inv)) continue;
      const vid = b.vendor?.id ?? b.vendor_id ?? '(no vendor id on bill)';
      const name = b.vendor?.business_name ?? b.vendor?.remote_name ?? '(unnamed)';
      const prev = seen.get(vid);
      seen.set(vid, { count: (prev?.count ?? 0) + 1, name, sample: prev?.sample ?? inv });
    }
    if (rows.length === 0) break;
    url = res.body.page?.next ?? null;
  }
  if (seen.size === 0) {
    console.log(`[${entity}] no existing Ramp bills with a C335-* invoice number`);
    return;
  }
  for (const [vid, info] of seen) {
    console.log(`[${entity}] existing-bill vendor id=${vid} bills=${info.count} "${info.name}" (e.g. ${info.sample})`);
  }
}

async function main(): Promise<void> {
  console.log('=== Bill Pay vendor directory (/vendors) ===');
  for (const entity of ALL_ENTITIES) await probeVendorDirectory(entity);
  console.log('\n=== vendor_id on Ramp bills Ramp already holds for Letco (invoice C335-*) ===');
  for (const entity of ALL_ENTITIES) await probeExistingBills(entity);
  console.log('\ncurrent env values (these are what returned 422):');
  for (const entity of ALL_ENTITIES) console.log(`   LETCO_RAMP_VENDOR_${entity}=${process.env[`LETCO_RAMP_VENDOR_${entity}`] ?? '(unset)'}`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
