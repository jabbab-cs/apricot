import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, '..');

/** Where Android Studio (and our setup scripts) install the SDK on each OS. */
function defaultAndroidHome() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Android', 'sdk');
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk');
  }
  return path.join(os.homedir(), 'Android', 'Sdk');
}

function int(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

export const config = {
  port: int('APRICOT_PORT', 7420),
  host: process.env.APRICOT_HOST ?? '0.0.0.0',
  // Optional shared secret. When set, every API/WebSocket request must carry it.
  token: process.env.APRICOT_TOKEN || null,
  dataDir: path.resolve(process.env.APRICOT_DATA_DIR ?? path.join(SERVER_ROOT, 'data')),
  publicDir: path.join(SERVER_ROOT, 'public'),
  vendorDir: path.join(SERVER_ROOT, 'vendor'),
  androidHome: process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || defaultAndroidHome(),
  // Must match the scrcpy-server binary exactly (the setup scripts download it).
  scrcpyVersion: process.env.APRICOT_SCRCPY_VERSION ?? '5.0.1',
  video: {
    maxSize: int('APRICOT_MAX_SIZE', 1600),
    bitRate: int('APRICOT_BIT_RATE', 8_000_000),
    maxFps: int('APRICOT_MAX_FPS', 60),
  },
  emulatorHeadless: process.env.APRICOT_HEADLESS === '1',
  emulatorGpu: process.env.APRICOT_EMULATOR_GPU ?? 'host',
  bonjour: process.env.APRICOT_BONJOUR !== '0',
  maxUploadBytes: int('APRICOT_MAX_UPLOAD_MB', 1024) * 1024 * 1024,
};
