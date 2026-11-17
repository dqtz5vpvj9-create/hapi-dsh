param(
    [string]$DshHome = 'D:\hapi\hhpi-win-source-dsh-home',
    [string]$Installer = 'D:\hapi\scripts\hhpi-retention-20261116\dist\install.mjs',
    [string]$Node = 'C:\nvm4w\nodejs\node.exe',
    [switch]$InstallTask
)
$ErrorActionPreference = 'Stop'
if ($InstallTask) {
    [void][scriptblock]::Create((Get-Content -LiteralPath $PSCommandPath -Raw))
    $principal = (Get-ScheduledTask -TaskName 'HAPI-background').Principal
    $action = New-ScheduledTaskAction -Execute (Get-Command pwsh.exe).Source -Argument ('-NoLogo -NoProfile -NonInteractive -File "'+$PSCommandPath+'"')
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 1)
    Register-ScheduledTask -TaskName 'HHPI-release-retention' -Action $action -Principal $principal -Settings $settings -Trigger $trigger -Force | Out-Null
    'HHPI-release-retention installed.'
    exit 0
}
$output = & $Node $Installer prune --dsh-home $DshHome --keep-previous 0 --json
$code = $LASTEXITCODE
if ($code -ne 0) { throw "HHPI release cleanup failed with exit code $code" }
$receipt = $output | ConvertFrom-Json
if (!$receipt.ok) { throw 'HHPI release cleanup did not report success' }
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath 'D:\hapi\state\hhpi-release-retention.json' -Encoding utf8NoBOM
$receipt | ConvertTo-Json -Depth 5 -Compress
