/**
 * Retry wrapper for QuickBooks reads run from CLI scripts.
 *
 * WHY: from this workstation, connections to quickbooks.api.intuit.com intermittently exceed
 * undici's 10s connect timeout (UND_ERR_CONNECT_TIMEOUT) — it is a local network/DNS flake, not
 * an API or credential problem: the same request succeeds on the next attempt, and plain `node`
 * (as opposed to `tsx`) rarely hits it at all. Running scripts with
 * `NODE_OPTIONS=--dns-result-order=ipv4first` reduces it but does not eliminate it, and a
 * multi-call script that dies two thirds of the way through wastes a full re-run.
 *
 * Only wrap READS with this. A blind retry around a write could double-post.
 */

/** True for the transient connect/socket failures worth retrying. */
function isTransient(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const cause: unknown = (e as { cause?: unknown }).cause;
  const code = typeof cause === 'object' && cause !== null && 'code' in cause
    ? String((cause as { code: unknown }).code)
    : '';
  return (
    e.message.includes('fetch failed') ||
    // Raised by refreshAccessToken when Intuit could not be REACHED (as opposed to rejecting the
    // refresh token). The stored credentials are fine; only the network failed.
    e.name === 'QuickBooksUnreachableError' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN'
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run `fn`, retrying transient network failures with linear backoff. */
export async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isTransient(e) || i === attempts) break;
      const waitMs = 1500 * i;
      console.log(`  (${label}: transient network failure, retry ${i}/${attempts - 1} in ${waitMs}ms)`);
      await sleep(waitMs);
    }
  }
  throw last;
}
