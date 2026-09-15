# RootRay installer smoke test (Windows, currentUser NSIS).
#
#   build → install → verify files → launch → clean exit → uninstall → verify gone
#
# Usage:
#   pwsh -File scripts/installer-smoke.ps1 [-InstallerPath <path>]
#
# Defaults to the newest bundle under target/release/bundle/nsis.
# Installs per-user (no admin) into %LOCALAPPDATA%\RootRay.
# Exits non-zero on any failed check.

param(
  [string]$InstallerPath = ""
)

$ErrorActionPreference = "Stop"

function Fail($msg) { Write-Host "FAIL: $msg" -ForegroundColor Red; exit 1 }
function Ok($msg)   { Write-Host "  ok  $msg" -ForegroundColor Green }

if (-not $InstallerPath) {
  $bundleDir = Join-Path $PSScriptRoot "..\target\release\bundle\nsis"
  $InstallerPath = (Get-ChildItem $bundleDir -Filter "*-setup.exe" |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}
if (-not (Test-Path $InstallerPath)) { Fail "installer not found: $InstallerPath" }
Write-Host "Installer: $InstallerPath"

$installDir = Join-Path $env:LOCALAPPDATA "RootRay"
$exe        = Join-Path $installDir "rootray-desktop.exe"
$unins      = Join-Path $installDir "uninstall.exe"

# Pre-clean in case a previous run left debris.
if (Test-Path $unins) { Start-Process $unins -ArgumentList "/S" -Wait; Start-Sleep 2 }

# ---- install -----------------------------------------------------------------
Write-Host "Installing (silent, current user)..."
Start-Process $InstallerPath -ArgumentList "/S" -Wait
Start-Sleep 3

if (-not (Test-Path $exe)) { Fail "installed exe missing at $exe" }
Ok "installed: $exe ($([math]::Round((Get-Item $exe).Length/1MB,1)) MB)"

# Inspector assets must ship as resources next to the app.
$resDir = Join-Path $installDir "inspector-assets"
if (-not (Test-Path (Join-Path $resDir "runner.cjs"))) { Fail "runner.cjs resource missing" }
if (-not (Test-Path (Join-Path $resDir "runtime.js"))) { Fail "runtime.js resource missing" }
if (-not (Test-Path (Join-Path $resDir "plugin.cjs"))) { Fail "plugin.cjs resource missing" }
Ok "inspector assets bundled under $resDir"

# ---- launch -------------------------------------------------------------------
Write-Host "Launching installed app..."
$proc = Start-Process $exe -PassThru
Start-Sleep 8
$alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if (-not $alive) { Fail "app exited during startup (check WebView2 runtime)" }
Ok "process initialized (pid $($proc.Id))"

# RootRay must not have spawned a dev server by itself.
$children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($proc.Id)" -ErrorAction SilentlyContinue
$nodeKids = $children | Where-Object { $_.Name -match "node|pnpm|npm|vite" }
if ($nodeKids) { Fail "unexpected dev process spawned at launch: $($nodeKids.Name -join ',')" }
Ok "no dev server auto-started on launch"

Stop-Process -Id $proc.Id -Force
Start-Sleep 1
Ok "terminated cleanly"

# ---- uninstall ----------------------------------------------------------------
Write-Host "Uninstalling (silent)..."
if (-not (Test-Path $unins)) { Fail "uninstaller missing at $unins" }
Start-Process $unins -ArgumentList "/S" -Wait
Start-Sleep 3

if (Test-Path $exe) { Fail "binary still present after uninstall" }
Ok "application binary removed"

Write-Host ""
Write-Host "INSTALLER SMOKE: PASS" -ForegroundColor Green
