# walmart-enrich

Capture Walmart order invoices → match to Ramp charges → itemized GL split + receipt attach.
Reuses the amazon-enrich splitter. See docs/walmart-receipt-capture/ for the DS + plan.

Bootstrap once:  npx tsx scripts/walmart-enrich/bootstrap-login.ts
Dry-run:         npx tsx scripts/walmart-enrich/run.ts
Live (gated):    npx tsx scripts/walmart-enrich/run.ts --live --cap 5
