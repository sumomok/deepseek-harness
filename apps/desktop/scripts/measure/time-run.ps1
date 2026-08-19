# Time one installer or uninstaller run, with an observer cheap enough not to
# change the answer.
#
# The earlier timings sampled `Get-ChildItem -Recurse` over the install
# directory every 400 ms. One such walk costs ~530 ms on this payload, so the
# observer ran at a 133% duty cycle against the very tree being written and
# inflated the file-copy phase roughly sixfold. This watches only whether a
# process matching a name pattern exists and what its dialog titles say — both
# constant-time, both well under a millisecond.
#
# Usage: time-run.ps1 -Exe <path> -Watch 'DSH Desktop Setup*','Un_*' [-AwaitApp]

param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string[]]$Watch,
  [switch]$AwaitApp
)

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumWindowsProc cb, IntPtr l);
  static int Target; static StringBuilder Found;
  // The wizard's caption never changes; which page is showing is only legible
  // from the static controls inside it, so the phase boundaries need the
  // children. Enumerating them is still a constant-time call — what made the
  // earlier observer ruinous was walking the install directory, not this.
  public static string Title(int pid) {
    Target = pid; Found = new StringBuilder();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      int p; GetWindowThreadProcessId(h, out p);
      if (p != Target) return true;
      var c = new StringBuilder(64); GetClassNameW(h, c, 64);
      if (c.ToString() != "#32770") return true;
      EnumChildWindows(h, delegate(IntPtr ch, IntPtr l2) {
        if (!IsWindowVisible(ch)) return true;
        var cc = new StringBuilder(64); GetClassNameW(ch, cc, 64);
        if (cc.ToString() != "Static") return true;
        var tt = new StringBuilder(256); GetWindowTextW(ch, tt, 256);
        if (tt.Length > 0) { Found.Append(tt.ToString()); Found.Append(" | "); }
        return true;
      }, IntPtr.Zero);
      return false;
    }, IntPtr.Zero);
    return Found.ToString();
  }
}
'@ -Language CSharp

function Matching { @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $n = $_.Name; ($Watch | Where-Object { $n -like $_ }).Count -gt 0 }) }

$clock = [Diagnostics.Stopwatch]::StartNew()
$marks = New-Object System.Collections.ArrayList
function Mark($name) {
  $s = [math]::Round($clock.Elapsed.TotalSeconds, 2)
  [void]$marks.Add([pscustomobject]@{ At = $s; Event = $name })
  Write-Host ("  {0,7} s  {1}" -f $s, $name)
}

Write-Host "launching: $Exe"
Start-Process -FilePath $Exe | Out-Null
Mark 'process launched'

$lastTitle = ''
$seen = $false
$gone = $false

while ($clock.Elapsed.TotalSeconds -lt 900) {
  $procs = Matching
  if ($procs.Count -gt 0) {
    $seen = $true
    $title = [W]::Title($procs[0].Id)
    if ($title -and $title -ne $lastTitle) { Mark "window: $title"; $lastTitle = $title }
  } elseif ($seen -and -not $gone) {
    Mark 'process exited'
    $gone = $true
    if (-not $AwaitApp) { break }
  }
  if ($gone -and $AwaitApp -and @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue).Count -gt 0) {
    Mark 'app process present again'
    break
  }
  Start-Sleep -Milliseconds 250
}

""
"=== timeline ==="
$marks | ForEach-Object { "{0,7} s  {1}" -f $_.At, $_.Event }
""
"observer cost per sample: single Get-Process plus one EnumWindows — sub-millisecond,"
"against a payload whose directory walk costs ~530 ms."
