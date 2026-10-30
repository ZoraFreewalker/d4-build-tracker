# Prints "<pid>|<process name>" of the foreground window whenever it changes.
# Usage: powershell -NoProfile -File focus.ps1 -ParentPid <pid>   (exits when that process is gone)
param([int]$ParentPid = 0)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$lastPid = -1; $tick = 0
while ($true) {
  $p = [uint32]0
  [Fg]::GetWindowThreadProcessId([Fg]::GetForegroundWindow(), [ref]$p) | Out-Null
  if ($p -ne $lastPid) {
    $lastPid = $p
    $name = try { (Get-Process -Id $p -ErrorAction Stop).ProcessName } catch { '' }
    [Console]::Out.WriteLine("$p|$name")
    [Console]::Out.Flush()
  }
  # don't outlive the app if it crashed
  if ($ParentPid -and (++$tick % 25 -eq 0) -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }
  Start-Sleep -Milliseconds 200
}
