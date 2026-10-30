# Contributing to Apricot

Thanks for helping! Apricot is small on purpose, so it stays easy to hack on.

## Development setup

```bash
./apricot                     # first run sets everything up (Windows: apricot.cmd)
cd server && APRICOT_REMOTE=0 npm run dev   # restarts on file changes, no tunnel
```

Open `http://localhost:7420` for the dashboard. Working on the iPhone app needs a Mac with Xcode:

```bash
open ios/Apricot.xcodeproj    # or: cd ios && xcodegen   after editing project.yml
```

The iOS Simulator has no camera. To pair it, open the link from the dashboard's pairing dialog
(`curl -s localhost:7420/api/pair` shows it) with `xcrun simctl openurl booted '<link>'`.

## Guidelines

- **Server**: plain modern JavaScript (ESM) on Node 20+. Avoid new dependencies unless they save a lot of
  code. The only one so far is `ws`.
- **Dashboard**: no build step. Keep it to HTML, CSS and vanilla JS modules.
- **iOS**: SwiftUI, iOS 17+, no third-party packages. Adding a Swift file? Re-run `xcodegen` and commit the
  updated `.xcodeproj`.
- Match the style of the code around you. `.editorconfig` covers the basics.
- Add or update tests in `server/test/` when you touch APK parsing or protocol code: `npm test`.

## Pull requests

1. Fork and create a branch: `git checkout -b feature/clipboard-sync`.
2. Keep each PR focused on one change, and describe how you tested it.
3. Make sure CI passes (server tests and the iOS build).

## Good first issues

- Clipboard sync (scrcpy control messages 8/9)
- Audio forwarding (scrcpy `audio=true` + Opus decode on iOS)
- A Linux host guide (Redroid)
- Translations for the iOS app
