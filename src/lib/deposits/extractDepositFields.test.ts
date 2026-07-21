import { describe, it, expect } from 'vitest';
import { extractDepositFields, EMPTY_SUGGESTIONS, type OcrResponse } from './extractDepositFields';

const NOW = new Date('2026-07-14T12:00:00Z');

function ocr(partial: Partial<OcrResponse>): OcrResponse {
  return { lines: [], fullText: '', keyValues: {}, tables: [], ...partial };
}

describe('extractDepositFields', () => {
  it('prefers labelled key/values (trailing colon stripped) for amount and date', () => {
    const result = extractDepositFields(
      ocr({ keyValues: { 'Date:': '07/14/2026', 'Total:': '1,491.86' }, fullText: 'DEPOSIT TICKET' }),
      NOW,
    );
    expect(result).toEqual({ date: '2026-07-14', type: 'Deposit', amount: '$1491.86' });
  });

  it('falls back to fullText when no labelled fields match', () => {
    const result = extractDepositFields(
      ocr({ fullText: 'Random check slip 7/14/26 amount $82.50' }),
      NOW,
    );
    expect(result).toEqual({ date: '2026-07-14', type: 'Check', amount: '$82.50' });
  });

  it('matches amount labels case-insensitively and ignoring the trailing colon', () => {
    const result = extractDepositFields(ocr({ keyValues: { 'AMOUNT:': '$500.00' } }), NOW);
    expect(result.amount).toBe('$500.00');
  });

  it('leaves a field null when its value is not parseable', () => {
    const result = extractDepositFields(
      ocr({ keyValues: { 'Total:': 'not a number', 'Date:': 'not a date' }, fullText: 'nothing' }),
      NOW,
    );
    expect(result).toEqual(EMPTY_SUGGESTIONS);
  });

  it('does not throw on a garbage amount value (formatAmount would throw)', () => {
    expect(() => extractDepositFields(ocr({ keyValues: { 'Total:': '$$$' } }), NOW)).not.toThrow();
  });

  it('rejects a future date found in the text', () => {
    const result = extractDepositFields(ocr({ fullText: 'dated 12/31/2026' }), NOW);
    expect(result.date).toBeNull();
  });

  it('returns EMPTY_SUGGESTIONS for an empty response', () => {
    expect(extractDepositFields(ocr({}), NOW)).toEqual(EMPTY_SUGGESTIONS);
  });
});
