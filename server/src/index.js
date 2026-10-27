#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { DeviceManager, assertPackage } from './devices.js';
import { advertise, computerName } from './discovery.js';
import { ApkLibrary, prettifyPackage } from './library.js';
import { streamLogcat } from './logcat.js';
import { KEYCODES, TOUCH_DOWN, TOUCH_MOVE, TOUCH_UP } from './scrcpy.js';

const SETUP_HINT = process.platform === 'win32' ? 'scripts\\setup-windows.ps1' : 'scripts/setup.sh';
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
const devices = new DeviceManager();
const library = new ApkLibrary(config.dataDir);
const tmpDir = path.join(config.dataDir, 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });

// ---------- helpers ----------

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1024 * 1024) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

function authorized(req, url) {
  if (!config.token) return true;
  const header = req.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token') ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(config.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(config.publicDir, path.normalize(rel));
  if (!file.startsWith(config.publicDir)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

/** Streams an uploaded APK (raw request body) to a temp file, then adds it to the library. */
async function receiveUpload(req) {
  const rawName = decodeURIComponent(req.headers['x-file-name'] ?? 'upload.apk');
  const name = path.basename(rawName).replace(/[^\w.\- ()]/g, '_') || 'upload.apk';
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > config.maxUploadBytes) throw Object.assign(new Error('APK is too large'), { status: 413 });

  const tmp = path.join(tmpDir, `${crypto.randomUUID()}.apk`);
  let received = 0;
  req.on('data', (c) => {
    received += c.length;
    if (received > config.maxUploadBytes) req.destroy(new Error('APK is too large'));
  });
  try {
    await pipeline(req, fs.createWriteStream(tmp));
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw Object.assign(err, { status: 413 });
  }
  if (received === 0) {
    await fsp.rm(tmp, { force: true });
    throw Object.assign(new Error('Empty upload'), { status: 400 });
  }
  return library.add(tmp, name);
}

// ---------- routes ----------

const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

route('GET', '/api/status', async () => ({
  name: 'Apricot',
  version: VERSION,
  host: computerName(),
  addresses: lanAddresses(),
  port: config.port,
  authRequired: Boolean(config.token),
  ...(await devices.status()),
}));

route('POST', '/api/devices/select', async (req) => {
  const { serial } = await readJson(req);
  devices.select(serial);
  return { ok: true };
});

route('POST', '/api/avds/boot', async (req) => {
  const { name } = await readJson(req);
  if (!/^[\w.-]+$/.test(name ?? '')) throw Object.assign(new Error('Invalid emulator name'), { status: 400 });
  await devices.boot(name);
  return { ok: true, message: `Booting ${name}. It shows up under devices in ~20-60 seconds.` };
});

route('GET', '/api/device/info', () => devices.info());

route('POST', '/api/device/key', async (req) => {
  const { key } = await readJson(req);
  await devices.key(key);
  return { ok: true };
});

route('POST', '/api/device/text', async (req) => {
  const { text } = await readJson(req);
  if (typeof text !== 'string' || !text) throw Object.assign(new Error('text is required'), { status: 400 });
  await devices.text(text);
  return { ok: true };
});

route('POST', '/api/device/rotate', async () => {
  await devices.rotate();
  return { ok: true };
});

route('GET', '/api/device/screenshot', async (_req, res) => {
  const png = await devices.screenshot();
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Disposition': `inline; filename="apricot-${Date.now()}.png"`,
  });
  res.end(png);
});

route('GET', '/api/apks', () => library.list());

route('POST', '/api/apks', (req) => receiveUpload(req));

route('GET', '/api/apks/:id/icon', async (_req, res, { id }) => {
  const meta = await library.get(id);
  if (!meta?.hasIcon) return sendJson(res, 404, { error: 'No icon' });
  res.writeHead(200, { 'Content-Type': meta.iconType ?? 'image/png', 'Cache-Control': 'max-age=86400' });
  fs.createReadStream(library.iconPath(id)).pipe(res);
});

route('GET', '/api/apks/:id/download', async (_req, res, { id }) => {
  const meta = await library.get(id);
  if (!meta) return sendJson(res, 404, { error: 'Not found' });
  res.writeHead(200, {
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Disposition': `attachment; filename="${meta.fileName}"`,
  });
  fs.createReadStream(library.apkPath(id)).pipe(res);
});

route('DELETE', '/api/apks/:id', async (_req, _res, { id }) => {
  await library.remove(id);
  return { ok: true };
});

route('POST', '/api/apks/:id/install', async (req, _res, { id }) => {
  const { launch = true } = await readJson(req);
  const meta = await library.get(id);
  if (!meta) throw Object.assign(new Error('APK not found in library'), { status: 404 });
  await devices.install(library.apkPath(id));
  if (launch && meta.packageName) await devices.appAction(meta.packageName, 'launch');
  return { ok: true, packageName: meta.packageName };
});

route('GET', '/api/apps', async () => {
  const [packages, apks] = await Promise.all([devices.installedPackages(), library.list()]);
  const byPackage = new Map(apks.map((a) => [a.packageName, a]));
  return packages.map((pkg) => {
    const apk = byPackage.get(pkg);
    return {
      packageName: pkg,
      label: apk?.label ?? prettifyPackage(pkg),
      apkId: apk?.id ?? null,
      hasIcon: Boolean(apk?.hasIcon),
      versionName: apk?.versionName ?? null,
    };
  });
});

route('POST', '/api/apps/:pkg/:action', async (_req, _res, { pkg, action }) => {
  await devices.appAction(decodeURIComponent(pkg), action);
  return { ok: true };
});

// ---------- http server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-File-Name');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
  if (url.pathname !== '/api/status' && !authorized(req, url)) return sendJson(res, 401, { error: 'Unauthorized' });

  for (const r of routes) {
    const m = r.method === req.method && r.re.exec(url.pathname);
    if (!m) continue;
    try {
      const result = await r.handler(req, res, m.groups ?? {});
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
    } catch (err) {
      if (!res.headersSent) sendJson(res, err.status ?? 500, { error: err.message });
      if (!err.status) console.error(`[${req.method} ${url.pathname}]`, err);
    }
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
});

// ---------- websockets ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (!['/ws/stream', '/ws/logcat'].includes(url.pathname) || !authorized(req, url)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === '/ws/stream') handleStream(ws, url).catch((err) => closeWithError(ws, err));
    else handleLogcat(ws, url).catch((err) => closeWithError(ws, err));
  });
});

function closeWithError(ws, err) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    ws.close(1011, err.message.slice(0, 120));
  }
}

async function handleLogcat(ws, url) {
  const device = await devices.device();
  const pkg = url.searchParams.get('package');
  streamLogcat(device, ws, {
    pkg: pkg ? assertPackage(pkg) : null,
    minLevel: url.searchParams.get('level') ?? 'V',
  });
}

const TOUCH_ACTIONS = { down: TOUCH_DOWN, move: TOUCH_MOVE, up: TOUCH_UP, cancel: TOUCH_UP };
// Each viewer gets its own range of Android pointer ids so two clients never share a finger.
let nextPointerBase = 0;

async function handleStream(ws, url) {
  const { serial } = await devices.device(url.searchParams.get('serial') || undefined);
  const entry = await devices.acquireSession(serial);
  const viewer = { ws, needKey: true, pointerBase: (nextPointerBase++ % 1000) * 16, down: new Map() };
  entry.viewers.add(viewer);
  ws.once('close', () => devices.releaseViewer(entry, viewer));

  await entry.ready;
  const { session } = entry;
  const stats = { sent: 0, waitingForKey: 0, backpressure: 0 };
  const statsTimer = process.env.APRICOT_DEBUG
    ? setInterval(() => console.error(`[stream ${serial}] ${JSON.stringify(stats)} buffered=${ws.bufferedAmount}`), 5000)
    : null;
  ws.once('close', () => clearInterval(statsTimer));
  const send = (frame) => {
    if (ws.readyState !== ws.OPEN) return;
    if (viewer.needKey && !frame.key) {
      stats.waitingForKey++;
      return;
    }
    // Slow client: drop frames until a fresh key frame instead of building latency.
    if (ws.bufferedAmount > 4 * 1024 * 1024) {
      stats.backpressure++;
      viewer.needKey = true;
      session.requestKeyFrame();
      return;
    }
    stats.sent++;
    viewer.needKey = false;
    const out = Buffer.allocUnsafe(frame.data.length + 1);
    out[0] = frame.key ? 1 : 0;
    frame.data.copy(out, 1);
    ws.send(out);
  };
  const onSize = (size) => ws.send(JSON.stringify({ type: 'size', ...size }));
  const onClose = (reason) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'closed', reason }));
      ws.close(1000);
    }
  };
  session.on('frame', send);
  session.on('size', onSize);
  session.once('close', onClose);
  ws.once('close', () => {
    // Lift any fingers this viewer still holds, or the device keeps them pressed.
    const size = session.videoSize;
    if (size) for (const [id, p] of viewer.down) session.touch(TOUCH_UP, id, p.x, p.y, size.width, size.height);
    session.off('frame', send);
    session.off('size', onSize);
    session.off('close', onClose);
  });

  ws.send(JSON.stringify({ type: 'hello', serial, deviceName: session.deviceName, ...(session.videoSize ?? {}) }));
  for (const frame of session.catchUpFrames()) send(frame);

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const size = session.videoSize;
    if (process.env.APRICOT_DEBUG && msg.type !== 'touch') console.error(`[control] viewer=${viewer.pointerBase / 16} ${raw}`);
    switch (msg.type) {
      case 'touch': {
        const action = TOUCH_ACTIONS[msg.action];
        if (action === undefined || !size) return;
        const x = Math.max(0, Math.min(1, Number(msg.x))) * size.width;
        const y = Math.max(0, Math.min(1, Number(msg.y))) * size.height;
        const id = viewer.pointerBase + (Math.abs(Number(msg.id)) % 16 || 0);
        if (action === TOUCH_UP) viewer.down.delete(id);
        else viewer.down.set(id, { x, y });
        if (process.env.APRICOT_DEBUG && action !== TOUCH_MOVE) {
          console.error(`[touch] viewer=${viewer.pointerBase / 16} ${msg.action} id=${id} ${Math.round(x)},${Math.round(y)}`);
        }
        session.touch(action, id, x, y, size.width, size.height, msg.pressure ?? 1);
        return;
      }
      case 'scroll':
        if (size) {
          session.scroll(msg.x * size.width, msg.y * size.height, size.width, size.height, Number(msg.dx) || 0, Number(msg.dy) || 0);
        }
        return;
      case 'key':
        if (KEYCODES[msg.key] !== undefined) session.pressKey(KEYCODES[msg.key]);
        return;
      case 'text':
        if (typeof msg.text === 'string' && msg.text) session.text(msg.text);
        return;
      case 'wake':
        return session.backOrScreenOn();
      case 'rotate':
        return session.rotate();
      case 'notifications':
        return session.expandNotifications();
      case 'quick-settings':
        return session.expandSettings();
      case 'collapse':
        return session.collapsePanels();
      case 'keyframe':
        return session.requestKeyFrame();
    }
  });
}

// ---------- shutdown ----------

let stopAdvertising = async () => {};
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { session } of devices.sessions.values()) session.stop('server shutting down');
  await stopAdvertising(); // sends mDNS goodbyes so phones don't keep listing a stale entry
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------- start ----------

server.listen(config.port, config.host, async () => {
  if (config.bonjour) stopAdvertising = advertise({ port: config.port, version: VERSION });
  const s = await devices.status();
  const c = (code, text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
  const ok = (v) => (v ? c(32, '✔') : c(31, '✘'));
  const ready = s.devices.filter((d) => d.state === 'device');

  console.log(`\n  ${c('38;5;209;1', 'Apricot')} ${c(2, `v${VERSION}`)}  -  Android apps on your iPhone\n`);
  console.log(`  Dashboard   ${c(1, `http://localhost:${config.port}`)}`);
  for (const ip of lanAddresses()) console.log(`  iPhone      ${c(1, `http://${ip}:${config.port}`)}`);
  console.log('');
  console.log(`  ${ok(s.tools.adb)} adb            ${c(2, s.tools.adb ?? `not found - run ${SETUP_HINT}`)}`);
  console.log(`  ${ok(s.tools.scrcpyServer)} scrcpy-server  ${c(2, s.tools.scrcpyServer ? `v${s.tools.scrcpyServer}` : `missing - run ${SETUP_HINT}`)}`);
  console.log(`  ${ok(s.tools.emulator)} emulator       ${c(2, s.tools.emulator ? `${s.avds.length} virtual device(s)` : 'not found - install Android Studio')}`);
  console.log(`  ${ok(ready.length)} devices        ${c(2, ready.length ? ready.map((d) => d.model).join(', ') : 'none running yet - boot one from the app or dashboard')}`);
  if (config.token) console.log(`\n  ${c(33, 'Token auth enabled')} (APRICOT_TOKEN)`);
  console.log('');
});
