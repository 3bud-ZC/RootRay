# Drives the native "Open project" folder picker (IFileOpenDialog) for the
# installed-app Change Project test.
#
# The dialog returns its CURRENT folder (the ShellView location), and
# IFileOpenDialog does not commit posted filename text — so the script
# navigates the nav-pane tree via UI Automation: it reads the dialog's
# current path from the breadcrumb pane, walks up the tree to the fork
# ancestor, expands/selects down the remaining target segments, then
# clicks Select Folder. No foreground/keyboard focus needed.
#
#   pwsh -File tests/e2e/pick-folder.ps1 -ProcId <pid> -Folder <abs path> [-Cancel]
param(
  [Parameter(Mandatory = $true)][int]$ProcId,
  [Parameter(Mandatory = $true)][string]$Folder,
  [switch]$Cancel,
  [int]$TimeoutSec = 30
)
$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class DlgWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public const uint BM_CLICK = 0x00F5, WM_COMMAND = 0x0111;
  public const uint WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
  public static void ClickCenter(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    var p = new POINT { X = (r.Left + r.Right) / 2, Y = (r.Top + r.Bottom) / 2 };
    ScreenToClient(h, ref p);
    var lp = new IntPtr((p.Y << 16) | (p.X & 0xFFFF));
    SendMessageW(h, WM_LBUTTONDOWN, new IntPtr(1), lp);
    SendMessageW(h, WM_LBUTTONUP, IntPtr.Zero, lp);
  }
  public const uint CB_SHOWDROPDOWN = 0x014F, CB_FINDSTRINGEXACT = 0x0158,
                   CB_SETCURSEL = 0x014E, CBN_SELENDOK = 9;
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public static IntPtr FindTop(uint pid, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      if (t.ToString() == title) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static List<KeyValuePair<IntPtr, string>> Children(IntPtr parent) {
    var list = new List<KeyValuePair<IntPtr, string>>();
    EnumChildWindows(parent, (h, l) => {
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      list.Add(new KeyValuePair<IntPtr, string>(h, c + "|" + t));
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$TS = [System.Windows.Automation.TreeScope]
$NameProp = $AE::NameProperty
$CtrlProp = $AE::ControlTypeProperty
$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$h = [IntPtr]::Zero
while ((Get-Date) -lt $deadline -and $h -eq [IntPtr]::Zero) {
  $h = [DlgWin]::FindTop($ProcId, "Open project")
  if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 250 }
}
if ($h -eq [IntPtr]::Zero) { Write-Host "NO_DIALOG"; exit 2 }

if ($Cancel) {
  $cn = [DlgWin]::GetDlgItem($h, 2)
  if ($cn -ne [IntPtr]::Zero) {
    [void][DlgWin]::SendMessageW($cn, [DlgWin]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
  }
  Write-Host "CANCELLED"
  exit 0
}

$dlg = $AE::FromHandle($h)

# The dialog returns its CURRENT folder (breadcrumb path). Navigate up
# via the UpBand's "up one level" button until the breadcrumb matches
# the target — a real navigation, so Select Folder returns the target.
$kids = [DlgWin]::Children($h)

function Get-CurrentPath {
  $panes = $dlg.FindAll($TS::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition($CtrlProp, $CT::Pane)))
  foreach ($p in $panes) {
    if ($p.Current.Name -match "([A-Za-z]:\\.*)$") { return $Matches[1] }
  }
  return $null
}

$currentPath = Get-CurrentPath
if (-not $currentPath) { Write-Host "NO_CURRENTPATH"; exit 3 }
Write-Host "CURRENT:$currentPath"

$target = $Folder.TrimEnd("\")
$ups = 0
while ($currentPath.TrimEnd("\") -ine $target -and $ups -lt 8) {
  # Only reachable by going up when the target is an ancestor.
  if (-not $currentPath.TrimEnd("\").StartsWith($target + "\",
        [StringComparison]::OrdinalIgnoreCase)) { break }
  $upBand = [IntPtr]::Zero
  foreach ($k in [DlgWin]::Children($h)) {
    if ($k.Value -match "^UpBand") { $upBand = $k.Key; break }
  }
  if ($upBand -eq [IntPtr]::Zero) { break }
  $upBtn = [IntPtr]::Zero
  foreach ($c in [DlgWin]::Children($upBand)) {
    if ($c.Value -match "^ToolbarWindow32|^Button") { $upBtn = $c.Key; break }
  }
  if ($upBtn -eq [IntPtr]::Zero) { $upBtn = $upBand }
  [DlgWin]::ClickCenter($upBtn)
  Start-Sleep -Milliseconds 600
  $currentPath = Get-CurrentPath
  $ups++
  if (-not $currentPath) { break }
}
Write-Host ("AFTER_UPS:" + $currentPath)

$curSegs = @($currentPath.TrimEnd("\") -split "\\")
$tgtSegs = @($Folder.TrimEnd("\") -split "\\")

# Already at the target — nothing to navigate.
$d = 0
while ($d -lt [Math]::Min($curSegs.Count, $tgtSegs.Count) -and
       $curSegs[$d] -ieq $tgtSegs[$d]) { $d++ }

if ($d -lt $tgtSegs.Count -or $curSegs.Count -ne $tgtSegs.Count) {
  $tree = $dlg.FindAll($TS::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition($CtrlProp, $CT::Tree))) |
    Select-Object -First 1
  if (-not $tree) { Write-Host "NO_TREE"; exit 4 }

  $treeItemCond = New-Object System.Windows.Automation.PropertyCondition($CtrlProp, $CT::TreeItem)

  function Find-Item($container, [string]$name) {
    for ($t = 0; $t -lt 10; $t++) {
      try {
        $icp = $container.GetCurrentPattern(
          [System.Windows.Automation.ItemContainerPattern]::Pattern)
        if ($icp) {
          $hit = $icp.FindItemByProperty($null, $NameProp, $name)
          if ($hit) { return $hit }
        }
      } catch {}
      try {
        $kids = $container.FindAll($TS::Children, $treeItemCond)
        foreach ($k in $kids) { if ($k.Current.Name -eq $name) { return $k } }
      } catch {}
      Start-Sleep -Milliseconds 300
    }
    return $null
  }

  function Expand-Item($el) {
    try {
      $pat = $el.GetCurrentPattern(
        [System.Windows.Automation.ExpandCollapsePattern]::Pattern)
      if ($pat) { $pat.Expand() }
    } catch {}
  }

  # Anchor: the tree item for the current folder (the nav pane expands to
  # it), else the UIA selection.
  $sel = Find-Item $tree $curSegs[-1]
  if (-not $sel) {
    try {
      $sels = $tree.GetCurrentPattern(
        [System.Windows.Automation.SelectionPattern]::Pattern).GetSelection()
      if ($sels.Count -gt 0) { $sel = $sels[0] }
    } catch {}
  }
  if (-not $sel) { Write-Host "NO_ANCHOR"; exit 5 }

  # Walk up to the fork ancestor — tree parents mirror folder parents.
  $node = $sel
  for ($u = 0; $u -lt ($curSegs.Count - $d) -and $node; $u++) {
    $node = $Walker.GetParent($node)
  }
  if (-not $node) { Write-Host "NO_FORK"; exit 6 }

  # Expand + descend the remaining segments; select the leaf so the
  # ShellView navigates to it.
  $remaining = $tgtSegs[$d..($tgtSegs.Count - 1)]
  $cur = $node
  foreach ($seg in $remaining) {
    Expand-Item $cur
    Start-Sleep -Milliseconds 350
    $item = Find-Item $cur $seg
    if (-not $item) { Write-Host "MISS:$seg"; exit 7 }
    if ($seg -eq $remaining[-1]) {
      try {
        $item.GetCurrentPattern(
          [System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
      } catch {
        try {
          $item.GetCurrentPattern(
            [System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        } catch {}
      }
    } else {
      Expand-Item $item
      $cur = $item
      Start-Sleep -Milliseconds 350
    }
  }
}

# Confirm via Select Folder — returns the ShellView's current folder.
Start-Sleep -Milliseconds 500
$btn = [DlgWin]::GetDlgItem($h, 1)
if ($btn -ne [IntPtr]::Zero) {
  [void][DlgWin]::SendMessageW($btn, [DlgWin]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
}

Start-Sleep -Milliseconds 900
if ([DlgWin]::FindTop($ProcId, "Open project") -ne [IntPtr]::Zero) {
  Write-Host "STILL_OPEN"; exit 8
}
Write-Host "PICKED"
