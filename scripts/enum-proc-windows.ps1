Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class WinEnum2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public static void ListAll(uint targetPid) {
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == targetPid) {
        var sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        RECT r; GetWindowRect(h, out r);
        Console.WriteLine(string.Format("hwnd={0} vis={1} rect={2},{3},{4},{5} title={6}", h, IsWindowVisible(h), r.Left, r.Top, r.Right, r.Bottom, sb.ToString()));
      }
      return true;
    }, IntPtr.Zero);
  }
}
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
"@
$p = Get-Process novel-studio -ErrorAction SilentlyContinue | Select-Object -First 1
if ($p) { [WinEnum2]::ListAll([uint32]$p.Id) } else { Write-Output "not running" }
