# Apricot one-time setup for Windows (macOS/Linux: scripts/setup.sh).
#  - installs the Android SDK pieces Apricot needs (adb + emulator + a system image)
#  - creates a ready-to-use virtual phone ("Apricot_Phone")
#  - downloads scrcpy-server (screen streaming + input)
#  - installs the server's npm dependencies
# Run from the repo root:  powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
# Safe to re-run: every step is skipped when already done.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is 10x slower with the progress bar

$ScrcpyVersion = if ($env:APRICOT_SCRCPY_VERSION) { $env:APRICOT_SCRCPY_VERSION } else { '5.0.1' }
$ApiLevel      = if ($env:APRICOT_API_LEVEL) { $env:APRICOT_API_LEVEL } else { '35' }
$AvdName       = if ($env:APRICOT_AVD_NAME) { $env:APRICOT_AVD_NAME } else { 'Apricot_Phone' }
$AvdDevice     = if ($env:APRICOT_AVD_DEVICE) { $env:APRICOT_AVD_DEVICE } else { 'pixel_7' }
$Repo          = 'https://dl.google.com/android/repository'

$Root = Split-Path -Parent $PSScriptRoot
$Sdk  = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$env:ANDROID_HOME = $Sdk

function Step($text) { Write-Host ""; Write-Host "> $text" -ForegroundColor DarkYellow }
function Ok($text)   { Write-Host "  [ok] $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  [!]  $text" -ForegroundColor Yellow }
function Die($text)  { Write-Host "  [x]  $text" -ForegroundColor Red; exit 1 }
# Windows PowerShell 5.1 turns redirected native stderr into terminating errors under 'Stop'.
function Invoke-Quiet {
    param([string]$Exe, [string[]]$Arguments)
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Exe @Arguments 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $old }
}
function Invoke-Checked {
    param([string]$Exe, [string[]]$Arguments, [string]$Stdin)
    if ($Stdin) { $Stdin | & $Exe @Arguments } else { & $Exe @Arguments }
    if ($LASTEXITCODE -ne 0) { Die "$([IO.Path]::GetFileName($Exe)) failed (exit $LASTEXITCODE)" }
}

if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
    Warn "The Android emulator doesn't run on Windows on ARM. Apricot still works with a real Android phone over USB."
    $NoEmulator = $true
    $Abi = 'arm64-v8a'
} else {
    $NoEmulator = $false
    $Abi = 'x86_64'
}
$Image = "system-images;android-$ApiLevel;google_apis;$Abi"

Write-Host ""
Write-Host "  Apricot setup  (Windows, Android SDK: $Sdk)" -ForegroundColor White

# ---------- prerequisites ----------
Step 'Checking prerequisites'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'Node.js 20+ is required: winget install OpenJS.NodeJS.LTS' }
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) { Die "Node.js 20+ is required (found $(node -v))" }
Ok "Node $(node -v)"

if (Get-Command java -ErrorAction SilentlyContinue) {
    Ok 'Java available'
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    Warn 'Installing a Java runtime (needed by the Android SDK tools)'
    winget install --silent --accept-source-agreements --accept-package-agreements EclipseAdoptium.Temurin.17.JRE | Out-Null
    $jre = Get-ChildItem 'C:\Program Files\Eclipse Adoptium' -Directory -Filter 'jre-17*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($jre) { $env:JAVA_HOME = $jre.FullName; $env:Path = "$($jre.FullName)\bin;$env:Path" }
    if (-not (Get-Command java -ErrorAction SilentlyContinue)) { Die 'Java was installed but is not on PATH yet. Open a new terminal and re-run.' }
} else {
    Die 'Install Java 17+ from https://adoptium.net, then re-run.'
}

# ---------- Android command-line tools ----------
Step 'Android SDK'
$Tools = Join-Path $Sdk 'cmdline-tools\latest\bin'
$SdkManager = Join-Path $Tools 'sdkmanager.bat'
$AvdManager = Join-Path $Tools 'avdmanager.bat'
if (-not (Test-Path $SdkManager)) {
    # Google's own zip, installed inside the SDK so sdkmanager/avdmanager agree on the SDK root.
    $index = (Invoke-WebRequest -UseBasicParsing "$Repo/repository2-3.xml").Content
    $zip = [regex]::Matches($index, 'commandlinetools-win-(\d+)_latest\.zip') |
        Sort-Object { [int64]$_.Groups[1].Value } | Select-Object -Last 1
    if (-not $zip) { Die "Couldn't find the Android command-line tools download." }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("apricot-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    Warn "Downloading $($zip.Value)"
    Invoke-WebRequest -UseBasicParsing "$Repo/$($zip.Value)" -OutFile "$tmp\tools.zip"
    Expand-Archive "$tmp\tools.zip" -DestinationPath $tmp
    New-Item -ItemType Directory -Force -Path (Join-Path $Sdk 'cmdline-tools') | Out-Null
    $latest = Join-Path $Sdk 'cmdline-tools\latest'
    if (Test-Path $latest) { Remove-Item -Recurse -Force $latest }
    Move-Item "$tmp\cmdline-tools" $latest
    Remove-Item -Recurse -Force $tmp
}
# Accept licenses (sdkmanager asks once per license)
("y`n" * 30) | & $SdkManager "--sdk_root=$Sdk" --licenses | Out-Null

$packages = @('platform-tools')
if (-not $NoEmulator) { $packages += 'emulator' }
$adb = Join-Path $Sdk 'platform-tools\adb.exe'
$emulator = Join-Path $Sdk 'emulator\emulator.exe'
if ((Test-Path $adb) -and ($NoEmulator -or (Test-Path $emulator))) {
    Ok "Already installed: $($packages -join ', ')"
} else {
    Invoke-Checked $SdkManager (@("--sdk_root=$Sdk") + $packages)
    Ok "Installed $($packages -join ', ')"
}

# ---------- hardware acceleration ----------
if (-not $NoEmulator) {
    Step 'Hardware acceleration'
    $accel = (Invoke-Quiet $emulator @('-accel-check') | Out-String)
    if ($accel -match 'is installed and usable|WHPX.*usable|AEHD.*usable') {
        Ok 'Hypervisor available'
    } else {
        Warn 'The emulator needs virtualization. Enable "Windows Hypervisor Platform" (run as admin, then reboot):'
        Warn '  Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All'
        Warn 'Also make sure virtualization (VT-x / AMD-V / SVM) is enabled in your BIOS.'
    }
}

# ---------- virtual phone ----------
if (-not $NoEmulator) {
    Step "Virtual phone ($AvdName)"
    $avds = @(Invoke-Quiet $emulator @('-list-avds') | Where-Object { $_ -and $_ -notmatch '\s' })
    if ($avds -contains $AvdName) {
        Ok "$AvdName already exists"
    } elseif ($avds.Count -gt 0) {
        Ok "Using your existing virtual devices: $($avds -join ' ')"
    } else {
        Warn "Downloading Android $ApiLevel system image (~1.5 GB, one time)"
        Invoke-Checked $SdkManager @("--sdk_root=$Sdk", $Image)
        Invoke-Checked $AvdManager @('create', 'avd', '--force', '--name', $AvdName, '--package', $Image, '--device', $AvdDevice) -Stdin 'no'
        $config = Join-Path $env:USERPROFILE ".android\avd\$AvdName.avd\config.ini"
        if (Test-Path $config) {
            # Hardware keyboard, host GPU (needed for a smooth stream) and a sensible amount of RAM
            $wanted = [ordered]@{ 'hw.keyboard' = 'yes'; 'hw.gpu.enabled' = 'yes'; 'hw.gpu.mode' = 'host'; 'hw.ramSize' = '4096' }
            $lines = @(Get-Content $config | Where-Object { -not $wanted.Contains(($_ -split '=', 2)[0]) })
            $lines += @($wanted.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })
            Set-Content -Path $config -Value $lines -Encoding ASCII
        }
        Ok "Created $AvdName"
    }
}

# ---------- scrcpy-server ----------
Step "scrcpy-server v$ScrcpyVersion"
$vendor = Join-Path $Root 'server\vendor'
$jar = Join-Path $vendor "scrcpy-server-v$ScrcpyVersion"
New-Item -ItemType Directory -Force -Path $vendor | Out-Null
if ((Test-Path $jar) -and ((Get-Item $jar).Length -gt 0)) {
    Ok 'Already downloaded'
} else {
    Invoke-WebRequest -UseBasicParsing "https://github.com/Genymobile/scrcpy/releases/download/v$ScrcpyVersion/scrcpy-server-v$ScrcpyVersion" -OutFile "$jar.part"
    Move-Item -Force "$jar.part" $jar
    Ok 'Saved to server\vendor\'
}

# ---------- server ----------
Step 'Server dependencies'
Push-Location (Join-Path $Root 'server')
try { Invoke-Checked 'npm.cmd' @('install', '--silent') } finally { Pop-Location }
Ok 'npm install done'

Write-Host ""
Write-Host '  All set. Start Apricot with:' -ForegroundColor White
Write-Host ''
Write-Host '    cd server; npm start'
Write-Host ''
Write-Host '  Then open the Apricot app on your iPhone (same Wi-Fi) - it finds this PC automatically.'
Write-Host '  When Windows asks, allow Node.js through the firewall on Private networks.'
Write-Host ''
