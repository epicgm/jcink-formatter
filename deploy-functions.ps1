# ------ inkform Edge Function Deployment Script ---------------------------------------------------------------------------------------------------------
# Run this in a regular PowerShell window (NOT inside Claude Code).
#
# Usage:
#   1. Open PowerShell (Windows Terminal / Start Menu --- PowerShell)
#   2. cd C:\Development\jcink-formatter
#   3. .\deploy-functions.ps1
# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

$supabase   = "C:\Development\supabase.exe"
$projectRef = "idohmzehnhfsoaqxlogi"

Write-Host ""
Write-Host "=== inkform Edge Function Deployer ===" -ForegroundColor Cyan
Write-Host ""

# ------ 1. Login ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
Write-Host "[1/4] Logging in to Supabase..." -ForegroundColor Yellow
Write-Host "      A browser window will open - sign in and click Authorize."
Write-Host ""
& $supabase login
if ($LASTEXITCODE -ne 0) { Write-Host "Login failed." -ForegroundColor Red; exit 1 }

# ------ 2. Link project ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
Write-Host ""
Write-Host "[2/4] Linking project $projectRef..." -ForegroundColor Yellow
Write-Host "      You'll be asked for your database password."
Write-Host "      Find it: Supabase Dashboard > Settings > Database > Connection string"
Write-Host ""
Set-Location "C:\Development\jcink-formatter"
& $supabase link --project-ref $projectRef
if ($LASTEXITCODE -ne 0) { Write-Host "Link failed." -ForegroundColor Red; exit 1 }

# ------ 3. Secrets ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
Write-Host ""
Write-Host "[3/4] Secrets..." -ForegroundColor Yellow

$anthropicKey = Read-Host "      ANTHROPIC_API_KEY (sk-ant-...) - required for extract-template"
if ($anthropicKey -match "^sk-") {
    & $supabase secrets set ANTHROPIC_API_KEY=$anthropicKey
    Write-Host "      ANTHROPIC_API_KEY set." -ForegroundColor Green
} else {
    Write-Host "      Skipped. extract-template will return errors until this is set." -ForegroundColor DarkYellow
}

Write-Host ""
Write-Host "      backup-to-github needs GITHUB_TOKEN + GITHUB_REPO (optional, set later)." -ForegroundColor DarkGray
Write-Host '      Run: C:\Development\supabase.exe secrets set GITHUB_TOKEN=ghp_xxx GITHUB_REPO=owner/repo' -ForegroundColor DarkGray

# ------ 4. Deploy ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
Write-Host ""
Write-Host "[4/4] Deploying functions..." -ForegroundColor Yellow
Write-Host ""

# extract-template   --- requires valid user JWT (called from browser)
# admin-create-user  --- requires valid user JWT (called from browser)
# backup-to-github   --- called by DB webhook, no user JWT, skip verify
$deployArgs = @{
    "extract-template"   = @()
    "admin-create-user"  = @()
    "backup-to-github"   = @("--no-verify-jwt")
}

$failed = @()
foreach ($fn in $deployArgs.Keys) {
    Write-Host "  $fn..." -NoNewline
    $args = $deployArgs[$fn]
    & $supabase functions deploy $fn @args 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host " deployed" -ForegroundColor Green
    } else {
        # Retry with output visible so we can see the error
        Write-Host " retrying..." -NoNewline
        & $supabase functions deploy $fn @args
        if ($LASTEXITCODE -eq 0) { Write-Host " deployed" -ForegroundColor Green }
        else { Write-Host " FAILED" -ForegroundColor Red; $failed += $fn }
    }
}

# ------ Summary ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Cyan
Write-Host ""
& $supabase functions list

if ($failed.Count -gt 0) {
    Write-Host ""
    Write-Host "Failed: $($failed -join ', ')" -ForegroundColor Red
    Write-Host "Retry:  C:\Development\supabase.exe functions deploy <name>"
}

Write-Host ""
Write-Host "Dashboard: https://supabase.com/dashboard/project/$projectRef/functions"
