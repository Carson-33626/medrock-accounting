import './load-env';
import { rampToken, getRampTransactions, getRampAccounts, getRampFields, getRampFieldOptions } from './ramp-client';

async function main(): Promise<void> {
  const token = await rampToken('FL', 'transactions:read accounting:read');
  const txns = await getRampTransactions('FL', token, 1);
  console.log('FL txns page 1:', txns.length, 'sample:', txns[0]?.merchantName, txns[0]?.amountCents);
  console.log('with parsed order#:', txns.filter((t) => t.orderNo).length);
  const accounts = await getRampAccounts('FL', token);
  console.log('accounts:', accounts.length, 'suspense?', accounts.find((a) => a.code === '8220')?.name);
  const fields = await getRampFields('FL', token);
  const klass = fields.find((f) => f.name === 'Class');
  console.log('fields:', fields.map((f) => f.name).join(', '));
  if (klass) console.log('Class options:', (await getRampFieldOptions('FL', token, klass.rampId)).length);
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
