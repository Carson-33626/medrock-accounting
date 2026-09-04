/**
 * READ-ONLY probe: reconcile three device rows against what the classifier actually does.
 *
 *   1. Eye Pad Pack  — which fills attach it, at what companion multiplier, small vs large.
 *   2. Syringes      — rule 9 (DRYNESS V) vs rule 26 (any small topical), and their unit maths.
 *   3. Tret Pump     — which items route there, and which TRET items route somewhere else.
 *
 * Imports the loader's own ruleset so the classification here is production's classification.
 * Run from web/:  npx tsx scripts/_probe-three-device-rows.ts
 */
import '../lib/load-env';
import { getRdsPool } from '../../src/lib/rds';
import {
  classifyDeviceRule,
  deriveForm,
  deriveQty,
  resolveCompanion,
  resolveDevice,
} from '../../../../MedRock-Data-Loader/powerbi-sqlite/src/transforms/fifo/devices';

interface FillRow {
  item: string | null;
  qty: string | null;
  location: string | null;
  month: string | null;
  fills: number;
}

const FILLS_SQL = `
  WITH d2 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Date Filled' AS filled,
           row_data->>'Dispensed Item Name' AS item
    FROM source."lifefile_data_2" ORDER BY row_data->>'ID', id ASC
  ),
  d1 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Location' AS location
    FROM source."lifefile_data_1" ORDER BY row_data->>'ID', id ASC
  ),
  d4 AS (
    SELECT DISTINCT ON (row_data->>'ID') row_data->>'ID' AS id,
           row_data->>'Label Type' AS label,
           row_data->>'Dispensed Quantity' AS qty
    FROM source."lifefile_data_4" ORDER BY row_data->>'ID', id ASC
  )
  SELECT d2.item,
         d4.qty,
         CASE WHEN position('TN' in upper(coalesce(d1.location,''))) > 0 THEN 'FL/TN/TX:TN'
              WHEN position('FL' in upper(coalesce(d1.location,''))) > 0 THEN 'FL/TN/TX:FL'
              WHEN position('TX' in upper(coalesce(d1.location,''))) > 0 THEN 'FL/TN/TX:TX'
              ELSE '' END AS location,
         to_char(NULLIF(d2.filled,'')::timestamp, 'YYYY-MM') AS month,
         count(*)::int AS fills
  FROM d2 JOIN d1 ON d1.id = d2.id JOIN d4 ON d4.id = d2.id
  WHERE trim(coalesce(d4.label,'')) = 'Compound'
    AND NULLIF(d2.filled,'') IS NOT NULL
    AND to_char(NULLIF(d2.filled,'')::timestamp, 'YYYY-MM') >= $1
  GROUP BY 1, 2, 3, 4`;

interface Bucket {
  fills: number;
  units: number;
  smallFills: number;
  largeFills: number;
  items: Map<string, { fills: number; qtys: Set<number> }>;
}

function bucket(): Bucket {
  return { fills: 0, units: 0, smallFills: 0, largeFills: 0, items: new Map() };
}

function note(b: Bucket, item: string, qty: number | null, fills: number, units: number): void {
  b.fills += fills;
  b.units += units;
  if (qty !== null && qty <= 15) b.smallFills += fills;
  else b.largeFills += fills;
  const e = b.items.get(item) ?? { fills: 0, qtys: new Set<number>() };
  e.fills += fills;
  if (qty !== null) e.qtys.add(qty);
  b.items.set(item, e);
}

function topItems(b: Bucket, n: number): string[] {
  return [...b.items.entries()]
    .sort((a, c) => c[1].fills - a[1].fills)
    .slice(0, n)
    .map(([name, e]) => {
      const qs = [...e.qtys].sort((x, y) => x - y);
      const qtxt = qs.length <= 6 ? qs.join('/') : `${qs[0]}..${qs[qs.length - 1]} (${qs.length} distinct)`;
      return `    ${String(e.fills).padStart(6)}  ${name}   [qty ${qtxt}]`;
    });
}

async function main(): Promise<void> {
  const pool = getRdsPool();
  const { rows } = await pool.query<FillRow>(FILLS_SQL, ['2026-01']);

  // ---- 1. Eye Pad Pack (companion of rule 12) ---------------------------------
  const eyePad = bucket();
  // Every compound item whose name mentions EYE, and where the classifier sends it.
  const eyeNamed = new Map<string, { fills: number; rule: number; device: string; companion: string }>();

  // ---- 2. Syringes ------------------------------------------------------------
  const syr9 = bucket();
  const syr26 = bucket();

  // ---- 3. Tret Pump -----------------------------------------------------------
  const tret20 = bucket();
  const tret45 = bucket();
  const tretNamed = new Map<string, { fills: number; rule: number; device: string }>();

  // Company-wide totals for context.
  let totalFills = 0;
  let unmapped = 0;
  const perLocEyePad = new Map<string, number>();
  const perLocSyr = new Map<string, number>();
  const perLocTret = new Map<string, number>();

  for (const r of rows) {
    const loc = (r.location ?? '').replace('FL/TN/TX:', '');
    if (loc === '') continue;
    const item = r.item ?? '';
    const qty = deriveQty(r.qty);
    const ruleId = classifyDeviceRule(item, deriveForm(item), qty);
    const res = resolveDevice(ruleId, qty);
    totalFills += r.fills;
    if (res.device === 'Unmapped') { unmapped += r.fills; continue; }

    const comp = resolveCompanion(ruleId, qty);
    const nameU = item.toUpperCase();

    if (nameU.includes('EYE')) {
      const e = eyeNamed.get(item) ?? {
        fills: 0, rule: ruleId, device: `${res.device} ${res.sku}`.trim(),
        companion: comp === null ? '-' : `${comp.device} x${comp.unitsPerFill}`,
      };
      e.fills += r.fills;
      eyeNamed.set(item, e);
    }
    if (nameU.includes('TRET')) {
      const e = tretNamed.get(item) ?? { fills: 0, rule: ruleId, device: `${res.device} ${res.sku}`.trim() };
      e.fills += r.fills;
      tretNamed.set(item, e);
    }

    if (comp !== null && comp.device === 'Eye Pad Pack') {
      note(eyePad, item, qty, r.fills, comp.unitsPerFill * r.fills);
      perLocEyePad.set(loc, (perLocEyePad.get(loc) ?? 0) + comp.unitsPerFill * r.fills);
    }
    if (res.device === 'Syringes') {
      const b = ruleId === 9 ? syr9 : syr26;
      note(b, item, qty, r.fills, res.unitsPerFill * r.fills);
      perLocSyr.set(loc, (perLocSyr.get(loc) ?? 0) + res.unitsPerFill * r.fills);
    }
    if (res.device === 'Tret Pump') {
      const b = res.sku === '20g' ? tret20 : tret45;
      note(b, item, qty, r.fills, res.unitsPerFill * r.fills);
      perLocTret.set(loc, (perLocTret.get(loc) ?? 0) + res.unitsPerFill * r.fills);
    }
  }

  const out: string[] = [];
  out.push(`ALL compound fills 2026-01..now: ${totalFills}  (unmapped ${unmapped})`);

  out.push('');
  out.push('=== 1. EYE PAD PACK (companion on rule 12: EYE-FRESH / EYE-LIGHT) ===');
  out.push(`fills carrying the companion: ${eyePad.fills}   units emitted: ${eyePad.units}`);
  out.push(`  small fills (qty<=15, x4): ${eyePad.smallFills}   large fills (x8): ${eyePad.largeFills}`);
  out.push(`  per location: ${[...perLocEyePad].map(([k, v]) => `${k}=${v}`).join('  ')}`);
  out.push('  items driving it:');
  out.push(...topItems(eyePad, 25));
  out.push('  EVERY compound item name containing "EYE" and where it classifies:');
  for (const [name, e] of [...eyeNamed.entries()].sort((a, b) => b[1].fills - a[1].fills).slice(0, 40)) {
    out.push(`    ${String(e.fills).padStart(6)}  rule ${String(e.rule).padStart(2)}  ${e.device.padEnd(20)} comp=${e.companion.padEnd(22)} ${name}`);
  }

  out.push('');
  out.push('=== 2. SYRINGES ===');
  out.push(`  per location units: ${[...perLocSyr].map(([k, v]) => `${k}=${v}`).join('  ')}`);
  out.push(`rule 9  (DRYNESS V, qty<30): fills ${syr9.fills}  units ${syr9.units}`);
  out.push(...topItems(syr9, 15));
  out.push(`rule 26 (any CREAM/GEL/LOTION with qty<10.5): fills ${syr26.fills}  units ${syr26.units}`);
  out.push(...topItems(syr26, 30));

  out.push('');
  out.push('=== 3. TRET PUMP (rule 15: TRET-C / TRET-H) ===');
  out.push(`  per location units: ${[...perLocTret].map(([k, v]) => `${k}=${v}`).join('  ')}`);
  out.push(`20g (qty<=20): fills ${tret20.fills}  units ${tret20.units}`);
  out.push(...topItems(tret20, 15));
  out.push(`45g (qty>20):  fills ${tret45.fills}  units ${tret45.units}`);
  out.push(...topItems(tret45, 15));
  out.push('  EVERY compound item name containing "TRET" and where it classifies:');
  for (const [name, e] of [...tretNamed.entries()].sort((a, b) => b[1].fills - a[1].fills).slice(0, 40)) {
    out.push(`    ${String(e.fills).padStart(6)}  rule ${String(e.rule).padStart(2)}  ${e.device.padEnd(20)} ${name}`);
  }

  console.log(out.join('\n'));
  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
