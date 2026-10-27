import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const EXE = process.platform === 'win32' ? '.exe' : '';

function which(bin) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir, bin + EXE);
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
}

function firstExisting(...candidates) {
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

export function findAdb() {
  return firstExisting(
    path.join(config.androidHome, 'platform-tools', 'adb' + EXE),
    which('adb'),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    '/usr/bin/adb',
  );
}

export function findEmulator() {
  return firstExisting(path.join(config.androidHome, 'emulator', 'emulator' + EXE), which('emulator'));
}

export function findScrcpyServer() {
  const vendored = path.join(config.vendorDir, `scrcpy-server-v${config.scrcpyVersion}`);
  if (fs.existsSync(vendored)) return { path: vendored, version: config.scrcpyVersion };
  return null;
}

export class CommandError extends Error {
  constructor(message, { stdout = '', stderr = '', code = null } = {}) {
    super(message);
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = code;
  }
}

export function run(bin, args, { timeout = 30_000, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, encoding, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || stdout || err.message).toString().trim();
        reject(new CommandError(detail || `${path.basename(bin)} failed`, { stdout, stderr, code: err.code }));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** Thin wrapper around the adb binary, scoped to one device serial when given. */
export class Adb {
  constructor(adbPath) {
    this.path = adbPath;
  }

  exec(args, opts) {
    return run(this.path, args, opts);
  }

  forDevice(serial) {
    return {
      exec: (args, opts) => this.exec(['-s', serial, ...args], opts),
      shell: (cmd, opts) => this.exec(['-s', serial, 'shell', cmd], opts),
      spawn: (args, opts) => spawn(this.path, ['-s', serial, ...args], { windowsHide: true, ...opts }),
    };
  }

  async devices() {
    const out = await this.exec(['devices', '-l']);
    const list = out
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [serial, state, ...rest] = line.split(/\s+/);
        const props = Object.fromEntries(
          rest.filter((r) => r.includes(':')).map((r) => r.split(':', 2)),
        );
        return {
          serial,
          state,
          model: (props.model ?? serial).replace(/_/g, ' '),
          product: props.product ?? null,
          isEmulator: serial.startsWith('emulator-'),
        };
      });
    // Emulators report a generic model ("sdk gphone64 arm64"); show the AVD name instead.
    await Promise.all(
      list
        .filter((d) => d.isEmulator && d.state === 'device')
        .map(async (d) => {
          const name = await this.#avdName(d.serial);
          if (name) {
            d.avd = name;
            d.model = name.replace(/_/g, ' ');
          }
        }),
    );
    return list;
  }

  #avdNames = new Map();

  async #avdName(serial) {
    if (!this.#avdNames.has(serial)) {
      const out = await this.exec(['-s', serial, 'emu', 'avd', 'name'], { timeout: 5_000 }).catch(() => '');
      const name = out.split('\n')[0].trim();
      if (!name) return null;
      this.#avdNames.set(serial, name);
    }
    return this.#avdNames.get(serial);
  }
}

export async function listAvds() {
  const emulator = findEmulator();
  if (!emulator) return [];
  try {
    const out = await run(emulator, ['-list-avds'], { timeout: 10_000 });
    return out
      .split('\n')
      .map((s) => s.trim())
      // The emulator sometimes prints INFO lines before the list.
      .filter((s) => s && !s.includes(' ') && !s.startsWith('INFO'));
  } catch {
    return [];
  }
}

export function bootAvd(name) {
  const emulator = findEmulator();
  if (!emulator) throw new Error('Android emulator not found. Install it from Android Studio > SDK Manager.');
  // '-gpu host' matters: with 'auto' the emulator barely refreshes the virtual display
  // scrcpy captures, which shows up as seconds of stream latency.
  const args = ['-avd', name, '-no-boot-anim', '-netdelay', 'none', '-netspeed', 'full', '-gpu', config.emulatorGpu];
  if (config.emulatorHeadless) args.push('-no-window');
  const child = spawn(emulator, args, { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = (chunk) => (output = (output + chunk).slice(-4000));
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  // The emulator exits within seconds when it can't start (AVD locked, missing image, ...).
  // Report that instead of pretending the boot is underway.
  return new Promise((resolve, reject) => {
    const settle = () => {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve();
    };
    const timer = setTimeout(settle, 5000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      const reason = output
        .split('\n')
        .filter((l) => /ERROR|FATAL|already running|another/i.test(l))
        .map((l) => l.replace(/^\s*(ERROR|FATAL)\s*\|\s*/, ''))
        .slice(-2)
        .join(' ');
      reject(Object.assign(new Error(reason || `Emulator exited during startup (code ${code})`), { status: 422 }));
    });
  });
}
