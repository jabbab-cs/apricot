// Remote access: a free Cloudflare quick tunnel (https://<random>.trycloudflare.com -> this server).
// No account needed. cloudflared is downloaded into server/vendor/ on first use.
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const EXE = process.platform === 'win32' ? '.exe' : '';
const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function assetName() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  if (process.platform === 'darwin') return `cloudflared-darwin-${arch}.tgz`;
  if (process.platform === 'win32') return `cloudflared-windows-${arch}.exe`;
  return `cloudflared-linux-${arch}`;
}

function onPath() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir, 'cloudflared' + EXE);
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
}

async function ensureCloudflared() {
  const vendored = path.join(config.vendorDir, 'cloudflared' + EXE);
  if (fs.existsSync(vendored)) return vendored;
  const system = onPath();
  if (system) return system;

  const asset = assetName();
  const res = await fetch(`${RELEASES}/${asset}`);
  if (!res.ok) throw new Error(`Downloading cloudflared failed (HTTP ${res.status})`);
  await fsp.mkdir(config.vendorDir, { recursive: true });
  const tmp = path.join(config.vendorDir, asset + '.part');
  await fsp.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  if (asset.endsWith('.tgz')) {
    await new Promise((resolve, reject) =>
      execFile('tar', ['-xzf', tmp, '-C', config.vendorDir], (err) => (err ? reject(err) : resolve())),
    );
    await fsp.rm(tmp);
  } else {
    await fsp.rename(tmp, vendored);
  }
  await fsp.chmod(vendored, 0o755);
  return vendored;
}

/** Keeps a quick tunnel running and restarts it if cloudflared exits. Emits 'url' on every new address. */
export class Tunnel extends EventEmitter {
  url = null;
  error = null;
  #child = null;
  #stopped = false;

  async start(port) {
    let bin;
    try {
      bin = await ensureCloudflared();
    } catch (err) {
      this.error = `Remote access unavailable: ${err.message}`;
      this.emit('error', this.error);
      return;
    }
    this.#run(bin, port);
  }

  #run(bin, port) {
    if (this.#stopped) return;
    const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#child = child;
    const scan = (chunk) => {
      const m = URL_RE.exec(chunk.toString());
      if (m && m[0] !== this.url) {
        this.url = m[0];
        this.error = null;
        this.emit('url', this.url);
      }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('error', (err) => (this.error = err.message));
    child.on('exit', () => {
      this.url = null;
      if (!this.#stopped) setTimeout(() => this.#run(bin, port), 5000);
    });
  }

  stop() {
    this.#stopped = true;
    this.#child?.kill();
  }
}
