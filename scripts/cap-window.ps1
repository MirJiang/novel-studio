param(
  [Parameter(Mandatory=$true)][string]$title,
  [Parameter(Mandatory=$true)][string]$out
)
Add-Type -AssemblyName System.Drawing
$src = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class Win32W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static IntPtr Find(string needle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (IsWindowVisible(h) && sb.ToString().Contains(needle)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
"@
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing
$h = [Win32W]::Find($title)
if ($h -eq [IntPtr]::Zero) { Write-Output "window '$title' not found"; exit 1 }
[void][Win32W]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 400
$r = New-Object RECT
[void][Win32W]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
$b = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($b)
$hdc = $g.GetHdc()
$ok = [Win32W]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
Write-Output "printwindow ok=$ok ${w}x${hh}"
$b.Save($out); $b.Dispose()
Write-Output "saved $out"
