import { NextRequest, NextResponse } from 'next/server';
import { requireManager } from '@/lib/auth';
import { updateSettings } from '@/lib/payroll/eom-diff-store';
import { validateSettings } from '@/lib/payroll/eom-correction';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SettingsBody {
  threshold?: number;
  enabled?: boolean;
  checkFromMonth?: string;
}

/** PUT /api/payroll/eom/diff/settings { threshold?, enabled?, checkFromMonth? } — partial
 *  update of the difference check's settings, stamped with the manager. DS 2026-09-25 §4.1. */
export async function PUT(request: NextRequest) {
  // requireManager redirects (throws NEXT_REDIRECT) — must run outside the try so Next handles it.
  const user = await requireManager();
  try {
    const body = (await request.json()) as SettingsBody;
    const checked = validateSettings({
      threshold: body.threshold, enabled: body.enabled, checkFromMonth: body.checkFromMonth,
    });
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error }, { status: 400 });
    }
    return NextResponse.json(await updateSettings(checked.value, user.email || null));
  } catch (error) {
    console.error('[payroll/eom/diff/settings PUT]', error);
    const message = error instanceof Error ? error.message : 'Failed to save the difference check settings';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
