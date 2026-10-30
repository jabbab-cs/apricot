# Architecture

```
┌──────────── iPhone ────────────┐          ┌────────────────── Computer ──────────────────┐
│ SwiftUI app                    │          │ Apricot server (Node.js)                     │
│  ├ DeviceStream ── WebSocket ──┼── /ws/stream ──► scrcpy.js ── adb forward ──┐           │
│  │   H264Renderer              │          │                                  ▼           │
│  │   (AVSampleBufferDisplay…)  │          │                     ┌── Android emulator ──┐ │
│  ├ AppsView ──── HTTP ─────────┼── /api/* ──► devices.js ─ adb ─►│ scrcpy-server (jar)  │ │
│  └ LogsView ──── WebSocket ────┼── /ws/logcat ─► logcat.js ─────►│ your app             │ │
│                                │          │  library.js + apk.js └──────────────────────┘ │
└────────────────────────────────┘          └──────────────────────────────────────────────┘
```

## Server modules

| File | Role |
|---|---|
| `src/index.js` | HTTP routes, WebSocket upgrade, static dashboard |
| `src/pairing.js` | The access token (generated once, kept in `data/token`) and the `apricot://pair` QR code |
| `src/tunnel.js` | Downloads `cloudflared` and keeps a Cloudflare quick tunnel running for remote access |
| `src/host.js` | Computer name and LAN addresses |
| `src/devices.js` | Device selection, on-demand emulator boot and idle shutdown, install/launch/stop/clear/uninstall, icons of installed apps, shared stream sessions |
| `src/icon.js` | Draws adaptive and vector-drawable icons: Android XML → SVG → PNG (resvg) |
| `src/scrcpy.js` | Starts `scrcpy-server` on the device, demuxes the video socket, encodes control messages |
| `src/apk.js` | Dependency-free APK inspector: zip reader, binary XML decoder, `resources.arsc` resolver |
| `src/library.js` | APK storage in `server/data/apks/` (`<id>.apk`, `<id>.json`, `<id>.icon`) |
| `src/logcat.js` | `adb logcat -v threadtime`, parsed and batched, optional per-app PID filter |

## Video pipeline

1. `scrcpy-server` runs on the device via `app_process` and encodes the display with `MediaCodec` (H.264).
2. The server connects through `adb forward tcp:N localabstract:scrcpy_<scid>`. The first socket is video and
   the second is control.
3. The video socket carries: dummy byte → 64-byte device name → 4-byte codec id → a stream of
   *session packets* (12 bytes, MSB set: width/height, sent again after rotation) and *media packets*
   (12-byte header: PTS with config/key-frame flags, then size, followed by the payload).
4. Config packets (SPS/PPS) are prepended to each key frame, so every key frame can be decoded on its own.
5. The server keeps the current GOP (last key frame plus the frames after it), so a newly connected viewer
   sees an image immediately. A slow viewer drops frames until the next key frame instead of falling behind.
6. On the iPhone, `H264Renderer` runs on a background queue. It splits the Annex-B stream into NAL units, builds a
   `CMVideoFormatDescription` from SPS/PPS, rewrites the slices as AVCC (length-prefixed) and decodes them with a
   `VTDecompressionSession`. Each decoded picture is enqueued on an `AVSampleBufferDisplayLayer` with `DisplayImmediately`.
   Decoding ourselves matters: if the layer gets compressed frames, it holds the newest one back until the next frame
   arrives, so a screen that stops changing is shown one frame stale.

One scrcpy session per device is shared by all viewers. It stops 15 s after the last viewer leaves.
Each viewer gets its own range of Android pointer ids, so two clients never control the same finger, and any finger
a viewer still holds is lifted when it disconnects.

A viewer that joins while the cached GOP is large, or that falls behind, gets a fresh key frame from the encoder
(`RESET_VIDEO`, throttled to twice a second) instead of a backlog. Apricot never sends `RESET_VIDEO` before the first
frame: scrcpy-server crashes if capture hasn't started yet.

## WebSocket `/ws/stream`

Query: `serial` (optional), `token` (if auth is enabled).

**Server → client**

| Frame | Meaning |
|---|---|
| binary `[flags:1][annexb…]` | One H.264 access unit. `flags & 1` means key frame (SPS/PPS included) |
| `{"type":"hello","serial","deviceName","width","height"}` | Sent after connecting |
| `{"type":"size","width","height"}` | Video size changed (rotation) |
| `{"type":"error","message"}` / `{"type":"closed","reason"}` | Stream failed or ended |

**Client → server** (JSON text)

| Message | |
|---|---|
| `{"type":"touch","action":"down\|move\|up\|cancel","id":0-9,"x":0-1,"y":0-1}` | Coordinates are normalized to the video |
| `{"type":"scroll","x","y","dx","dy"}` | Mouse wheel |
| `{"type":"key","key":"back\|home\|recents\|power\|volume_up\|volume_down\|enter\|del\|tab\|escape\|dpad_*"}` | Press and release |
| `{"type":"text","text":"…"}` | Inject text |
| `{"type":"rotate"}` `{"type":"notifications"}` `{"type":"quick-settings"}` `{"type":"collapse"}` `{"type":"wake"}` | Device actions |
| `{"type":"keyframe"}` | Ask the encoder for a new key frame (decoder recovery) |

## WebSocket `/ws/logcat`

Query: `package` (optional, filters by that app's PIDs), `level` (`V`/`D`/`I`/`W`/`E`).
The server sends `{"type":"lines","lines":[{"time","pid","tid","level","tag","message"}]}` about every 150 ms.

## Pairing

The QR code is `apricot://pair?n=<computer name>&t=<token>&u=<url>&u=<url>…`: the LAN addresses first, then the tunnel's
`https://….trycloudflare.com` address. The iPhone tries them in that order (LAN with a 3 s timeout, so being away from
home fails fast), remembers the one that answered, and tries the others again when polling fails.

## Emulator lifecycle

Anything that needs a device (`/api/start`, launching or installing an app, opening a stream) calls
`DeviceManager.device()`. If nothing is running it boots the first virtual phone (`Apricot_Phone` if present) headless,
waits for `sys.boot_completed`, and switches it to gesture navigation. Concurrent callers share one boot. An emulator
Apricot started is stopped with `adb emu kill` (which saves a quick-boot snapshot) after `APRICOT_IDLE_MINUTES` without
viewers or API activity. Icon requests never boot Android; `/api/apps` returns the last known list while it's off.

## HTTP API

Send `Authorization: Bearer <token>` or `?token=`. Requests from the computer itself (loopback, not relayed by the
tunnel) don't need it.

| Method | Path | |
|---|---|---|
| GET | `/api/status` | Server info, tools, devices, AVDs, `booting`, `remote` |
| GET | `/api/pair` | Pairing link and QR SVG (only from the computer itself) |
| POST | `/api/start` | Start Android if needed and wait until it's ready |
| POST | `/api/devices/select` | `{serial}` |
| POST | `/api/avds/boot` | `{name}` |
| GET | `/api/device/info` | Model, Android version, ABIs, screen |
| POST | `/api/device/key` | `{key}` |
| POST | `/api/device/text` | `{text}` |
| POST | `/api/device/rotate` | |
| GET | `/api/device/screenshot` | PNG |
| GET | `/api/apks` | Library |
| POST | `/api/apks` | Raw APK body, `X-File-Name` header → library entry |
| GET | `/api/apks/:id/icon` | App icon |
| GET | `/api/apks/:id/download` | Original APK |
| DELETE | `/api/apks/:id` | Remove from library |
| POST | `/api/apks/:id/install` | `{launch: true}` installs with `-r -t -d -g`, then launches |
| GET | `/api/apps` | Third-party packages on the device, enriched from the library (cached while the device is off) |
| GET | `/api/apps/:package/icon` | Icon from the library, or extracted from the installed APK |
| POST | `/api/apps/:package/:action` | `launch`, `stop`, `clear`, `uninstall` |

## iOS app

| File | Role |
|---|---|
| `App/AppModel.swift` | Pairing, address fallback, polling, home screen items, APK import |
| `Networking/APIClient.swift` | REST + upload with progress |
| `Stream/DeviceStream.swift` | Stream WebSocket, auto-retry, input messages |
| `Stream/H264Renderer.swift` | Annex-B → AVCC → `VTDecompressionSession` → `AVSampleBufferDisplayLayer` |
| `Stream/DeviceScreen.swift` | `UIView` handling multi-touch and `UIKeyInput` |
| `Views/HomeView.swift` | iOS-style home screen and dock |
| `Views/AppRunnerView.swift` | One app full screen, edge gestures for Back and close |
| `Views/QRScannerView.swift` | Pairing scanner (AVFoundation) |
| `Views/*` | Also: Connect, Phone (whole Android screen), Device (settings), Logs |

The project is defined in `ios/project.yml` ([XcodeGen](https://github.com/yonaskolb/XcodeGen)). The generated
`Apricot.xcodeproj` is committed so you can build without XcodeGen.
