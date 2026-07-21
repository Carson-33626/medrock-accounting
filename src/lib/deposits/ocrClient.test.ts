import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOcr } from './ocrClient';

const OK_BODY = { lines: [], fullText: 'hi', keyValues: {}, tables: [] };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('runOcr', () => {
  it('throws when OCR_API_KEY is unset', async () => {
    vi.stubEnv('OCR_API_KEY', '');
    await expect(runOcr(Buffer.from([1, 2, 3]))).rejects.toThrow();
  });

  it('posts base64 with the x-api-key header and returns the parsed body', async () => {
    vi.stubEnv('OCR_API_KEY', 'secret-key');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(OK_BODY), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runOcr(Buffer.from('abc'));

    expect(result).toEqual(OK_BODY);
    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('secret-key');
    expect(JSON.parse(init.body as string)).toEqual({ document: Buffer.from('abc').toString('base64') });
  });

  it('throws on a non-2xx gateway response', async () => {
    vi.stubEnv('OCR_API_KEY', 'secret-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(runOcr(Buffer.from('x'))).rejects.toThrow();
  });
});
