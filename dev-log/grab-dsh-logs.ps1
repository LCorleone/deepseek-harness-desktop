# DSH Desktop log grabber - captures the pnpm error behind the free-search install failure
# Usage: right-click "Run with PowerShell", or: powershell -ExecutionPolicy Bypass -File .\grab-dsh-logs.ps1
# Output: dsh-logs-<timestamp>.txt on the Desktop - just send that file back

$ErrorActionPreference = 'SilentlyContinue'
$out = Join-Path ([Environment]::GetFolderPath('Desktop')) ("dsh-logs-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$new = New-Object System.Collections.Generic.List[string]

function Add-Line($t) { $new.Add($t) }

Add-Line ("=== DSH Desktop log grab {0} ===" -f (Get-Date))
Add-Line ""

$roots = @($env:APPDATA, $env:LOCALAPPDATA) | Where-Object { $_ }
$logFiles = @()
foreach ($root in $roots) {
  $logFiles += Get-ChildItem -Path $root -Filter 'dsh-*.log' -Recurse -Depth 3 -File -ErrorAction SilentlyContinue
}
$dshHome = Join-Path $env:USERPROFILE '.dsh'
if (Test-Path $dshHome) {
  $logFiles += Get-ChildItem -Path $dshHome -Filter '*.log' -Recurse -Depth 4 -File -ErrorAction SilentlyContinue
}
$logFiles = @($logFiles | Sort-Object LastWriteTime -Descending -Unique | Select-Object -First 8)

if ($logFiles.Count -eq 0) {
  Add-Line "!! No dsh-*.log found (searched $env:APPDATA / $env:LOCALAPPDATA depth 3, $dshHome depth 4)"
  Add-Line "   Please tell me the app install folder name (right-click app icon -> Open file location)"
} else {
  foreach ($f in $logFiles) {
    Add-Line ("--- file: {0}  (modified {1}, {2} KB) ---" -f $f.FullName, $f.LastWriteTime, [math]::Round($f.Length/1KB))
  }
  Add-Line ""

  foreach ($f in $logFiles) {
    $lines = Get-Content -LiteralPath $f.FullName -ErrorAction SilentlyContinue
    if (-not $lines) { continue }
    $hitIdx = New-Object System.Collections.Generic.List[int]
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match 'free-search|pnpm|market|tarball') { $hitIdx.Add($i) }
    }
    if ($hitIdx.Count -gt 0) {
      Add-Line ("===== excerpts: {0} =====" -f $f.Name)
      $emitted = New-Object System.Collections.Generic.HashSet[int]
      foreach ($idx in ($hitIdx | Select-Object -Last 40)) {
        $lo = [Math]::Max(0, $idx - 6); $hi = [Math]::Min($lines.Count - 1, $idx + 8)
        for ($j = $lo; $j -le $hi; $j++) {
          if ($emitted.Add($j)) { Add-Line ("{0,6}: {1}" -f ($j + 1), $lines[$j]) }
        }
        Add-Line "   ......"
      }
      Add-Line ""
    }
  }

  $latest = $logFiles[0]
  Add-Line ("===== tail of newest file: {0} (last 120 lines) =====" -f $latest.Name)
  $tail = Get-Content -LiteralPath $latest.FullName -Tail 120 -ErrorAction SilentlyContinue
  foreach ($l in $tail) { Add-Line $l }
}

Add-Line ""
Add-Line "=== environment snapshot ==="
Add-Line ("USERPROFILE = {0}" -f $env:USERPROFILE)
Add-Line ("APPDATA     = {0}" -f $env:APPDATA)
Add-Line ("username has non-ASCII chars: {0}" -f ($env:USERNAME -match '[^\x00-\x7F]'))
Add-Line ("USERPROFILE contains spaces: {0}" -f ($env:USERPROFILE -match ' '))

$new | Set-Content -LiteralPath $out -Encoding UTF8
Write-Host ""
Write-Host ("Done! Log saved to Desktop: {0}" -f $out) -ForegroundColor Green
Write-Host "Send that file back to dev."
Start-Sleep -Seconds 3
