# Installed-app verification: seed last_project, launch installed RootRay,
# capture the window after auto-analysis, kill.
#
#   pwsh -File scripts/verify-installed.ps1 -Project <dir> -Shot <png>
#
# Requires RootRay already installed (scripts/installer-smoke.ps1 pattern).
param(
  [Parameter(Mandatory=$true)][string]$Project,
  [Parameter(Mandatory=$true)][string]$Shot
)
$ErrorActionPreference = "Stop"
function Fail($msg) { Write-Host "FAIL: $msg" -ForegroundColor Red; exit 1 }

$installDir = Join-Path $env:LOCALAPPDATA "RootRay"
$exe = Join-Path $installDir "rootray-desktop.exe"
if (-not (Test-Path $exe)) { Fail "installed exe missing: $exe" }

# Tauri app_config_dir = %APPDATA%\<bundle identifier>
$cfgDir = Join-Path $env:APPDATA "dev.rootray.app"
New-Item -ItemType Directory -Force $cfgDir | Out-Null
$settingsPath = Join-Path $cfgDir "settings.json"
$resolved = (Resolve-Path $Project).Path
$json = @{ lastProject = $resolved; recentProjects = @(); preferredLauncher = $null;
           openBrowserAutomatically = $false } | ConvertTo-Json
# serde_json rejects a UTF-8 BOM — write raw bytes without one.
[System.IO.File]::WriteAllText($settingsPath, $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Seeded lastProject = $resolved"

$proc = Start-Process $exe -PassThru
try {
  # Wait for the main window + analysis to settle.
  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep 1
    $proc.Refresh()
    if ($proc.HasExited) { Fail "app exited during startup" }
  } while ($proc.MainWindowHandle -eq 0 -and (Get-Date) -lt $deadline)
  if ($proc.MainWindowHandle -eq 0) { Fail "no main window" }
  Start-Sleep 6  # analyze + render

  Add-Type -AssemblyName System.Drawing
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinRect {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
  $h = $proc.MainWindowHandle
  [WinRect]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
  [WinRect]::SetForegroundWindow($h) | Out-Null
  Start-Sleep 1
  $r = New-Object WinRect+RECT
  [WinRect]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
  if ($w -le 0 -or $ht -le 0) { Fail "bad window rect" }
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "  ok  screenshot: $Shot"

  # Analysis success proof: push_recent_project rewrites settings on success.
  $s = Get-Content $settingsPath -Raw | ConvertFrom-Json
  if (-not ($s.recentProjects -contains $resolved)) {
    Fail "analyze did not complete (recentProjects missing project)"
  }
  Write-Host "  ok  settings.json recents updated (analyze succeeded in installed app)"
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
Write-Host "INSTALLED VERIFY: PASS" -ForegroundColor Green
