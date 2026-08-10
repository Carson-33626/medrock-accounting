// Drive the Amazon Business "Items" order-history report console and return the CSV text.
// Flow (validated live 2026-07-22 against the authenticated console):
//   1. Navigate the Items report page for the chosen date span.
//   2. Arm the Playwright download listener BEFORE generating (download capture works over CDP-attached
//      real Chrome — confirmed live).
//   3. Click "Generate report" (#download-csv-file-button). A "report generating" modal appears; dismiss
//      its OK button ([data-testid="ok-btn"]) immediately. For a report this size Amazon finishes in
//      seconds and the download then fires directly on the page (no Download-history round-trip needed).
//   4. Await the download and read it.
// If Amazon ever routes a slow/large report to Download history instead of an on-page download, the
// awaited download simply times out — raise opts.timeoutMs or split the range.
import type { Page } from '@playwright/test';

export type DateSpan = 'PAST_12_MONTHS' | 'YEAR_TO_DATE' | 'MONTH_TO_DATE';
// items_report_1 = order/line items (order-level). transactions_report = the ACTUAL card charges
// (batched) with the order number(s) each charge reconciles to — what pairs 1:1 with Ramp txns.
export type ReportType = 'items_report_1' | 'transactions_report';

export function reportUrl(span: DateSpan, reportType: ReportType = 'items_report_1'): string {
  return `https://www.amazon.com/b2b/aba/reports?reportType=${reportType}&dateSpanSelection=${span}`;
}

export async function downloadItemsReportCsv(page: Page, span: DateSpan, opts: { timeoutMs?: number; reportType?: ReportType } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  await page.goto(reportUrl(span, opts.reportType ?? 'items_report_1'), { waitUntil: 'domcontentloaded' });

  // Arm the listener first, then generate + dismiss the modal fast so the on-page download is captured.
  const downloadPromise = page.waitForEvent('download', { timeout: timeoutMs });
  await page.locator('#download-csv-file-button').first().click();
  const ok = page.locator('[data-testid="ok-btn"]');
  await ok.waitFor({ state: 'visible', timeout: 15_000 }).then(() => ok.click()).catch(() => undefined);

  const download = await downloadPromise;
  const stream = await download.createReadStream();
  if (!stream) throw new Error('Report download produced no readable stream.');
  return streamToString(stream);
}

function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}
