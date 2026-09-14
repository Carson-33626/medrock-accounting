/**
 * How an account is shown to an accountant: number first, then the leaf name —
 * '1220.05 Commercial Rx Inventory', the way the QuickBooks balance sheet and
 * P&L print it. Carson, 2026-09-14: "please add the account numbers as well,
 * accounting uses these."
 *
 * The posting code needs the FullyQualifiedName ('Inventory Asset:Commercial Rx
 * Inventory') because that is what `refs.accounts` is keyed by; the SCREEN needs
 * the number. This is the one place that bridges the two for display, using the
 * same FullyQualifiedName -> AcctNum map `fetchDimensions` already returns.
 *
 * Pure. An account with no number (or no map for its company) falls back to the
 * full name unchanged rather than inventing one.
 */
export function formatAccount(
  fullyQualifiedName: string,
  accountNumbers: Readonly<Record<string, string>> | null | undefined,
): string {
  const num = accountNumbers?.[fullyQualifiedName];
  if (!num) return fullyQualifiedName;
  const leaf = fullyQualifiedName.split(':').pop() ?? fullyQualifiedName;
  return `${num} ${leaf}`;
}
