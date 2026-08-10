// Static asset serving is the one route that reads a file chosen by request path, so these tests
// are mostly about what it REFUSES to serve. The allowlist is the security property; everything
// else here is plumbing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAssetReader, readIndexHtml, ASSET_PATHS } from './assets';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sweep-ui-assets-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>panel</title>');
  writeFileSync(join(dir, 'styles.css'), 'body { color: red; }');
  writeFileSync(join(dir, 'app.js'), 'console.log("hi");');
  // A file that exists next to the assets but is NOT on the allowlist.
  writeFileSync(join(dir, 'secret.txt'), 'should never be served');
  mkdirSync(join(dir, 'nested'), { recursive: true });
  writeFileSync(join(dir, 'nested', 'inner.css'), 'nope');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('makeAssetReader', () => {
  it('serves allowlisted assets with the right content type', () => {
    const read = makeAssetReader(dir);
    expect(read('/styles.css')).toEqual({ body: 'body { color: red; }', contentType: 'text/css; charset=utf-8' });
    expect(read('/app.js')).toEqual({ body: 'console.log("hi");', contentType: 'text/javascript; charset=utf-8' });
  });

  it('exposes exactly the allowlisted paths', () => {
    expect([...ASSET_PATHS].sort()).toEqual(['/app.js', '/styles.css']);
  });

  it('refuses a real file that is not on the allowlist', () => {
    expect(makeAssetReader(dir)('/secret.txt')).toBeNull();
  });

  it('refuses traversal attempts rather than resolving them', () => {
    const read = makeAssetReader(dir);
    // None of these are allowlist KEYS, so no path is ever built — the lookup misses first.
    expect(read('/../secret.txt')).toBeNull();
    expect(read('/../../../../../../etc/passwd')).toBeNull();
    expect(read('/nested/inner.css')).toBeNull();
    expect(read('/styles.css/../secret.txt')).toBeNull();
    expect(read('styles.css')).toBeNull(); // no leading slash -> not a key
  });

  it('returns null for an allowlisted name whose file is missing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'sweep-ui-empty-'));
    try {
      expect(makeAssetReader(empty)('/styles.css')).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('readIndexHtml', () => {
  it('reads the panel page', () => {
    expect(readIndexHtml(dir)).toContain('<title>panel</title>');
  });

  it('throws a directed error when the page is missing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'sweep-ui-empty-'));
    try {
      expect(() => readIndexHtml(empty)).toThrow(/ui\/ folder is incomplete|page not found/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
