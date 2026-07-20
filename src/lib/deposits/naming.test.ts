import { describe, it, expect } from 'vitest';
import {
  buildFolderSegments,
  formatAmount,
  formatUploader,
  buildFileName,
  nextSequence,
  parseLegacyName,
  InvalidAmountError,
} from './naming';

describe('buildFolderSegments', () => {
  const FIXED_NOW = new Date('2026-07-14T12:00:00Z');

  it('returns location, year, iso date', () => {
    expect(buildFolderSegments('Florida', '2026-07-14', FIXED_NOW)).toEqual(['Florida', '2026', '2026-07-14']);
  });

  it('handles a January date without off-by-one', () => {
    expect(buildFolderSegments('Texas', '2026-01-01', FIXED_NOW)).toEqual(['Texas', '2026', '2026-01-01']);
  });

  it('rejects a malformed date', () => {
    expect(() => buildFolderSegments('Florida', '7/14/26', FIXED_NOW)).toThrow();
  });

  it('rejects a shape-valid date that does not exist on the calendar (Feb 30)', () => {
    expect(() => buildFolderSegments('Florida', '2026-02-30', FIXED_NOW)).toThrow();
  });

  it('rejects 9999-99-99', () => {
    expect(() => buildFolderSegments('Florida', '9999-99-99', FIXED_NOW)).toThrow();
  });

  it('rejects 0000-00-00', () => {
    expect(() => buildFolderSegments('Florida', '0000-00-00', FIXED_NOW)).toThrow();
  });

  it('accepts a valid leap day', () => {
    expect(buildFolderSegments('Florida', '2024-02-29', FIXED_NOW)).toEqual(['Florida', '2024', '2024-02-29']);
  });

  it('rejects an invalid leap day (2023 is not a leap year)', () => {
    expect(() => buildFolderSegments('Florida', '2023-02-29', FIXED_NOW)).toThrow();
  });

  it('rejects a future date', () => {
    expect(() => buildFolderSegments('Florida', '2026-07-16', FIXED_NOW)).toThrow();
  });

  it('accepts a date within the one-day clock-skew grace', () => {
    expect(buildFolderSegments('Florida', '2026-07-15', FIXED_NOW)).toEqual(['Florida', '2026', '2026-07-15']);
  });

  it('rejects a date before 2020-01-01', () => {
    expect(() => buildFolderSegments('Florida', '2019-12-31', FIXED_NOW)).toThrow();
  });

  it('accepts an ordinary valid date (regression)', () => {
    expect(buildFolderSegments('Texas', '2025-11-03', FIXED_NOW)).toEqual(['Texas', '2025', '2025-11-03']);
  });
});

describe('formatAmount', () => {
  it('returns null for blank input', () => {
    expect(formatAmount('')).toBeNull();
    expect(formatAmount('   ')).toBeNull();
  });

  it('strips commas and dollar signs, keeps two decimals', () => {
    expect(formatAmount('$1,409.36')).toBe('$1409.36');
    expect(formatAmount('1409.36')).toBe('$1409.36');
  });

  it('pads a whole-dollar amount to two decimals', () => {
    expect(formatAmount('1409')).toBe('$1409.00');
  });

  it('pads a single decimal place', () => {
    expect(formatAmount('1409.5')).toBe('$1409.50');
  });

  it('throws on non-numeric input', () => {
    expect(() => formatAmount('abc')).toThrow(InvalidAmountError);
  });

  it('throws on a negative amount', () => {
    expect(() => formatAmount('-5.00')).toThrow(InvalidAmountError);
  });
});

describe('formatUploader', () => {
  it('builds First-LastInitial', () => {
    expect(formatUploader({ first_name: 'Carson', last_name: 'Daugherty', email: 'd.carson@x.com' })).toBe('Carson-D');
  });

  it('strips non-alphanumerics from the first name', () => {
    expect(formatUploader({ first_name: "O'Brien", last_name: 'Smith', email: 'a@x.com' })).toBe('OBrien-S');
  });

  it('uses the LAST token of a multi-word surname field', () => {
    // AuthUser.last_name is everything after the first space in full_name, so a
    // middle name lands here too: "Carson James Doe" -> last_name "James Doe".
    expect(formatUploader({ first_name: 'Carson', last_name: 'James Doe', email: 'a@x.com' })).toBe('Carson-D');
  });

  it('handles a hyphenated surname', () => {
    expect(formatUploader({ first_name: 'Ana', last_name: 'Ruiz-Gomez', email: 'a@x.com' })).toBe('Ana-R');
  });

  it('falls back to the email local part when no name is set', () => {
    expect(formatUploader({ first_name: null, last_name: null, email: 'd.carson@medrockpharmacy.com' })).toBe('dcarson');
  });

  it('uses the first name alone when there is no last name', () => {
    expect(formatUploader({ first_name: 'Carson', last_name: null, email: 'a@x.com' })).toBe('Carson');
  });
});

describe('buildFileName', () => {
  it('includes the amount when present', () => {
    expect(
      buildFileName({ isoDate: '2026-07-14', type: 'Deposit', amount: '$1409.36', uploader: 'Carson-D', seq: 1, ext: '.jpeg' })
    ).toBe('2026-07-14_Deposit_$1409.36_Carson-D_01.jpeg');
  });

  it('omits the amount segment entirely when null', () => {
    expect(
      buildFileName({ isoDate: '2026-07-14', type: 'Check', amount: null, uploader: 'Carson-D', seq: 2, ext: '.jpeg' })
    ).toBe('2026-07-14_Check_Carson-D_02.jpeg');
  });

  it('omits the uploader segment when null (migrated historical files)', () => {
    expect(
      buildFileName({ isoDate: '2023-05-26', type: 'Deposit', amount: '$5381.64', uploader: null, seq: 3, ext: '.jpg' })
    ).toBe('2023-05-26_Deposit_$5381.64_03.jpg');
  });

  it('lowercases the extension', () => {
    expect(
      buildFileName({ isoDate: '2026-07-14', type: 'Deposit', amount: null, uploader: 'A-B', seq: 1, ext: '.JPEG' })
    ).toBe('2026-07-14_Deposit_A-B_01.jpeg');
  });

  it('zero-pads sequence to two digits and beyond', () => {
    const parts = { isoDate: '2026-07-14', type: 'Deposit' as const, amount: null, uploader: 'A-B', ext: '.jpg' };
    expect(buildFileName({ ...parts, seq: 9 })).toContain('_09.jpg');
    expect(buildFileName({ ...parts, seq: 10 })).toContain('_10.jpg');
    expect(buildFileName({ ...parts, seq: 123 })).toContain('_123.jpg');
  });

  it('omits both amount and uploader when both are null', () => {
    expect(
      buildFileName({ isoDate: '2026-07-14', type: 'Deposit', amount: null, uploader: null, seq: 4, ext: '.jpg' })
    ).toBe('2026-07-14_Deposit_04.jpg');
  });
});

describe('nextSequence', () => {
  it('returns 1 for an empty folder', () => {
    expect(nextSequence([])).toBe(1);
  });

  it('returns max + 1', () => {
    expect(nextSequence(['2026-07-14_Deposit_A-B_01.jpg', '2026-07-14_Check_A-B_02.jpg'])).toBe(3);
  });

  it('ignores names with no sequence suffix', () => {
    expect(nextSequence(['IMG_7389.jpeg', 'random.pdf'])).toBe(1);
  });

  it('handles sequences above 99', () => {
    expect(nextSequence(['2026-07-14_Deposit_A-B_100.jpg'])).toBe(101);
  });

  it('ignores legacy names when mixed with convention names', () => {
    expect(
      nextSequence([
        'IMG_7389.jpeg',
        'Receipt_12.jpg',
        'Deposit 05_26_23   $5,381 64.jpg',
        '2026-07-14_Deposit_A-B_01.jpg',
        '2026-07-14_Check_A-B_02.jpg',
      ])
    ).toBe(3);
  });
});

describe('parseLegacyName', () => {
  it('parses a dash date with no amount', () => {
    expect(parseLegacyName('Deposit 12-21-21.png')).toEqual({ isoDate: '2021-12-21', amount: null, type: 'Deposit' });
  });

  it('parses an underscore date with a space-separated cents amount', () => {
    expect(parseLegacyName('Deposit 05_26_23   $5,381 64.jpg')).toEqual({
      isoDate: '2023-05-26',
      amount: '$5381.64',
      type: 'Deposit',
    });
  });

  it('parses a leading-date name with a decimal amount', () => {
    expect(parseLegacyName('12-01-23 $1,409.36.pdf')).toEqual({
      isoDate: '2023-12-01',
      amount: '$1409.36',
      type: null,
    });
  });

  it('parses a four-digit year', () => {
    expect(parseLegacyName('6-05-2024 $1429.94.jpg')).toEqual({
      isoDate: '2024-06-05',
      amount: '$1429.94',
      type: null,
    });
  });

  it('parses the dotted 2026 folder-style date', () => {
    expect(parseLegacyName('7.9.26 Deposit from Cash Drawer.jpeg')).toEqual({
      isoDate: '2026-07-09',
      amount: null,
      type: null,
    });
  });

  it('recognises the "Depost" typo as a Deposit', () => {
    expect(parseLegacyName('Depost 12-28-21.png').type).toBe('Deposit');
  });

  it('returns nulls for a raw phone filename', () => {
    expect(parseLegacyName('IMG_7389.jpeg')).toEqual({ isoDate: null, amount: null, type: null });
  });
});
