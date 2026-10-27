// Drives scrcpy-server (https://github.com/Genymobile/scrcpy) on the device:
// receives the H.264 video stream and sends touch/key control messages.
// Protocol reference: scrcpy doc/develop.md (v5).
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';

const REMOTE_JAR = '/data/local/tmp/apricot-scrcpy-server.jar';
const CODEC_H264 = 0x68323634;
const FLAG_CONFIG = 1n << 62n;
const FLAG_KEY_FRAME = 1n << 61n;
const MAX_GOP_FRAMES = 600;
// Above this, a joining viewer gets a fresh key frame instead of the whole cached GOP.
const MAX_CATCH_UP_BYTES = 1_500_000;

const MSG_INJECT_KEYCODE = 0;
const MSG_INJECT_TEXT = 1;
const MSG_INJECT_TOUCH = 2;
const MSG_INJECT_SCROLL = 3;
const MSG_BACK_OR_SCREEN_ON = 4;
const MSG_EXPAND_NOTIFICATION_PANEL = 5;
const MSG_EXPAND_SETTINGS_PANEL = 6;
const MSG_COLLAPSE_PANELS = 7;
const MSG_ROTATE_DEVICE = 11;
const MSG_RESET_VIDEO = 17;

export const KEYCODES = {
  home: 3,
  back: 4,
  call: 5,
  dpad_up: 19,
  dpad_down: 20,
  dpad_left: 21,
  dpad_right: 22,
  volume_up: 24,
  volume_down: 25,
  power: 26,
  camera: 27,
  tab: 61,
  enter: 66,
  del: 67,
  menu: 82,
  escape: 111,
  forward_del: 112,
  recents: 187,
};

export const TOUCH_DOWN = 0;
export const TOUCH_UP = 1;
export const TOUCH_MOVE = 2;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Connects through the adb forward and waits for the dummy byte proving the server side is listening. */
async function connectVideoSocket(port, isAlive) {
  for (let attempt = 0; attempt < 100 && isAlive(); attempt++) {
    const result = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      const fail = () => {
        socket.destroy();
        resolve(null);
      };
      socket.once('error', fail);
      socket.once('close', fail);
      socket.once('data', (chunk) => {
        // Hold further data until the caller attaches its own 'data' listener.
        socket.pause();
        socket.removeListener('error', fail);
        socket.removeListener('close', fail);
        resolve({ socket, rest: chunk.subarray(1) });
      });
    });
    if (result) return result;
    await sleep(100);
  }
  throw new Error('Could not connect to scrcpy-server on the device.');
}

function connectSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
    socket.once('error', reject);
  });
}

export class ScrcpySession extends EventEmitter {
  /**
   * @param {object} opts
   * @param {ReturnType<import('./adb.js').Adb['forDevice']>} opts.device
   * @param {string} opts.serverJar local path to scrcpy-server
   * @param {string} opts.version scrcpy-server version string
   * @param {{maxSize:number,bitRate:number,maxFps:number}} opts.video
   */
  constructor({ device, serverJar, version, video }) {
    super();
    this.device = device;
    this.serverJar = serverJar;
    this.version = version;
    this.videoOpts = video;
    this.state = 'idle';
    this.deviceName = null;
    this.videoSize = null;
    this.codecConfig = null;
    this.gop = [];
    this.hasVideo = false;
    this.log = [];
    this.pending = Buffer.alloc(0);
    this.headerDone = false;
  }

  async start() {
    this.state = 'starting';
    try {
      await this.device.exec(['push', this.serverJar, REMOTE_JAR], { timeout: 60_000 });
      const scid = crypto.randomInt(1, 0x7fffffff).toString(16).padStart(8, '0');
      this.port = await freePort();
      await this.device.exec(['forward', `tcp:${this.port}`, `localabstract:scrcpy_${scid}`]);

      const { maxSize, bitRate, maxFps } = this.videoOpts;
      const cmd = [
        `CLASSPATH=${REMOTE_JAR}`,
        'app_process',
        '/',
        'com.genymobile.scrcpy.Server',
        this.version,
        `scid=${scid}`,
        'log_level=info',
        'tunnel_forward=true',
        'audio=false',
        'control=true',
        'video_codec=h264',
        `max_size=${maxSize}`,
        `video_bit_rate=${bitRate}`,
        `max_fps=${maxFps}`,
        'stay_awake=true',
        'clipboard_autosync=false',
        'cleanup=true',
      ].join(' ');

      this.proc = this.device.spawn(['shell', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
      const capture = (chunk) => {
        this.log.push(...chunk.toString().split('\n').filter(Boolean));
        if (this.log.length > 50) this.log.splice(0, this.log.length - 50);
      };
      this.proc.stdout.on('data', capture);
      this.proc.stderr.on('data', capture);
      this.proc.once('exit', (code) => this.stop(`scrcpy-server exited (code ${code})`));

      const { socket, rest } = await connectVideoSocket(this.port, () => this.state === 'starting');
      this.video = socket;
      this.control = await connectSocket(this.port);
      this.control.on('data', () => {}); // device messages (clipboard etc.) are not used
      this.control.on('error', () => {});

      this.video.on('data', (chunk) => this.#onVideoData(chunk));
      this.video.on('close', () => this.stop('video stream closed'));
      this.video.on('error', () => {});
      this.state = 'running';
      if (rest.length) this.#onVideoData(rest);
      this.video.resume();
    } catch (err) {
      const detail = this.log.filter((l) => /ERROR|Exception|error/.test(l)).slice(-3).join(' | ');
      this.stop(err.message);
      throw new Error(detail ? `${err.message} (${detail})` : err.message);
    }
  }

  #onVideoData(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let buf = this.pending;
    let off = 0;

    if (!this.headerDone) {
      if (buf.length < 64 + 4) return;
      this.deviceName = buf.toString('utf8', 0, 64).replace(/\0.*$/s, '');
      const codec = buf.readUInt32BE(64);
      if (codec !== CODEC_H264) {
        this.stop(codec === 1 ? 'Video encoder configuration error on the device' : 'Video stream disabled by device');
        return;
      }
      off = 68;
      this.headerDone = true;
    }

    while (buf.length - off >= 12) {
      if (buf[off] & 0x80) {
        // session packet: flags(4) width(4) height(4)
        this.videoSize = { width: buf.readUInt32BE(off + 4), height: buf.readUInt32BE(off + 8) };
        off += 12;
        this.emit('size', this.videoSize);
        continue;
      }
      const size = buf.readUInt32BE(off + 8);
      if (buf.length - off - 12 < size) break;
      const flags = buf.readBigUInt64BE(off);
      const payload = Buffer.from(buf.subarray(off + 12, off + 12 + size));
      off += 12 + size;

      if (flags & FLAG_CONFIG) {
        this.codecConfig = payload; // SPS + PPS, merged into the next key frame
        continue;
      }
      const key = (flags & FLAG_KEY_FRAME) !== 0n;
      const data = key && this.codecConfig ? Buffer.concat([this.codecConfig, payload]) : payload;
      const frame = { key, data };
      this.hasVideo = true;
      if (key) this.gop = [frame];
      else if (this.gop.length) this.gop.push(frame);
      if (this.gop.length > MAX_GOP_FRAMES) {
        this.gop = [];
        this.resetVideo();
      }
      this.emit('frame', frame);
    }
    this.pending = off < buf.length ? buf.subarray(off) : Buffer.alloc(0);
  }

  /** Frames a newly joined viewer needs to start decoding (last key frame and its successors). */
  catchUpFrames() {
    const bytes = this.gop.reduce((n, f) => n + f.data.length, 0);
    if (this.gop.length && this.gop[0].key && bytes <= MAX_CATCH_UP_BYTES) return this.gop;
    this.requestKeyFrame();
    return [];
  }

  /** Asks the encoder for a new key frame, at most twice a second. */
  requestKeyFrame() {
    const now = Date.now();
    if (now - (this.lastKeyRequest ?? 0) < 500) return;
    this.lastKeyRequest = now;
    this.resetVideo();
  }

  #send(buf) {
    if (this.state === 'running' && this.control?.writable) this.control.write(buf);
  }

  touch(action, pointerId, x, y, width, height, pressure = 1) {
    const b = Buffer.alloc(32);
    b[0] = MSG_INJECT_TOUCH;
    b[1] = action;
    b.writeBigUInt64BE(BigInt.asUintN(64, BigInt(pointerId)), 2);
    b.writeInt32BE(Math.round(x), 10);
    b.writeInt32BE(Math.round(y), 14);
    b.writeUInt16BE(width, 18);
    b.writeUInt16BE(height, 20);
    b.writeUInt16BE(action === TOUCH_UP ? 0 : Math.min(0xffff, Math.round(pressure * 0xffff)), 22);
    b.writeUInt32BE(0, 24); // action button
    b.writeUInt32BE(0, 28); // buttons
    this.#send(b);
  }

  scroll(x, y, width, height, hScroll, vScroll) {
    const b = Buffer.alloc(21);
    b[0] = MSG_INJECT_SCROLL;
    b.writeInt32BE(Math.round(x), 1);
    b.writeInt32BE(Math.round(y), 5);
    b.writeUInt16BE(width, 9);
    b.writeUInt16BE(height, 11);
    // i16 fixed point over [-16, 16]
    const fx = (v) => Math.max(-0x8000, Math.min(0x7fff, Math.round((v / 16) * 0x8000)));
    b.writeInt16BE(fx(hScroll), 13);
    b.writeInt16BE(fx(vScroll), 15);
    b.writeUInt32BE(0, 17);
    this.#send(b);
  }

  keycode(keycode, action, repeat = 0, metaState = 0) {
    const b = Buffer.alloc(14);
    b[0] = MSG_INJECT_KEYCODE;
    b[1] = action;
    b.writeUInt32BE(keycode, 2);
    b.writeUInt32BE(repeat, 6);
    b.writeUInt32BE(metaState, 10);
    this.#send(b);
  }

  pressKey(keycode) {
    this.keycode(keycode, 0);
    this.keycode(keycode, 1);
  }

  text(str) {
    // scrcpy limits injected text to 300 bytes per message
    let rest = Buffer.from(str, 'utf8');
    while (rest.length) {
      let cut = Math.min(300, rest.length);
      while (cut < rest.length && (rest[cut] & 0xc0) === 0x80) cut--; // don't split a UTF-8 sequence
      const chunk = rest.subarray(0, cut);
      rest = rest.subarray(cut);
      const b = Buffer.alloc(5 + chunk.length);
      b[0] = MSG_INJECT_TEXT;
      b.writeUInt32BE(chunk.length, 1);
      chunk.copy(b, 5);
      this.#send(b);
    }
  }

  backOrScreenOn() {
    this.#send(Buffer.from([MSG_BACK_OR_SCREEN_ON, 0]));
    this.#send(Buffer.from([MSG_BACK_OR_SCREEN_ON, 1]));
  }

  expandNotifications() {
    this.#send(Buffer.from([MSG_EXPAND_NOTIFICATION_PANEL]));
  }

  expandSettings() {
    this.#send(Buffer.from([MSG_EXPAND_SETTINGS_PANEL]));
  }

  collapsePanels() {
    this.#send(Buffer.from([MSG_COLLAPSE_PANELS]));
  }

  rotate() {
    this.#send(Buffer.from([MSG_ROTATE_DEVICE]));
  }

  resetVideo() {
    // Before the first frame, scrcpy-server has no capture yet and crashes on RESET_VIDEO
    // (the first key frame arrives on its own anyway).
    if (!this.hasVideo) return;
    this.#send(Buffer.from([MSG_RESET_VIDEO]));
  }

  stop(reason = 'stopped') {
    if (process.env.APRICOT_DEBUG) console.error(`[scrcpy] stop: ${reason}\n${this.log.join('\n')}`);
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    this.video?.destroy();
    this.control?.destroy();
    if (this.proc && this.proc.exitCode === null) this.proc.kill();
    if (this.port) this.device.exec(['forward', '--remove', `tcp:${this.port}`]).catch(() => {});
    this.emit('close', reason);
  }
}
