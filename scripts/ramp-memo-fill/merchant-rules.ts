// Merchant->GL mapping for memo labels (and reusable as coding guidance). Priority the caller applies:
//   1) Amazon/Walmart -> per-item GL classifier (handled in run: buildItemizedMemo)
//   2) OCR_CLASSIFY vendors (e.g. ULINE, a genuine blend) -> per-item classifier when OCR items exist
//   3) OVERRIDES  -> Carson's ratified/known vendor corrections (win over history)
//   4) manual history (loadHistoryLabels) -> vendor's dominant HUMAN coding, gated on >=2 manual lines
//   5) Ramp sk_category -> last-resort fallback
import { existsSync, readFileSync } from 'node:fs';

// Ratified + newly-confirmed vendor corrections. Leaf label is what shows in the memo; acct kept for
// downstream GL coding. Matched case-insensitively as a substring/regex on merchant_name.
const OVERRIDES: { re: RegExp; label: string; acct: string }[] = [
  { re: /oak\s*drugs/i, label: 'Commercial Rx Inventory', acct: '1220.05' },
  { re: /\btop\s*rx\b/i, label: 'Commercial Rx Inventory', acct: '1220.05' },
  { re: /amerisource/i, label: 'Commercial Rx Inventory', acct: '1220.05' },
  { re: /kalchem/i, label: 'Compound Ingredient Inventory', acct: '1220.10' },
  { re: /makingcosmetics/i, label: 'Compound Ingredient Inventory', acct: '1220.10' },
  { re: /cosmetic\s*packaging/i, label: 'Compound Packaging Inventory', acct: '1220.15' },
  { re: /dropperbottles/i, label: 'Compound Packaging Inventory', acct: '1220.15' },
  { re: /bottlemate/i, label: 'Compound Packaging Inventory', acct: '1220.15' },
];

// Blend vendors: don't force one GL — classify each OCR line item instead (ULINE sells both
// compounding packaging and shipping supplies, so it splits from product detail).
const OCR_CLASSIFY: RegExp[] = [/uline/i];

export function overrideLabel(name: string | null): string | null {
  const n = name ?? '';
  for (const o of OVERRIDES) if (o.re.test(n)) return o.label;
  return null;
}
export function isOcrClassify(name: string | null): boolean {
  const n = name ?? '';
  return OCR_CLASSIFY.some((re) => re.test(n));
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// merchant (lowercased) -> dominant MANUAL GL leaf, only when >=2 human codings back it (excludes the
// vendors whose only codings are wrong auto-rules, e.g. oak drugs/Kalchem/TopRx had 0 manual).
// CSV columns: merchant,ramp_category,coded_lines,top_gl,top_acct,agreement_pct,manual_top_gl,manual_lines
export function loadHistoryLabels(path: string, minManual = 2): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(path)) return m;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
  for (const l of lines) {
    const c = parseCsvLine(l);
    const merchant = c[0]; const manualTop = c[6]; const manualN = Number(c[7]);
    if (merchant && manualTop && manualTop !== '(none manual)' && Number.isFinite(manualN) && manualN >= minManual) {
      m.set(merchant.toLowerCase(), manualTop);
    }
  }
  return m;
}
