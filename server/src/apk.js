// Dependency-free APK inspector: reads the zip, decodes the binary
// AndroidManifest.xml and resolves label/icon through resources.arsc.
import zlib from 'node:zlib';
import { renderIcon } from './icon.js';

// ---------- zip ----------

export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This file is not a valid APK (zip directory not found).');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, {
      name,
      method: buf.readUInt16LE(off + 10),
      compressedSize: buf.readUInt32LE(off + 20),
      size: buf.readUInt32LE(off + 24),
      localOffset: buf.readUInt32LE(off + 42),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }

  return {
    entries,
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const lo = e.localOffset;
      const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
      const data = buf.subarray(start, start + e.compressedSize);
      if (e.method === 0) return data;
      if (e.method === 8) return zlib.inflateRawSync(data);
      throw new Error(`Unsupported zip compression method ${e.method} for ${name}`);
    },
  };
}

// ---------- Android binary resources ----------

const RES_STRING_POOL = 0x0001;
const RES_TABLE = 0x0002;
const RES_XML = 0x0003;
const RES_XML_START_ELEMENT = 0x0102;
const RES_XML_RESOURCE_MAP = 0x0180;
const RES_TABLE_PACKAGE = 0x0200;
const RES_TABLE_TYPE = 0x0201;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_FLOAT = 0x04;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_BOOLEAN = 0x12;

// android:* attribute ids, used when attribute names were stripped by obfuscators.
const ATTR_IDS = {
  0x01010001: 'label',
  0x01010002: 'icon',
  0x0101021b: 'versionCode',
  0x0101021c: 'versionName',
  0x0101020c: 'minSdkVersion',
  0x01010270: 'targetSdkVersion',
  0x01010003: 'name',
};

function parseStringPool(buf, start) {
  const headerSize = buf.readUInt16LE(start + 2);
  const count = buf.readUInt32LE(start + 8);
  const flags = buf.readUInt32LE(start + 16);
  const stringsStart = buf.readUInt32LE(start + 20);
  const utf8 = (flags & 0x100) !== 0;
  const strings = new Array(count);
  const base = start + stringsStart;

  for (let i = 0; i < count; i++) {
    let p = base + buf.readUInt32LE(start + headerSize + i * 4);
    if (utf8) {
      // utf16 length, then utf8 byte length, each 1 or 2 bytes
      p += buf[p] & 0x80 ? 2 : 1;
      let len = buf[p];
      if (len & 0x80) {
        len = ((len & 0x7f) << 8) | buf[p + 1];
        p += 2;
      } else {
        p += 1;
      }
      strings[i] = buf.toString('utf8', p, p + len);
    } else {
      let len = buf.readUInt16LE(p);
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p + 2);
        p += 4;
      } else {
        p += 2;
      }
      strings[i] = buf.toString('utf16le', p, p + len * 2);
    }
  }
  return strings;
}

/** Decodes a binary XML document into a flat list of start elements. */
export function parseBinaryXml(buf) {
  if (buf.readUInt16LE(0) !== RES_XML) throw new Error('AndroidManifest.xml is not binary XML');
  let strings = [];
  let resourceIds = [];
  const elements = [];
  let depth = 0;

  let off = buf.readUInt16LE(2);
  while (off + 8 <= buf.length) {
    const type = buf.readUInt16LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (size <= 0) break;

    if (type === RES_STRING_POOL) {
      strings = parseStringPool(buf, off);
    } else if (type === RES_XML_RESOURCE_MAP) {
      const headerSize = buf.readUInt16LE(off + 2);
      for (let p = off + headerSize; p < off + size; p += 4) resourceIds.push(buf.readUInt32LE(p));
    } else if (type === RES_XML_START_ELEMENT) {
      const ext = off + 16;
      const name = strings[buf.readUInt32LE(ext + 4)];
      const attrStart = buf.readUInt16LE(ext + 8);
      const attrSize = buf.readUInt16LE(ext + 10);
      const attrCount = buf.readUInt16LE(ext + 12);
      const attrs = {};
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        const nameIdx = buf.readUInt32LE(a + 4);
        let attrName = strings[nameIdx];
        if (!attrName && ATTR_IDS[resourceIds[nameIdx]]) attrName = ATTR_IDS[resourceIds[nameIdx]];
        if (!attrName) continue;
        const raw = buf.readUInt32LE(a + 8);
        const dataType = buf[a + 15];
        const data = buf.readUInt32LE(a + 16);
        let value;
        if (raw !== 0xffffffff) value = strings[raw];
        else if (dataType === TYPE_STRING) value = strings[data];
        else if (dataType === TYPE_REFERENCE) value = { ref: data };
        else if (dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX) value = data | 0;
        else if (dataType === TYPE_BOOLEAN) value = data !== 0;
        else if (dataType === TYPE_FLOAT) value = buf.readFloatLE(a + 16);
        else value = data;
        attrs[attrName] = value;
      }
      elements.push({ name, depth, attrs });
      depth++;
    } else if (type === 0x0103) {
      depth--;
    }
    off += size;
  }
  return elements;
}

/** Indexes resources.arsc so resource ids can be resolved to strings / file paths. */
export function parseResourceTable(buf) {
  const table = new Map();
  if (!buf || buf.readUInt16LE(0) !== RES_TABLE) return table;
  let valueStrings = [];

  let off = buf.readUInt16LE(2);
  while (off + 8 <= buf.length) {
    const type = buf.readUInt16LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (size <= 0) break;
    if (type === RES_STRING_POOL) {
      valueStrings = parseStringPool(buf, off);
    } else if (type === RES_TABLE_PACKAGE) {
      parsePackage(buf, off, size, () => valueStrings, table);
    }
    off += size;
  }
  return table;
}

function parsePackage(buf, start, size, getStrings, table) {
  const pkgId = buf.readUInt32LE(start + 8);
  let off = start + buf.readUInt16LE(start + 2);
  const end = start + size;

  while (off + 8 <= end) {
    const type = buf.readUInt16LE(off);
    const chunkSize = buf.readUInt32LE(off + 4);
    if (chunkSize <= 0) break;
    if (type === RES_TABLE_TYPE) {
      const headerSize = buf.readUInt16LE(off + 2);
      const typeId = buf[off + 8];
      const flags = buf[off + 9];
      const entryCount = buf.readUInt32LE(off + 12);
      const entriesStart = buf.readUInt32LE(off + 16);
      const cfg = off + 20;
      const configInfo = {
        language: buf.readUInt16LE(cfg + 8),
        density: buf.readUInt16LE(cfg + 14),
      };

      const slots = [];
      const idx = off + headerSize;
      if (flags & 0x01) {
        // sparse: (u16 entry index, u16 offset / 4)
        for (let i = 0; i < entryCount; i++) {
          slots.push([buf.readUInt16LE(idx + i * 4), buf.readUInt16LE(idx + i * 4 + 2) * 4]);
        }
      } else if (flags & 0x02) {
        for (let i = 0; i < entryCount; i++) {
          const v = buf.readUInt16LE(idx + i * 2);
          if (v !== 0xffff) slots.push([i, v * 4]);
        }
      } else {
        for (let i = 0; i < entryCount; i++) {
          const v = buf.readUInt32LE(idx + i * 4);
          if (v !== 0xffffffff) slots.push([i, v]);
        }
      }

      for (const [entryIndex, entryOff] of slots) {
        const e = off + entriesStart + entryOff;
        if (e + 8 > off + chunkSize) continue;
        const eflags = buf.readUInt16LE(e + 2);
        let dataType;
        let data;
        if (eflags & 0x0008) {
          // compact entry: dataType packed in the high byte of flags
          dataType = eflags >> 8;
          data = buf.readUInt32LE(e + 4);
        } else if (eflags & 0x0001) {
          continue; // complex/bag entries (styles, arrays) are not needed
        } else {
          const entrySize = buf.readUInt16LE(e);
          dataType = buf[e + entrySize + 3];
          data = buf.readUInt32LE(e + entrySize + 4);
        }
        const resId = ((pkgId << 24) | (typeId << 16) | entryIndex) >>> 0;
        let list = table.get(resId);
        if (!list) table.set(resId, (list = []));
        list.push({
          ...configInfo,
          dataType,
          data,
          get string() {
            return dataType === TYPE_STRING ? getStrings()[data] : null;
          },
        });
      }
    }
    off += chunkSize;
  }
}

export function resolveAll(table, value, depth = 0) {
  if (typeof value !== 'object' || value === null) return [{ value, density: 0, language: 0 }];
  if (depth > 5) return [];
  const list = table.get(value.ref) ?? [];
  return list.flatMap((entry) => {
    if (entry.dataType === TYPE_REFERENCE) return resolveAll(table, { ref: entry.data }, depth + 1);
    if (entry.dataType === TYPE_STRING) return [{ value: entry.string, density: entry.density, language: entry.language }];
    return [];
  });
}

function pickIcon(zip, table, iconAttr) {
  const isBitmap = (p) => /\.(png|webp|jpg)$/i.test(p) && zip.entries.has(p);
  const densityRank = (d) => (d === 0xfffe || d === 0xffff ? 0 : d || 160);

  const candidates = iconAttr ? resolveAll(table, iconAttr).filter((c) => typeof c.value === 'string') : [];
  const bitmaps = candidates.filter((c) => isBitmap(c.value)).sort((a, b) => densityRank(b.density) - densityRank(a.density));
  if (bitmaps.length) return bitmaps[0].value;

  // Adaptive (XML) icons: fall back to a pre-rendered launcher bitmap that most build tools still ship.
  const baseNames = candidates.map((c) => c.value.split('/').pop().replace(/\.xml$/, ''));
  const all = [...zip.entries.values()].filter((e) => /^res\/(mipmap|drawable)[^/]*\/[^/]+\.(png|webp)$/.test(e.name));
  const score = (e) => {
    const file = e.name.split('/').pop().replace(/\.(png|webp)$/, '');
    if (baseNames.includes(file)) return 3;
    if (/^ic_launcher(_round)?$/.test(file)) return 2;
    if (/launcher|app_icon|icon/.test(file)) return 1;
    return 0;
  };
  const best = all.filter((e) => score(e) > 0).sort((a, b) => score(b) - score(a) || b.size - a.size)[0];
  return best?.name ?? null;
}

/**
 * Returns metadata for an APK buffer:
 * { packageName, label, versionName, versionCode, minSdk, targetSdk, abis, iconPath, icon (Buffer|null) }
 */
export function inspectApk(buf) {
  const zip = readZip(buf);
  const manifestBuf = zip.read('AndroidManifest.xml');
  if (!manifestBuf) {
    const nested = [...zip.entries.keys()].some((n) => n.endsWith('.apk'));
    throw new Error(
      nested
        ? 'This looks like a split bundle (.apks/.xapk). Export a universal APK and upload that instead.'
        : 'AndroidManifest.xml not found - this file is not an APK.',
    );
  }

  const elements = parseBinaryXml(manifestBuf);
  const manifest = elements.find((e) => e.name === 'manifest')?.attrs ?? {};
  const usesSdk = elements.find((e) => e.name === 'uses-sdk')?.attrs ?? {};
  const application = elements.find((e) => e.name === 'application')?.attrs ?? {};

  let table = new Map();
  try {
    table = parseResourceTable(zip.read('resources.arsc'));
  } catch {
    // Resource table is optional for our purposes.
  }

  const labels = application.label !== undefined ? resolveAll(table, application.label) : [];
  const label = (labels.find((l) => l.language === 0) ?? labels[0])?.value;

  let iconPath = pickIcon(zip, table, application.icon);
  let icon = iconPath ? zip.read(iconPath) : null;
  if (!icon) {
    // Modern apps often ship only an adaptive/vector icon: draw it.
    icon = renderIcon(zip, table, application.icon) ?? renderIcon(zip, table, application.roundIcon);
    if (icon) iconPath = 'rendered.png';
  }
  const abis = [...new Set([...zip.entries.keys()].map((n) => n.match(/^lib\/([^/]+)\//)?.[1]).filter(Boolean))];

  const asString = (v) => (v === undefined || v === null || typeof v === 'object' ? null : String(v));
  return {
    packageName: asString(manifest.package),
    label: typeof label === 'string' && label.trim() ? label.trim() : null,
    versionName: asString(manifest.versionName),
    versionCode: typeof manifest.versionCode === 'number' ? manifest.versionCode : Number(manifest.versionCode) || null,
    minSdk: typeof usesSdk.minSdkVersion === 'number' ? usesSdk.minSdkVersion : null,
    targetSdk: typeof usesSdk.targetSdkVersion === 'number' ? usesSdk.targetSdkVersion : null,
    abis,
    iconPath,
    icon,
  };
}
