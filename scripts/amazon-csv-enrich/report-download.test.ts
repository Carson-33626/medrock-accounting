import { describe, it, expect } from 'vitest';
import { reportUrl } from './report-download';

describe('reportUrl', () => {
  it('builds the items-report URL with the given span', () => {
    expect(reportUrl('PAST_12_MONTHS')).toBe(
      'https://www.amazon.com/b2b/aba/reports?reportType=items_report_1&dateSpanSelection=PAST_12_MONTHS');
    expect(reportUrl('YEAR_TO_DATE')).toContain('dateSpanSelection=YEAR_TO_DATE');
  });
});
