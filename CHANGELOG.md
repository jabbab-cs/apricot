# Changelog

## 0.1.0 (unreleased)

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
