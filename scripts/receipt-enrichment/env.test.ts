import { describe, it, expect } from 'vitest';
import { checkCapabilities, formatMissing } from './env';

const FULL: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  RAMP_FL_CLIENT_ID: 'x', RAMP_FL_CLIENT_SECRET: 'x',
  RAMP_TN_CLIENT_ID: 'x', RAMP_TN_CLIENT_SECRET: 'x',
  RAMP_TX_CLIENT_ID: 'x', RAMP_TX_CLIENT_SECRET: 'x',
  QUICKBOOKS_CLIENT_ID: 'x', QUICKBOOKS_CLIENT_SECRET: 'x',
  RDS_DATABASE_URL: 'x',
  SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x',
  TopRX_FL: 'x', TopRX_FL_Pass: 'x', TopRX_TN: 'x', TopRX_TN_Pass: 'x', TopRX_TX: 'x', TopRX_TX_Pass: 'x',
  Uline_FL: 'x', Uline_FL_Pass: 'x', Uline_TN: 'x', Uline_TN_Pass: 'x', Uline_TX: 'x', Uline_TX_Pass: 'x',
  LETCO_FL: 'x', LETCO_FL_Pass: 'x', LETCO_TN: 'x', LETCO_TN_Pass: 'x', LETCO_TX: 'x', LETCO_TX_Pass: 'x',
  MEDISCA_FL: 'x', MEDISCA_FL_Pass: 'x', MEDISCA_TN: 'x', MEDISCA_TN_Pass: 'x', MEDISCA_TX: 'x', MEDISCA_TX_Pass: 'x',
};

describe('checkCapabilities', () => {
  it('reports every capability ok when all vars are present', () => {
    const caps = checkCapabilities(FULL);
    expect(caps.filter((c) => !c.ok)).toEqual([]);
  });

  it('names the missing variable and marks only its capability down', () => {
    const env = { ...FULL };
    delete env.RDS_DATABASE_URL;
    const caps = checkCapabilities(env);
    const rds = caps.find((c) => c.name === 'rds');
    expect(rds?.ok).toBe(false);
    expect(rds?.missing).toEqual(['RDS_DATABASE_URL']);
    expect(caps.filter((c) => !c.ok).map((c) => c.name)).toEqual(['rds']);
  });

  it('treats an empty string as missing, not present', () => {
    const caps = checkCapabilities({ ...FULL, QUICKBOOKS_CLIENT_SECRET: '' });
    expect(caps.find((c) => c.name === 'quickbooks')?.missing).toEqual(['QUICKBOOKS_CLIENT_SECRET']);
  });

  it('accepts NEXT_PUBLIC_SUPABASE_URL in place of SUPABASE_URL', () => {
    const env = { ...FULL };
    delete env.SUPABASE_URL;
    env.NEXT_PUBLIC_SUPABASE_URL = 'x';
    expect(checkCapabilities(env).find((c) => c.name === 'supabase')?.ok).toBe(true);
  });

  it('formats a message naming both the variable and what it disables', () => {
    const env = { ...FULL };
    delete env.RAMP_TX_CLIENT_SECRET;
    const msg = formatMissing(checkCapabilities(env));
    expect(msg).toContain('RAMP_TX_CLIENT_SECRET');
    expect(msg).toContain('ramp');
  });

  it('formats to an empty string when nothing is missing', () => {
    expect(formatMissing(checkCapabilities(FULL))).toBe('');
  });
});
