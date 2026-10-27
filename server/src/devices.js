// Tracks connected devices, the selected one, and the shared live-stream sessions.
import { Adb, findAdb, findScrcpyServer, bootAvd, listAvds, findEmulator } from './adb.js';
import { config } from './config.js';
import { ScrcpySession, KEYCODES } from './scrcpy.js';

const PACKAGE_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/;

export function assertPackage(pkg) {
  if (!PACKAGE_RE.test(pkg)) throw Object.assign(new Error(`Invalid package name: ${pkg}`), { status: 400 });
  return pkg;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export class DeviceManager {
  constructor() {
    this.selectedSerial = null;
    this.sessions = new Map();
    this.refreshTools();
  }

  refreshTools() {
    const adbPath = findAdb();
    this.adb = adbPath ? new Adb(adbPath) : null;
    this.scrcpy = findScrcpyServer();
    this.emulatorPath = findEmulator();
  }

  async status() {
    this.refreshTools();
    let devices = [];
    let adbError = null;
    if (this.adb) {
      try {
        devices = await this.adb.devices();
      } catch (err) {
        adbError = err.message;
      }
    }
    const ready = devices.filter((d) => d.state === 'device');
    if (!ready.some((d) => d.serial === this.selectedSerial)) this.selectedSerial = ready[0]?.serial ?? null;
    return {
      tools: {
        adb: this.adb?.path ?? null,
        emulator: this.emulatorPath,
        scrcpyServer: this.scrcpy?.version ?? null,
        adbError,
      },
      devices: devices.map((d) => ({ ...d, selected: d.serial === this.selectedSerial })),
      selectedSerial: this.selectedSerial,
      avds: await listAvds(),
      runningAvds: devices.map((d) => d.avd).filter(Boolean),
    };
  }

  select(serial) {
    this.selectedSerial = serial;
  }

  boot(name) {
    return bootAvd(name);
  }

  /** Returns a device handle for the selected (or given) serial, or throws a helpful 4xx/5xx. */
  async device(serial = this.selectedSerial) {
    if (!this.adb) throw httpError(503, 'adb not found. Run the setup script (scripts/setup.sh, or scripts/setup-windows.ps1) or install Android Studio.');
    if (!serial) {
      await this.status();
      serial = this.selectedSerial;
    }
    if (!serial) throw httpError(409, 'No Android device is running. Boot an emulator first.');
    return { serial, ...this.adb.forDevice(serial) };
  }

  async info() {
    const d = await this.device();
    const props = await d.shell(
      'getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.cpu.abilist; wm size; wm density; true',
    );
    const [model, release, sdk, abis, size, density] = props.split('\n').map((s) => s.trim());
    return {
      serial: d.serial,
      model,
      androidVersion: release,
      sdk: Number(sdk) || null,
      abis: abis ? abis.split(',') : [],
      // `wm` is unavailable for a few seconds after boot; those lines are then empty.
      screen: size?.includes(':') ? size.split(':').pop().trim() : null,
      density: Number(density?.split(':').pop()) || null,
    };
  }

  // ---------- live stream sessions ----------

  async acquireSession(serial) {
    let entry = this.sessions.get(serial);
    if (entry && entry.session.state !== 'stopped') {
      clearTimeout(entry.idleTimer);
      return entry;
    }
    if (!this.scrcpy) {
      throw httpError(503, `scrcpy-server v${config.scrcpyVersion} is missing. Run the setup script to download it.`);
    }
    const device = await this.device(serial);
    if (serial.startsWith('emulator-')) {
      // Emulators advertise a stylus, so Gboard pops a "Try out your stylus" sheet over text
      // fields that swallows taps. Streamed input is always a finger, so turn handwriting off.
      device.shell('settings put secure stylus_handwriting_enabled 0').catch(() => {});
    }
    const session = new ScrcpySession({
      device,
      serverJar: this.scrcpy.path,
      version: this.scrcpy.version,
      video: config.video,
    });
    entry = { serial, session, viewers: new Set(), idleTimer: null };
    entry.ready = session.start();
    entry.ready.catch(() => {});
    session.once('close', () => {
      if (this.sessions.get(serial) === entry) this.sessions.delete(serial);
    });
    this.sessions.set(serial, entry);
    return entry;
  }

  releaseViewer(entry, viewer) {
    entry.viewers.delete(viewer);
    if (entry.viewers.size === 0) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => entry.session.stop('no viewers'), 15_000);
    }
  }

  /** A running stream session for the selected device, if any (used for faster input). */
  activeSession() {
    const s = this.sessions.get(this.selectedSerial)?.session;
    return s?.state === 'running' ? s : null;
  }

  // ---------- input (works with or without a live stream) ----------

  async key(name) {
    const code = KEYCODES[name];
    if (code === undefined) throw httpError(400, `Unknown key: ${name}`);
    const session = this.activeSession();
    if (session) return session.pressKey(code);
    const d = await this.device();
    await d.shell(`input keyevent ${code}`);
  }

  async text(text) {
    const session = this.activeSession();
    if (session) return session.text(text);
    const d = await this.device();
    // `input text` uses %s for spaces; everything else must survive the device shell.
    const escaped = text.replace(/(["\\$`'&|;<>()*?!~#%])/g, '\\$1').replace(/ /g, '%s');
    await d.shell(`input text ${escaped}`);
  }

  async rotate() {
    const session = this.activeSession();
    if (session) return session.rotate();
    const d = await this.device();
    const current = Number((await d.shell('settings get system user_rotation')).trim()) || 0;
    await d.shell(`settings put system accelerometer_rotation 0; settings put system user_rotation ${(current + 1) % 4}`);
  }

  async screenshot() {
    const d = await this.device();
    return d.exec(['exec-out', 'screencap', '-p'], { encoding: 'buffer', timeout: 15_000 });
  }

  // ---------- apps ----------

  async install(apkPath) {
    const d = await this.device();
    let out;
    try {
      out = await d.exec(['install', '-r', '-t', '-d', '-g', apkPath], { timeout: 5 * 60_000 });
    } catch (err) {
      throw httpError(422, friendlyInstallError(err.message));
    }
    if (!/Success/.test(out)) throw httpError(422, friendlyInstallError(out));
  }

  async installedPackages() {
    const d = await this.device();
    const out = await d.shell('pm list packages -3');
    return out
      .split('\n')
      .map((l) => l.trim().replace(/^package:/, ''))
      .filter(Boolean)
      .sort();
  }

  async appAction(pkg, action) {
    assertPackage(pkg);
    const d = await this.device();
    switch (action) {
      case 'launch': {
        const out = await d.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
        if (/No activities found/.test(out)) throw httpError(422, `${pkg} has no launcher activity.`);
        return;
      }
      case 'stop':
        await d.shell(`am force-stop ${pkg}`);
        return;
      case 'clear':
        await d.shell(`pm clear ${pkg}`);
        return;
      case 'uninstall': {
        const out = await d.exec(['uninstall', pkg]);
        if (!/Success/.test(out)) throw httpError(422, out.trim());
        return;
      }
      default:
        throw httpError(400, `Unknown action: ${action}`);
    }
  }
}

function friendlyInstallError(raw) {
  const msg = raw.trim();
  const hints = {
    INSTALL_FAILED_NO_MATCHING_ABIS:
      'This APK only contains native code for a different CPU. Use an arm64-v8a build (Apple Silicon emulators) or a universal APK.',
    INSTALL_FAILED_UPDATE_INCOMPATIBLE:
      'A version signed with a different key is already installed. Uninstall it from the Installed tab first.',
    INSTALL_FAILED_OLDER_SDK: 'The APK requires a newer Android version than this emulator runs.',
    INSTALL_PARSE_FAILED_NO_CERTIFICATES: 'The APK is not signed. Build a debug or signed release APK.',
    INSTALL_FAILED_INSUFFICIENT_STORAGE: 'The emulator is out of storage. Wipe its data from Android Studio.',
  };
  const code = Object.keys(hints).find((k) => msg.includes(k));
  return code ? `${hints[code]} (${code})` : msg || 'Install failed';
}
