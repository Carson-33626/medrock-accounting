import { createDecipheriv } from 'node:crypto';
import type { SensitiveRow } from './types';

export function decryptSensitive(b64: string, keyB64: string): SensitiveRow {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error(`PAYROLL key must be 32 bytes, got ${key.length}`);
  const raw = Buffer.from(b64, 'base64');
  if (raw.length < 28) throw new Error('ciphertext too short');
  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as SensitiveRow;
}
