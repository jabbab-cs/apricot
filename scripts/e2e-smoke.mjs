#!/usr/bin/env node
// End-to-end smoke test against a running Apricot server with a booted device:
// upload the sample APK, install + launch it, stream video, tap the button, check it counted.
// Usage: node scripts/e2e-smoke.mjs [http://localhost:7420]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://localhost:7420';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apk = fs.readFileSync(path.join(root, 'examples/hello-apricot/hello-apricot.apk'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts = {}) {
  const res = await fetch(base + p, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${opts.method ?? 'GET'} ${p} -> ${res.status} ${body.error ?? ''}`);
  return body;
}

function step(name) {
  console.log(`\n▸ ${name}`);
}

step('server status');
const status = await api('/api/status');
const device = status.devices.find((d) => d.state === 'device');
if (!device) throw new Error('No running device');
console.log(`  device ${device.serial} (${device.model}), scrcpy-server ${status.tools.scrcpyServer}`);

step('upload + inspect APK');
const entry = await api('/api/apks', { method: 'POST', headers: { 'X-File-Name': 'hello-apricot.apk' }, body: apk });
if (entry.packageName !== 'dev.apricot.hello' || entry.label !== 'Hello Apricot' || !entry.hasIcon) {
  throw new Error(`Unexpected APK metadata: ${JSON.stringify(entry)}`);
}
console.log(`  ${entry.label} ${entry.versionName} (${entry.packageName}), icon ${entry.iconPath}`);

step('install + launch');
await api(`/api/apks/${entry.id}/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"launch":true}' });
const apps = await api('/api/apps');
if (!apps.some((a) => a.packageName === 'dev.apricot.hello')) throw new Error('App not listed as installed');
console.log('  installed and launched');
await sleep(4000);

step('stream + input');
const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws/stream');
ws.binaryType = 'arraybuffer';
let frames = 0;
let keyFrames = 0;
let size = null;
ws.onmessage = (e) => {
  if (typeof e.data === 'string') {
    const m = JSON.parse(e.data);
    if (m.width) size = { width: m.width, height: m.height };
    if (m.type === 'error') console.error('  stream error:', m.message);
  } else {
    frames++;
    if (new Uint8Array(e.data)[0] & 1) keyFrames++;
  }
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('WebSocket failed'));
});
for (let i = 0; i < 60 && frames === 0; i++) await sleep(500);
if (!frames || !keyFrames) throw new Error(`No video received (frames=${frames}, keyFrames=${keyFrames})`);
console.log(`  video ${size?.width}x${size?.height}, first key frame received`);

// Logcat for the app, to see the taps land.
const logs = [];
const logWs = new WebSocket(base.replace(/^http/, 'ws') + '/ws/logcat?package=dev.apricot.hello&level=I');
logWs.onmessage = (e) => logs.push(...JSON.parse(e.data).lines.map((l) => l.message));
await sleep(2500);

// The "Tap me" button sits just below the vertical center in portrait.
for (let i = 0; i < 3; i++) {
  for (const action of ['down', 'up']) ws.send(JSON.stringify({ type: 'touch', action, id: 0, x: 0.5, y: 0.493 }));
  await sleep(700);
}
await sleep(2500);
const taps = logs.filter((m) => /^tap #\d+/.test(m));
console.log(`  frames=${frames}, taps seen in logcat: ${taps.join(', ') || 'none'}`);
ws.close();
logWs.close();
if (taps.length < 3) throw new Error('Taps did not reach the app');

step('cleanup');
await api('/api/apps/dev.apricot.hello/uninstall', { method: 'POST' });
await api(`/api/apks/${entry.id}`, { method: 'DELETE' });
console.log('\n✔ end-to-end smoke test passed');
process.exit(0);
