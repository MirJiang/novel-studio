param(
  [string]$processName = "novel-studio",
  [string]$out = "D:\VibeCodingProject\novel-studio\designs\shot-app-shelf.png"
)
Add-Type -AssemblyName System.Drawing
$src = @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
}
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
"@
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing
$p = Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object -First 1
if (-not $p) { Write-Output "no window"; exit 1 }
$h = $p.MainWindowHandle
$r = New-Object RECT
[void][Win32]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
$b = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($b)
$hdc = $g.GetHdc()
$ok = [Win32]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
Write-Output "printwindow ok=$ok ${w}x${hh}"
$b.Save($out)
$b.Dispose()
Write-Output "saved"
