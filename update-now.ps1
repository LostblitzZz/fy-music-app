<#
.SYNOPSIS
Shortcut satu-perintah untuk update bot PM2.

.DESCRIPTION
Wrapper untuk update-bot.ps1 dengan default aman agar proses update
di laptop lain cukup jalankan satu command.

.EXAMPLE
.\update-now.ps1

.EXAMPLE
.\update-now.ps1 -ShowLogs
#>

param(
    [switch]$ShowLogs,
    [switch]$SkipNpm,
    [switch]$ForceNpm,
    [string]$AppName,
    [string]$Remote = "origin",
    [string]$Branch = "master",
    [switch]$NoAutoStash
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$updaterPath = Join-Path $scriptDir "update-bot.ps1"
if (-not (Test-Path $updaterPath)) {
    throw "File update-bot.ps1 tidak ditemukan di folder project."
}

$args = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $updaterPath,
    "-Remote", $Remote,
    "-Branch", $Branch
)

if (-not $NoAutoStash) {
    $args += "-AutoStash"
}

if ($SkipNpm) {
    $args += "-SkipNpm"
}

if ($ForceNpm) {
    $args += "-ForceNpm"
}

if ($ShowLogs) {
    $args += "-ShowLogs"
}

if ($AppName) {
    $args += @("-AppName", $AppName)
}

Write-Host "Memulai update otomatis..." -ForegroundColor Cyan
Write-Host "Perintah: update-bot.ps1 (wrapper mode)"

& powershell @args

if ($LASTEXITCODE -ne 0) {
    throw "Update gagal dengan exit code $LASTEXITCODE"
}

Write-Host "Update selesai." -ForegroundColor Green