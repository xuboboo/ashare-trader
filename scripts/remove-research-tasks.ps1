#requires -version 5
<#
    Unregister the two tasks created by setup-research-tasks.ps1 and delete the generated .cmd wrappers.
    Run: powershell -ExecutionPolicy Bypass -File scripts\remove-research-tasks.ps1
    Keep ASCII-only (see note in setup-research-tasks.ps1 about PowerShell 5.1 ANSI decoding).
#>
$ErrorActionPreference = "Stop"

$names = @(
    "AShareTrader Research Accumulate",
    "AShareTrader Research Recorder"
)
foreach ($n in $names) {
    if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $n -Confirm:$false
        Write-Host ("Unregistered: {0}" -f $n)
    } else {
        Write-Host ("Not found: {0}" -f $n)
    }
}

foreach ($cmd in @(".run-accumulate.cmd", ".run-recorder.cmd")) {
    $p = Join-Path $PSScriptRoot $cmd
    if (Test-Path $p) { Remove-Item $p -Force; Write-Host ("Deleted: {0}" -f $p) }
}

Write-Host "Done. Log files (data\research\.cron-*.log) were left in place; remove manually if wanted."

