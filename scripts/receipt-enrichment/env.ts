// scripts/receipt-enrichment/env.ts
//
// What this program needs from the environment, grouped by what it unlocks.
//
// Before this module, a missing QUICKBOOKS_CLIENT_ID was `process.env.X!` — it surfaced as a 401
// three minutes into a run, from inside a child process, with no indication which variable was
// at fault. checkCapabilities answers "what can this install actually do?" before anything spawns.
//
// This is a usability boundary, NOT a security one. Arming (ui/actions.ts `live()`) remains the
// only thing standing between a click and a write.
// Amazon and Walmart are deliberately ABSENT. Their only env vars are AMZ_CDP_URL / WM_CDP_URL,
// which are optional overrides — every reader defaults to 'http://127.0.0.1:9222'. What actually
// gates those vendors is a *running* CDP Chrome, which ui/status.ts already probes live. Listing
// them here would report "unavailable" on a machine where they work fine, and a preflight that
// cries wolf gets ignored.
export type CapabilityName =
  | 'ramp' | 'quickbooks' | 'rds' | 'supabase'
  | 'toprx' | 'uline' | 'letco' | 'medisca';

export interface Capability {
  name: CapabilityName;
  /** What breaks without it — shown to the operator, not parsed. */
  unlocks: string;
  vars: readonly string[];
  missing: readonly string[];
  ok: boolean;
}

const ENTITIES = ['FL', 'TN', 'TX'] as const;

/** Alternatives: satisfied when ANY member is set. Everything else must be present. */
const EITHER: Readonly<Record<string, readonly string[]>> = {
  SUPABASE_URL: ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'],
};

interface CapabilitySpec {
  name: CapabilityName;
  unlocks: string;
  vars: readonly string[];
}

const SPECS: readonly CapabilitySpec[] = [
  {
    name: 'ramp',
    unlocks: 'every receipt, memo and split write — nothing runs without it',
    vars: ENTITIES.flatMap((e) => [`RAMP_${e}_CLIENT_ID`, `RAMP_${e}_CLIENT_SECRET`]),
  },
  {
    name: 'quickbooks',
    unlocks: 'Letco and Medisca bill dedupe, QB gap scans',
    vars: ['QUICKBOOKS_CLIENT_ID', 'QUICKBOOKS_CLIENT_SECRET'],
  },
  { name: 'rds', unlocks: 'the split-push audit log and preview', vars: ['RDS_DATABASE_URL'] },
  { name: 'supabase', unlocks: 'the QuickBooks token store', vars: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] },
  { name: 'toprx', unlocks: 'TopRx invoice capture', vars: ENTITIES.flatMap((e) => [`TopRX_${e}`, `TopRX_${e}_Pass`]) },
  { name: 'uline', unlocks: 'ULINE invoice capture', vars: ENTITIES.flatMap((e) => [`Uline_${e}`, `Uline_${e}_Pass`]) },
  { name: 'letco', unlocks: 'Letco bill enrichment', vars: ENTITIES.flatMap((e) => [`LETCO_${e}`, `LETCO_${e}_Pass`]) },
  { name: 'medisca', unlocks: 'Medisca cache refresh, enrich and create', vars: ENTITIES.flatMap((e) => [`MEDISCA_${e}`, `MEDISCA_${e}_Pass`]) },
];

function isSet(env: NodeJS.ProcessEnv, name: string): boolean {
  const candidates = EITHER[name] ?? [name];
  // An empty string is a set-but-blank variable — the most common .env mistake, and it fails
  // downstream identically to an absent one. Treat it as missing.
  return candidates.some((c) => (env[c] ?? '') !== '');
}

export function checkCapabilities(env: NodeJS.ProcessEnv): Capability[] {
  return SPECS.map((spec) => {
    const missing = spec.vars.filter((v) => !isSet(env, v));
    return { name: spec.name, unlocks: spec.unlocks, vars: spec.vars, missing, ok: missing.length === 0 };
  });
}

/** Operator-facing summary of what is missing and what it costs. Empty string when all is well. */
export function formatMissing(caps: readonly Capability[]): string {
  const down = caps.filter((c) => !c.ok);
  if (down.length === 0) return '';
  const lines = down.map((c) => `  ${c.name}: missing ${c.missing.join(', ')}\n    disables ${c.unlocks}`);
  return `Incomplete .env — ${down.length} capabilit${down.length === 1 ? 'y' : 'ies'} unavailable:\n${lines.join('\n')}`;
}
