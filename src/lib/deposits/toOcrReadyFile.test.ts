import { describe, it, expect } from 'vitest';
import { ocrConversionFor } from './toOcrReadyFile';

describe('ocrConversionFor', () => {
  it('flags HEIC by mime', () => {
    expect(ocrConversionFor({ type: 'image/heic', name: 'x.jpg' })).toBe('heic');
    expect(ocrConversionFor({ type: 'image/heif', name: 'x' })).toBe('heic');
  });
  it('flags HEIC by extension when the mime is empty (Safari)', () => {
    expect(ocrConversionFor({ type: '', name: 'IMG_1234.HEIC' })).toBe('heic');
  });
  it('flags WebP', () => {
    expect(ocrConversionFor({ type: 'image/webp', name: 'x' })).toBe('webp');
    expect(ocrConversionFor({ type: '', name: 'photo.webp' })).toBe('webp');
  });
  it('passes JPEG/PNG/PDF through untouched', () => {
    expect(ocrConversionFor({ type: 'image/jpeg', name: 'x.jpg' })).toBe('none');
    expect(ocrConversionFor({ type: 'image/png', name: 'x.png' })).toBe('none');
    expect(ocrConversionFor({ type: 'application/pdf', name: 'x.pdf' })).toBe('none');
  });
});
