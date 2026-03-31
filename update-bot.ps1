<#
.SYNOPSIS
Update kode terbaru dari GitHub dan restart bot PM2.

.DESCRIPTION
Skrip ini melakukan fetch/pull terbaru, install dependency produksi,
lalu restart proses PM2. Jika -AppName tidak diisi, skrip akan mencoba
auto-detect proses PM2 berdasarkan folder project saat ini.

.EXAMPLE
.\update-bot.ps1 -AutoStash -ShowLogs

.EXAMPLE
.\update-bot.ps1 -AppName fy-music-app -AutoStash
#>

param(
    [string]$Remote = "origin",
    [string]$Branch = "master",
    [string]$AppName,
    [switch]$AutoStash,
    [switch]$SkipNpm,
    [switch]$ShowLogs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [string[]]$Arguments = @()
    )

    Write-Host "`n==> $Label" -ForegroundColor Cyan
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        $joinedArgs = ($Arguments -join " ")
        throw "Perintah gagal: $Command $joinedArgs"
    }
}

function Normalize-PathText {
    param(
        [string]$PathText
    )

    if ([string]::IsNullOrWhiteSpace($PathText)) {
        return $null
    }

    try {
        return [System.IO.Path]::GetFullPath($PathText).TrimEnd([char[]]@('\', '/'))
    }
    catch {
        return $PathText.TrimEnd([char[]]@('\', '/'))
    }
}

function Resolve-Pm2AppName {
    param(
        [array]$Apps,
        [string]$RequestedName,
        [string]$ProjectDir
    )

    if ($RequestedName) {
        $byName = @($Apps | Where-Object { $_.name -ieq $RequestedName })
        if ($byName.Count -eq 1) {
            return $byName[0].name
        }

        Write-Host "`nProses PM2 '$RequestedName' tidak ditemukan. Daftar proses saat ini:" -ForegroundColor Yellow
        & pm2 list
        throw "Gunakan nilai -AppName yang valid, atau jalankan tanpa -AppName untuk auto-detect."
    }

    $projectDirNorm = Normalize-PathText -PathText $ProjectDir
    $appsByProject = @(
        $Apps | Where-Object {
            $cwdNorm = Normalize-PathText -PathText $_.pm2_env.pm_cwd
            $execNorm = Normalize-PathText -PathText $_.pm2_env.pm_exec_path

            ($cwdNorm -and $cwdNorm -ieq $projectDirNorm) -or
            ($execNorm -and $projectDirNorm -and $execNorm.StartsWith($projectDirNorm, [System.StringComparison]::OrdinalIgnoreCase))
        }
    )

    if ($appsByProject.Count -eq 1) {
        $detected = $appsByProject[0].name
        Write-Host "Auto-detect PM2 app: $detected" -ForegroundColor Green
        return $detected
    }

    if ($appsByProject.Count -gt 1) {
        $onlineApps = @($appsByProject | Where-Object { $_.pm2_env.status -eq "online" })
        if ($onlineApps.Count -eq 1) {
            $detectedOnline = $onlineApps[0].name
            Write-Host "Auto-detect PM2 app (online): $detectedOnline" -ForegroundColor Green
            return $detectedOnline
        }

        $names = ($appsByProject | ForEach-Object { $_.name }) -join ", "
        throw "Auto-detect menemukan beberapa app di folder ini: $names. Jalankan lagi dengan -AppName untuk memilih app."
    }

    if ($Apps.Count -eq 1) {
        $fallback = $Apps[0].name
        Write-Host "Auto-detect fallback (satu app PM2 tersedia): $fallback" -ForegroundColor Yellow
        return $fallback
    }

    throw "Tidak bisa auto-detect PM2 app. Jalankan dengan parameter -AppName."
}

function Get-Pm2AppsSnapshot {
        $nodeScript = @"
const { execSync } = require('child_process');

function safeString(value) {
    if (value === null || value === undefined) return '';
    return String(value);
}

let raw;
try {
    raw = execSync('pm2 jlist', { encoding: 'utf8' });
} catch (err) {
    const stderr = err && err.stderr ? String(err.stderr) : '';
    const message = stderr || (err && err.message ? String(err.message) : 'pm2 jlist failed');
    console.error(message.trim());
    process.exit(1);
}

let parsed;
try {
    parsed = JSON.parse(raw);
} catch (err) {
    console.error('Invalid JSON from pm2 jlist: ' + (err && err.message ? err.message : err));
    process.exit(1);
}

const simplified = (Array.isArray(parsed) ? parsed : []).map((app) => {
    const env = app && app.pm2_env ? app.pm2_env : {};
    return {
        name: safeString(app && app.name),
        pm2_env: {
            status: safeString(env.status),
            pm_cwd: safeString(env.pm_cwd),
            pm_exec_path: safeString(env.pm_exec_path)
        }
    };
});

process.stdout.write(JSON.stringify(simplified));
"@

        $pm2SnapshotJson = & node -e $nodeScript
        if ($LASTEXITCODE -ne 0 -or -not $pm2SnapshotJson) {
                throw "Gagal membaca daftar proses PM2."
        }

        try {
                return @($pm2SnapshotJson | ConvertFrom-Json)
        }
        catch {
                throw "Gagal memproses data PM2 snapshot."
        }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git tidak ditemukan. Install Git terlebih dahulu."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm tidak ditemukan. Pastikan Node.js sudah terpasang."
}

if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    throw "PM2 tidak ditemukan. Install dengan: npm install -g pm2"
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

if (-not (Test-Path ".\\package.json")) {
    throw "package.json tidak ditemukan. Pastikan skrip dijalankan dari folder proyek bot."
}

$insideRepo = (& git rev-parse --is-inside-work-tree 2>$null)
if (-not $insideRepo -or $insideRepo.Trim() -ne "true") {
    throw "Folder saat ini bukan repositori Git yang valid."
}

$dirty = (& git status --porcelain)
$didStash = $false
if ($dirty) {
    if ($AutoStash) {
        $stamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss"
        Invoke-Step -Label "Menyimpan perubahan lokal sementara (stash)" -Command "git" -Arguments @("stash", "push", "-u", "-m", "auto-stash sebelum update $stamp")
        $didStash = $true
    }
    else {
        throw "Ada perubahan lokal. Jalankan lagi dengan -AutoStash atau commit/stash manual dulu."
    }
}

Invoke-Step -Label "Ambil update terbaru dari remote" -Command "git" -Arguments @("fetch", $Remote, "--prune")
Invoke-Step -Label "Tarik update branch terbaru (fast-forward only)" -Command "git" -Arguments @("pull", "--ff-only", $Remote, $Branch)

$pm2Apps = Get-Pm2AppsSnapshot
if ($pm2Apps.Count -eq 0) {
    throw "Belum ada proses PM2 terdaftar. Jalankan bot dulu dengan pm2 start index.js --name fy-music-app"
}

$resolvedAppName = Resolve-Pm2AppName -Apps $pm2Apps -RequestedName $AppName -ProjectDir $scriptDir
$targetPm2App = $pm2Apps | Where-Object { $_.name -ieq $resolvedAppName } | Select-Object -First 1
$pm2WasOnline = $false
if ($targetPm2App -and $targetPm2App.pm2_env.status -eq "online") {
    $pm2WasOnline = $true
}

if (-not $SkipNpm -and $pm2WasOnline) {
    Invoke-Step -Label "Stop proses PM2 '$resolvedAppName' sementara (hindari file lock saat npm)" -Command "pm2" -Arguments @("stop", $resolvedAppName)
}

if (-not $SkipNpm) {
    $installArgs = @("install", "--omit=dev")
    $installLabel = "Install dependency produksi (npm install)"
    if (Test-Path ".\\package-lock.json") {
        $installArgs = @("ci", "--omit=dev")
        $installLabel = "Install dependency produksi (npm ci)"
    }

    try {
        Invoke-Step -Label $installLabel -Command "npm" -Arguments $installArgs
    }
    catch {
        $rawErrorText = $_.Exception.Message
        $isLockError = ($rawErrorText -match "EPERM") -or ($rawErrorText -match "EBUSY") -or ($rawErrorText -match "operation not permitted")

        if ($isLockError) {
            Write-Host "`nTerdeteksi lock file Windows saat install dependency. Menjalankan recovery otomatis..." -ForegroundColor Yellow

            # Pastikan proses PM2 berhenti agar native module tidak terkunci saat reinstall.
            & pm2 stop $resolvedAppName | Out-Null
            Start-Sleep -Seconds 2

            $escapedProjectDir = [regex]::Escape($scriptDir)
            $projectNodeProcesses = @(
                Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -and $_.CommandLine -match $escapedProjectDir }
            )

            if ($projectNodeProcesses.Count -gt 0) {
                Write-Host "Menutup proses node yang masih memakai folder project..." -ForegroundColor Yellow
                foreach ($proc in $projectNodeProcesses) {
                    try {
                        Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
                    }
                    catch {
                        # Lanjutkan recovery untuk proses lain.
                    }
                }
                Start-Sleep -Seconds 1
            }

            if (Test-Path ".\\node_modules") {
                Write-Host "Membersihkan node_modules untuk clean reinstall..." -ForegroundColor Yellow
                Remove-Item ".\\node_modules" -Recurse -Force -ErrorAction SilentlyContinue
                if (Test-Path ".\\node_modules") {
                    Invoke-Step -Label "Hapus node_modules (fallback cmd)" -Command "cmd" -Arguments @("/c", "rmdir /s /q node_modules")
                }
            }

            try {
                Invoke-Step -Label "Install dependency produksi ulang (recovery)" -Command "npm" -Arguments $installArgs
            }
            catch {
                if ($pm2WasOnline) {
                    Write-Host "`nRecovery gagal. Mencoba menyalakan kembali app PM2..." -ForegroundColor Yellow
                    & pm2 restart $resolvedAppName --update-env | Out-Null
                }
                throw
            }
        }
        else {
            if ($pm2WasOnline) {
                Write-Host "`nInstall dependency gagal. Mencoba menyalakan kembali app PM2..." -ForegroundColor Yellow
                & pm2 restart $resolvedAppName --update-env | Out-Null
            }
            throw
        }
    }
}

Invoke-Step -Label "Restart proses PM2 '$resolvedAppName'" -Command "pm2" -Arguments @("restart", $resolvedAppName, "--update-env")
Invoke-Step -Label "Simpan konfigurasi PM2" -Command "pm2" -Arguments @("save")

if ($didStash) {
    Write-Host "`nPerubahan lokal sudah di-stash otomatis." -ForegroundColor Yellow
    Write-Host "Cek dengan: git stash list"
    Write-Host "Pulihkan lagi dengan: git stash pop"
}

if ($ShowLogs) {
    Write-Host "`nMenampilkan 60 baris log terakhir..." -ForegroundColor Cyan
    & pm2 logs $resolvedAppName --lines 60
}

Write-Host "`nSelesai. Bot sudah diperbarui dari GitHub dan direstart lewat PM2." -ForegroundColor Green