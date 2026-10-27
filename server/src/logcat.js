// Streams `adb logcat` to a WebSocket, optionally filtered to one app's process.
import readline from 'node:readline';

// threadtime: "10-27 19:30:01.123  1234  1250 I Tag     : message"
const LINE_RE = /^(\d\d-\d\d\s+[\d:.]+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*:\s(.*)$/;

export function streamLogcat(device, ws, { pkg = null, minLevel = 'V' } = {}) {
  const levels = 'VDIWEFA';
  const min = Math.max(0, levels.indexOf(minLevel));
  const proc = device.spawn(['logcat', '-v', 'threadtime', '-T', '500'], { stdio: ['ignore', 'pipe', 'ignore'] });

  let pids = null;
  let pidTimer = null;
  if (pkg) {
    const refresh = async () => {
      try {
        const out = await device.shell(`pidof ${pkg}`);
        pids = new Set(out.trim().split(/\s+/).filter(Boolean));
      } catch {
        pids = new Set();
      }
    };
    refresh();
    pidTimer = setInterval(refresh, 2000);
  }

  let batch = [];
  const flush = setInterval(() => {
    if (batch.length && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'lines', lines: batch }));
    batch = [];
  }, 150);

  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    const m = LINE_RE.exec(line);
    if (!m) return;
    const [, time, pid, tid, level, tag, message] = m;
    if (levels.indexOf(level) < min) return;
    if (pids && !pids.has(pid)) return;
    batch.push({ time, pid: Number(pid), tid: Number(tid), level, tag, message });
    if (batch.length > 2000) batch.splice(0, batch.length - 2000);
  });

  const stop = () => {
    clearInterval(flush);
    clearInterval(pidTimer);
    proc.kill();
  };
  proc.once('exit', () => ws.close());
  ws.once('close', stop);
}
