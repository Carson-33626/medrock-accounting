'use client';

export type OcrConversion = 'heic' | 'webp' | 'none';

/**
 * What conversion a file needs before the OCR gateway (which accepts only
 * JPEG/PNG/PDF) can read it. HEIC is detected by mime OR extension — iPhone
 * Safari sometimes reports an empty mime type for HEIC captures.
 */
export function ocrConversionFor(file: { type: string; name: string }): OcrConversion {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (type === 'image/heic' || type === 'image/heif' || name.endsWith('.heic') || name.endsWith('.heif')) {
    return 'heic';
  }
  if (type === 'image/webp' || name.endsWith('.webp')) return 'webp';
  return 'none';
}

function swapExtension(name: string, ext: string): string {
  return `${name.replace(/\.[^.]+$/, '')}.${ext}`;
}

async function heicToJpeg(file: File): Promise<File> {
  // Dynamic import: the libheif WASM only loads when a HEIC file is encountered,
  // keeping it out of the initial /deposits bundle.
  const { default: heic2any } = await import('heic2any');
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  const blob = Array.isArray(out) ? out[0] : out;
  return new File([blob], swapExtension(file.name, 'jpg'), { type: 'image/jpeg' });
}

async function webpToJpeg(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) throw new Error('canvas toBlob returned null');
  return new File([blob], swapExtension(file.name, 'jpg'), { type: 'image/jpeg' });
}

/**
 * Returns an OCR-readable (and Drive-previewable) version of the file: HEIC and
 * WebP become JPEG; everything else passes through. Best-effort — if conversion
 * throws, the original file is returned so the flow degrades to manual entry
 * rather than erroring.
 */
export async function toOcrReadyFile(file: File): Promise<File> {
  const conversion = ocrConversionFor(file);
  try {
    if (conversion === 'heic') return await heicToJpeg(file);
    if (conversion === 'webp') return await webpToJpeg(file);
  } catch {
    return file;
  }
  return file;
}
