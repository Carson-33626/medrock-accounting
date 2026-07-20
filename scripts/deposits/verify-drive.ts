import { config } from 'dotenv';
config({ path: '.env.local' });

import { ensurePath, listChildren, uploadFile, trashFile, findFolder } from '../../src/lib/google/drive';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const ROOT = requiredEnv('DEPOSIT_SLIPS_FOLDER_ID');

async function main(): Promise<void> {
  const leaf = await ensurePath(ROOT, ['__verify', '2026', '2026-07-20']);
  console.log('ensurePath      :', leaf);

  const again = await ensurePath(ROOT, ['__verify', '2026', '2026-07-20']);
  console.log('idempotent      :', again === leaf ? 'OK' : `FAIL (${again} !== ${leaf})`);

  const uploaded = await uploadFile(leaf, 'test.txt', 'text/plain', Buffer.from('hello'));
  console.log('uploadFile      :', uploaded.id, uploaded.name);

  const children = await listChildren(leaf);
  console.log('listChildren    :', children.map((f) => f.name).join(', '));

  await trashFile(uploaded.id);
  console.log('trashFile       : OK');

  const scratch = await findFolder(ROOT, '__verify');
  if (scratch) {
    await trashFile(scratch.id);
    console.log('cleanup         : __verify trashed');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
