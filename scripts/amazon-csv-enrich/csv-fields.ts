// Pure field-normalizers for the Amazon Business order-history CSV.
// Amazon escapes some cells as ="...." (to preserve leading zeros / long ids) and quotes decimals.
export function unwrapExcel(raw: string): string {
  let s = (raw ?? '').trim();
  const m = /^="(.*)"$/.exec(s);
  if (m) return m[1];
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (s.startsWith('=')) s = s.slice(1); // Excel formula prefix left after the tokenizer consumed the quotes
  return s;
}

export function parseMoneyCents(raw: string): number {
  const s = unwrapExcel(raw).replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}

export function parseMDY(raw: string): string {
  const s = unwrapExcel(raw);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) return '';
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}
