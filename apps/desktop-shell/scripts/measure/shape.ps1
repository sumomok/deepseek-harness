# Separate the per-file cost of an install from its per-byte cost, by moving the
# same number of bytes in two shapes: the real payload's 12452 files, and the
# same total as a handful of large ones.
#
# Everything measured so far is from one NVMe device — C:, D:, E: and F: are
# partitions of a single ZHITAI TiPlus5000, so "cross-volume" here is a
# filesystem boundary and not a second spindle. On a mechanical disk the
# per-byte term scales with throughput while the per-file term scales with seek
# time, which is two orders of magnitude worse; this split is what lets the two
# be extrapolated separately instead of guessed at together.
#
# Usage: shape.ps1   (sources are built once, then three timed runs)

$ErrorActionPreference = 'Stop'
$sevenZip = 'D:\soft\7-Zip\7z.exe'
$archive = "$PSScriptRoot\app-64.7z"
$work = "$env:TEMP\dsh-shape"
$dest = 'D:\_dsh-shape'
$runs = 3
$bigFiles = 10

function Fresh($p) { if (Test-Path $p) { Remove-Item -LiteralPath $p -Recurse -Force }; New-Item -ItemType Directory -Path $p | Out-Null }
function Secs($block) { $sw = [Diagnostics.Stopwatch]::StartNew(); & $block; $sw.Stop(); [math]::Round($sw.Elapsed.TotalSeconds, 2) }

Fresh $work
"building sources under $work"
& $sevenZip x $archive "-o$work\many" -y -bso0 -bsp0 | Out-Null
$manyFiles = @(Get-ChildItem "$work\many" -Recurse -File -Force)
$bytes = ($manyFiles | Measure-Object Length -Sum).Sum
"  many: $($manyFiles.Count) files, $([math]::Round($bytes/1MB,1)) MB"

# The same byte total as `$bigFiles` files, written from a repeating buffer so
# the content is incompressible-agnostic — nothing here compresses, both shapes
# are plain copies.
New-Item -ItemType Directory -Path "$work\few" | Out-Null
$per = [long][math]::Floor($bytes / $bigFiles)
$buffer = New-Object byte[] (8MB)
(New-Object Random 1).NextBytes($buffer)
foreach ($i in 1..$bigFiles) {
  $fs = [System.IO.File]::Create("$work\few\blob$i.bin")
  $written = [long]0
  while ($written -lt $per) {
    $chunk = [int][math]::Min($buffer.Length, $per - $written)
    $fs.Write($buffer, 0, $chunk)
    $written += $chunk
  }
  $fs.Close()
}
$fewFiles = @(Get-ChildItem "$work\few" -File)
"  few:  $($fewFiles.Count) files, $([math]::Round((($fewFiles | Measure-Object Length -Sum).Sum)/1MB,1)) MB"
""

$r = @{ copyMany = @(); copyFew = @(); delMany = @(); delFew = @() }

foreach ($i in 1..$runs) {
  "run $i"
  Fresh $dest
  $r.copyMany += Secs { & robocopy "$work\many" "$dest\many" /E /MT:1 /NFL /NDL /NJH /NJS /NP | Out-Null }
  $r.copyFew  += Secs { & robocopy "$work\few"  "$dest\few"  /E /MT:1 /NFL /NDL /NJH /NJS /NP | Out-Null }
  $r.delMany  += Secs { Remove-Item -LiteralPath "$dest\many" -Recurse -Force }
  $r.delFew   += Secs { Remove-Item -LiteralPath "$dest\few"  -Recurse -Force }
  "  copy many {0} s / copy few {1} s / del many {2} s / del few {3} s" -f $r.copyMany[-1], $r.copyFew[-1], $r.delMany[-1], $r.delFew[-1]
}

function Median($a) { $s = @($a | Sort-Object); $s[[math]::Floor($s.Count / 2)] }

$cm = Median $r.copyMany; $cf = Median $r.copyFew
$dm = Median $r.delMany;  $df = Median $r.delFew
$n = $manyFiles.Count - $fewFiles.Count
$mb = [math]::Round($bytes / 1MB, 1)

""
"=== medians over $runs runs, $mb MB either way ==="
"copy {0,6} files : {1,6} s   (runs: {2})" -f $manyFiles.Count, $cm, ($r.copyMany -join ', ')
"copy {0,6} files : {1,6} s   (runs: {2})" -f $fewFiles.Count, $cf, ($r.copyFew -join ', ')
"delete {0,4} files : {1,6} s   (runs: {2})" -f $manyFiles.Count, $dm, ($r.delMany -join ', ')
"delete {0,4} files : {1,6} s   (runs: {2})" -f $fewFiles.Count, $df, ($r.delFew -join ', ')
""
"per-byte  (from the few-file copy): {0} MB/s" -f [math]::Round($mb / $cf, 1)
"per-file  (copy):   {0} ms/file" -f [math]::Round((($cm - $cf) / $n) * 1000, 3)
"per-file  (delete): {0} ms/file" -f [math]::Round((($dm - $df) / $n) * 1000, 3)
""
"share of the many-file copy that is per-file overhead: {0}%" -f [math]::Round((($cm - $cf) / $cm) * 100)

Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
