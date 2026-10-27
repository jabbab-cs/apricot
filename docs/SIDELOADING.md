# Installing the iPhone app

Apricot isn't on the App Store, so you install it on your own iPhone with your own Apple ID (a free one works).
Which way to go depends on the computer you have:

| Your computer | Easiest way | App expires after (free Apple ID) |
|---|---|---|
| **Mac** | [Build with Xcode](#1-mac-build-with-xcode) | 7 days, reinstall with one click |
| **Windows** | [Prebuilt IPA + Sideloadly or AltStore](#2-windows-prebuilt-ipa) | 7 days (AltStore refreshes automatically) |
| **Linux** | [Prebuilt IPA + Sideloader](#3-linux-prebuilt-ipa) | 7 days |

With a paid Apple Developer Program account ($99/yr), installs last a year on every method.

## 1. Mac: build with Xcode

1. Install Xcode from the Mac App Store.
2. Open the project:
   ```bash
   open ios/Apricot.xcodeproj
   ```
3. Select the **Apricot** target, open **Signing & Capabilities**, and choose your **Team**. Sign in with
   your Apple ID under *Xcode → Settings → Accounts* if it isn't listed.
4. Free accounts can't use the shared bundle ID. Change **Bundle Identifier** to something unique,
   such as `com.yourname.apricot`.
5. Connect your iPhone with a cable, select it as the run destination, and press **⌘R**.
6. Do the [first-launch steps on the iPhone](#first-launch-on-the-iphone).

With a free account the app stops launching after 7 days. Plug the phone in and press Run again; your settings are kept.

If you change `ios/project.yml`, regenerate the project with [XcodeGen](https://github.com/yonaskolb/XcodeGen): `cd ios && xcodegen`.

## 2. Windows: prebuilt IPA

Xcode only runs on macOS, so every release includes a ready-built, unsigned `Apricot-unsigned.ipa`.
A sideloading tool signs it with your Apple ID and installs it.

1. Download `Apricot-unsigned.ipa` from the project's **Releases** page.
2. Install **iTunes** and **iCloud** from Apple's website (the direct downloads, *not* the Microsoft Store
   versions). Sideloading tools need their USB drivers.
3. Use either tool:
   - **[Sideloadly](https://sideloadly.io):** plug in the iPhone, drop the IPA in, enter your Apple ID, click **Start**.
   - **[AltStore](https://altstore.io):** install AltServer, use it to install AltStore on the phone, then open the
     IPA in AltStore. AltStore re-signs the app in the background over Wi-Fi, so it doesn't expire after 7 days.
4. Do the [first-launch steps on the iPhone](#first-launch-on-the-iphone).

## 3. Linux: prebuilt IPA

1. Download `Apricot-unsigned.ipa` from the project's **Releases** page.
2. Install [Sideloader](https://github.com/Dadoum/Sideloader) (it uses `usbmuxd`, which most distros ship), plug in
   the iPhone, sign in with your Apple ID and install the IPA.
3. Do the [first-launch steps on the iPhone](#first-launch-on-the-iphone).

Sideloader can also install [SideStore](https://sidestore.io). SideStore then refreshes Apricot on the phone itself, so
you don't need the computer every 7 days.

## Building the IPA yourself (Mac)

```bash
cd ios
xcodebuild -project Apricot.xcodeproj -scheme Apricot -configuration Release \
  -sdk iphoneos -derivedDataPath build CODE_SIGNING_ALLOWED=NO
mkdir -p Payload && cp -R build/Build/Products/Release-iphoneos/Apricot.app Payload/
zip -qry Apricot-unsigned.ipa Payload
```

The [release workflow](../.github/workflows/release.yml) does exactly this when a `v*` tag is pushed.

## First launch on the iPhone

1. **Settings → General → VPN & Device Management** → trust your developer certificate.
2. **Settings → Privacy & Security → Developer Mode → On** (iOS 16+, restarts the phone).
3. Open Apricot and allow **Local Network** access when asked. It needs this to find your computer.
   If you declined, re-enable it under **Settings → Privacy & Security → Local Network → Apricot**.
