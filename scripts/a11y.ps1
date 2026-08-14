param([string]$click = "", [switch]$list, [switch]$rect, [switch]$restore)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$src = @"
using System;
using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
public struct R { public int Left; public int Top; public int Right; public int Bottom; }
"@
Add-Type -TypeDefinition $src
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "Novel Studio")
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) { Write-Output "window not found"; exit 1 }
$h = $win.Current.NativeWindowHandle

function Find-Button($name) {
  $ct = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  $btns = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $ct)
  foreach ($b in $btns) {
    if ($b.Current.Name -and $b.Current.Name.Contains($name)) { return $b }
  }
  return $null
}

if ($rect) {
  $r = New-Object R
  [void][W32]::GetWindowRect($h, [ref]$r)
  Write-Output ("rect: $($r.Left),$($r.Top) $($r.Right-$r.Left)x$($r.Bottom-$r.Top)")
}
if ($restore) {
  [void][W32]::ShowWindow($h, 9)
  Write-Output "restored"
}
if ($click -ne "") {
  $btn = Find-Button $click
  if (-not $btn) { Write-Output "button '$click' not found"; exit 1 }
  $ip = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $ip.Invoke()
  Write-Output "clicked '$click'"
  Start-Sleep -Milliseconds 700
}
if ($list) {
  $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($el in $all) {
    $n = $el.Current.Name
    $t = $el.Current.ControlType.ProgrammaticName
    if ($n -and $n.Trim() -ne "") { Write-Output "$t | $n" }
  }
}
