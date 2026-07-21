/**
 * File-safety primitives shared by the deposit upload and OCR routes.
 *
 * `file.type` and `file.size` are client-supplied and trivially forged, so the
 * extension is derived from the validated MIME type (never the filename) and the
 * declared type is checked against the leading "magic bytes" of the actual file.
 */

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB — phone photos land well under this

export const ALLOWED_MIME = /^(image\/(jpeg|png|heic|heif|webp)|application\/pdf)$/;

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

export function extensionForMime(mimeType: string): string {
  return EXT_BY_MIME[mimeType] ?? '.jpg';
}

export function matchesMagicBytes(mimeType: string, bytes: Buffer): boolean {
  switch (mimeType) {
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case 'application/pdf':
      return (
        bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
      );
    case 'image/webp':
      return (
        bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    case 'image/heic':
    case 'image/heif':
      return (
        bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
      );
    default:
      return false;
  }
}
