#requires -version 5
<#
    Watchdog: if the paper engine is not answering on 127.0.0.1:3005 during trading
    hours, restart its scheduled task ("AShareTrader Engine (Paper)").

    Why it exists: on 2026-09-23 the engine died silently at 09:25 after 9542 rounds
    (no error line anywhere). With open positions a silent stop is the worst failure
    mode, and nothing else notices it.

    Safety design
      - acts only on weekdays inside 08:55..15:05. A restart outside that window can
        be killed by the task's own 7h ExecutionTimeLimit right in the middle of a
        later session (e.g. a 03:00 restart dies at 10:00), which is worse than dead.
      - never touches anything when the engine answers (GET / must be HTTP 200 and
        mention the model id).
      - restarting with open positions is safe: trades.jsonl is the only source of
        truth, positions.json is a cache rebuilt on boot (verified by Book.verify).
      - Stop- then Start-ScheduledTask: a dead process can leave the task instance
        "Running", and MultipleInstances=IgnoreNew would swallow the restart.

    Install (one line, current user, no admin):
      powershell -ExecutionPolicy Bypass -File scripts\watchdog.ps1 -Install
    The -Install switch registers "AShareTrader Watchdog" to run this script every
    5 minutes; the script itself no-ops outside the weekday/trading window.

    Keep ASCII-only: Windows PowerShell 5.1 decodes non-BOM scripts as ANSI (GBK here).
#>
param([switch]$Install)

$ErrorActionPreference = "SilentlyContinue"
$taskName = "AShareTrader Watchdog"
$scriptsDir = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $scriptsDir "..")).Path
$log = Join-Path $repo "data\watchdog.log"

function Log($msg) {
    Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg)
}

if ($Install) {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument ("-NoProfile -ExecutionPolicy Bypass -File `"{0}`"" -f (Join-Path $scriptsDir "watchdog.ps1")) `
        -WorkingDirectory $repo
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
        -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Write-Host ("Registered: {0} (every 5 minutes; acts only on weekdays 08:55-15:05)" -f $taskName)
    exit 0
}

# ---- guard: weekdays only, 08:55..15:05 only ----
$now = Get-Date
if ($now.DayOfWeek -eq "Saturday" -or $now.DayOfWeek -eq "Sunday") { exit 0 }
$minutes = $now.Hour * 60 + $now.Minute
if ($minutes -lt 535 -or $minutes -gt 905) { exit 0 }

# ---- check ----
$alive = $false
try {
    $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:3005/" -TimeoutSec 5
    $alive = ($r.StatusCode -eq 200) -and ($r.Content -match "jev-")
} catch { $alive = $false }
if ($alive) { exit 0 }

# ---- restart ----
Log "engine down during trading window -> restarting task"
Stop-ScheduledTask -TaskName "AShareTrader Engine (Paper)"
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName "AShareTrader Engine (Paper)"
Start-Sleep -Seconds 25
try {
    $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:3005/" -TimeoutSec 8
    Log ("restarted, HTTP " + $r.StatusCode)
} catch {
    Log "restart attempted but engine still not answering (needs human)"
}
