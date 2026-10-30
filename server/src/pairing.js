// The access token and the QR code that pairs the iPhone app with this server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { config } from './config.js';

/** APRICOT_TOKEN if set, otherwise a random token generated once and kept in the data dir. */
export function loadToken() {
  if (config.token) return config.token;
  const file = path.join(config.dataDir, 'token');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  } catch {
    // first run
  }
  const token = crypto.randomBytes(18).toString('base64url');
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

/** `apricot://pair?n=<name>&t=<token>&u=<url>&u=<url>`: the iPhone tries each URL, LAN first. */
export function pairingLink({ name, token, urls }) {
  const q = new URLSearchParams({ n: name, t: token });
  for (const u of urls) q.append('u', u);
  return `apricot://pair?${q}`;
}

export const qrSvg = (text) => QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
export const qrTerminal = (text) => QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'L' });
