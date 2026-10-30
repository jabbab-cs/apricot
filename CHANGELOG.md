# Changelog

## 0.2.0 (unreleased)

Much easier to set up and use.

- **One command:** `./apricot` (Windows: `apricot.cmd`) sets everything up on first run, then starts the server.
- **QR pairing:** the server prints a QR code (also on the dashboard under *Pair iPhone*). Scan it with the app or the
  iPhone Camera. Replaces Bonjour discovery and manual addresses.
- **Connect from anywhere:** a free Cloudflare quick tunnel, started automatically. The app uses the LAN address at home
  and the tunnel elsewhere, and switches when the network changes.
- **Always-on auth:** a random token is generated on first run and carried by the QR code.
- **Invisible Android:** the emulator runs headless, boots when you open an app, and shuts down after 10 idle minutes
  (`APRICOT_IDLE_MINUTES`). New virtual phones are slimmer (2 GB RAM, no cameras/mic) and use gesture navigation.
- **New iPhone app UI:** an iOS-style home screen with real app icons, full-screen apps with a zoom transition,
  swipe up to close, edge-swipe for Back, long-press menus. Logs and devices moved into Settings.
- Adaptive and vector-drawable app icons are now drawn (via resvg), so modern apps show their real icon.
- Installed apps stay on the home screen while the emulator is off; real app names for apps installed outside Apricot.
- Faster app launch (`am start` instead of `monkey`).

## 0.1.0

First release.

- Host server for macOS, Windows and Linux: APK library with built-in APK parsing (label, version, icon, ABIs), install/launch/stop/clear/uninstall,
  emulator boot, scrcpy v5 H.264 streaming with touch/key/text injection, live logcat, Bonjour discovery, optional token auth.
- iPhone app: Bonjour connect, hardware-decoded live screen, multi-touch, Android nav bar, iOS keyboard input,
  APK manager with share-sheet import, logcat viewer, device switching.
- Web dashboard: live screen (WebCodecs), drag-and-drop APKs, installed apps, logs.
- One-command setup: `scripts/setup.sh` (macOS, Linux) and `scripts/setup-windows.ps1` (Windows).
- Prebuilt unsigned IPA on every release, for sideloading from Windows and Linux.
- CI runs on macOS, Windows and Linux, plus a Linux end-to-end job (real setup, emulator, stream, taps).
- `examples/hello-apricot`: a tiny test app built with the raw Android build tools.

Found and fixed during end-to-end testing on an Android 15 emulator:
- Emulators now boot with `-gpu host`. With `auto`, the stream lagged by seconds.
- No `RESET_VIDEO` before the first frame (it crashed scrcpy-server). Late or slow viewers get a fresh key frame instead of stalling.
- iOS decodes with VideoToolbox on a background queue, so the screen is never a frame behind and the UI stays responsive.
- Pointer handling: per-viewer pointer ids, stale pointers released, fingers lifted on disconnect.
- Gboard's stylus tutorial no longer swallows taps on emulators.
- Boot errors (AVD already running, …) are reported instead of silently ignored.
