// Tracks connected devices, the selected one, and the shared live-stream sessions.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { inspectApk } from './apk.js';
import { Adb, findAdb, findScrcpyServer, bootAvd, listAvds, findEmulator } from './adb.js';
import { config } from './config.js';
import { ScrcpySession, KEYCODES } from './scrcpy.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    this.booting = null; // promise while Apricot starts an emulator on its own
    this.startedSerial = null; // the emulator Apricot started, shut down again when idle
    this.lastActivity = Date.now();
    this.iconDir = path.join(config.dataDir, 'icons');
    this.refreshTools();
    if (config.idleMinutes > 0) setInterval(() => this.#shutdownIfIdle(), 30_000).unref();
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
      booting: Boolean(this.booting),
      runningAvds: devices.map((d) => d.avd).filter(Boolean),
    };
  }

  select(serial) {
    this.selectedSerial = serial;
  }

  boot(name) {
    return bootAvd(name);
  }

  /**
   * Returns a device handle for the selected (or given) serial. When nothing is running, starts the
   * first virtual phone in the background and waits for it, so callers never have to boot one by hand.
   */
  async device(serial = this.selectedSerial) {
    if (!this.adb) throw httpError(503, 'adb not found. Run ./apricot (or apricot.cmd on Windows) to finish setup.');
    this.lastActivity = Date.now();
    if (!serial) {
      await this.status();
      serial = this.selectedSerial ?? (await this.ensureRunning());
    }
    return { serial, ...this.adb.forDevice(serial) };
  }

  /** Boots an emulator if no device is ready; resolves with its serial once Android has finished booting. */
  ensureRunning() {
    this.booting ??= this.#bootFirstAvd().finally(() => (this.booting = null));
    return this.booting;
  }

  async #bootFirstAvd() {
    const avds = await listAvds();
    const name = avds.find((a) => a === 'Apricot_Phone') ?? avds[0];
    if (!name) throw httpError(409, 'No Android device found. Run ./apricot (or apricot.cmd on Windows) to create one.');
    const before = new Set((await this.adb.devices()).map((d) => d.serial));
    try {
      await bootAvd(name);
    } catch (err) {
      if (!/already running/i.test(err.message)) throw err;
    }
    const deadline = Date.now() + 4 * 60_000;
    while (Date.now() < deadline) {
      await sleep(1500);
      const devices = await this.adb.devices().catch(() => []);
      const d = devices.find((x) => x.state === 'device' && (x.avd === name || !before.has(x.serial)));
      if (!d) continue;
      const booted = await this.adb.forDevice(d.serial).shell('getprop sys.boot_completed').catch(() => '');
      if (booted.trim() !== '1') continue;
      this.startedSerial = d.serial;
      this.selectedSerial = d.serial;
      await this.#prepare(d.serial);
      return d.serial;
    }
    throw httpError(504, `${name} took too long to start. Check that hardware acceleration is enabled.`);
  }

  /** Makes a fresh emulator feel like a phone: gesture navigation (no 3-button bar), no stylus prompts. */
  async #prepare(serial) {
    const d = this.adb.forDevice(serial);
    await d
      .shell(
        'cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.gestural; ' +
          'settings put secure stylus_handwriting_enabled 0; true',
      )
      .catch(() => {});
  }

  async #shutdownIfIdle() {
    const serial = this.startedSerial;
    if (!serial || this.booting) return;
    const watched = [...this.sessions.values()].some((e) => e.viewers.size > 0);
    if (watched) {
      this.lastActivity = Date.now();
      return;
    }
    if (Date.now() - this.lastActivity < config.idleMinutes * 60_000) return;
    this.startedSerial = null;
    console.log(`  Idle for ${config.idleMinutes} min: shutting down ${serial} (it saves a snapshot and restarts in seconds).`);
    // 'emu kill' saves a quick-boot snapshot, so the next start resumes instead of cold-booting.
    await this.adb.exec(['-s', serial, 'emu', 'kill']).catch(() => {});
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

  /** Extracts the launcher icon from an installed app's APK (cached). Returns { data, type } or null. */
  async appIcon(pkg) {
    assertPackage(pkg);
    const cached = path.join(this.iconDir, `${pkg}.icon`);
    try {
      return JSON.parse(await fsp.readFile(cached + '.json', 'utf8')).hasIcon
        ? imageResult(await fsp.readFile(cached))
        : null;
    } catch {
      // not cached yet
    }
    // Icons must never start Android on their own; try again once it is running.
    if (!(await this.status()).selectedSerial) return null;
    const d = await this.device();
    const apkPath = (await d.shell(`pm path ${pkg}`)).split('\n').map((l) => l.trim()).find((l) => l.endsWith('base.apk') || l.startsWith('package:'));
    if (!apkPath) return null;
    await fsp.mkdir(this.iconDir, { recursive: true });
    const tmp = path.join(this.iconDir, `${pkg}.apk`);
    let icon = null;
    let label = null;
    try {
      await d.exec(['pull', apkPath.replace(/^package:/, ''), tmp], { timeout: 120_000 });
      ({ icon = null, label = null } = inspectApk(await fsp.readFile(tmp)));
    } catch {
      // unreadable APK: fall back to a monogram on the phone
    } finally {
      await fsp.rm(tmp, { force: true });
    }
    if (icon) await fsp.writeFile(cached, icon);
    await fsp.writeFile(cached + '.json', JSON.stringify({ hasIcon: Boolean(icon), label }));
    return icon ? imageResult(icon) : null;
  }

  /** The real app name, once appIcon() has read the app's APK. */
  async cachedLabel(pkg) {
    try {
      return JSON.parse(await fsp.readFile(path.join(this.iconDir, `${pkg}.icon.json`), 'utf8')).label ?? null;
    } catch {
      return null;
    }
  }

  async appAction(pkg, action) {
    assertPackage(pkg);
    const d = await this.device();
    switch (action) {
      case 'launch': {
        // Starting the launcher activity directly is about a second faster than `monkey`.
        const activity = (
          await d.shell(`cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${pkg} | tail -n 1`)
        ).trim();
        if (activity.includes('/')) {
          await d.shell(`am start -n ${activity} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -f 0x10200000`);
          return;
        }
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

function imageResult(data) {
  const type = data[0] === 0x89 ? 'image/png' : data.subarray(0, 4).toString() === 'RIFF' ? 'image/webp' : 'image/jpeg';
  return { data, type };
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
