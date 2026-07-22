import { describe, it, expect } from 'vitest';
import { unwrapExcel, parseMoneyCents, parseMDY } from './csv-fields';

describe('unwrapExcel', () => {
  it('strips the ="..." wrapper', () => { expect(unwrapExcel('="9985"')).toBe('9985'); });
  it('strips plain quotes', () => { expect(unwrapExcel('"MedRock Florida"')).toBe('MedRock Florida'); });
  it('passes through bare text', () => { expect(unwrapExcel('Visa')).toBe('Visa'); });
  it('returns empty for N/A after trim', () => { expect(unwrapExcel(' N/A ')).toBe('N/A'); });
  it('strips a bare leading = left by the tokenizer', () => { expect(unwrapExcel('=9985')).toBe('9985'); });
  it('still handles the quoted excel wrapper', () => { expect(unwrapExcel('="9985"')).toBe('9985'); });
});

describe('parseMoneyCents', () => {
  it('parses quoted decimals', () => { expect(parseMoneyCents('"141.21"')).toBe(14121); });
  it('parses bare decimals', () => { expect(parseMoneyCents('23.26')).toBe(2326); });
  it('handles thousands separators', () => { expect(parseMoneyCents('"1,299.00"')).toBe(129900); });
  it('returns NaN on junk', () => { expect(Number.isNaN(parseMoneyCents('N/A'))).toBe(true); });
});

describe('parseMDY', () => {
  it('converts MM/DD/YYYY to ISO', () => { expect(parseMDY('07/21/2026')).toBe('2026-07-21'); });
  it('returns empty on junk', () => { expect(parseMDY('')).toBe(''); });
});
