// Advertises the server over mDNS/Bonjour (`_apricot._tcp`) so the iPhone app finds it automatically.
//
// Never claim the computer's own hostname: on macOS, a second responder answering for it makes
// mDNSResponder treat it as a conflict and rename the machine (MacBook-Air -> MacBook-Air-2).
//  - macOS: register through the system responder with `dns-sd`.
//  - Windows/Linux: a pure-JS responder that publishes under its own host name (apricot-<name>.local).
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import { Bonjour } from 'bonjour-service';

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

/** Starts advertising; returns a stop function that resolves once goodbye packets are sent. */
export function advertise({ port, version }) {
  const name = `Apricot on ${computerName()}`;

  if (process.platform === 'darwin') {
    const proc = spawn('dns-sd', ['-R', name, '_apricot._tcp', 'local', String(port), `version=${version}`], {
      stdio: 'ignore',
    });
    proc.on('error', (err) => console.error('mDNS unavailable (auto-discovery off):', err.message));
    return async () => {
      proc.kill(); // mDNSResponder withdraws the record when the registering process exits
    };
  }

  const slug = os.hostname().toLowerCase().replace(/\.local$/, '').replace(/[^a-z0-9-]/g, '-') || 'host';
  let bonjour;
  try {
    bonjour = new Bonjour({}, (err) => console.error('mDNS error (auto-discovery off):', err.message));
    bonjour.publish({ name, type: 'apricot', port, host: `apricot-${slug}.local`, txt: { version } });
  } catch (err) {
    console.error('mDNS unavailable (auto-discovery off):', err.message);
    return async () => {};
  }
  return () =>
    new Promise((resolve) => {
      const done = () => {
        bonjour.destroy();
        resolve();
      };
      const timer = setTimeout(done, 1000);
      bonjour.unpublishAll(() => {
        clearTimeout(timer);
        done();
      });
    });
}
