# Troubleshooting

Start with `curl localhost:7420/api/status` on the computer running the server (PowerShell: `curl.exe localhost:7420/api/status`). It shows which tools were found and which devices adb sees.

### The iPhone doesn't find my computer
- Both devices must be on the same Wi-Fi network. Guest networks and some office networks block device-to-device traffic.
- Check that **Settings → Privacy & Security → Local Network → Apricot** is on.
- Check the firewall (TCP 7420 and UDP 5353 for discovery). See [SETUP.md → Firewall](SETUP.md#firewall).
  On Windows, make sure the Wi-Fi network profile is **Private**: Windows blocks discovery on *Public* networks.
- On Linux, if `avahi-daemon` is running and discovery still fails, check that nothing else exclusively owns UDP 5353.
- Use *Enter address manually* with the IP from the server's startup banner.

### "scrcpy-server is missing"
Run the setup script (`./scripts/setup.sh`, or `scripts\setup-windows.ps1` on Windows). It downloads the server into `server/vendor/`.

### "The server version (…) does not match the client"
The jar in `server/vendor/` and `APRICOT_SCRCPY_VERSION` must match. Re-run the setup script with the same version.

### Black screen, or it stays on "Connecting…"
- Wait until the emulator has fully booted to the home screen.
- Check the server log for `scrcpy-server exited`.
- Lower the resolution: `APRICOT_MAX_SIZE=1280 npm start`.
- Some emulator GPU modes can't encode video. In Android Studio set *Graphics* to **Hardware**,
  or add `hw.gpu.mode=host` to `~/.android/avd/<name>.avd/config.ini`.

### `INSTALL_FAILED_NO_MATCHING_ABIS`
The APK only contains native libraries for another CPU. Build for `arm64-v8a` (Apple Silicon emulators),
build a universal APK. x86_64 emulator images (Windows/Linux PCs, Intel Macs) translate ARM code on Android 11+, so an x86_64-only APK is the case that fails on Apple Silicon.

### `INSTALL_FAILED_UPDATE_INCOMPATIBLE`
A build signed with a different key is already installed. Uninstall it from **Apps → Installed** first.

### "This looks like a split bundle"
`.apks`, `.xapk` and `.aab` files contain several APKs. Build a universal APK instead:
`./gradlew assembleDebug`, or `bundletool build-apks --mode=universal`.

### The stream lags by seconds, or only updates now and then
The emulator is probably using the wrong GPU mode. The emulator only refreshes the virtual display scrcpy captures
when it renders with the host GPU. Apricot boots emulators with `-gpu host`. If you start one yourself, do the same:

```bash
~/Library/Android/sdk/emulator/emulator -avd Apricot_Phone -gpu host
```

Or set *Graphics: Hardware* in Android Studio's device settings.

### "Running multiple emulators with the same AVD…"
That virtual device is already running, or still shutting down. Wait a few seconds and try again, or pick it in the device list.

### Taps stop working on a text field ("Try out your stylus")
The emulator reports a stylus, so Gboard sometimes shows a handwriting tutorial over text fields, and it swallows taps.
Apricot turns stylus handwriting off on emulators when streaming starts. If the sheet is already showing, tap **Cancel**.

### Lag or stutter
- Use 5 GHz Wi-Fi, or set `APRICOT_BIT_RATE=4000000` and `APRICOT_MAX_FPS=30`.
- Over Tailscale, make sure the connection is direct and not relayed (`tailscale status`).

### Windows: "x86_64 emulation currently requires hardware acceleration"
Turn on **Windows Hypervisor Platform** and enable virtualization in the BIOS. See [SETUP.md → Hardware acceleration](SETUP.md#windows).
If you also use VirtualBox or VMware, update them to a version that runs on top of Hyper-V.

### Linux: "/dev/kvm is not found" or "permission denied"
Enable virtualization in the BIOS, install KVM, and add yourself to the `kvm` group (`sudo usermod -aG kvm $USER`), then log out and back in.
Inside a VM, you need nested virtualization.

### Typing doesn't work
Tap the text field in the Android app first, then tap the ⌨️ button. Text goes to the field that has focus on Android.

### The app stopped opening after a week
Free Apple IDs sign apps for 7 days. Press Run in Xcode again, or use SideStore. See [SIDELOADING.md](SIDELOADING.md).
