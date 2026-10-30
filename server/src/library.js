// The APK library: uploaded APKs plus their extracted metadata, stored on disk.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { inspectApk } from './apk.js';

export class ApkLibrary {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'apks');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  #metaPath(id) {
    return path.join(this.dir, `${id}.json`);
  }

  apkPath(id) {
    if (!/^[a-f0-9]{16}$/.test(id)) throw Object.assign(new Error('Invalid APK id'), { status: 400 });
    return path.join(this.dir, `${id}.apk`);
  }

  iconPath(id) {
    return path.join(this.dir, `${id}.icon`);
  }

  async list() {
    const files = (await fsp.readdir(this.dir)).filter((f) => f.endsWith('.json'));
    const items = await Promise.all(
      files.map(async (f) => JSON.parse(await fsp.readFile(path.join(this.dir, f), 'utf8'))),
    );
    return items.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }

  async get(id) {
    try {
      return JSON.parse(await fsp.readFile(this.#metaPath(id), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Moves an uploaded temp file into the library. Re-uploading the same file returns the existing entry. */
  async add(tempFile, originalName) {
    const buf = await fsp.readFile(tempFile);
    let info;
    try {
      info = inspectApk(buf);
    } catch (err) {
      await fsp.rm(tempFile, { force: true });
      throw Object.assign(err, { status: 422 });
    }

    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const id = sha256.slice(0, 16);
    const existing = await this.get(id);
    if (existing) {
      await fsp.rm(tempFile, { force: true });
      return existing;
    }

    const { icon, ...meta } = info;
    await fsp.rename(tempFile, this.apkPath(id));
    if (icon) await fsp.writeFile(this.iconPath(id), icon);

    const entry = {
      id,
      ...meta,
      label: meta.label ?? prettifyPackage(meta.packageName) ?? originalName.replace(/\.apk$/i, ''),
      fileName: originalName,
      size: buf.length,
      sha256,
      hasIcon: Boolean(icon),
      iconType: meta.iconPath === 'rendered.png' ? 'image/png' : iconMime(meta.iconPath),
      addedAt: new Date().toISOString(),
    };
    await fsp.writeFile(this.#metaPath(id), JSON.stringify(entry, null, 2));
    return entry;
  }

  /** Entries added before Apricot could draw XML icons get one on first request. */
  async ensureIcon(meta) {
    if (meta.hasIcon || meta.iconTried) return meta;
    let icon = null;
    try {
      icon = inspectApk(await fsp.readFile(this.apkPath(meta.id))).icon;
    } catch {
      // keep the monogram
    }
    if (icon) await fsp.writeFile(this.iconPath(meta.id), icon);
    const updated = { ...meta, hasIcon: Boolean(icon), iconType: icon ? 'image/png' : meta.iconType, iconTried: true };
    await fsp.writeFile(this.#metaPath(meta.id), JSON.stringify(updated, null, 2));
    return updated;
  }

  async remove(id) {
    await Promise.all(
      [this.apkPath(id), this.#metaPath(id), this.iconPath(id)].map((p) => fsp.rm(p, { force: true })),
    );
  }
}

function iconMime(p) {
  if (!p) return null;
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.jpg')) return 'image/jpeg';
  return 'image/png';
}

export function prettifyPackage(pkg) {
  if (!pkg) return null;
  const last = pkg.split('.').pop();
  return last.charAt(0).toUpperCase() + last.slice(1);
}
