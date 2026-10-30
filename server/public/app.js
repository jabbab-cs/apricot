// Apricot web dashboard: live device view (WebCodecs), APK library, installed apps, logcat.
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const SETUP_SCRIPT = /Windows/.test(navigator.userAgent) ? 'apricot.cmd' : './apricot';
const state = { status: null, token: localStorage.getItem('apricot.token') ?? '', serial: null };

// ---------- api ----------

function withToken(url) {
  if (!state.token) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(state.token);
}

async function api(path, { method = 'GET', body, raw } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    const t = prompt('This Apricot server requires a token (APRICOT_TOKEN):');
    if (t) {
      state.token = t;
      localStorage.setItem('apricot.token', t);
      return api(path, { method, body, raw });
    }
  }
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtSize = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);

async function busy(btn, fn) {
  btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------- status & devices ----------

async function refreshStatus() {
  try {
    state.status = await api('/api/status');
  } catch {
    setOverlay('Server offline', 'Start it with  cd server && npm start');
    return;
  }
  const s = state.status;
  const ready = s.devices.filter((d) => d.state === 'device');
  const select = $('#device-select');
  select.innerHTML = ready.length
    ? ready.map((d) => `<option value="${esc(d.serial)}" ${d.selected ? 'selected' : ''}>${esc(d.model)}</option>`).join('')
    : '<option>No device</option>';
  $('#device-dot').className = `dot ${ready.length ? 'on' : 'off'}`;

  const changed = s.selectedSerial !== state.serial;
  state.serial = s.selectedSerial;
  renderDevicePanel();
  if (!s.tools.adb) {
    player.stop();
    setOverlay('Android tools not installed', `Run ${SETUP_SCRIPT} on this computer.`);
  } else if (!s.tools.scrcpyServer) {
    player.stop();
    setOverlay('scrcpy-server missing', `Run ${SETUP_SCRIPT} to download it.`);
  } else if (!state.serial) {
    player.stop();
    setOverlay(
      'No device running',
      s.avds.length ? 'Boot a virtual phone to get started.' : `Create a virtual device in Android Studio, or run ${SETUP_SCRIPT}.`,
      s.avds.map((name) => ({ label: `Boot ${name.replace(/_/g, ' ')}`, onClick: (b) => bootAvd(name, b) })),
    );
  } else if (changed || !player.active) {
    player.start(state.serial);
    refreshInstalled();
  }
}

async function bootAvd(name, btn) {
  await busy(btn, async () => {
    const r = await api('/api/avds/boot', { method: 'POST', body: { name } });
    toast(r.message);
  });
}

$('#device-select').addEventListener('change', async (e) => {
  await api('/api/devices/select', { method: 'POST', body: { serial: e.target.value } });
  refreshStatus();
});

function setOverlay(title, text = '', actions = []) {
  const overlay = $('#overlay');
  if (!title) {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  $('#overlay-title').textContent = title;
  $('#overlay-text').textContent = text;
  const box = $('#overlay-actions');
  box.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'btn light';
    b.textContent = a.label;
    b.onclick = () => a.onClick(b);
    box.append(b);
  }
}

// ---------- live stream ----------

class Player {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ws = null;
    this.active = false;
    this.decoder = null;
    this.codec = null;
    this.ts = 0;
    this.useWebCodecs = 'VideoDecoder' in window;
    this.#bindInput();
  }

  start(serial) {
    this.stop();
    this.active = true;
    this.serial = serial;
    setOverlay('Connecting…', 'Starting the screen stream');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(withToken(`${proto}://${location.host}/ws/stream?serial=${encodeURIComponent(serial)}`));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (ev) => (typeof ev.data === 'string' ? this.#onJson(JSON.parse(ev.data)) : this.#onFrame(ev.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.active = false;
      this.ws = null;
      setOverlay(this.lastError ? 'Could not start the stream' : 'Stream disconnected', this.lastError ?? 'Reconnecting…');
      this.lastError = null;
      setTimeout(refreshStatus, 1500);
    };
    if (!this.useWebCodecs) this.#startScreenshots();
  }

  stop() {
    this.active = false;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    clearInterval(this.shotTimer);
    try {
      this.decoder?.close();
    } catch {}
    this.decoder = null;
    this.codec = null;
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  #onJson(msg) {
    if (msg.type === 'error') {
      this.lastError = msg.message;
      setOverlay('Could not start the stream', msg.message);
    }
    if (msg.type === 'hello' && msg.width) this.#setSize(msg.width, msg.height);
    if (msg.type === 'size') this.#setSize(msg.width, msg.height);
  }

  #setSize(w, h) {
    this.size = { w, h };
    $('#screen').classList.toggle('landscape', w > h);
  }

  #onFrame(buf) {
    if (!this.useWebCodecs) return;
    const u8 = new Uint8Array(buf);
    const key = (u8[0] & 1) === 1;
    const data = u8.subarray(1);
    if (key) {
      const codec = codecFromSps(data);
      if (codec && (codec !== this.codec || !this.decoder || this.decoder.state === 'closed')) this.#configure(codec);
    }
    if (!this.decoder || this.decoder.state !== 'configured') return;
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: (this.ts += 16_666), data }));
    } catch {
      this.codec = null; // force reconfigure on the next key frame
      this.send({ type: 'keyframe' });
    }
  }

  #configure(codec) {
    try {
      this.decoder?.close();
    } catch {}
    this.codec = codec;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
          this.canvas.width = frame.displayWidth;
          this.canvas.height = frame.displayHeight;
        }
        this.ctx.drawImage(frame, 0, 0);
        frame.close();
        setOverlay(null);
      },
      error: () => {
        this.codec = null;
        this.send({ type: 'keyframe' });
      },
    });
    this.decoder.configure({ codec, optimizeForLatency: true });
  }

  // Fallback when WebCodecs is unavailable (e.g. plain-http access from another device).
  #startScreenshots() {
    const img = new Image();
    img.onload = () => {
      this.canvas.width = img.naturalWidth;
      this.canvas.height = img.naturalHeight;
      this.ctx.drawImage(img, 0, 0);
      setOverlay(null);
    };
    const tick = async () => {
      const res = await api('/api/device/screenshot', { raw: true }).catch(() => null);
      if (res?.ok) img.src = URL.createObjectURL(await res.blob());
    };
    tick();
    this.shotTimer = setInterval(tick, 700);
  }

  #bindInput() {
    const c = this.canvas;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      // object-fit: contain -> compute the drawn content box
      const scale = Math.min(r.width / c.width, r.height / c.height);
      const w = c.width * scale;
      const h = c.height * scale;
      return {
        x: (e.clientX - r.left - (r.width - w) / 2) / w,
        y: (e.clientY - r.top - (r.height - h) / 2) / h,
      };
    };
    // Browser pointerId -> Android pointer id. A finger left "down" on the device turns every
    // later tap into a second finger, so stale pointers are always released before reuse.
    const pointers = new Map();
    c.addEventListener('pointerdown', (e) => {
      c.focus();
      c.setPointerCapture(e.pointerId);
      if (pointers.has(e.pointerId)) {
        this.send({ type: 'touch', action: 'up', id: pointers.get(e.pointerId), ...pos(e) });
        pointers.delete(e.pointerId);
      }
      const used = new Set(pointers.values());
      let id = 0;
      while (used.has(id)) id++;
      pointers.set(e.pointerId, id);
      this.send({ type: 'touch', action: 'down', id, ...pos(e) });
    });
    c.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      this.send({ type: 'touch', action: 'move', id: pointers.get(e.pointerId), ...pos(e) });
    });
    const up = (e) => {
      if (!pointers.has(e.pointerId)) return;
      this.send({ type: 'touch', action: 'up', id: pointers.get(e.pointerId), ...pos(e) });
      pointers.delete(e.pointerId);
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('lostpointercapture', up);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.send({ type: 'scroll', ...pos(e), dx: -e.deltaX / 60, dy: -e.deltaY / 60 });
      },
      { passive: false },
    );
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.send({ type: 'key', key: 'back' });
    });

    const special = {
      Backspace: 'del', Delete: 'forward_del', Enter: 'enter', Escape: 'back', Tab: 'tab',
      ArrowUp: 'dpad_up', ArrowDown: 'dpad_down', ArrowLeft: 'dpad_left', ArrowRight: 'dpad_right',
    };
    c.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey) return;
      if (special[e.key]) {
        e.preventDefault();
        this.send({ type: 'key', key: special[e.key] });
      } else if (e.key.length === 1) {
        e.preventDefault();
        this.send({ type: 'text', text: e.key });
      }
    });
    c.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text');
      if (text) this.send({ type: 'text', text });
    });
  }
}

/** Builds the WebCodecs codec string ("avc1.PPCCLL") from the SPS in an Annex B buffer. */
function codecFromSps(data) {
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 7) {
      const hex = (b) => b.toString(16).padStart(2, '0');
      return `avc1.${hex(data[i + 4])}${hex(data[i + 5])}${hex(data[i + 6])}`;
    }
  }
  return null;
}

const player = new Player($('#video'));

$$('[data-key]').forEach((b) =>
  b.addEventListener('click', () => {
    if (player.active) player.send({ type: 'key', key: b.dataset.key });
    else api('/api/device/key', { method: 'POST', body: { key: b.dataset.key } }).catch((e) => toast(e.message, 'error'));
  }),
);
$$('[data-action]').forEach((b) => b.addEventListener('click', () => player.send({ type: b.dataset.action })));
$('#screenshot').addEventListener('click', async (e) => {
  e.preventDefault();
  const res = await api('/api/device/screenshot', { raw: true });
  if (!res.ok) return toast('Screenshot failed', 'error');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = `apricot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  a.click();
});

// ---------- library ----------

function iconHtml(item) {
  const letter = esc((item.label ?? '?').charAt(0).toUpperCase());
  if (!item.hasIcon || !(item.id || item.apkId)) return `<div class="icon">${letter}</div>`;
  const url = withToken(`/api/apks/${item.id ?? item.apkId}/icon`);
  return `<div class="icon" style="background-image:url('${url}')"></div>`;
}

async function refreshLibrary() {
  const items = await api('/api/apks').catch(() => []);
  const list = $('#library-list');
  if (!items.length) {
    list.innerHTML = '<div class="empty">Your library is empty. Drop an APK above to get started.</div>';
    return;
  }
  list.innerHTML = items
    .map(
      (a) => `
      <div class="row" data-id="${a.id}">
        ${iconHtml(a)}
        <div class="meta">
          <div class="title">${esc(a.label)}${a.versionName ? `<span class="badge">v${esc(a.versionName)}</span>` : ''}</div>
          <div class="sub">${esc(a.packageName ?? a.fileName)} · ${fmtSize(a.size)}${a.abis.length ? ' · ' + esc(a.abis.join(', ')) : ''}</div>
        </div>
        <div class="actions">
          <button class="btn" data-run>Run</button>
          <button class="btn ghost" data-install>Install</button>
          <button class="btn danger" data-delete title="Remove from library">Remove</button>
        </div>
      </div>`,
    )
    .join('');
  list.querySelectorAll('.row').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('[data-run]').onclick = (e) => installApk(id, true, e.target);
    row.querySelector('[data-install]').onclick = (e) => installApk(id, false, e.target);
    row.querySelector('[data-delete]').onclick = (e) =>
      busy(e.target, async () => {
        await api(`/api/apks/${id}`, { method: 'DELETE' });
        refreshLibrary();
      });
  });
  refreshLogPackages(items);
}

async function installApk(id, launch, btn) {
  await busy(btn, async () => {
    const label = btn.textContent;
    btn.textContent = 'Installing…';
    try {
      await api(`/api/apks/${id}/install`, { method: 'POST', body: { launch } });
      toast(launch ? 'Installed and launched' : 'Installed');
      refreshInstalled();
    } finally {
      btn.textContent = label;
    }
  });
}

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/apks');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    if (state.token) xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
    const bar = $('#upload-progress');
    bar.hidden = false;
    xhr.upload.onprogress = (e) => (bar.firstElementChild.style.width = `${(e.loaded / e.total) * 100}%`);
    xhr.onload = () => {
      bar.hidden = true;
      const data = JSON.parse(xhr.responseText || '{}');
      xhr.status < 300 ? resolve(data) : reject(new Error(data.error ?? 'Upload failed'));
    };
    xhr.onerror = () => {
      bar.hidden = true;
      reject(new Error('Upload failed'));
    };
    xhr.send(file);
  });
}

async function handleFiles(files) {
  for (const file of files) {
    try {
      const apk = await uploadFile(file);
      toast(`Added ${apk.label}`);
      await refreshLibrary();
      if (state.serial) {
        const btn = document.querySelector(`.row[data-id="${apk.id}"] [data-run]`);
        if (btn) await installApk(apk.id, true, btn);
      }
    } catch (err) {
      toast(`${file.name}: ${err.message}`, 'error');
    }
  }
}

const dz = $('#dropzone');
$('#file-input').addEventListener('change', (e) => handleFiles([...e.target.files]));
['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => (e.preventDefault(), dz.classList.add('drag'))));
['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, () => dz.classList.remove('drag')));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  handleFiles([...e.dataTransfer.files]);
});

// ---------- installed apps ----------

async function refreshInstalled() {
  const list = $('#installed-list');
  if (!state.serial) {
    list.innerHTML = '<div class="empty">No device running.</div>';
    return;
  }
  let apps;
  try {
    apps = await api('/api/apps');
  } catch (err) {
    list.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  if (!apps.length) {
    list.innerHTML = '<div class="empty">No third-party apps installed yet.</div>';
    return;
  }
  list.innerHTML = apps
    .map(
      (a) => `
      <div class="row" data-pkg="${esc(a.packageName)}">
        ${iconHtml(a)}
        <div class="meta">
          <div class="title">${esc(a.label)}${a.versionName ? `<span class="badge">v${esc(a.versionName)}</span>` : ''}</div>
          <div class="sub">${esc(a.packageName)}</div>
        </div>
        <div class="actions">
          <button class="btn" data-act="launch">Open</button>
          <button class="btn ghost" data-act="stop">Stop</button>
          <button class="btn ghost" data-act="clear">Clear data</button>
          <button class="btn danger" data-act="uninstall">Uninstall</button>
        </div>
      </div>`,
    )
    .join('');
  list.querySelectorAll('[data-act]').forEach((b) => {
    const pkg = b.closest('.row').dataset.pkg;
    b.onclick = () =>
      busy(b, async () => {
        await api(`/api/apps/${encodeURIComponent(pkg)}/${b.dataset.act}`, { method: 'POST' });
        toast({ launch: 'Opened', stop: 'Stopped', clear: 'Data cleared', uninstall: 'Uninstalled' }[b.dataset.act]);
        if (b.dataset.act === 'uninstall') refreshInstalled();
      });
  });
}

// ---------- logs ----------

const logs = { ws: null, paused: false, lines: [] };

function refreshLogPackages(apks) {
  const sel = $('#log-package');
  const current = sel.value;
  const pkgs = [...new Set(apks.map((a) => a.packageName).filter(Boolean))];
  sel.innerHTML = '<option value="">All processes</option>' + pkgs.map((p) => `<option>${esc(p)}</option>`).join('');
  sel.value = pkgs.includes(current) ? current : '';
}

function startLogs() {
  logs.ws?.close();
  $('#logs').innerHTML = '';
  if (!state.serial) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({ level: $('#log-level').value });
  if ($('#log-package').value) params.set('package', $('#log-package').value);
  const ws = new WebSocket(withToken(`${proto}://${location.host}/ws/logcat?${params}`));
  logs.ws = ws;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== 'lines' || logs.paused) return;
    const filter = $('#log-filter').value.toLowerCase();
    const box = $('#logs');
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    const frag = document.createDocumentFragment();
    for (const l of msg.lines) {
      if (filter && !`${l.tag} ${l.message}`.toLowerCase().includes(filter)) continue;
      const div = document.createElement('div');
      div.className = `log ${l.level}`;
      div.innerHTML = `<span class="t">${esc(l.time)}</span> ${l.level} <span class="tag">${esc(l.tag)}</span> ${esc(l.message)}`;
      frag.append(div);
    }
    box.append(frag);
    while (box.childElementCount > 3000) box.firstElementChild.remove();
    if (stick) box.scrollTop = box.scrollHeight;
  };
}

['#log-package', '#log-level'].forEach((s) => $(s).addEventListener('change', startLogs));
$('#log-pause').onclick = (e) => {
  logs.paused = !logs.paused;
  e.target.textContent = logs.paused ? 'Resume' : 'Pause';
};
$('#log-clear').onclick = () => ($('#logs').innerHTML = '');

// ---------- device panel ----------

async function renderDevicePanel() {
  const s = state.status;
  const cards = $('#device-cards');
  const card = (k, v) => `<div class="card"><div class="k">${k}</div><div class="v">${esc(v ?? '—')}</div></div>`;
  if (state.serial) {
    const info = await api('/api/device/info').catch(() => null);
    cards.innerHTML = info
      ? card('Model', info.model) + card('Android', `${info.androidVersion} (API ${info.sdk})`) +
        card('CPU', info.abis.join(', ')) + card('Screen', `${info.screen} @ ${info.density}dpi`) + card('Serial', info.serial)
      : '';
  } else {
    cards.innerHTML = card('Device', 'None running');
  }

  const avds = $('#avd-list');
  avds.innerHTML = s.avds.length
    ? s.avds
        .map(
          (name) => `<div class="row"><div class="icon">📱</div><div class="meta"><div class="title">${esc(name.replace(/_/g, ' '))}</div>
          <div class="sub">${esc(name)}</div></div><div class="actions">${
            s.runningAvds?.includes(name)
              ? '<span class="badge">Running</span>'
              : `<button class="btn ghost" data-boot="${esc(name)}">Boot</button>`
          }</div></div>`,
        )
        .join('')
    : `<div class="empty">No virtual devices. Run ${SETUP_SCRIPT} or create one in Android Studio.</div>`;
  avds.querySelectorAll('[data-boot]').forEach((b) => (b.onclick = () => bootAvd(b.dataset.boot, b)));

  $('#connect-card').innerHTML = `
    <ol>
      <li>Install the Apricot iOS app (see <code>docs/SIDELOADING.md</code>).</li>
      <li>Click <b>Pair iPhone</b> above and scan the QR code. That's it.</li>
      <li>${s.remote ? 'Remote access is on: your iPhone connects from any network.' : 'Remote access is off, so the iPhone must be on the same Wi-Fi.'}</li>
    </ol>`;
}

// ---------- pairing ----------

async function showPairing() {
  const dialog = $('#pair-dialog');
  if (!dialog.open) dialog.showModal();
  try {
    const p = await api('/api/pair');
    $('#pair-qr').innerHTML = p.svg;
    $('#pair-note').textContent = p.remote
      ? 'Works on any network: home Wi-Fi, other Wi-Fi or cellular.'
      : !p.remoteEnabled
        ? 'Remote access is off (APRICOT_REMOTE=0): the iPhone must be on this Wi-Fi.'
        : p.remoteError ?? 'Remote access is starting… the code works on this Wi-Fi meanwhile.';
    // The tunnel address can still arrive; refresh while the dialog stays open.
    if (!p.remote && p.remoteEnabled && dialog.open) setTimeout(() => dialog.open && showPairing(), 4000);
  } catch (err) {
    $('#pair-note').textContent = err.message;
  }
}
$('#pair-btn').addEventListener('click', showPairing);

// ---------- tabs & boot ----------

$$('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${t.dataset.tab}`));
    if (t.dataset.tab === 'installed') refreshInstalled();
    if (t.dataset.tab === 'logs' && !logs.ws) startLogs();
  }),
);

refreshStatus();
refreshLibrary();
setInterval(refreshStatus, 5000);
