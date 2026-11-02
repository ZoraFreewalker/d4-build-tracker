# Prints "<pid>|<process name>|<left>,<top>,<right>,<bottom>" of the foreground window whenever it (or its
# position) changes. The rectangle is in physical pixels, so the app can tell which monitor the game is on.
# Usage: powershell -NoProfile -File focus.ps1 -ParentPid <pid>   (exits when that process is gone)
param([int]$ParentPid = 0)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Fg {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[Fg]::SetProcessDPIAware() | Out-Null # real pixel coordinates instead of DPI-virtualized ones
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$last = ''; $lastPid = -1; $name = ''; $tick = 0
while ($true) {
  $h = [Fg]::GetForegroundWindow()
  $p = [uint32]0
  [Fg]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if ($p -ne $lastPid) {
    $lastPid = $p
    $name = try { (Get-Process -Id $p -ErrorAction Stop).ProcessName } catch { '' }
  }
  $r = New-Object Fg+RECT
  [Fg]::GetWindowRect($h, [ref]$r) | Out-Null
  $line = "$p|$name|$($r.L),$($r.T),$($r.R),$($r.B)"
  if ($line -ne $last) {
    $last = $line
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
  }
  # don't outlive the app if it crashed
  if ($ParentPid -and (++$tick % 25 -eq 0) -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }
  Start-Sleep -Milliseconds 200
}
