// Drive the Amazon Business "Items" order-history report console: navigate, Generate (async), poll the
// Download history, and return the finished CSV text. Selectors validated against the live console
// snapshot (docs/amazon-receipt-capture/Business Analytics.mhtml); the Download-history ready-state
// selector is confirmed + hardened during the EXTRACT smoke (Task 10).
import type { Page } from '@playwright/test';

export type DateSpan = 'PAST_12_MONTHS' | 'YEAR_TO_DATE' | 'MONTH_TO_DATE';

export function reportUrl(span: DateSpan): string {
  return `https://www.amazon.com/b2b/aba/reports?reportType=items_report_1&dateSpanSelection=${span}`;
}

export async function downloadItemsReportCsv(page: Page, span: DateSpan, opts: { timeoutMs?: number } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  await page.goto(reportUrl(span), { waitUntil: 'domcontentloaded' });

  // Kick off generation, then capture the CSV via the browser's download event from Download history.
  await page.locator('#download-csv-file-button').click();

  // Poll Download history for the newest report's ready "Download" control, then trigger + read the file.
  const deadline = Date.now() + timeoutMs;
  // NOTE (smoke): open Download history, wait for the top row to reach a ready state, click its download.
  await page.getByTestId('download_history').click().catch(() => undefined);
  let csv = '';
  while (Date.now() < deadline) {
    const dl = await page.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
    if (dl) {
      const stream = await dl.createReadStream();
      if (stream) { csv = await streamToString(stream); break; }
    }
    // re-open / refresh Download history between polls if no download fired yet
    await page.getByTestId('download_history').click().catch(() => undefined);
  }
  if (!csv) throw new Error('Report did not become downloadable within the timeout.');
  return csv;
}

function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}
