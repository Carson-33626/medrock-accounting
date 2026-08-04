// Portal value parsers. Money is integer cents everywhere — the invoice reconcile gate compares
// exact sums, so a float would fail legitimate invoices.

export function parseMoneyCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  const sign = whole.startsWith('-') ? -1 : 1;
  const wholeCents = Math.abs(Number.parseInt(whole, 10)) * 100;
  const fracCents = Number.parseInt(frac.padEnd(2, '0'), 10);
  return sign * (wholeCents + fracCents);
}

// The portal renders M/D/YYYY (e.g. "8/4/2026"). Anything else is refused rather than guessed.
export function parsePortalDate(raw: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (m === null) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
