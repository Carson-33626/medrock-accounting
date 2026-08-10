import './load-env';
import { rampToken } from './ramp-client';
import { buildCodingMap } from './coding-map';

async function main(): Promise<void> {
  const token = await rampToken('FL', 'accounting:read');
  const m = await buildCodingMap('FL', token);
  console.log('gl options:', Object.keys(m.gl).length);
  console.log('class options:', Object.keys(m.klass).length);
  console.log('location options:', Object.keys(m.location).length);
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
