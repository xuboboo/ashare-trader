#requires -version 5
<#
    Watchdog v2: restart the paper engine ONLY when its listen port (3005) is
    provably down for two consecutive checks (10 minutes).

    v1 defect (2026-09-23 13:49-14:06 incident): it used Invoke-WebRequest as the
    health signal and called Stop-ScheduledTask on a single failed probe. A spurious
    probe failure killed a LIVE engine with 4 open positions, every 5 minutes.

    v2 design
      - primary signal = kernel TCP state of port 3005 (Get-NetTCPConnection):
        it does not go through the network stack, so it cannot fail spuriously.
      - two consecutive "port down" checks required before acting (state file
        data\watchdog-state.json), so a single flake or a normal restart boot
        window never triggers a kill.
      - acting = Stop- then Start-ScheduledTask (a dead process leaves the task
        instance "Running"; IgnoreNew would swallow a plain Start).
      - acts only on weekdays 08:55..15:05: a restart outside that window can be
        killed by the task's 7h ExecutionTimeLimit right inside a later session.
      - restarting with open positions is safe: trades.jsonl is the only source
        of truth; positions.json is a cache rebuilt and cross-checked on boot.

    Install (current user, no admin):
      powershell -ExecutionPolicy Bypass -File scripts\watchdog.ps1 -Install

    Keep ASCII-only: Windows PowerShell 5.1 decodes non-BOM scripts as ANSI (GBK here).
#>
param([switch]$Install)

$ErrorActionPreference = "SilentlyContinue"
$taskName = "AShareTrader Engine (Paper)"
$scriptsDir = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $scriptsDir "..")).Path
$log = Join-Path $repo "data\watchdog.log"
$stateFile = Join-Path $repo "data\watchdog-state.json"

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
    Register-ScheduledTask -TaskName "AShareTrader Watchdog" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Write-Host ("Registered: AShareTrader Watchdog (every 5 minutes; acts on two consecutive port-down checks, weekdays 08:55-15:05)")
    exit 0
}

# ---- guard: weekdays only, 08:55..15:05 only ----
$now = Get-Date
if ($now.DayOfWeek -eq "Saturday" -or $now.DayOfWeek -eq "Sunday") { exit 0 }
$minutes = $now.Hour * 60 + $now.Minute
if ($minutes -lt 535 -or $minutes -gt 905) { exit 0 }

# ---- primary signal: is port 3005 listening (kernel state, cannot flake) ----
$listening = Get-NetTCPConnection -LocalPort 3005 -State Listen -ErrorAction SilentlyContinue

if ($listening) {
    if (Test-Path $stateFile) { Remove-Item $stateFile -Force }
    exit 0
}

# ---- port is down ----
# 连续计数直接看 watchdog.log（Add-Content/Get-Content 在本环境已验证可靠；独立状态文件
# 在计划任务子进程里 Set-Content 会静默失败，v2 实测踩中）。数最近 15 分钟内的 down 行（含本次）。
Log "port 3005 down"
$recentDown = 0
$cut = (Get-Date).AddMinutes(-15)
foreach ($line in (Get-Content $log -Tail 12 -ErrorAction SilentlyContinue)) {
    if ($line -match '^(....-..-.. ..:..:..)  port 3005 down') {
        try {
            $t = [datetime]::ParseExact($matches[1], "yyyy-MM-dd HH:mm:ss", [System.Globalization.CultureInfo]::InvariantCulture)
            if (($now - $t).TotalMinutes -le 15) { $recentDown++ }
        } catch { }
    }
}
Log ("consecutive down checks in last 15 min: {0}" -f $recentDown)
if ($recentDown -lt 2) {
    Log "first failure: wait for the next cycle before acting (boot window / single flake)"
    exit 0
}

# ---- act: clear the task instance, then start a fresh engine ----
Log "two consecutive port-down checks -> restarting engine task"
Stop-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 30
$up = Get-NetTCPConnection -LocalPort 3005 -State Listen -ErrorAction SilentlyContinue
if ($up) {
    Log "restarted, port 3005 listening again"
} else {
    Log "restart attempted but port 3005 still down (needs human)"
}
