// Names and addresses of the computer running the server.
import { execFileSync } from 'node:child_process';
import os from 'node:os';

/** Human-friendly computer name, e.g. "Mohammad's MacBook Air" or "DESKTOP-1234". */
export function computerName() {
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim();
      if (name) return name;
    } catch {
      // fall through
    }
  }
  return os.hostname().replace(/\.local$/, '');
}

export function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}
