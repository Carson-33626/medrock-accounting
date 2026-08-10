// Why: the bookkeeper reports the TopRx receipts we attach are BLANK. run-toprx.ts does pdfParse
// the invoice and skips when the text does not parse, so a truly empty file should not have gotten
// through — yet all 222 cached invoice PDFs are within ~500 bytes of the same size, which is not
// what a set of real invoices with varying line counts looks like.
//
// This reads the cached PDFs we actually uploaded and reports, per file: byte size, page count,
// extracted character count, whether an invoice number and any line/total figures are present, and
// the first lines of text. A file that parses to boilerplate-only is the failure mode the existing
// guard cannot see — it checks that text parsed, not that the text contains an invoice. READ-ONLY.
//   npx tsx scripts/receipt-enrichment/engines/receipt-capture/_probe-toprx-blank.ts [FL|TN|TX] [sampleCount]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { RC } from '../../paths';

const PDF_DIR = RC.pdf;

interface Row {
  file: string;
  bytes: number;
  pages: number;
  chars: number;
  hasInvoiceNo: boolean;
  hasMoney: boolean;
  firstLines: string;
}

async function main(): Promise<void> {
  const entity = process.argv[2] ?? '';
  const sample = Number(process.argv[3] ?? '8');

  // --dump <file>: print one invoice's full extracted text. The summary table can only tell us a
  // money figure is absent; this shows WHAT is there instead, which is what identifies the failure.
  const dumpIdx = process.argv.indexOf('--dump');
  if (dumpIdx !== -1) {
    const target = process.argv[dumpIdx + 1];
    const buf = readFileSync(`${PDF_DIR}/${target}`);
    const parsed = await pdfParse(buf);
    console.log(`${target}: ${buf.length} bytes, ${parsed.numpages} page(s)`);
    console.log('---- full extracted text ----');
    console.log(parsed.text);
    console.log('---- end ----');
    return;
  }
  const files = readdirSync(PDF_DIR)
    .filter((f) => /^toprx-/i.test(f) && f.endsWith('.pdf'))
    .filter((f) => entity === '' || f.includes(`-${entity}-`));
  console.log(`${files.length} cached TopRx invoice PDF(s)${entity ? ` for ${entity}` : ''}`);

  const sizes = files.map((f) => statSync(`${PDF_DIR}/${f}`).size);
  const min = Math.min(...sizes), max = Math.max(...sizes);
  console.log(`byte size: min=${min} max=${max} spread=${max - min} (a real invoice set varies a lot more)`);

  const rows: Row[] = [];
  let emptyish = 0;
  for (const f of files.slice(0, sample)) {
    const buf = readFileSync(`${PDF_DIR}/${f}`);
    const parsed = await pdfParse(buf);
    const text = (parsed.text ?? '').replace(/\s+/g, ' ').trim();
    // Does the text contain anything that looks like invoice CONTENT, as opposed to letterhead?
    const hasInvoiceNo = /invoice\s*#?\s*[:\-]?\s*\d{4,}/i.test(text);
    const hasMoney = /\$\s?\d[\d,]*\.\d{2}/.test(text);
    if (text.length < 200 || (!hasInvoiceNo && !hasMoney)) emptyish++;
    rows.push({
      file: f,
      bytes: buf.length,
      pages: parsed.numpages ?? 0,
      chars: text.length,
      hasInvoiceNo,
      hasMoney,
      firstLines: text.slice(0, 140),
    });
  }

  console.log(`\n${'file'.padEnd(28)} ${'bytes'.padStart(7)} ${'pg'.padStart(3)} ${'chars'.padStart(6)} inv$  text`);
  for (const r of rows) {
    console.log(`${r.file.padEnd(28)} ${String(r.bytes).padStart(7)} ${String(r.pages).padStart(3)} ${String(r.chars).padStart(6)} ${r.hasInvoiceNo ? 'Y' : 'n'}${r.hasMoney ? 'Y' : 'n'}   ${r.firstLines}`);
  }
  console.log(`\nsampled ${rows.length}: ${emptyish} look content-free (no invoice number AND no money figure, or <200 chars)`);
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
