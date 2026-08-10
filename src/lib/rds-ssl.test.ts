import { describe, it, expect } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { RDS_SSL } from './rds-ssl';

/**
 * Guards the fix for the repo-wide `rejectUnauthorized: false`. Every RDS pool now shares this
 * one object, so a regression here silently un-verifies every database connection in the app and
 * every script — the failure mode is invisible (connections keep working) which is exactly why it
 * survived so long the first time.
 */
describe('RDS_SSL', () => {
  it('verifies the server certificate', () => {
    expect(RDS_SSL.rejectUnauthorized).toBe(true);
  });

  it('pins a CA bundle rather than relying on the system trust store', () => {
    expect(RDS_SSL.ca).toContain('-----BEGIN CERTIFICATE-----');
  });

  it('carries all three Amazon RDS us-east-1 roots (RSA2048, RSA4096, ECC384)', () => {
    const count = RDS_SSL.ca.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0;
    expect(count).toBe(3);
  });

  it('every certificate parses, is a CA, and is currently valid', () => {
    const pems = RDS_SSL.ca
      .split(/(?=-----BEGIN CERTIFICATE-----)/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
    expect(pems).toHaveLength(3);

    const now = Date.now();
    for (const pem of pems) {
      const cert = new X509Certificate(pem);
      expect(cert.subject).toContain('Amazon RDS');
      expect(cert.ca).toBe(true);
      // An expired root would break every connection at once; catch it here, not in production.
      expect(new Date(cert.validTo).getTime()).toBeGreaterThan(now);
      expect(new Date(cert.validFrom).getTime()).toBeLessThan(now);
    }
  });

  it('the roots are the us-east-1 ones — the region this database actually lives in', () => {
    expect(RDS_SSL.ca).toContain('-----BEGIN CERTIFICATE-----');
    const pems = RDS_SSL.ca
      .split(/(?=-----BEGIN CERTIFICATE-----)/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
    for (const pem of pems) {
      expect(new X509Certificate(pem).subject).toContain('us-east-1');
    }
  });
});
