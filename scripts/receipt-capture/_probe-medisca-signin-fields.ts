// Probe: find the EXACT keys the Medisca portal passes to NextAuth signIn('credentials', {...}).
//
// The login form's HTML `name` attributes come from react-hook-form and need not match the object
// handed to signIn(). Two entities with different credential shapes both returned 401
// CredentialsSignin, which points at the field contract rather than at the passwords. Read it out of
// the shipped JS instead of guessing (each guess costs a failed login against a real account).
//   npx tsx scripts/receipt-capture/_probe-medisca-signin-fields.ts
const BASE = 'https://www.medisca.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

async function main(): Promise<void> {
  const page = await fetch(`${BASE}/login`, { headers: { 'User-Agent': UA } });
  const html = await page.text();

  const chunks = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/[a-zA-Z0-9/._-]+\.js/g)].map((m) => m[0]))];
  console.log(`login page references ${chunks.length} JS chunks`);

  const hits: { chunk: string; snippet: string }[] = [];
  let scanned = 0;
  for (const c of chunks) {
    const res = await fetch(`${BASE}${c}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) continue;
    const js = await res.text();
    scanned++;
    if (!/credentials/.test(js)) continue;
    for (const m of js.matchAll(/signIn\s*\(\s*["'`]credentials["'`][\s\S]{0,300}?\)/g)) {
      hits.push({ chunk: c, snippet: m[0].replace(/\s+/g, ' ').slice(0, 300) });
    }
    // Fallback: the redirect:!1 option object is a reliable landmark even when signIn is minified.
    for (const m of js.matchAll(/["'`]credentials["'`]\s*,\s*\{[^}]{0,220}\}/g)) {
      hits.push({ chunk: c, snippet: m[0].replace(/\s+/g, ' ').slice(0, 260) });
    }
  }
  console.log(`scanned ${scanned} chunks, ${hits.length} hit(s)\n`);
  const seen = new Set<string>();
  for (const h of hits) {
    if (seen.has(h.snippet)) continue;
    seen.add(h.snippet);
    console.log(`--- ${h.chunk.split('/').pop()}`);
    console.log(`    ${h.snippet}\n`);
  }
}

main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
