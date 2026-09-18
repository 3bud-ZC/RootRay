# Captures the RootRay main window via PrintWindow (PW_RENDERFULLCONTENT),
# which renders the full DWM-composited window — including the native
# WebView2 child preview that DOM-level screenshots cannot see.
# Usage: powershell -File capture-window.ps1 -ProcId <pid> -Out <png>
param(
  [Parameter(Mandatory = $true)][int]$ProcId,
  [Parameter(Mandatory = $true)][string]$Out
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CapDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
# Must run before any rect math: DPI-unaware processes get scaled-down
# window coordinates, producing a bitmap smaller than the real window.
[void][CapDpi]::SetProcessDPIAware()
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CapWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$proc = Get-Process -Id $ProcId -ErrorAction Stop
$hwnd = $proc.MainWindowHandle
if ($hwnd -eq 0) { Write-Error "no main window"; exit 1 }

# Maximize for consistent full-screen captures, then let the compositor settle.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CapShow {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
}
"@
[void][CapShow]::ShowWindow($hwnd, 3) # SW_MAXIMIZE
Start-Sleep -Milliseconds 700

$r = New-Object CapWin+RECT
[void][CapWin]::GetWindowRect($hwnd, [ref]$r)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { Write-Error "bad rect ${w}x${h}"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# 2 = PW_RENDERFULLCONTENT (includes layered/DWM child surfaces)
$ok = [CapWin]::PrintWindow($hwnd, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
if (-not $ok) { Write-Error "PrintWindow failed"; exit 1 }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "CAPTURED $Out (${w}x${h})"
