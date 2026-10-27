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
| `src/discovery.js` | mDNS/Bonjour advertisement: the system `dns-sd` on macOS, a JS responder (`bonjour-service`) on Windows/Linux under its own `apricot-<host>.local` name, so it never claims the computer's real hostname |
| `src/devices.js` | Device selection, emulator boot, install/launch/stop/clear/uninstall, shared stream sessions |
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

## HTTP API

If `APRICOT_TOKEN` is set, send `Authorization: Bearer <token>` or `?token=`. `/api/status` is always open,
so clients can discover that a token is needed.

| Method | Path | |
|---|---|---|
| GET | `/api/status` | Server info, tools, devices, AVDs |
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
| GET | `/api/apps` | Third-party packages on the device, enriched from the library |
| POST | `/api/apps/:package/:action` | `launch`, `stop`, `clear`, `uninstall` |

## iOS app

| File | Role |
|---|---|
| `App/AppModel.swift` | Connection, polling, library/installed state, APK import |
| `Networking/Discovery.swift` | Bonjour browse (`_apricot._tcp`) and IPv4 resolve |
| `Networking/APIClient.swift` | REST + upload with progress |
| `Stream/DeviceStream.swift` | Stream WebSocket, auto-retry, input messages |
| `Stream/H264Renderer.swift` | Annex-B → AVCC → `VTDecompressionSession` → `AVSampleBufferDisplayLayer` |
| `Stream/DeviceScreen.swift` | `UIView` handling multi-touch and `UIKeyInput` |
| `Views/*` | Phone, Apps, Logs, Device, Connect screens |

The project is defined in `ios/project.yml` ([XcodeGen](https://github.com/yonaskolb/XcodeGen)). The generated
`Apricot.xcodeproj` is committed so you can build without XcodeGen.
