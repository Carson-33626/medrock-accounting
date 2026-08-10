import './load-env';
import { readQbAmazonEntries } from './qb-amazon-reader';

async function main(): Promise<void> {
  const fl = await readQbAmazonEntries('FL');
  console.log('FL Amazon entries:', fl.length);
  const withOrder = fl.filter((e) => e.orderNo).length;
  console.log('with DocNumber order#:', withOrder);
  const sample = fl.find((e) => e.lines.length > 1) ?? fl[0];
  console.log('sample entry:', JSON.stringify({ id: sample?.qbEntryId, order: sample?.orderNo, total: sample?.totalCents, lines: sample?.lines.length }, null, 2));
  console.log('sample line GL:', sample?.lines[0]);
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
