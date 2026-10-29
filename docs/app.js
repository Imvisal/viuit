'use strict';
/* SimpleCut web app: runs fully in the browser. No upload, no server. */
const $ = (s, el = document) => el.querySelector(s);
const RES = { '480p': [854, 480], '720p': [1280, 720], '1080p': [1920, 1080] };
const BITRATE = { '480p': 3e6, '720p': 6e6, '1080p': 12e6 };
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';

const state = {
  clips: [], audios: [], texts: [], captions: [],
  cap: { enabled: true, size: 54, color: '#ffffff', bottom: 8, box: false },
  t: 0, playing: false, res: '1080p',
};
let uid = 1;

/* ------------------------------------------------------------ helpers */
const fmt = t => { t = Math.max(0, t || 0); return Math.floor(t / 60) + ':' + (t % 60).toFixed(1).padStart(4, '0'); };
const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const total = () => state.clips.reduce((a, c) => a + (c.end - c.start), 0);
let toastTimer;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 3200);
}
function outSize() {
  const [L, S] = RES[state.res], c = state.clips[0];
  return c && c.h > c.w ? [S, L] : [L, S];
}
function locate(t) {
  let acc = 0;
  for (let i = 0; i < state.clips.length; i++) {
    const d = state.clips[i].end - state.clips[i].start;
    if (t < acc + d || i === state.clips.length - 1) return { i, local: clamp(t - acc, 0, d), base: acc, d };
    acc += d;
  }
  return null;
}

/* ------------------------------------------------------------ media loading */
function loadMedia(file, tag) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(tag);
    el.preload = 'auto';
    if (tag === 'video') { el.playsInline = true; el.setAttribute('playsinline', ''); }
    const url = URL.createObjectURL(file);
    el.onloadedmetadata = () => resolve({ el, url });
    el.onerror = () => reject(new Error('This file type is not supported by your browser.'));
    el.src = url;
  });
}
async function addVideos(files) {
  for (const f of files) {
    try {
      const { el, url } = await loadMedia(f, 'video');
      if (!isFinite(el.duration)) throw new Error('Cannot read the length of this video.');
      state.clips.push({ id: uid++, name: f.name, file: f, url, el, dur: el.duration, start: 0, end: +el.duration.toFixed(2), w: el.videoWidth, h: el.videoHeight });
    } catch (e) { toast(f.name + ': ' + e.message); }
  }
  refresh(true);
}
async function addAudio(file) {
  try {
    const { el, url } = await loadMedia(file, 'audio');
    if (!isFinite(el.duration)) throw new Error('Cannot read the length of this sound.');
    state.audios.push({ id: uid++, name: file.name, url, el, dur: el.duration, offset: +state.t.toFixed(1), start: 0, end: +el.duration.toFixed(2), volume: 100 });
    refresh();
  } catch (e) { toast(e.message); }
}

/* ------------------------------------------------------------ audio graph */
let AC, recDest, monitor;
function ensureAudio() {
  if (AC) return;
  AC = new (window.AudioContext || window.webkitAudioContext)();
  recDest = AC.createMediaStreamDestination();
  monitor = AC.createGain();
  monitor.connect(AC.destination);
}
function wire(item, isMusic) {
  ensureAudio();
  if (!item.node) {
    item.node = AC.createMediaElementSource(item.el);
    item.gain = AC.createGain();
    item.node.connect(item.gain);
    item.gain.connect(monitor);
    item.gain.connect(recDest);
  }
  item.gain.gain.value = isMusic ? item.volume / 100 : 1;
}
function wireAll() { state.clips.forEach(c => wire(c, false)); state.audios.forEach(a => wire(a, true)); }

/* ------------------------------------------------------------ drawing */
const cv = $('#cv'), ctx = cv.getContext('2d');
function wrapLines(text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (line && ctx.measureText(test).width > maxW) { out.push(line); line = w; } else line = test;
    }
    out.push(line);
  }
  return out;
}
function drawOverlays(t, W, H) {
  const k = Math.min(W, H) / 1080;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const fontFam = 'system-ui, "Segoe UI", Roboto, "Noto Sans Sinhala", Arial, sans-serif';
  for (const x of state.texts) {
    if (t < x.start || t >= x.end || !x.text.trim()) continue;
    const px = Math.max(8, x.size * k);
    ctx.font = '700 ' + px + 'px ' + fontFam;
    const lines = wrapLines(x.text, W * 0.92), lh = px * 1.2;
    const y0 = H * x.y / 100 - (lines.length - 1) * lh / 2;
    ctx.lineWidth = Math.max(2, px * 0.1); ctx.strokeStyle = '#000'; ctx.fillStyle = x.color;
    lines.forEach((ln, i) => { const cx = W * x.x / 100, cy = y0 + i * lh; ctx.strokeText(ln, cx, cy); ctx.fillText(ln, cx, cy); });
  }
  const cs = state.cap;
  if (cs.enabled) {
    const c = state.captions.find(c => t >= c.start && t < c.end);
    if (c && c.text.trim()) {
      const px = Math.max(8, cs.size * k);
      ctx.font = '700 ' + px + 'px ' + fontFam;
      const lines = wrapLines(c.text.trim(), W * 0.88), lh = px * 1.25;
      const bottom = H - H * cs.bottom / 100;
      if (cs.box) {
        const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + px * 0.8;
        ctx.fillStyle = 'rgba(0,0,0,.55)';
        ctx.fillRect(W / 2 - w / 2, bottom - lines.length * lh - px * 0.1, w, lines.length * lh + px * 0.3);
      }
      ctx.lineWidth = cs.box ? 0 : Math.max(2, px * 0.14); ctx.strokeStyle = '#000'; ctx.fillStyle = cs.color;
      lines.forEach((ln, i) => {
        const cy = bottom - (lines.length - i - 0.5) * lh + px * 0.05;
        if (ctx.lineWidth) ctx.strokeText(ln, W / 2, cy);
        ctx.fillText(ln, W / 2, cy);
      });
    }
  }
}
function draw(t) {
  const [W, H] = outSize();
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const loc = locate(t);
  if (loc) {
    const el = state.clips[loc.i].el;
    if (el.videoWidth) {
      const s = Math.min(W / el.videoWidth, H / el.videoHeight), w = el.videoWidth * s, h = el.videoHeight * s;
      ctx.drawImage(el, (W - w) / 2, (H - h) / 2, w, h);
    }
  }
  drawOverlays(t, W, H);
}

/* ------------------------------------------------------------ playback */
let raf = 0, playStart = 0, tStart = 0, curClip = -1, prepared = -1, onEnd = null, seekToken = 0;
async function seekTo(t) {
  const my = ++seekToken;
  state.t = clamp(t, 0, total());
  const loc = locate(state.t);
  if (loc) {
    const c = state.clips[loc.i], want = c.start + loc.local;
    if (Math.abs(c.el.currentTime - want) > 0.03) {
      await new Promise(res => {
        const done = () => { c.el.removeEventListener('seeked', done); res(); };
        c.el.addEventListener('seeked', done); c.el.currentTime = want; setTimeout(done, 700);
      });
    }
  }
  if (my === seekToken) { draw(state.t); updateTransport(); }
}
function sync(t) {
  const loc = locate(t), c = state.clips[loc.i], want = c.start + loc.local;
  if (loc.i !== curClip) {
    if (state.clips[curClip]) state.clips[curClip].el.pause();
    curClip = loc.i;
    if (prepared !== loc.i) c.el.currentTime = want;
    c.el.play().catch(() => {});
  } else if (Math.abs(c.el.currentTime - want) > 0.4) c.el.currentTime = want;
  const nxt = state.clips[loc.i + 1];
  if (nxt && loc.d - loc.local < 0.7 && prepared !== loc.i + 1) { nxt.el.currentTime = nxt.start; prepared = loc.i + 1; }
  for (const a of state.audios) {
    const rel = t - a.offset, inside = rel >= 0 && rel < a.end - a.start;
    if (inside && a.el.paused) { a.el.currentTime = a.start + rel; a.el.play().catch(() => {}); }
    else if (!inside && !a.el.paused) a.el.pause();
  }
}
function play(endCb) {
  if (!state.clips.length) return toast('Add a video first.');
  ensureAudio(); AC.resume(); wireAll();
  if (state.t >= total() - 0.05) state.t = 0;
  state.playing = true; tStart = state.t; playStart = performance.now(); curClip = -1; prepared = -1; onEnd = endCb || null;
  setPlayIcon(); loop();
}
function pause() {
  state.playing = false; cancelAnimationFrame(raf);
  state.clips.forEach(c => c.el.pause()); state.audios.forEach(a => a.el.pause());
  setPlayIcon();
}
function loop() {
  if (!state.playing) return;
  const t = tStart + (performance.now() - playStart) / 1000;
  if (t >= total()) {
    state.t = total(); draw(state.t); updateTransport();
    const cb = onEnd; onEnd = null; pause(); if (cb) cb(); return;
  }
  sync(t); state.t = t; draw(t); updateTransport();
  raf = requestAnimationFrame(loop);
}
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
function setPlayIcon() { const b = $('#playBtn'); b.innerHTML = state.playing ? ICON_PAUSE : ICON_PLAY; b.setAttribute('aria-label', state.playing ? 'Pause' : 'Play'); }
function updateTransport() {
  const tot = total();
  $('#tlabel').textContent = fmt(state.t) + ' / ' + fmt(tot);
  const s = $('#scrub'); s.max = Math.max(tot, 0.1); if (document.activeElement !== s || state.playing) s.value = state.t;
  drawTimeline();
}

/* ------------------------------------------------------------ timeline */
const tl = $('#tl'), tctx = tl.getContext('2d');
function drawTimeline() {
  const dpr = window.devicePixelRatio || 1, w = tl.clientWidth, h = tl.clientHeight;
  if (!w) return;
  if (tl.width !== Math.round(w * dpr) || tl.height !== Math.round(h * dpr)) { tl.width = Math.round(w * dpr); tl.height = Math.round(h * dpr); }
  const c = tctx; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  const x0 = 66, x1 = w - 10, span = Math.max(total(), 10), X = t => x0 + (x1 - x0) * t / span;
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600], step = steps.find(s => (x1 - x0) * s / span >= 56) || 600;
  c.font = '10px system-ui, sans-serif'; c.textBaseline = 'middle';
  for (let t = 0; t <= span; t += step) { c.fillStyle = '#2a2d34'; c.fillRect(X(t), 14, 1, h - 14); c.fillStyle = '#777'; c.textAlign = 'left'; c.fillText(fmt(t), X(t) + 3, 7); }
  const rows = [['Video', '#3f7cd6'], ['Sound', '#3fae7a'], ['Text', '#d6a53f'], ['Captions', '#a56ad6']];
  let acc = 0;
  const blocks = [
    state.clips.map(k => { const s = acc; acc += k.end - k.start; return [s, acc, k.name]; }),
    state.audios.map(a => [a.offset, a.offset + a.end - a.start, a.name]),
    state.texts.map(x => [x.start, x.end, x.text]),
    state.captions.map(x => [x.start, x.end, x.text]),
  ];
  rows.forEach(([name, col], i) => {
    const y = 20 + i * 28;
    c.fillStyle = '#9aa0ad'; c.textAlign = 'left'; c.font = '11px system-ui, sans-serif'; c.fillText(name, 6, y + 11);
    blocks[i].forEach(([s, e, label]) => {
      const xa = X(s), xb = Math.max(X(e), xa + 3);
      c.fillStyle = col; c.fillRect(xa, y, xb - xa, 22);
      if (xb - xa > 34) { c.save(); c.beginPath(); c.rect(xa, y, xb - xa, 22); c.clip(); c.fillStyle = '#fff'; c.font = '10px system-ui, sans-serif'; c.fillText(label, xa + 4, y + 11); c.restore(); }
    });
  });
  c.fillStyle = '#ff5a4d'; c.fillRect(X(state.t) - 1, 12, 2, h - 12);
}
function tlSeek(ev) {
  const r = tl.getBoundingClientRect(), x0 = 66, x1 = r.width - 10, span = Math.max(total(), 10);
  const t = clamp((ev.clientX - r.left - x0) / (x1 - x0) * span, 0, total());
  if (state.playing) pause();
  seekTo(t);
}
let tlDrag = false;
tl.addEventListener('pointerdown', e => { tlDrag = true; tl.setPointerCapture(e.pointerId); tlSeek(e); });
tl.addEventListener('pointermove', e => { if (tlDrag) tlSeek(e); });
tl.addEventListener('pointerup', () => (tlDrag = false));
tl.addEventListener('pointercancel', () => (tlDrag = false));

/* ------------------------------------------------------------ bottom sheet */
function openSheet({ title, fields, extra = [], onSave, onDelete }) {
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = fields.map(f => {
    const id = 'f_' + f.k, v = esc(f.v);
    const input = f.type === 'area' ? `<textarea id="${id}" rows="2">${v}</textarea>`
      : `<input id="${id}" type="${f.type || 'text'}" value="${v}" ${f.type === 'number' ? 'step="any" inputmode="decimal"' : ''}>`;
    return `<label class="field">${esc(f.label)}${input}</label>`;
  }).join('');
  const ex = $('#sheetExtra'); ex.innerHTML = '';
  extra.forEach(a => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = a.label; b.onclick = () => { a.run(); close(); }; ex.appendChild(b); });
  const wrap = $('#sheetWrap'); wrap.hidden = false;
  const close = () => { wrap.hidden = true; };
  $('#sheetCancel').onclick = close; $('#sheetBack').onclick = close;
  $('#sheetDel').hidden = !onDelete; $('#sheetDel').onclick = () => { onDelete(); close(); };
  $('#sheet').onsubmit = e => {
    e.preventDefault();
    const vals = {}; fields.forEach(f => (vals[f.k] = $('#f_' + f.k).value));
    onSave(vals); close();
  };
  const first = $('#sheetBody input, #sheetBody textarea'); if (first) first.focus();
}

/* ------------------------------------------------------------ lists */
function refresh(seek) {
  const li = (t, n, onclick) => { const e = document.createElement('li'); e.innerHTML = `<span class="t">${esc(t)}</span><span class="n">${esc(n)}</span>`; e.onclick = onclick; return e; };
  const fill = (id, items) => { const ul = $(id); ul.innerHTML = ''; items.forEach(i => ul.appendChild(i)); };
  fill('#list-videos', state.clips.map((c, i) => li(fmt(c.start) + '–' + fmt(c.end), c.name, () => editClip(i))));
  fill('#list-sound', state.audios.map((a, i) => li('at ' + fmt(a.offset) + ' · ' + Math.round(a.volume) + '%', a.name, () => editAudio(i))));
  fill('#list-text', state.texts.map((x, i) => li(fmt(x.start) + '–' + fmt(x.end), x.text.replace(/\n/g, ' '), () => editText(i))));
  fill('#list-captions', state.captions.map((x, i) => li(fmt(x.start), x.text, () => editCaption(i))));
  $('#empty').hidden = state.clips.length > 0;
  state.t = clamp(state.t, 0, total());
  if (state.playing) { tStart = state.t; playStart = performance.now(); }
  updateTransport();
  if (seek || !state.playing) seekTo(state.t);
}
function editClip(i) {
  const c = state.clips[i];
  openSheet({
    title: 'Trim clip', fields: [
      { k: 's', label: 'Start (seconds)', type: 'number', v: c.start }, { k: 'e', label: 'End (seconds, max ' + c.dur.toFixed(1) + ')', type: 'number', v: c.end }],
    extra: [
      { label: 'Move earlier', run: () => { if (i > 0) { [state.clips[i - 1], state.clips[i]] = [state.clips[i], state.clips[i - 1]]; refresh(true); } } },
      { label: 'Move later', run: () => { if (i < state.clips.length - 1) { [state.clips[i + 1], state.clips[i]] = [state.clips[i], state.clips[i + 1]]; refresh(true); } } }],
    onSave: v => {
      const s = clamp(num(v.s), 0, c.dur), e = clamp(num(v.e, c.dur), 0, c.dur);
      if (e - s < 0.1) return toast('End must be after start.');
      c.start = +s.toFixed(2); c.end = +e.toFixed(2); refresh(true);
    },
    onDelete: () => { URL.revokeObjectURL(c.url); state.clips.splice(i, 1); refresh(true); },
  });
}
function editAudio(i) {
  const a = state.audios[i];
  openSheet({
    title: 'Sound settings', fields: [
      { k: 'o', label: 'Starts on timeline (seconds)', type: 'number', v: a.offset }, { k: 's', label: 'Use from (seconds)', type: 'number', v: a.start },
      { k: 'e', label: 'Use until (seconds, max ' + a.dur.toFixed(1) + ')', type: 'number', v: a.end }, { k: 'v', label: 'Volume %', type: 'number', v: a.volume }],
    onSave: v => {
      a.offset = Math.max(0, num(v.o)); a.start = clamp(num(v.s), 0, a.dur);
      a.end = clamp(num(v.e, a.dur), a.start + 0.1, a.dur); a.volume = clamp(num(v.v, 100), 0, 300); refresh();
    },
    onDelete: () => { a.el.pause(); state.audios.splice(i, 1); refresh(); },
  });
}
function textFields(x) {
  return [
    { k: 'text', label: 'Text', type: 'area', v: x.text }, { k: 's', label: 'Start (seconds)', type: 'number', v: x.start }, { k: 'e', label: 'End (seconds)', type: 'number', v: x.end },
    { k: 'x', label: 'Left %', type: 'number', v: x.x }, { k: 'y', label: 'Top %', type: 'number', v: x.y }, { k: 'size', label: 'Size', type: 'number', v: x.size }, { k: 'color', label: 'Color', type: 'color', v: x.color }];
}
function readText(v) {
  return { text: v.text, start: Math.max(0, num(v.s)), end: Math.max(0, num(v.e, 3)), x: clamp(num(v.x, 50), 0, 100), y: clamp(num(v.y, 50), 0, 100), size: clamp(num(v.size, 90), 10, 400), color: v.color || '#ffffff' };
}
function editText(i) {
  openSheet({ title: 'Text', fields: textFields(state.texts[i]), onSave: v => { if (v.text.trim()) { state.texts[i] = readText(v); refresh(); } }, onDelete: () => { state.texts.splice(i, 1); refresh(); } });
}
function addText() {
  const s = +state.t.toFixed(1);
  openSheet({ title: 'Add text', fields: textFields({ text: 'Your text', start: s, end: +(s + 3).toFixed(1), x: 50, y: 50, size: 90, color: '#ffffff' }), onSave: v => { if (v.text.trim()) { state.texts.push(readText(v)); refresh(); } } });
}
function capFields(c) { return [{ k: 'text', label: 'Caption', type: 'area', v: c.text }, { k: 's', label: 'Start (seconds)', type: 'number', v: c.start }, { k: 'e', label: 'End (seconds)', type: 'number', v: c.end }]; }
function readCap(v) { return { text: v.text.trim(), start: Math.max(0, num(v.s)), end: Math.max(0, num(v.e)) }; }
const sortCaps = () => state.captions.sort((a, b) => a.start - b.start);
function editCaption(i) {
  seekTo(state.captions[i].start);
  openSheet({ title: 'Caption', fields: capFields(state.captions[i]), onSave: v => { if (v.text.trim()) { state.captions[i] = readCap(v); sortCaps(); refresh(); } }, onDelete: () => { state.captions.splice(i, 1); refresh(); } });
}
function addCaption() {
  const s = +state.t.toFixed(1);
  openSheet({ title: 'Add caption', fields: capFields({ text: '', start: s, end: +(s + 2).toFixed(1) }), onSave: v => { if (v.text.trim()) { state.captions.push(readCap(v)); sortCaps(); refresh(); } } });
}

/* ------------------------------------------------------------ auto captions (Whisper in the browser) */
async function decodeTimeline16k() {
  const SR = 16000, AC16 = window.AudioContext || window.webkitAudioContext;
  const ac = new AC16({ sampleRate: SR });
  const parts = [];
  for (const c of state.clips) {
    const len = Math.round((c.end - c.start) * SR), out = new Float32Array(len);
    try {
      const ab = await ac.decodeAudioData(await (await fetch(c.url)).arrayBuffer());
      const chans = []; for (let k = 0; k < ab.numberOfChannels; k++) chans.push(ab.getChannelData(k));
      const ratio = ab.sampleRate / SR, from = Math.round(c.start * ab.sampleRate);
      for (let i = 0; i < len; i++) {
        const idx = from + Math.round(i * ratio); let s = 0;
        for (const ch of chans) s += ch[idx] || 0;
        out[i] = s / chans.length;
      }
    } catch (e) { /* no audio track: keep silence */ }
    parts.push(out);
  }
  ac.close && ac.close();
  const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  return all;
}
function splitChunk(text, s, e) {
  const words = text.trim().split(/\s+/).filter(Boolean), groups = []; let cur = [];
  for (const w of words) {
    if (cur.length && (cur.length >= 7 || (cur.join(' ') + ' ' + w).length > 34)) { groups.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  const lens = groups.map(g => g.join(' ').length), sum = lens.reduce((a, b) => a + b, 0) || 1;
  let t = s;
  return groups.map((g, i) => { const d = (e - s) * lens[i] / sum, r = { start: +t.toFixed(2), end: +(t + d).toFixed(2), text: g.join(' ') }; t += d; return r; });
}
async function genCaptions() {
  if (!state.clips.length) return toast('Add a video first.');
  if (state.captions.length && !confirm('Replace the existing captions?')) return;
  const btn = $('#genCaps'), box = $('#capStatus'), msg = $('#capMsg'), barWrap = box.querySelector('.bar'), bar = $('#capBar');
  btn.disabled = true; box.hidden = false;
  const say = (m, p) => { msg.textContent = m; if (p == null) barWrap.classList.add('indet'); else { barWrap.classList.remove('indet'); bar.style.width = (p * 100) + '%'; } };
  try {
    say('Reading the audio…');
    const audio = await decodeTimeline16k();
    say('Loading the AI model. The first time this downloads it.', 0);
    const tf = await import(TRANSFORMERS_URL);
    const asr = await tf.pipeline('automatic-speech-recognition', $('#model').value, {
      progress_callback: p => { if (p.status === 'progress' && p.total) say('Downloading AI model… ' + Math.round(p.progress) + '%', p.progress / 100); },
    });
    say('Listening. This can take a few minutes on a phone.');
    const lang = $('#lang').value;
    const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, task: 'transcribe', ...(lang ? { language: lang } : {}) });
    const tot = total(), caps = [];
    for (const ch of out.chunks || []) {
      if (!ch.text || !ch.text.trim()) continue;
      const s = ch.timestamp[0] ?? 0, e = ch.timestamp[1] ?? Math.min(tot, s + 3);
      caps.push(...splitChunk(ch.text, s, Math.max(e, s + 0.4)));
    }
    state.captions = caps; sortCaps();
    say(caps.length + ' captions added. Tap one to fix a word.', 1);
    refresh();
  } catch (e) {
    console.error(e);
    say('Captions failed: ' + (e.message || e) + '. Check your internet connection and try again.', 0);
  } finally { btn.disabled = false; box.querySelector('.bar').classList.remove('indet'); }
}

/* ------------------------------------------------------------ export */
let recorder = null, exportCancelled = false, wakeLock = null;
function pickMime() {
  const list = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return list.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
async function exportVideo() {
  if (!state.clips.length) return toast('Add a video first.');
  if (!window.MediaRecorder) return toast('This browser cannot export video. Try Chrome or Safari.');
  pause(); ensureAudio(); await AC.resume(); wireAll(); monitor.gain.value = 0;
  const mime = pickMime(), ext = mime.includes('mp4') ? 'mp4' : 'webm';
  const wrap = $('#exportWrap'); wrap.hidden = false;
  $('#exportTitle').textContent = 'Exporting ' + state.res; $('#exportMsg').textContent = 'Keep this screen open. The video is recorded in real time.';
  $('#exportVideo').hidden = true; $('#exportActions').hidden = true; $('#exportCancel').hidden = false; $('#exportBar').style.width = '0';
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) { wakeLock = null; }
  exportCancelled = false;
  const [W, H] = outSize(); cv.width = W; cv.height = H;
  await seekTo(0);
  const stream = cv.captureStream(30);
  recDest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  const chunks = [];
  recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: BITRATE[state.res], audioBitsPerSecond: 192000 });
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    monitor.gain.value = 1; wakeLock && wakeLock.release && wakeLock.release().catch(() => {});
    if (exportCancelled) { wrap.hidden = true; return; }
    const blob = new Blob(chunks, { type: mime || 'video/webm' }), url = URL.createObjectURL(blob);
    const v = $('#exportVideo'); v.src = url; v.hidden = false;
    const a = $('#saveLink'); a.href = url; a.download = 'simplecut.' + ext;
    $('#exportTitle').textContent = 'Done'; $('#exportMsg').textContent = (blob.size / 1048576).toFixed(1) + ' MB · ' + ext.toUpperCase() + ' · ' + W + '×' + H;
    $('#exportBar').style.width = '100%'; $('#exportActions').hidden = false; $('#exportCancel').hidden = true;
    $('#shareBtn').onclick = async () => {
      try { const f = new File([blob], 'simplecut.' + ext, { type: blob.type }); if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f] }); else toast('Use Save video instead.'); } catch (e) { /* cancelled */ }
    };
  };
  recorder.start(1000);
  const tick = setInterval(() => { $('#exportBar').style.width = (100 * state.t / Math.max(total(), 0.1)) + '%'; }, 250);
  play(() => setTimeout(() => { clearInterval(tick); if (recorder.state !== 'inactive') recorder.stop(); }, 400));
  recorder.addEventListener('stop', () => clearInterval(tick));
}
function cancelExport() {
  exportCancelled = true; pause();
  if (recorder && recorder.state !== 'inactive') recorder.stop(); else $('#exportWrap').hidden = true;
}

/* ------------------------------------------------------------ wiring */
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + b.dataset.tab));
}));
$('#fileVideo').addEventListener('change', e => { addVideos([...e.target.files]); e.target.value = ''; });
$('#fileAudio').addEventListener('change', e => { if (e.target.files[0]) addAudio(e.target.files[0]); e.target.value = ''; });
$('#addText').onclick = addText; $('#addCap').onclick = addCaption; $('#genCaps').onclick = genCaptions;
$('#playBtn').onclick = () => (state.playing ? pause() : play());
$('#scrub').addEventListener('input', e => { if (state.playing) pause(); seekTo(num(e.target.value)); });
$('#res').addEventListener('change', e => { state.res = e.target.value; draw(state.t); });
$('#exportBtn').onclick = exportVideo; $('#exportCancel').onclick = cancelExport;
$('#exportClose').onclick = () => { $('#exportWrap').hidden = true; $('#exportVideo').pause(); };
const capInputs = () => {
  const c = state.cap;
  c.enabled = $('#capOn').checked; c.box = $('#capBox').checked; c.size = clamp(num($('#capSize').value, 54), 10, 300);
  c.bottom = clamp(num($('#capBottom').value, 8), 0, 90); c.color = $('#capColor').value;
  if (!state.playing) draw(state.t);
};
['#capOn', '#capBox', '#capSize', '#capBottom', '#capColor'].forEach(s => $(s).addEventListener('input', capInputs));
window.addEventListener('resize', drawTimeline);
document.addEventListener('visibilitychange', () => { if (document.hidden && state.playing && !(recorder && recorder.state === 'recording')) pause(); });
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
setPlayIcon(); refresh();
window.__sc = { state, seekTo, play, pause, exportVideo, addVideos };
