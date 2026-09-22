#requires -version 5
<#
    Unregister the paper-engine scheduled task and delete its generated .cmd wrapper.
    Run: powershell -ExecutionPolicy Bypass -File scripts\remove-engine-task.ps1
    Keep ASCII-only (see note in setup-engine-task.ps1).
#>
$ErrorActionPreference = "Stop"

$name = "AShareTrader Engine (Paper)"
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host ("Unregistered: {0}" -f $name)
} else {
    Write-Host ("Not found: {0}" -f $name)
}

$cmd = Join-Path $PSScriptRoot ".run-engine.cmd"
if (Test-Path $cmd) { Remove-Item $cmd -Force; Write-Host ("Deleted: {0}" -f $cmd) }

Write-Host "Done. Note: if a manual engine instance is still running it was left untouched."

