# scripts/receipt-enrichment/engines/receipt-capture/weekly.ps1 — DEPRECATED in favor of run-sweep.ts
#
# Kept as a convenience wrapper. Runs the sweep in read-only/dry-run mode.
# The actual receipt sweep (run-sweep.ts) is the canonical entrypoint; it orchestrates
# all vendors, scanning before/after, and emits a full report.
#
# For a real (LIVE) sweep:  npx tsx scripts/receipt-enrichment/engines/receipt-capture/run-sweep.ts
# (no --dry-run flag — the sweep is LIVE BY DEFAULT with no caps)
#
# Run from anywhere (PowerShell 5.1+):  powershell -File scripts\receipt-capture\weekly.ps1

# -> web/  (engines/receipt-capture -> engines -> receipt-enrichment -> scripts -> web).
# Every path below is relative to web/, so this cd is load-bearing, not cosmetic.
Set-Location "$PSScriptRoot\..\..\..\.."

Write-Host "=== receipt-capture weekly (dry-run) ===" -ForegroundColor Cyan

npx tsx scripts/receipt-enrichment/engines/receipt-capture/run-sweep.ts --dry-run
if ($LASTEXITCODE -ne 0) {
    Write-Host "Sweep failed (exit $LASTEXITCODE)" -ForegroundColor Red
}
