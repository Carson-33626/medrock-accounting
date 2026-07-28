# scripts/receipt-capture/weekly.ps1 — weekly receipt-capture pass.
#
# TopRx runs unattended for all 3 entities (scripted login, auto re-login on session lapse).
# ULINE runs per entity and is skipped cleanly (not a failure of the pass) whenever sign-in is
# required — run-uline.ts exits 2 for that; see README.md "ULINE session bootstrap".
#
# STAYS DRY-RUN ON PURPOSE: no --live flag appears anywhere below. Flipping to live is a
# deliberate one-line edit YOU make by hand once Carson green-lights standing live mode (add
# --live and a --limit to the command(s) below) — do not add it as part of routine maintenance.
#
# Run from anywhere (PowerShell 5.1+):  powershell -File scripts\receipt-capture\weekly.ps1

Set-Location "$PSScriptRoot\..\.."

$since = (Get-Date).AddDays(-21).ToString('yyyy-MM-dd')

Write-Host "=== receipt-capture weekly pass (DRY-RUN) | since=$since ===" -ForegroundColor Cyan

Write-Host "`n--- TopRx (FL, TN, TX) ---" -ForegroundColor Yellow
npx tsx scripts/receipt-capture/run-toprx.ts --since $since
if ($LASTEXITCODE -ne 0) {
    Write-Host "TopRx run failed (exit $LASTEXITCODE) - see output above." -ForegroundColor Red
}

$ulineEntities = @('FL', 'TN', 'TX')
foreach ($entity in $ulineEntities) {
    Write-Host "`n--- ULINE $entity ---" -ForegroundColor Yellow
    npx tsx scripts/receipt-capture/run-uline.ts --entity=$entity --since $since
    if ($LASTEXITCODE -eq 2) {
        Write-Host "ULINE $entity : sign-in required - skipped this pass (run: npx tsx scripts/receipt-capture/uline-bootstrap.ts --entity=$entity)" -ForegroundColor DarkYellow
    } elseif ($LASTEXITCODE -eq 3) {
        Write-Host "ULINE $entity : account mismatch or ULINE_ACCOUNT_$entity not set - skipped this pass" -ForegroundColor Red
    } elseif ($LASTEXITCODE -ne 0) {
        Write-Host "ULINE $entity : run failed (exit $LASTEXITCODE) - see output above." -ForegroundColor Red
    }
}

Write-Host "`n--- Amazon (FL, TN, TX) ---" -ForegroundColor Yellow
npx tsx scripts/receipt-capture/run-amazon.ts
if ($LASTEXITCODE -ne 0) {
    Write-Host "Amazon run failed (exit $LASTEXITCODE) - see output above." -ForegroundColor Red
}

Write-Host "`n=== weekly pass complete - review out\*-plan-*.csv and the audit CSV before any live run ===" -ForegroundColor Cyan
