# Setting up your computer

Apricot's server runs on **macOS, Windows or Linux** and needs three things:

| Piece | What for | Installed by the setup script |
|---|---|---|
| **adb** (Android platform-tools) | install apps, run shell commands, forward the stream | ✅ |
| **Android emulator + a virtual device** | the "phone" your apps run on | ✅ |
| **scrcpy-server** | captures the screen as H.264 and injects touches | ✅ |

You also need [Node.js 20+](https://nodejs.org). The script installs Java if it's missing, because the Android SDK tools need it.

## Option A: just run it (recommended)

**macOS / Linux**

```bash
./apricot
```

**Windows:** double-click `apricot.cmd`, or run it from a terminal in the repo folder.

The first run calls the setup script (`scripts/setup.sh`, or `scripts\setup-windows.ps1` on Windows), then starts the
server. Later runs skip straight to starting. To re-run setup by hand, run the script directly. It:

1. Checks for Node.js 20+ and Java. If Java is missing it installs it: Homebrew on macOS, `apt`/`dnf`/`pacman`
   on Linux (asks for `sudo`), `winget` on Windows.
2. Reuses your Android Studio SDK if you have one. Otherwise it downloads Google's Android command-line tools
   straight from Google and installs `platform-tools` and `emulator` into the default SDK folder:

   | OS | SDK folder |
   |---|---|
   | macOS | `~/Library/Android/sdk` |
   | Windows | `%LOCALAPPDATA%\Android\Sdk` |
   | Linux | `~/Android/Sdk` |

3. Checks hardware acceleration and tells you exactly what to fix if it's missing.
4. Creates a slim virtual phone called **Apricot_Phone** (Pixel 7, Android 15, Google APIs, 2 GB RAM, no cameras or
   microphone) unless you already have virtual devices. Apple Silicon gets the `arm64-v8a` image; Intel/AMD PCs get `x86_64`.
5. Downloads `scrcpy-server` into `server/vendor/` and runs `npm install` in `server/`.

You can re-run it at any time; it skips steps that are already done. To change its defaults:

```bash
APRICOT_API_LEVEL=34 APRICOT_AVD_DEVICE=pixel_6 ./scripts/setup.sh
```

```powershell
$env:APRICOT_API_LEVEL="34"; powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
```

## Option B: Android Studio

1. Install [Android Studio](https://developer.android.com/studio).
2. Open **Device Manager** and create a virtual device. Choose a *Google Play* image if your app needs Play Services.
   Under *Advanced settings*, set **Graphics** to **Hardware**.
3. Run the setup script. It detects the SDK and only adds what's missing (`scrcpy-server`, npm packages).

## Hardware acceleration

The emulator needs CPU virtualization. The setup script checks it, but here's what each OS needs:

### macOS
Nothing to do: the emulator uses Apple's Hypervisor.framework on both Apple Silicon and Intel.

### Windows
1. Enable virtualization (Intel VT-x / AMD-V / "SVM") in your BIOS/UEFI. Task Manager → Performance → CPU shows
   *Virtualization: Enabled* when it's on.
2. Turn on **Windows Hypervisor Platform**. In an admin PowerShell, run this and then reboot:
   ```powershell
   Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All
   ```
3. Check it: `& "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe" -accel-check`

### Linux
1. Enable virtualization in your BIOS/UEFI.
2. Install KVM (Debian/Ubuntu: `sudo apt install qemu-kvm`) and give yourself access to it, then log out and back in:
   ```bash
   sudo usermod -aG kvm $USER
   ```
3. Check it: `~/Android/Sdk/emulator/emulator -accel-check`

### ARM PCs (Windows on ARM, Linux on ARM)
Google doesn't ship the Android emulator for these. Use a real Android phone over USB instead (see below).

## Using a real Android phone

On the phone, enable **Developer options → USB debugging**, then plug it into the computer and accept the prompt.
It shows up in the device picker next to the emulators, and everything works the same way.
On Windows you may need your phone maker's USB driver.

## Starting the server

```bash
./apricot          # Windows: apricot.cmd
```

The startup banner shows what's ready, then a QR code to scan with the iPhone app:

```
  Apricot v0.1.0  -  Android apps on your iPhone

  ✔ adb            /home/you/Android/Sdk/platform-tools/adb
  ✔ scrcpy-server  v5.0.1
  ✔ emulator       1 virtual phone(s), starts automatically when you open an app

  Opening a secure tunnel for remote access…

  Scan with your iPhone camera to connect  (works on Wi-Fi and cellular)
  ▄▄▄▄▄▄▄ ▄ ▄ ▄ …
```

You don't need to start Android yourself. When you open an app on the iPhone, Apricot boots the first virtual phone
in the background (no window), and after 10 minutes without anyone watching it shuts it down again. The emulator saves a
quick-boot snapshot when it stops, so the next start takes seconds. Set `APRICOT_HEADLESS=0` to see the emulator window.

You can still start an emulator yourself, from Android Studio or a terminal:

```bash
~/Library/Android/sdk/emulator/emulator -avd Apricot_Phone -gpu host     # macOS
~/Android/Sdk/emulator/emulator -avd Apricot_Phone -gpu host             # Linux
```

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe" -avd Apricot_Phone -gpu host   # Windows
```

Use `-gpu host` when you start it yourself. With other GPU modes the emulator barely refreshes the screen scrcpy
captures, and the stream lags by seconds. Apricot passes this flag automatically when it boots an emulator.
On a machine without a GPU (a headless server, a VM), use `APRICOT_EMULATOR_GPU=swiftshader_indirect` instead.

### Pairing and remote access

The QR code holds your computer's name, a random token, its local address and a remote address from a free
Cloudflare quick tunnel. The tunnel needs no account and no open ports: `cloudflared` (downloaded into `server/vendor/`
on first use) makes an outbound connection to Cloudflare, which gives you a `https://….trycloudflare.com` address.

- At home the iPhone connects directly over Wi-Fi (fastest). Elsewhere it uses the tunnel.
- The tunnel address changes each time the server starts. If the iPhone can't reach either address, scan the new code
  (dashboard → **Pair iPhone**).
- To unpair every phone, delete `server/data/token` and restart. A new token is generated.
- To turn the tunnel off, set `APRICOT_REMOTE=0`.

### Firewall

On your own Wi-Fi the iPhone connects to TCP port **7420**. The tunnel needs no incoming ports.

- **macOS:** allow incoming connections for `node` if the firewall asks.
- **Windows:** when Windows Defender Firewall asks about Node.js, allow it on **Private networks**. Make sure
  your Wi-Fi network profile is *Private*, not *Public*.
- **Linux:** with `ufw`, run `sudo ufw allow 7420/tcp`. With `firewalld`, run
  `sudo firewall-cmd --add-port=7420/tcp --permanent && sudo firewall-cmd --reload`.

### Run it in the background

- **macOS / Linux:** `nohup ./apricot > ~/apricot.log 2>&1 &` (the QR code is in the log, or use the dashboard). To start it at login, use a
  LaunchAgent (macOS) or a systemd user service (Linux) that runs `node /path/to/apricot/server/src/index.js`.
- **Windows:** `Start-Process -WindowStyle Hidden node -ArgumentList "src\index.js" -WorkingDirectory server`.
  To start it at login, add a Task Scheduler task with the same command.

## Updating scrcpy

The scrcpy-server version must match exactly what the server passes to it. To move to a newer release:

```bash
APRICOT_SCRCPY_VERSION=5.1 ./scripts/setup.sh
APRICOT_SCRCPY_VERSION=5.1 ./apricot
```

## Checking everything end to end

With the server running and a device booted, this uploads the sample app, installs it, streams video and taps
its button. It's the same check CI runs on Linux:

```bash
node scripts/e2e-smoke.mjs
```
