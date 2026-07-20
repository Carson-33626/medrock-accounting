/**
 * Read-only sanity check for the deposit-review summary route.
 *
 * Calls the real route handler against the live Drive tree and prints what it
 * produced. Read-only: the route only lists. Run with DEV_SKIP_AUTH=true so
 * requireAuth() returns the mock user instead of redirecting.
 *
 *   npx tsx scripts/deposits/verify-review-summary.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

process.env.DEV_SKIP_AUTH = 'true';

async function main(): Promise<void> {
  const { GET } = await import('../../src/app/api/deposit-review/summary/route');
  const response = await GET();

  console.log('HTTP', response.status);
  const body: unknown = await response.json();

  if (response.status !== 200) {
    console.log(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  const summary = body as {
    totalFiles: number;
    thisMonthCount: number;
    mostRecent: { fileName: string; isoDate: string | null; uploader: string | null } | null;
    locations: { location: string; fileCount: number; thisMonthCount: number; latestUploadDate: string | null }[];
    recent: {
      fileName: string;
      location: string;
      isoDate: string | null;
      type: string | null;
      amount: string | null;
      uploader: string | null;
      webViewLink: string;
    }[];
  };

  console.log(`\ntotalFiles     : ${summary.totalFiles}`);
  console.log(`thisMonthCount : ${summary.thisMonthCount}`);
  console.log(`mostRecent     : ${summary.mostRecent ? `${summary.mostRecent.fileName} (${summary.mostRecent.isoDate})` : '(none)'}`);

  console.log('\nlocations:');
  for (const l of summary.locations) {
    console.log(`  ${l.location.padEnd(12)} files=${String(l.fileCount).padStart(3)}  thisMonth=${String(l.thisMonthCount).padStart(3)}  latest=${l.latestUploadDate ?? '(none)'}`);
  }

  console.log(`\nrecent (${summary.recent.length}, showing 12):`);
  for (const r of summary.recent.slice(0, 12)) {
    console.log(
      `  ${(r.isoDate ?? '----------')}  ${r.location.padEnd(10)} ${(r.type ?? '-').padEnd(8)} ${(r.amount ?? '-').padStart(10)}  ${(r.uploader ?? '-').padEnd(12)} ${r.fileName}`
    );
  }

  // The parse quality signal: how much did we fail to extract?
  const noDate = summary.recent.filter((r) => !r.isoDate).length;
  const noType = summary.recent.filter((r) => !r.type).length;
  const links = summary.recent.filter((r) => r.webViewLink).length;
  console.log(`\nparse: ${noDate} of ${summary.recent.length} recent lack a date, ${noType} lack a type, ${links} have a webViewLink`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
