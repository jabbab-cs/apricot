// Synthetic APK builder used by tests: binary manifest + resources.arsc + icons, zipped.
import zlib from 'node:zlib';


const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);

function stringPool(strings) {
  const offsets = [];
  const data = [];
  let off = 0;
  for (const s of strings) {
    offsets.push(off);
    const chars = Buffer.from(s, 'utf16le');
    const entry = Buffer.concat([u16(s.length), chars, u16(0)]);
    data.push(entry);
    off += entry.length;
  }
  const body = pad4(Buffer.concat(data));
  const headerSize = 28;
  const stringsStart = headerSize + strings.length * 4;
  const size = stringsStart + body.length;
  return Buffer.concat([
    u16(0x0001), u16(headerSize), u32(size), u32(strings.length), u32(0), u32(0), u32(stringsStart), u32(0),
    ...offsets.map(u32), body,
  ]);
}

const TYPE_STRING = 0x03;
const TYPE_REF = 0x01;
const TYPE_INT = 0x10;

function binaryManifest() {
  const S = ['manifest', 'package', 'versionCode', 'versionName', 'uses-sdk', 'minSdkVersion',
    'application', 'label', 'icon', 'dev.apricot.sample', '1.2.3'];
  const idx = (s) => S.indexOf(s);
  const attr = (name, type, data, raw = 0xffffffff) =>
    Buffer.concat([u32(0xffffffff), u32(idx(name)), u32(raw), u16(8), Buffer.from([0, type]), u32(data)]);
  const start = (name, attrs) => {
    const body = Buffer.concat([
      u32(0xffffffff), u32(idx(name)), u16(20), u16(20), u16(attrs.length), u16(0), u16(0), u16(0), ...attrs,
    ]);
    return Buffer.concat([u16(0x0102), u16(16), u32(16 + body.length), u32(1), u32(0xffffffff), body]);
  };
  const end = (name) => Buffer.concat([u16(0x0103), u16(16), u32(24), u32(1), u32(0xffffffff), u32(0xffffffff), u32(idx(name))]);

  const chunks = [
    stringPool(S),
    start('manifest', [
      attr('package', TYPE_STRING, idx('dev.apricot.sample'), idx('dev.apricot.sample')),
      attr('versionCode', TYPE_INT, 42),
      attr('versionName', TYPE_STRING, idx('1.2.3'), idx('1.2.3')),
    ]),
    start('uses-sdk', [attr('minSdkVersion', TYPE_INT, 24)]),
    end('uses-sdk'),
    start('application', [attr('label', TYPE_REF, 0x7f020000), attr('icon', TYPE_REF, 0x7f010000)]),
    end('application'),
    end('manifest'),
  ];
  const body = Buffer.concat(chunks);
  return Buffer.concat([u16(0x0003), u16(8), u32(8 + body.length), body]);
}

function resourceTable() {
  const values = ['res/mipmap-anydpi-v26/ic_launcher.xml', 'res/mipmap-xxhdpi-v4/ic_launcher.png', 'Hello Apricot'];
  const typeChunk = (typeId, density, valueIndex) => {
    const config = Buffer.alloc(64);
    config.writeUInt32LE(64, 0);
    config.writeUInt16LE(density, 14);
    const headerSize = 20 + 64;
    const entry = Buffer.concat([u16(8), u16(0), u32(0), u16(8), Buffer.from([0, TYPE_STRING]), u32(valueIndex)]);
    const entriesStart = headerSize + 4;
    const size = entriesStart + entry.length;
    return Buffer.concat([
      u16(0x0201), u16(headerSize), u32(size), Buffer.from([typeId, 0]), u16(0), u32(1), u32(entriesStart), config,
      u32(0), entry,
    ]);
  };
  const pkgHeaderSize = 288;
  const types = Buffer.concat([typeChunk(1, 0xfffe, 0), typeChunk(1, 480, 1), typeChunk(2, 0, 2)]);
  const pkgHeader = Buffer.concat([
    u16(0x0200), u16(pkgHeaderSize), u32(pkgHeaderSize + types.length), u32(0x7f), Buffer.alloc(256), u32(0), u32(0), u32(0), u32(0), u32(0),
  ]);
  const body = Buffer.concat([stringPool(values), pkgHeader, types]);
  return Buffer.concat([u16(0x0002), u16(12), u32(12 + body.length), u32(1), body]);
}

export function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content, deflate] of files) {
    const nameBuf = Buffer.from(name);
    const data = deflate ? zlib.deflateRawSync(content) : content;
    const crc = zlib.crc32(content);
    const common = [u16(20), u16(0), u16(deflate ? 8 : 0), u16(0), u16(0), u32(crc), u32(data.length), u32(content.length), u16(nameBuf.length), u16(0)];
    const local = Buffer.concat([u32(0x04034b50), ...common, nameBuf, data]);
    centrals.push(Buffer.concat([u32(0x02014b50), u16(20), ...common, u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(offset), u16(0)]);
  return Buffer.concat([...locals, cd, eocd]);
}

export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');


export function buildSampleApk() {
  return zip([
    ['AndroidManifest.xml', binaryManifest(), true],
    ['resources.arsc', resourceTable(), false],
    ['res/mipmap-anydpi-v26/ic_launcher.xml', Buffer.from('<adaptive-icon/>'), true],
    ['res/mipmap-xxhdpi-v4/ic_launcher.png', PNG, false],
    ['lib/arm64-v8a/libnative.so', Buffer.from('elf'), true],
    ['classes.dex', Buffer.from('dex\n035'), true],
  ]);
}
