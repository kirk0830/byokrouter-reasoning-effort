# paratera-proxy-ctl.ps1 - process control for the byokrouter proxy
#
# Used by paratera-proxy.bat / paratera-proxy-stop.bat. Doing this in PowerShell
# avoids cmd's quoting rules for CIM filters, and avoids the classic false match
# where `tasklist /FI "PID eq 0"` returns "System Idle Process".
#
#   find   [port]  -> print the PID of the proxy (by command line, else by port)
#   pid    [port]  -> print the PID listening on the port
#   stop   [port]  -> stop the proxy; prints what it did
#   status [port]  -> PID + URL check

param(
  [Parameter(Position = 0)][ValidateSet('find', 'pid', 'stop', 'status')][string]$Command = 'status',
  [Parameter(Position = 1)][int]$Port = 8798
)

$ErrorActionPreference = 'SilentlyContinue'

function Get-ProxyByCommandLine {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*proxy.mjs*' } |
    Select-Object -ExpandProperty ProcessId
}

function Get-PidOnPort {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen
  if ($conn) { return @($conn | Select-Object -ExpandProperty OwningProcess -Unique) }
  # fall back to netstat when the cmdlet is unavailable
  $line = netstat -ano -p tcp | Select-String ":$Port\s.*LISTENING" | Select-Object -First 1
  if ($line -and $line.Line -match '(\d+)\s*$') { return @([int]$Matches[1]) }
  return @()
}

switch ($Command) {
  'find' {
    $ids = @(Get-ProxyByCommandLine)
    if ($ids.Count -eq 0) { $ids = @(Get-PidOnPort) }
    $ids | Where-Object { $_ -gt 0 } | Select-Object -Unique | ForEach-Object { $_ }
  }

  'pid' {
    Get-PidOnPort | Where-Object { $_ -gt 0 } | Select-Object -Unique | ForEach-Object { $_ }
  }

  'status' {
    $ids = @(Get-ProxyByCommandLine)
    if ($ids.Count -eq 0) { $ids = @(Get-PidOnPort) }
    $ids = @($ids | Where-Object { $_ -gt 0 } | Select-Object -Unique)
    if ($ids.Count -eq 0) {
      Write-Output 'stopped'
    } else {
      Write-Output ("running pid " + ($ids -join ', '))
      # When the proxy was started with an admin token (paratera-hardening.bat),
      # /_status requires it - read it from the file the hardening script writes.
      $headers = @{}
      $tokFile = Join-Path $PSScriptRoot '..\..\.state\admin.token'
      if (Test-Path -LiteralPath $tokFile) {
        $tok = (Get-Content -LiteralPath $tokFile -Raw).Trim()
        if ($tok) { $headers['Authorization'] = "Bearer $tok" }
      }
      try {
        $r = Invoke-RestMethod "http://127.0.0.1:$Port/_status" -Headers $headers -TimeoutSec 5
        Write-Output ("  effort: " + ($r.effort | ConvertTo-Json -Compress))
        Write-Output ("  counters: " + ($r.counters | ConvertTo-Json -Compress))
      } catch {
        $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        if ($code -eq 401) {
          Write-Output "  (/_status needs the admin token - see ..\..\.state\admin.token)"
        } else {
          Write-Output "  (port $Port is not answering _status)"
        }
      }
    }
  }

  'stop' {
    $ids = @(Get-ProxyByCommandLine)
    $viaPort = @(Get-PidOnPort)
    foreach ($p in $viaPort) { if ($ids -notcontains $p) { $ids += $p } }
    $ids = @($ids | Where-Object { $_ -gt 0 } | Select-Object -Unique)

    if ($ids.Count -eq 0) { Write-Output 'none'; break }

    foreach ($id in $ids) {
      Write-Output "killing $id"
      Stop-Process -Id $id -Force
    }
    Start-Sleep -Milliseconds 700
    $left = @(Get-PidOnPort | Where-Object { $_ -gt 0 })
    if ($left.Count -eq 0) { Write-Output 'stopped' } else { Write-Output ("still listening: " + ($left -join ', ')) }
  }
}
