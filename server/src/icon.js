// Draws Android adaptive and vector-drawable icons, which APKs ship as XML instead of a bitmap.
// The XML is converted to SVG and rasterized with resvg.
import { Resvg } from '@resvg/resvg-js';
import { parseBinaryXml, resolveAll } from './apk.js';

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const isColorType = (t) => t >= 0x1c && t <= 0x1f;

/** Returns a PNG for an icon resource that resolves to XML, or null when it can't be drawn. */
export function renderIcon(zip, table, iconAttr) {
  if (!iconAttr) return null;
  try {
    const xmlPath = resolveAll(table, iconAttr).map((c) => c.value).find((v) => typeof v === 'string' && v.endsWith('.xml'));
    if (!xmlPath) return null;
    const ctx = { zip, table, defs: [], ids: 0 };
    const elements = readXml(ctx, xmlPath);
    if (!elements?.length) return null;

    let body;
    let viewBox;
    if (elements[0].name === 'adaptive-icon') {
      const layer = (name) => elements.find((e) => e.name === name)?.attrs.drawable;
      body = drawable(ctx, layer('background')) + drawable(ctx, layer('foreground'));
      viewBox = '18 18 72 72'; // launchers show the middle 72dp of the 108dp canvas
    } else if (elements[0].name === 'vector') {
      body = vector(ctx, elements, 108);
      viewBox = '0 0 108 108';
    } else {
      return null;
    }
    if (!body) return null;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${viewBox}"><defs>${ctx.defs.join('')}</defs>${body}</svg>`;
    return new Resvg(svg, { fitTo: { mode: 'width', value: 192 } }).render().asPng();
  } catch {
    return null;
  }
}

function readXml(ctx, path) {
  const buf = ctx.zip.read(path);
  return buf ? parseBinaryXml(buf) : null;
}

/** Resolves a reference to { color } or { path }. */
function resolve(ctx, value, depth = 0) {
  if (typeof value === 'number') return { color: value >>> 0 };
  if (typeof value === 'string') return value.startsWith('#') ? { color: hexColor(value) } : { path: value };
  if (!value?.ref || depth > 5) return null;
  const entries = ctx.table.get(value.ref) ?? [];
  const entry = entries.find((e) => e.density === 0) ?? entries[0];
  if (!entry) return null;
  if (isColorType(entry.dataType)) return { color: entry.data >>> 0 };
  if (entry.dataType === TYPE_REFERENCE) return resolve(ctx, { ref: entry.data }, depth + 1);
  if (entry.dataType === TYPE_STRING) return { path: entry.string };
  return null;
}

function hexColor(hex) {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length === 6) h = 'ff' + h;
  return Number.parseInt(h, 16) >>> 0;
}

const rgb = (argb) => `rgb(${(argb >>> 16) & 255},${(argb >>> 8) & 255},${argb & 255})`;
const alpha = (argb) => ((argb >>> 24) & 255) / 255;

/** One adaptive-icon layer (108x108): a color, a bitmap or a vector. */
function drawable(ctx, value) {
  const r = resolve(ctx, value);
  if (!r) return '';
  if (r.color !== undefined) return `<rect width="108" height="108" fill="${rgb(r.color)}" fill-opacity="${alpha(r.color)}"/>`;
  if (/\.(png|webp|jpg)$/i.test(r.path)) {
    const data = ctx.zip.read(r.path);
    if (!data) return '';
    const mime = r.path.endsWith('.png') ? 'image/png' : r.path.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return `<image width="108" height="108" xlink:href="data:${mime};base64,${data.toString('base64')}"/>`;
  }
  if (r.path.endsWith('.xml')) {
    const elements = readXml(ctx, r.path);
    if (elements?.[0]?.name === 'vector') return vector(ctx, elements, 108);
    if (elements?.[0]?.name === 'inset') {
      const inner = drawable(ctx, elements[0].attrs.drawable);
      const f = fraction(elements[0].attrs.inset);
      return f ? `<g transform="translate(${54 * 2 * f} ${54 * 2 * f}) scale(${1 - 2 * f})">${inner}</g>` : inner;
    }
  }
  return '';
}

/** Android fractions are encoded as TYPE_FRACTION; convert to 0..1, or 0 if it isn't one. */
function fraction(v) {
  if (typeof v !== 'number') return 0;
  const radix = [2 ** -23, 2 ** -15, 2 ** -7, 2 ** 1][(v >> 4) & 3];
  return ((v & 0xffffff00) >> 8) * radix;
}

/** Converts a <vector> element tree to SVG, scaled to `size`. */
function vector(ctx, elements, size) {
  const root = elements[0].attrs;
  const vw = num(root.viewportWidth) || 24;
  const vh = num(root.viewportHeight) || 24;
  let out = `<g transform="scale(${size / vw} ${size / vh})">`;
  const open = [0]; // depths of currently open <g>
  for (const el of elements.slice(1)) {
    while (open.length > 1 && el.depth <= open.at(-1)) {
      out += '</g>';
      open.pop();
    }
    const a = el.attrs;
    if (el.name === 'group') {
      const px = num(a.pivotX);
      const py = num(a.pivotY);
      out += `<g transform="translate(${num(a.translateX) + px} ${num(a.translateY) + py}) rotate(${num(a.rotation)}) scale(${num(a.scaleX, 1)} ${num(a.scaleY, 1)}) translate(${-px} ${-py})">`;
      open.push(el.depth);
    } else if (el.name === 'clip-path' && typeof a.pathData === 'string') {
      const id = `c${ctx.ids++}`;
      ctx.defs.push(`<clipPath id="${id}"><path d="${esc(a.pathData)}"/></clipPath>`);
      out += `<g clip-path="url(#${id})">`;
      open.push(el.depth - 1); // closes with its parent group
    } else if (el.name === 'path' && typeof a.pathData === 'string') {
      const fill = paint(ctx, a.fillColor);
      const stroke = paint(ctx, a.strokeColor);
      out += `<path d="${esc(a.pathData)}" fill="${fill.value}" fill-opacity="${fill.opacity * num(a.fillAlpha, 1)}"` +
        ` fill-rule="${a.fillType === 1 ? 'evenodd' : 'nonzero'}"` +
        (stroke.value !== 'none'
          ? ` stroke="${stroke.value}" stroke-opacity="${stroke.opacity * num(a.strokeAlpha, 1)}" stroke-width="${num(a.strokeWidth)}"`
          : '') +
        '/>';
    }
  }
  return out + '</g>'.repeat(open.length);
}

/** A fill or stroke: a color, or a gradient resource turned into an SVG gradient. */
function paint(ctx, value) {
  if (value === undefined) return { value: 'none', opacity: 1 };
  const r = resolve(ctx, value);
  if (r?.color !== undefined) return { value: rgb(r.color), opacity: alpha(r.color) };
  if (!r?.path?.endsWith('.xml')) return { value: 'none', opacity: 1 };
  const elements = readXml(ctx, r.path) ?? [];
  const root = elements[0];
  if (root?.name === 'selector') {
    const item = elements.find((e) => e.name === 'item' && e.attrs.color !== undefined);
    return item ? paint(ctx, item.attrs.color) : { value: 'none', opacity: 1 };
  }
  if (root?.name !== 'gradient') return { value: 'none', opacity: 1 };
  const g = root.attrs;
  let stops = elements
    .filter((e) => e.name === 'item')
    .map((e) => ({ offset: num(e.attrs.offset), color: resolve(ctx, e.attrs.color)?.color ?? 0 }));
  if (!stops.length) {
    stops = [{ offset: 0, color: resolve(ctx, g.startColor)?.color ?? 0 }];
    if (g.centerColor !== undefined) stops.push({ offset: 0.5, color: resolve(ctx, g.centerColor)?.color ?? 0 });
    stops.push({ offset: 1, color: resolve(ctx, g.endColor)?.color ?? 0 });
  }
  const id = `g${ctx.ids++}`;
  const stopsSvg = stops.map((s) => `<stop offset="${s.offset}" stop-color="${rgb(s.color)}" stop-opacity="${alpha(s.color)}"/>`).join('');
  ctx.defs.push(
    g.type === 1
      ? `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${num(g.centerX)}" cy="${num(g.centerY)}" r="${num(g.gradientRadius)}">${stopsSvg}</radialGradient>`
      : `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(g.startX)}" y1="${num(g.startY)}" x2="${num(g.endX)}" y2="${num(g.endY)}">${stopsSvg}</linearGradient>`,
  );
  return { value: `url(#${id})`, opacity: 1 };
}

const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const esc = (s) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
