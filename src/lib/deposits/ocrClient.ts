import type { OcrResponse } from './extractDepositFields';

// Grant's internal Textract gateway (AnalyzeDocument, FORMS + TABLES).
const DEFAULT_OCR_URL = 'https://kt1cx51lff.execute-api.us-east-1.amazonaws.com/ocr';

// The gateway's own ceiling is 30s; stay just under it so our abort fires first
// and surfaces as a clean fallback rather than a gateway 5xx.
const OCR_TIMEOUT_MS = 25_000;

/**
 * POST raw file bytes (base64) to the OCR gateway and return its parsed response.
 * Throws if the key is missing or the gateway does not answer 2xx — callers
 * treat any throw as "no suggestions" and let the user enter fields manually.
 */
export async function runOcr(bytes: Buffer): Promise<OcrResponse> {
  const key = process.env.OCR_API_KEY;
  if (!key) throw new Error('OCR_API_KEY is not set');
  const url = process.env.OCR_API_URL ?? DEFAULT_OCR_URL;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ document: bytes.toString('base64') }),
    signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`OCR gateway returned HTTP ${response.status}`);
  return (await response.json()) as OcrResponse;
}
