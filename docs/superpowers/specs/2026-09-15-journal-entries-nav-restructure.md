# DS — Journal Entries: one page per entry type, grouped in the left nav

**Date:** 2026-09-15. **Asked by:** Carson: "each journal entry page is getting complex enough
that we need to break it out on the left nav bar instead of selectors at the top … remove the
selector at the top and promote each page to its own page … sub-selectors under the journal
entries on the nav bar on the left."

## Before

`/payroll` is one client shell (`PayrollTabs`) with a top pill selector switching four views in
state: Payrolls · End of Month · Inventory Close · Mappings. Deep links ride on `?tab=` and
`?month=`. The sidebar has a single "Journal Entries" link.

## After

| route | page | notes |
|---|---|---|
| `/journal-entries/payroll` | Payroll Journal (landing list; a card opens Review + Post in place with a Back link) | "Refine in Mappings →" navigates to the Mappings page with `?entity=` |
| `/journal-entries/end-of-month` | End of Month Allocation | unchanged component |
| `/journal-entries/inventory-close` | Inventory Month-End Close | `?month=` honoured (Point-in-Time page return trip) |
| `/journal-entries/mappings` | Payroll Mappings | `?entity=` honoured |
| `/payroll` | **redirect** | `?tab=` maps to the matching route, `?month=` / `?entity=` carried across, so every old link and bookmark still lands |

- **Sidebar:** "Journal Entries" becomes an expandable group under Admin (same pattern as Sales
  Tax): four sub-links, auto-expanded whenever the path starts with `/journal-entries`, the
  group header highlighted when collapsed on an active child.
- **Shared shell:** `JournalEntriesShell` renders the page background, the "Journal Entries"
  eyebrow, the page title and the reference notes banner (payroll / end-of-month / mappings
  only, as before). Each page is a thin server component: `requireManager()` then the shell
  with its client body. Metadata per page.
- **Components stay put** in `src/app/payroll/components/` — the four bodies are unchanged;
  only `PayrollTabs.tsx` is deleted. No API routes move.
- **Auth:** middleware gates by app entitlement, not path prefix, so no allowlist change; each
  new page keeps the server-side `requireManager()` that `/payroll` had.

## Out of scope

Moving the components directory, changing any page body, changing any API.
