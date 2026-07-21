import { describe, it, expect } from 'vitest';
import { ALLOWED_MIME, extensionForMime, matchesMagicBytes, MAX_FILE_BYTES } from './fileValidation';

describe('ALLOWED_MIME', () => {
  it('accepts the supported image and pdf types', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'application/pdf']) {
      expect(ALLOWED_MIME.test(t)).toBe(true);
    }
  });
  it('rejects unsupported types', () => {
    expect(ALLOWED_MIME.test('image/gif')).toBe(false);
    expect(ALLOWED_MIME.test('text/html')).toBe(false);
    expect(ALLOWED_MIME.test('')).toBe(false);
  });
});

describe('extensionForMime', () => {
  it('maps known types', () => {
    expect(extensionForMime('image/jpeg')).toBe('.jpg');
    expect(extensionForMime('application/pdf')).toBe('.pdf');
    expect(extensionForMime('image/png')).toBe('.png');
  });
  it('falls back to .jpg for anything unknown', () => {
    expect(extensionForMime('image/tiff')).toBe('.jpg');
  });
});

describe('matchesMagicBytes', () => {
  it('accepts a real JPEG header', () => {
    expect(matchesMagicBytes('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe(true);
  });
  it('rejects a JPEG claim over PNG bytes', () => {
    expect(matchesMagicBytes('image/jpeg', Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  });
  it('accepts a real PDF header', () => {
    expect(matchesMagicBytes('application/pdf', Buffer.from([0x25, 0x50, 0x44, 0x46]))).toBe(true);
  });

  it('exposes a sane max byte ceiling', () => {
    expect(MAX_FILE_BYTES).toBe(25 * 1024 * 1024);
  });
});
